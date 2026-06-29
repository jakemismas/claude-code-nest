// Export/import core: the ADDITIVE per-project merge and its collision identity
// rule, the export serialization helper, and the import plan that the command
// module applies via the store. PURE and vscode-free (unit-gate rule): no
// filesystem, no vscode. The command module owns the file read/write (via
// vscode.workspace.fs, NOT node fs, so it never trips the read-only lint bank)
// and the store calls; this module takes plain data and returns plain results.
//
// Binding rules honored (ARCHITECTURE.md and the slice patch):
// - Import validates and migrates a scratch copy BEFORE touching the live store,
//   then merges additively per project and NEVER deletes a project absent from
//   the file (a project in the store but not in the import is untouched; line 205).
// - The ADDITIVE per-project merge with the pinned COLLISION IDENTITY RULE:
//     * folders and tags UNION by id (same id = same record); on a same-id
//       conflict the document-level higher updatedAt wins (LWW, consistent with
//       the reconcile rule, applied per RECORD-source not per scalar field).
//     * chat tags UNION (set union of tag ids).
//     * chat links UNION, deduped on the exact (targetChatId, kind) pair, matching
//       the store's addLink dedupe.
//     * chat folderId is the LWW scalar arbitrated by ChatMeta.updatedAt (there is
//       NO per-scalar-field stamp; per-RECORD updatedAt arbitrates folderId).
//     * chat starred and the (userArchived, archivedAt) pair are LWW scalars
//       arbitrated by the SAME per-record ChatMeta.updatedAt (Slice 3), but as
//       TWO INDEPENDENT groups: starred is orthogonal to the archive pair, so the
//       stamp-winner wins a group only when it SET that group, otherwise the
//       loser's independently-set group is carried (not dropped). archivedAt
//       travels COUPLED to userArchived (the side that supplies the flag supplies
//       its timestamp), and a tie keeps live.
//     * Folder.color is an LWW field arbitrated by the document-level updatedAt
//       (folders have no per-record stamp), via foldersEqual/cloneFolder.
// - Tags/links unions are additive and stamp-independent.
// - The merged document is written via store.putProjectMeta, which re-stamps the
//   project and preserves __unknown; this module does NOT bump SCHEMA_VERSION or
//   invent a per-field stamp.

import {
  ChatMeta,
  Folder,
  Link,
  ProjectMeta,
  Tag,
  isSafeRecordId,
} from './schema';
import { NormalizedEnvelope } from './schemaMigrate';

// One project's merge result: the project key and the merged document to persist
// via store.putProjectMeta. Carries whether the merge actually changed anything
// (so the command module can skip a no-op write) and the collisions it resolved
// (a same-scalar folderId conflict where one side lost), for the honest LWW
// warning surface.
export interface ProjectMergeResult {
  projectKey: string;
  merged: ProjectMeta;
  changed: boolean;
  // Chats where BOTH sides set a DIFFERENT non-null folderId, i.e. a genuine
  // same-scalar-field conflict resolved by LWW (the older side lost its home).
  // The irreducible floor the architecture calls out and surfaces.
  folderConflicts: string[];
}

// The plan an import produces: one merge result per project PRESENT in the import
// file. A project in the live store but ABSENT from the file does not appear here
// and is therefore never touched (the never-delete-absent rule). The command
// module persists each result via store.putProjectMeta and reports the summary.
export interface ImportPlan {
  results: ProjectMergeResult[];
  // Total folder-conflict count across all projects, for the LWW warning.
  totalFolderConflicts: number;
}

// Build the import plan: for each project in the migrated envelope, merge it
// additively onto the live store's current document for that project key. The
// caller supplies a reader for the live document (the store's getProjectMeta) so
// this stays pure and the live read is injected.
//
// readLive returns the live ProjectMeta for a key (an empty document when the
// project has never been stored). A project in the store but not in the envelope
// is NOT enumerated here, so it is never merged and never deleted.
export function buildImportPlan(
  envelope: NormalizedEnvelope,
  readLive: (projectKey: string) => ProjectMeta,
): ImportPlan {
  const results: ProjectMergeResult[] = [];
  let totalFolderConflicts = 0;
  for (const [projectKey, incoming] of Object.entries(envelope.projects)) {
    const live = readLive(projectKey);
    const result = mergeProjectMeta(projectKey, live, incoming);
    results.push(result);
    totalFolderConflicts += result.folderConflicts.length;
  }
  return { results, totalFolderConflicts };
}

