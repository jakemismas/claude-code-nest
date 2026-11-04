// promoteSmartGroup: the explicit, idempotent commands that promote a read-only smart-group bucket to a real Folder or Tag.
// They write only synced ProjectMeta through the store and file nothing automatically; a repeat promote reuses the folder or tag matched by name.
// The batch is N synchronous store calls, one flush and one refresh; the module has no vscode import.

import { MetadataStore } from '../store/metadataStore';
import { Folder, Tag } from '../store/schema';
import { mintFolderId, mintTagId, assertMintableId } from '../model/idFactory';
import { findChildByName } from '../model/folderTree';

export const PROMOTE_GROUP_TO_FOLDER_COMMAND = 'claudeNest.promoteSmartGroupToFolder';
export const PROMOTE_GROUP_TO_TAG_COMMAND = 'claudeNest.promoteSmartGroupToTag';

// The bucket to promote: the human name (folder name or tag label) and member chat sessionIds.
export interface PromotableGroup {
  name: string;
  memberChatIds: string[];
}

export interface PromoteDeps {
  store: MetadataStore;
  provider: { refresh(): void };
  // Resolve the project key on demand so a project created after activation still resolves.
  getProjectKey: () => string | undefined;
}

// The promotion target: created is true only when a new folder or tag was minted; id is the reused or new id.
export interface PromoteResult {
  id: string;
  created: boolean;
  memberCount: number;
}

// Promote a bucket to a top-level folder, filing every member into it and reusing an existing top-level folder of the same name.
// Returns null when there is no project or the bucket has no members.
export async function promoteGroupToFolder(
  deps: PromoteDeps,
  group: PromotableGroup,
): Promise<PromoteResult | null> {
  const { store, provider } = deps;
  const projectKey = deps.getProjectKey();
  if (projectKey === undefined) {
    return null;
  }
  const name = group.name.trim();
  const members = dedupe(group.memberChatIds);
  if (name.length === 0 || members.length === 0) {
    return null;
  }

  const meta = store.getProjectMeta(projectKey);
  // Reuse a top-level folder of this name (parentId null); findChildByName matches that key exactly.
  const existing = findChildByName(meta.folders, null, name);
  let folderId: string;
  let created: boolean;
  if (existing !== null) {
    folderId = existing.id;
    created = false;
  } else {
    folderId = mintFolderId();
    assertMintableId(folderId, 'promoted folder id');
    const folder: Folder = {
      id: folderId,
      name,
      parentId: null,
      order: topLevelFolderCount(meta.folders),
    };
    store.upsertFolder(projectKey, folder);
    created = true;
  }

  // File every member; setChatFolder is last-write, so a repeat promotion is a no-op. Calls coalesce into one pending write.
  for (const chatId of members) {
    store.setChatFolder(projectKey, chatId, folderId);
  }
  await store.flush();
  provider.refresh();
  return { id: folderId, created, memberCount: members.length };
}

// Promote a bucket to a tag, applying it to every member and reusing an existing tag of the same label.
// Returns null when there is no project or the bucket has no members.
export async function promoteGroupToTag(
  deps: PromoteDeps,
  group: PromotableGroup,
): Promise<PromoteResult | null> {
  const { store, provider } = deps;
  const projectKey = deps.getProjectKey();
  if (projectKey === undefined) {
    return null;
  }
  const label = group.name.trim();
  const members = dedupe(group.memberChatIds);
  if (label.length === 0 || members.length === 0) {
    return null;
  }

  const meta = store.getProjectMeta(projectKey);
  // Reuse the first tag whose label equals this name (tags have no parent and labels are not unique), so re-promoting converges on one tag.
  const existing = findTagByLabel(meta.tags, label);
  let tagId: string;
  let created: boolean;
  if (existing !== null) {
    tagId = existing.id;
    created = false;
  } else {
    tagId = mintTagId();
    assertMintableId(tagId, 'promoted tag id');
    const tag: Tag = { id: tagId, label };
    store.upsertTag(projectKey, tag);
    created = true;
  }

  // addChatTag dedupes, so a repeat promotion is a no-op for tagged members.
  for (const chatId of members) {
    store.addChatTag(projectKey, chatId, tagId);
  }
  await store.flush();
  provider.refresh();
  return { id: tagId, created, memberCount: members.length };
}

// Find a stored tag by exact label, or null.
export function findTagByLabel(
  tags: { [id: string]: Tag },
  label: string,
): Tag | null {
  for (const tag of Object.values(tags)) {
    if (tag.label === label) {
      return tag;
    }
  }
  return null;
}

// Count top-level (parentId null) folders, for the new folder's append order.
function topLevelFolderCount(folders: { [id: string]: Folder }): number {
  let count = 0;
  for (const folder of Object.values(folders)) {
    if (folder.parentId === null) {
      count++;
    }
  }
  return count;
}

// De-duplicate sessionIds preserving first-seen order, dropping empties.
function dedupe(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (id.length > 0 && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
