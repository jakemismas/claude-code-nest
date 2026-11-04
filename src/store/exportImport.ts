// Export and import core: the additive per-project merge, the export helper and the import plan.
// Pure and vscode-free: the command module owns file IO and store writes.
// Import never deletes a project absent from the file.

import {
  ChatMeta,
  Folder,
  Link,
  ProjectMeta,
  Tag,
  isSafeRecordId,
  nullProtoMaps,
} from './schema';
import { NormalizedEnvelope } from './schemaMigrate';

// One project's merge result: the merged document, whether it changed, and the folder conflicts resolved.
export interface ProjectMergeResult {
  projectKey: string;
  merged: ProjectMeta;
  changed: boolean;
  // Chats where both sides set a different non-null folderId and the older side lost.
  folderConflicts: string[];
}

// One merge result per project present in the import file; absent projects are never touched.
export interface ImportPlan {
  results: ProjectMergeResult[];
  totalFolderConflicts: number;
}

// Builds the import plan by merging each envelope project onto the live document from readLive.
// Projects absent from the envelope are never touched.
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

// Additive per-project merge of the file document onto live. Neither input is mutated.
export function mergeProjectMeta(
  projectKey: string,
  live: ProjectMeta,
  file: ProjectMeta,
): ProjectMergeResult {
  // Deep copy so the result is independent of both inputs. The JSON round-trip restores Object.prototype
  // on the id-keyed maps, so rebuild them with a null prototype.
  const merged: ProjectMeta = nullProtoMaps(
    JSON.parse(JSON.stringify(live)) as ProjectMeta,
  );

  let changed = false;

  // Folders: union by id; on conflict the higher document updatedAt wins.
  for (const [folderId, fileFolder] of Object.entries(file.folders)) {
    // Skip keys that fail the record-id check: the merge re-keys with the raw key, and mergeProjectMeta is public.
    if (!isSafeRecordId(folderId)) {
      continue;
    }
    const liveFolder = merged.folders[folderId];
    if (!liveFolder) {
      merged.folders[folderId] = cloneFolder(fileFolder);
      changed = true;
      continue;
    }
    // Same id on both sides: the higher document updatedAt wins (there is no per-folder stamp). A tie keeps live.
    if (!foldersEqual(liveFolder, fileFolder) && file.updatedAt > live.updatedAt) {
      merged.folders[folderId] = cloneFolder(fileFolder);
      changed = true;
    }
  }

  // Tags: union by id; on conflict the higher document updatedAt wins.
  for (const [tagId, fileTag] of Object.entries(file.tags)) {
    // Skip an unsafe key, as in the folders loop.
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

  // Chats: union by id. Tags union, links dedupe on (targetChatId, kind), folderId is LWW by updatedAt.
  const folderConflicts: string[] = [];
  for (const [chatId, fileChat] of Object.entries(file.chats)) {
    // Skip an unsafe chat key: it reaches the archive body path, where '..' would escape globalStorage.
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

    const linkKeys = new Set(liveChat.links.map(linkKey));
    const mergedLinks = liveChat.links.map(cloneLink);
    for (const l of fileChat.links) {
      const key = linkKey(l);
      if (!linkKeys.has(key)) {
        linkKeys.add(key);
        mergedLinks.push(cloneLink(l));
      }
    }

    // folderId: the newer record wins and a tie keeps live. Both sides setting different non-null
    // folders is a conflict, recorded for the warning.
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

    // The merged stamp is the max of both. The scalar groups below follow the stamp-winner, with a tie
    // keeping live. starred and the archive pair are independent toggles sharing one stamp, so each
    // falls back to the loser when the winner never set it (star on one machine, archive on another
    // keeps both). archivedAt stays coupled to userArchived.
    const useFile = fileChat.updatedAt > liveChat.updatedAt;
    const winner = useFile ? fileChat : liveChat;
    const loser = useFile ? liveChat : fileChat;
    // Equal stamps need a device-independent tie-break. Automated archive flips do not refresh updatedAt,
    // so two devices can hold identical stamps with divergent groups and never converge. The tie-breaks
    // below compare values only, never which side is live.
    const stampsEqual = fileChat.updatedAt === liveChat.updatedAt;
    const mergedChat: ChatMeta = {
      folderId: mergedFolderId,
      tags: mergedTags,
      links: mergedLinks,
      updatedAt: Math.max(liveChat.updatedAt, fileChat.updatedAt),
      deviceId: useFile ? fileChat.deviceId : liveChat.deviceId,
    };
    // starred: the stamp-winner wins when it set the flag, else carry the loser's. On equal stamps true
    // wins on both machines, since starring exempts a chat from auto-archive.
    let starred = winner.starred !== undefined ? winner.starred : loser.starred;
    if (
      stampsEqual &&
      fileChat.starred !== undefined &&
      liveChat.starred !== undefined &&
      fileChat.starred !== liveChat.starred
    ) {
      starred = true;
    }
    if (starred !== undefined) {
      mergedChat.starred = starred;
    }
    // Archive group: the stamp-winner takes the whole group when it set userArchived, else the loser's.
    // archivedAt and restoredAt travel with the flag so the restore marker reaches the other machine.
    let archiveSide =
      winner.userArchived !== undefined
        ? winner
        : loser.userArchived !== undefined
          ? loser
          : undefined;
    // Equal stamps: pick the side with the later archive or restore event, then compare the serialized
    // group, so both machines resolve to one value.
    if (
      stampsEqual &&
      fileChat.userArchived !== undefined &&
      liveChat.userArchived !== undefined
    ) {
      const groupOf = (c: ChatMeta): string =>
        JSON.stringify([c.userArchived, c.archivedAt ?? 0, c.restoredAt ?? 0]);
      if (groupOf(fileChat) !== groupOf(liveChat)) {
        const activityOf = (c: ChatMeta): number =>
          Math.max(c.archivedAt ?? 0, c.restoredAt ?? 0);
        if (activityOf(fileChat) !== activityOf(liveChat)) {
          archiveSide = activityOf(fileChat) > activityOf(liveChat) ? fileChat : liveChat;
        } else {
          archiveSide = groupOf(fileChat) > groupOf(liveChat) ? fileChat : liveChat;
        }
      }
    }
    if (archiveSide !== undefined) {
      mergedChat.userArchived = archiveSide.userArchived;
      if (archiveSide.archivedAt !== undefined) {
        mergedChat.archivedAt = archiveSide.archivedAt;
      }
      if (archiveSide.restoredAt !== undefined) {
        mergedChat.restoredAt = archiveSide.restoredAt;
      }
    }
    merged.chats[chatId] = mergedChat;
    if (JSON.stringify(mergedChat) !== before) {
      changed = true;
    }
  }

  // Keep forward-compat __unknown fields from both sides, preferring the higher version.
  const mergedUnknown = mergeUnknown(live, file);
  if (mergedUnknown !== undefined) {
    if (JSON.stringify(mergedUnknown) !== JSON.stringify(live.__unknown)) {
      changed = true;
    }
    merged.__unknown = mergedUnknown;
  }
  // Keep the higher schemaVersion so merging a newer file does not downgrade the document.
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
  // Use the higher-version escrow as the base, then add keys only the other side has.
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
  // Copy color through so a color-only edit survives a merge that picks the file folder.
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
  // Carry the optional scalars so a new imported chat keeps its starred and archive state.
  if (c.starred !== undefined) {
    out.starred = c.starred;
  }
  if (c.userArchived !== undefined) {
    out.userArchived = c.userArchived;
  }
  if (c.archivedAt !== undefined) {
    out.archivedAt = c.archivedAt;
  }
  if (c.restoredAt !== undefined) {
    out.restoredAt = c.restoredAt;
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