// The ADDITIVE per-project merge. `live` is the store's current document, `file`
// is the imported document. The result is a new ProjectMeta; neither input is
// mutated. The collision identity rule (pinned in the slice patch) is applied
// here exactly.
export function mergeProjectMeta(
  projectKey: string,
  live: ProjectMeta,
  file: ProjectMeta,
): ProjectMergeResult {
  // Start from a deep copy of the live document so the result is independent of
  // both inputs and putProjectMeta can re-stamp it freely.
  const merged: ProjectMeta = JSON.parse(JSON.stringify(live)) as ProjectMeta;

  let changed = false;

  // ---- Folders: union by id; same-id conflict -> higher document updatedAt wins.
  for (const [folderId, fileFolder] of Object.entries(file.folders)) {
    // SKIP any file-side key that fails the record-id check, the same way the
    // normalize boundary drops it. A merge re-keys merged.folders[folderId] with
    // this raw key verbatim, so an untrusted '../../x' or prototype-name key would
    // otherwise re-enter the document on import/reconcile and reach the downstream
    // path sink. The normalize pass already gates a migrated import, but
    // mergeProjectMeta is also called directly (and is public), so it must gate too.
    if (!isSafeRecordId(folderId)) {
      continue;
    }
    const liveFolder = merged.folders[folderId];
    if (!liveFolder) {
      merged.folders[folderId] = cloneFolder(fileFolder);
      changed = true;
      continue;
    }
    // Same id present on both sides. If the records differ, the side from the
    // document with the higher updatedAt wins (document-level LWW: there is no
    // per-folder stamp, so the project's updatedAt arbitrates). A tie keeps live.
    if (!foldersEqual(liveFolder, fileFolder) && file.updatedAt > live.updatedAt) {
      merged.folders[folderId] = cloneFolder(fileFolder);
      changed = true;
    }
  }

  // ---- Tags: union by id; same-id conflict -> higher document updatedAt wins.
  for (const [tagId, fileTag] of Object.entries(file.tags)) {
    // SKIP an unsafe file-side key (see the folders loop note); the merge re-keys
    // merged.tags[tagId] with it verbatim otherwise.
    if (!isSafeRecordId(tagId)) {
      continue;
    }
    const liveTag = merged.tags[tagId];
    if (!liveTag) {
      merged.tags[tagId] = cloneTag(fileTag);
      changed = true;
      continue;
    }
    if (!tagsEqual(liveTag, fileTag) && file.updatedAt > live.updatedAt) {
      merged.tags[tagId] = cloneTag(fileTag);
      changed = true;
    }
  }

  // ---- Chats: union by id. For a chat present on both sides:
  //   tags  -> set union (additive, stamp-independent)
  //   links -> union deduped on (targetChatId, kind) (matches addLink)
  //   folderId -> LWW scalar by ChatMeta.updatedAt (the only per-record scalar
  //               arbitrated by a stamp); a genuine differing-non-null conflict is
  //               recorded as a folderConflict.
  const folderConflicts: string[] = [];
  for (const [chatId, fileChat] of Object.entries(file.chats)) {
    // SKIP an unsafe file-side chat KEY. This is the CRITICAL boundary: a chat key
    // flows verbatim to the archive body-file path (archiveBodyStore.bodyFileUri),
    // where Uri.joinPath collapses '..' and escapes globalStorage. A key like
    // '../../../../Users/victim/evil' must never re-enter the merged document and
    // reach readArchivedBody (auto-fired on every Archive-view refresh).
    if (!isSafeRecordId(chatId)) {
      continue;
    }
    const liveChat = merged.chats[chatId];
    if (!liveChat) {
      merged.chats[chatId] = cloneChat(fileChat);
      changed = true;
      continue;
    }
    const before = JSON.stringify(liveChat);

    // tags: set union, first-seen order (live first, then file's new ones).
    const tagSet = new Set(liveChat.tags);
    const mergedTags = liveChat.tags.slice();
    for (const t of fileChat.tags) {
      if (!tagSet.has(t)) {
        tagSet.add(t);
        mergedTags.push(t);
      }
    }

    // links: union deduped on the exact (targetChatId, kind) pair.
    const linkKeys = new Set(liveChat.links.map(linkKey));
    const mergedLinks = liveChat.links.map(cloneLink);
    for (const l of fileChat.links) {
      const key = linkKey(l);
      if (!linkKeys.has(key)) {
        linkKeys.add(key);
        mergedLinks.push(cloneLink(l));
      }
    }

    // folderId: LWW scalar by per-record updatedAt. A tie keeps live (local-wins
    // bias, consistent with the sync model). A genuine conflict is where BOTH set
    // a DIFFERENT non-null home; that is the irreducible same-scalar floor, so
    // record it for the honest warning.
    let mergedFolderId = liveChat.folderId;
    if (fileChat.folderId !== liveChat.folderId) {
      if (
        liveChat.folderId !== null &&
        fileChat.folderId !== null
      ) {
        folderConflicts.push(chatId);
      }
      if (fileChat.updatedAt > liveChat.updatedAt) {
        mergedFolderId = fileChat.folderId;
      }
    }

    // The merged chat's stamp is the MAX of the two record stamps, so a later
    // reconcile/merge sees the freshest known time for the record. deviceId
    // follows the winning stamp's side (informational; the project re-stamp by
    // putProjectMeta sets the authoritative project-level stamp/device).
    //
    // The remaining per-record SCALARS are arbitrated by the SAME single useFile
    // boolean as deviceId (one per-record updatedAt stamp, NO per-scalar stamp;
    // a tie (useFile === false) keeps the live side, local-wins bias consistent
    // with folderId's tie rule). BUT starred is an INDEPENDENT user toggle from
    // the archive pair, and the two share one record stamp. If we copied all
    // three only from the single stamp-winner, a side that last touched ONLY one
    // group would carry just its own scalar and the OTHER group's
    // independently-set value on the loser would be silently dropped (e.g. star
    // on machine A, archive on machine B later -> the merge keeps the archive and
    // loses the star). So each INDEPENDENT group falls back to the loser when the
    // stamp-winner has not set it: arbitrate starred on its own, and the
    // (userArchived, archivedAt) pair on its own. Within the archive pair
    // archivedAt stays COUPLED to userArchived (the side that supplies the flag
    // supplies its timestamp) so the timestamp can never desynchronize from the
    // flag. folderId stays on its own comparison above so it can record the
    // conflict floor; these scalars need no conflict array (when both sides set
    // an independent group the stamp-winner takes it, LWW, no surfaced floor).
    const useFile = fileChat.updatedAt > liveChat.updatedAt;
    const winner = useFile ? fileChat : liveChat;
    const loser = useFile ? liveChat : fileChat;
    const mergedChat: ChatMeta = {
      folderId: mergedFolderId,
      tags: mergedTags,
      links: mergedLinks,
      updatedAt: Math.max(liveChat.updatedAt, fileChat.updatedAt),
      deviceId: useFile ? fileChat.deviceId : liveChat.deviceId,
    };
    // starred: stamp-winner wins when it set the flag; otherwise carry the
    // loser's independently-set flag rather than dropping it.
    const starred =
      winner.starred !== undefined ? winner.starred : loser.starred;
    if (starred !== undefined) {
      mergedChat.starred = starred;
    }
    // archive pair (userArchived + its coupled archivedAt): the stamp-winner wins
    // the WHOLE pair when it set userArchived; otherwise carry the loser's whole
    // pair. archivedAt always travels with the side that supplied userArchived.
    const archiveSide =
      winner.userArchived !== undefined
        ? winner
        : loser.userArchived !== undefined
          ? loser
          : undefined;
    if (archiveSide !== undefined) {
      mergedChat.userArchived = archiveSide.userArchived;
      if (archiveSide.archivedAt !== undefined) {
        mergedChat.archivedAt = archiveSide.archivedAt;
      }
    }
    merged.chats[chatId] = mergedChat;
    if (JSON.stringify(mergedChat) !== before) {
      changed = true;
    }
  }

  // Carry the forward-compat escrow additively: prefer the document with the
  // higher version's __unknown, else union the two so neither side's
  // newer-build fields are stripped on the merge.
  const mergedUnknown = mergeUnknown(live, file);
  if (mergedUnknown !== undefined) {
    if (JSON.stringify(mergedUnknown) !== JSON.stringify(live.__unknown)) {
      changed = true;
    }
    merged.__unknown = mergedUnknown;
  }
  // Keep the higher schemaVersion so a merge with a forward-version file does not
  // advertise the document as our older shape (mirrors migrateProjectMeta).
  if (file.schemaVersion > merged.schemaVersion) {
    merged.schemaVersion = file.schemaVersion;
    changed = true;
  }

  return { projectKey, merged, changed, folderConflicts };
}

