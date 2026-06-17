// promoteSmartGroup: the two explicit, idempotent promotion commands that turn a
// read-only smart-group bucket into a real Folder or Tag. This is the ONLY write
// path the smart-groups slice has, and it writes ONLY synced ProjectMeta through
// the store (never under ~/.claude/projects). Nothing here auto-files; the user
// invokes a promote on a chosen bucket.
//
// Idempotency has TWO levels, both honored (accepted patch):
//  - membership: store.setChatFolder is last-write and store.addChatTag dedupes,
//    so re-running a promotion is a no-op on already-promoted chats.
//  - GROUP IDENTITY (idempotency-on-NAME): a second promote of the SAME bucket
//    reuses the existing folder/tag BY NAME rather than minting a duplicate.
//    promote-to-folder reuses a top-level folder matched by name
//    (findChildByName(folders, null, name)); promote-to-tag reuses a tag matched
//    by label. So promoting "PR #1" twice yields one folder/tag with every member
//    filed/tagged once, not two same-named folders/tags.
//
// The batch follows the deleteFolder-cascade shape (ARCHITECTURE.md "Refresh
// coalescing"): N synchronous store calls (which coalesce into one pending
// write), ONE await store.flush(), ONE provider.refresh().
//
// This module imports the store and the pure id-factory/folderTree helpers; it is
// NOT vscode-bound (no vscode import), so the orchestration is exercisable in the
// headless unit suite with a real MetadataStore and a fake provider.

import { MetadataStore } from '../store/metadataStore';
import { Folder, Tag } from '../store/schema';
import { mintFolderId, mintTagId, assertMintableId } from '../model/idFactory';
import { findChildByName } from '../model/folderTree';

export const PROMOTE_GROUP_TO_FOLDER_COMMAND = 'claudeNest.promoteSmartGroupToFolder';
export const PROMOTE_GROUP_TO_TAG_COMMAND = 'claudeNest.promoteSmartGroupToTag';

// The plain description of a bucket to promote: the human name (becomes the
// folder name / tag label) and the member chat sessionIds. The view extracts this
// from the clicked smart-group bucket row; a test supplies it directly.
export interface PromotableGroup {
  name: string;
  memberChatIds: string[];
}

export interface PromoteDeps {
  store: MetadataStore;
  provider: { refresh(): void };
  // Resolve the encoded project key ON DEMAND (mirroring the other commands), so a
  // promote invoked after Claude Code created the project dir resolves it.
  getProjectKey: () => string | undefined;
}

// The result of resolving-or-creating the promotion target, for the unit tests to
// assert idempotency-on-name: created is true only when a NEW folder/tag was
// minted; id is the (reused or new) target id.
export interface PromoteResult {
  id: string;
  created: boolean;
  memberCount: number;
}

// Promote a smart-group bucket to a real top-level FOLDER, filing every member
// chat into it. Reuses an existing top-level folder of the same name (idempotent
// group identity); files each member with setChatFolder (last-write, so a member
// already in the folder is a no-op). Returns null when there is no project or the
// bucket has no members; otherwise the PromoteResult.
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
  // Idempotency-on-NAME: reuse a top-level (parentId null) folder of this name.
  // A smart-group promotion always creates a TOP-LEVEL folder, so the reuse key
  // is (parentId=null, name), which findChildByName matches exactly.
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

  // File every member into the folder. setChatFolder is last-write, so a chat
  // already homed here is re-stamped to the same value (a harmless no-op on
  // re-promotion). N synchronous calls coalesce into one pending write.
  for (const chatId of members) {
    store.setChatFolder(projectKey, chatId, folderId);
  }
  await store.flush();
  provider.refresh();
  return { id: folderId, created, memberCount: members.length };
}

// Promote a smart-group bucket to a real TAG, applying it to every member chat.
// Reuses an existing tag of the same label (idempotent group identity); applies
// with addChatTag (dedupes, so a member already tagged is a no-op). Returns null
// when there is no project or the bucket has no members; otherwise the result.
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
  // Idempotency-on-NAME: reuse a tag whose label equals this name. Tags carry no
  // parent, so the reuse key is the label alone. The FIRST matching label wins;
  // the create-tag command does not enforce label uniqueness, but a promote only
  // ever reuses (never edits) so re-promoting a group converges on whichever tag
  // already carries the label rather than minting another.
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

  // Apply the tag to every member. addChatTag dedupes, so a member already
  // carrying the tag is a no-op on re-promotion. N synchronous calls coalesce.
  for (const chatId of members) {
    store.addChatTag(projectKey, chatId, tagId);
  }
  await store.flush();
  provider.refresh();
  return { id: tagId, created, memberCount: members.length };
}

// Find a stored tag by exact label, or null. Exported for the promotion unit
// test so the idempotency-on-label reuse rule is assertable directly.
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
