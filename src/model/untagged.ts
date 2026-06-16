// untagged: the PURE model for the Tags view's synthetic Untagged bucket and the
// many-to-many tag-tree assembly. A chat falls into Untagged when its EFFECTIVE
// tag set is empty: its stored tags array is empty, OR every tag id it references
// no longer resolves to a real Tag (a dangling reference). This mirrors how
// folderTree.assembleFolderTree routes a chat whose home folderId no longer
// resolves to a real Folder into the synthetic Unfiled bucket: a dangling
// reference is treated as "no membership," never lost.
//
// This module is vscode-free (build contract): no vscode import, no filesystem.
//
// The Untagged tag id is the '__untagged__' sentinel, which is excluded from the
// id factory's mintable space (idFactory.RESERVED_SENTINELS), so a real tag id can
// never collide with it. The view memoizes the Untagged node by this stable id
// across refreshes exactly like a real tag, so it is "recomputed and memoized on
// refresh" (slice 3 plan): the membership is recomputed each assembly, the node
// object is reused by id.

import { Tag } from '../store/schema';
import { ChatOccurrence, makeOccurrence } from './occurrence';

// The Tags-view synthetic bucket for every chat with an empty EFFECTIVE tag set.
// The sentinel mirrors the '__unfiled__' convention and is excluded from the id
// factory's mintable space, so a real tag can never collide with it.
export const UNTAGGED_TAG_ID = '__untagged__';
export const UNTAGGED_LABEL = 'Untagged';

// One node in the assembled Tags tree: a tag (real or the synthetic Untagged
// bucket) and the ordered occurrence wrappers of the chats under it. The Untagged
// node is represented with id UNTAGGED_TAG_ID and a null tag record.
export interface TagNode {
  id: string;
  label: string;
  // The stored Tag this node renders, or null for the synthetic Untagged node.
  tag: Tag | null;
  // Whether this is the synthetic Untagged bucket.
  synthetic: boolean;
  // The occurrence wrappers of the chats assigned to this tag. Each wrapper has a
  // tree-wide-unique composite id and dereferences one shared ChatRecord.
  occurrences: ChatOccurrence[];
}

// Inputs to a tag-tree assembly: the flat tag map (ProjectMeta.tags) plus each
// chat's stored tag-id list. chatTags maps a sessionId to its ChatMeta.tags
// array (absent => no tags). Only chats present in chatTags are placed; the caller
// supplies the set of known sessionIds it wants rendered.
export interface AssembleTagsInput {
  tags: { [id: string]: Tag };
  // sessionId -> the chat's stored tag-id list (absent/empty => Untagged).
  chatTags: { [chatId: string]: string[] | undefined };
}

// The assembled Tags tree: the ordered real tag nodes followed by the Untagged
// node. The Untagged node is always present in the model (the view may hide it
// when empty); it is appended LAST so real tags sort above it.
export interface AssembledTagsTree {
  tags: TagNode[];
  untagged: TagNode;
}

// Resolve a chat's EFFECTIVE tag set: the subset of its stored tag ids that still
// resolve to a real Tag in `tags`, de-duplicated and order-preserving. A stored id
// that no longer resolves (a dangling reference, e.g. the tag was deleted on
// another machine and the chat record has not been reconciled yet) is dropped.
// When the result is empty the chat is Untagged. Exported so the membership rule
// is unit-testable directly and so the provider and tests share one definition.
export function effectiveTagIds(
  tags: { [id: string]: Tag },
  storedTagIds: string[] | undefined,
): string[] {
  if (storedTagIds === undefined) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tagId of storedTagIds) {
    if (Object.prototype.hasOwnProperty.call(tags, tagId) && !seen.has(tagId)) {
      seen.add(tagId);
      result.push(tagId);
    }
  }
  return result;
}

// True when a chat's EFFECTIVE tag set is empty (stored tags empty OR every
// referenced id dangling), i.e. the chat belongs in the Untagged bucket. This is
// the membership predicate the "Untagged membership equals the empty-tags set"
// acceptance test asserts against the RESOLVED tag set, including the dangling-id
// case.
export function isUntagged(
  tags: { [id: string]: Tag },
  storedTagIds: string[] | undefined,
): boolean {
  return effectiveTagIds(tags, storedTagIds).length === 0;
}

// MANY-TO-MANY INVARIANT: a chat appears once under EACH tag in its effective set,
// each appearance a distinct occurrence wrapper with a tree-wide-unique composite
// id. A chat with an empty effective set appears exactly once, under Untagged. No
// chat is dropped, and no occurrence is shared across two tags.
//
// The Untagged membership is RECOMPUTED here on every assembly (the plan's
// "recomputed ... on refresh"); the view memoizes the node objects by id across
// refreshes (the plan's "memoized").
export function assembleTagsTree(input: AssembleTagsInput): AssembledTagsTree {
  const { tags, chatTags } = input;

  const nodesById = new Map<string, TagNode>();
  const order: string[] = [];
  for (const tag of Object.values(tags)) {
    nodesById.set(tag.id, {
      id: tag.id,
      label: tag.label,
      tag,
      synthetic: false,
      occurrences: [],
    });
    order.push(tag.id);
  }

  const untagged: TagNode = {
    id: UNTAGGED_TAG_ID,
    label: UNTAGGED_LABEL,
    tag: null,
    synthetic: true,
    occurrences: [],
  };

  // Place each chat once per tag in its effective set, or once under Untagged when
  // that set is empty. A dangling tag id contributes no occurrence (it does not
  // resolve to a node), so a chat whose tags are ALL dangling lands in Untagged.
  for (const [chatId, storedTagIds] of Object.entries(chatTags)) {
    const effective = effectiveTagIds(tags, storedTagIds);
    if (effective.length === 0) {
      untagged.occurrences.push(makeOccurrence(untagged.id, chatId));
      continue;
    }
    for (const tagId of effective) {
      const node = nodesById.get(tagId);
      if (node !== undefined) {
        node.occurrences.push(makeOccurrence(tagId, chatId));
      }
    }
  }

  // Sort real tags by label (case-insensitive, stable), then append Untagged last.
  const tagNodes = order
    .map((id) => nodesById.get(id) as TagNode)
    .sort((a, b) => a.label.localeCompare(b.label));

  return { tags: tagNodes, untagged };
}

// True when a tag id names the synthetic Untagged bucket.
export function isUntaggedId(tagId: string): boolean {
  return tagId === UNTAGGED_TAG_ID;
}
