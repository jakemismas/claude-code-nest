// Pure model for the Tags view's Untagged bucket and many-to-many tag tree assembly.
// A chat is Untagged when none of its stored tag ids resolves to a real Tag; a dangling
// reference counts as no membership, never as a lost chat.

import { Tag } from '../store/schema';
import { ChatOccurrence, makeOccurrence } from './occurrence';

// Sentinel for the Untagged bucket; it is outside the id factory's mintable space.
export const UNTAGGED_TAG_ID = '__untagged__';
export const UNTAGGED_LABEL = 'Untagged';

// One tag (real or the synthetic Untagged bucket) with its ordered chat occurrences.
export interface TagNode {
  id: string;
  label: string;
  // The stored Tag this node renders, or null for the synthetic Untagged node.
  tag: Tag | null;
  // Whether this is the synthetic Untagged bucket.
  synthetic: boolean;
  // Each wrapper has a tree-wide-unique id and points at one shared ChatRecord.
  occurrences: ChatOccurrence[];
}

// Inputs to tag tree assembly: the flat tag map plus each chat's stored tag ids.
export interface AssembleTagsInput {
  tags: { [id: string]: Tag };
  // sessionId to stored tag ids; absent or empty means Untagged.
  chatTags: { [chatId: string]: string[] | undefined };
}

// Real tag nodes sorted by label, then the Untagged node, which is always present so
// the view can hide it when empty.
export interface AssembledTagsTree {
  tags: TagNode[];
  untagged: TagNode;
}

// Stored tag ids that still resolve to a real Tag, deduplicated and in order. A
// dangling id (for example a tag deleted on another machine) is dropped.
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

// True when the chat's effective tag set is empty.
export function isUntagged(
  tags: { [id: string]: Tag },
  storedTagIds: string[] | undefined,
): boolean {
  return effectiveTagIds(tags, storedTagIds).length === 0;
}

// A chat appears once under each tag in its effective set, and once under Untagged
// when that set is empty. Membership is recomputed on every assembly.
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

  // A dangling tag id adds no occurrence, so a chat whose tags are all dangling lands in
  // Untagged.
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

  // Sort by label, case-insensitive; Untagged stays outside the sort.
  const tagNodes = order
    .map((id) => nodesById.get(id) as TagNode)
    .sort((a, b) => a.label.localeCompare(b.label));

  return { tags: tagNodes, untagged };
}

// True when a tag id names the synthetic Untagged bucket.
export function isUntaggedId(tagId: string): boolean {
  return tagId === UNTAGGED_TAG_ID;
}