function mergeUnknown(
  live: ProjectMeta,
  file: ProjectMeta,
): { [k: string]: unknown } | undefined {
  const liveU = live.__unknown;
  const fileU = file.__unknown;
  if (liveU === undefined && fileU === undefined) {
    return undefined;
  }
  // Prefer the higher-version document's escrow as the base, then fold in any
  // keys the other side has that the base lacks (additive, no clobber of a
  // present key on the higher-version base).
  const baseFromFile = file.schemaVersion >= live.schemaVersion;
  const base = baseFromFile ? fileU : liveU;
  const other = baseFromFile ? liveU : fileU;
  const result: { [k: string]: unknown } = base
    ? (JSON.parse(JSON.stringify(base)) as { [k: string]: unknown })
    : {};
  if (other) {
    for (const [k, v] of Object.entries(other)) {
      if (!(k in result)) {
        result[k] = JSON.parse(JSON.stringify(v));
      }
    }
  }
  return result;
}

function linkKey(l: Link): string {
  return l.targetChatId + ' ' + l.kind;
}

function cloneFolder(f: Folder): Folder {
  const out: Folder = { id: f.id, name: f.name, parentId: f.parentId, order: f.order };
  // color is a curation scalar: copy it through, else a color-only edit is lost
  // on a merge that picks the file folder. Coupled with foldersEqual including
  // color (a color-only diff must read as NOT equal) and normalizeFolder carrying
  // it; without all three a color-only change is a silent no-op.
  if (f.color !== undefined) {
    out.color = f.color;
  }
  return out;
}

