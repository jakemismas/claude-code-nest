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
    const useFile = fileChat.updatedAt > liveChat.updatedAt;
    const mergedChat: ChatMeta = {
      folderId: mergedFolderId,
      tags: mergedTags,
      links: mergedLinks,
      updatedAt: Math.max(liveChat.updatedAt, fileChat.updatedAt),
      deviceId: useFile ? fileChat.deviceId : liveChat.deviceId,
    };
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
  return { id: f.id, name: f.name, parentId: f.parentId, order: f.order };
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
  return {
    folderId: c.folderId,
    tags: c.tags.slice(),
    links: c.links.map(cloneLink),
    updatedAt: c.updatedAt,
    deviceId: c.deviceId,
  };
}

function foldersEqual(a: Folder, b: Folder): boolean {
  return (
    a.name === b.name && a.parentId === b.parentId && a.order === b.order
  );
}

function tagsEqual(a: Tag, b: Tag): boolean {
  return a.label === b.label && a.color === b.color;
}