function cloneTag(t: Tag): Tag {
  const out: Tag = { id: t.id, label: t.label };
  if (t.color !== undefined) {
    out.color = t.color;
  }
  return out;
}

function cloneLink(l: Link): Link {
  return { targetChatId: l.targetChatId, kind: l.kind };
}

function cloneChat(c: ChatMeta): ChatMeta {
  const out: ChatMeta = {
    folderId: c.folderId,
    tags: c.tags.slice(),
    links: c.links.map(cloneLink),
    updatedAt: c.updatedAt,
    deviceId: c.deviceId,
  };
  // Carry the optional curation scalars through a file-only-chat clone, else a
  // brand-new imported/merged chat loses its starred/archive state.
  if (c.starred !== undefined) {
    out.starred = c.starred;
  }
  if (c.userArchived !== undefined) {
    out.userArchived = c.userArchived;
  }
  if (c.archivedAt !== undefined) {
    out.archivedAt = c.archivedAt;
  }
  return out;
}

function foldersEqual(a: Folder, b: Folder): boolean {
  return (
    a.name === b.name &&
    a.parentId === b.parentId &&
    a.order === b.order &&
    a.color === b.color
  );
}

function tagsEqual(a: Tag, b: Tag): boolean {
  return a.label === b.label && a.color === b.color;
}
