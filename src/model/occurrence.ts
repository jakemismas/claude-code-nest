// occurrence: the PURE model behind the Tags view's many-to-many membership. A
// chat carries a SET of tag ids, so the same chat appears once under EACH tag it
// is assigned to. Each on-screen appearance is a distinct ChatOccurrence wrapper
// with its own tree-wide-unique composite id `${tagId}:${chatId}`; every wrapper
// dereferences ONE shared ChatRecord (never the bare record under two parents),
// and getParent recovers the single owning tag from the wrapper's id.
//
// This module is vscode-free (build contract): no vscode import, no filesystem.
// The view layer (tagsProvider.ts) turns a ChatOccurrence into a TreeItem and
// memoizes the node object; this module produces only plain data and the grammar.
//
// Composite-id grammar (ARCHITECTURE.md "Tree and VSCode API binding rules"):
//   tag occurrence id = `${tagId}:${chatId}`
// tagId is separator-free (minted by idFactory.mintTagId or the '__untagged__'
// sentinel) and chatId is a separator-free UUID, so the id splits unambiguously
// on the FIRST ':' back to its owning tag id. getParent recovers exactly that one
// owning tag (one parent per node, ARCHITECTURE.md line 100).

const TAG_OCCURRENCE_SEPARATOR = ':';

// A single occurrence of a chat under one tag: the owning tag id plus the chat's
// sessionId. The wrapper is intentionally tiny (two ids); the shared ChatRecord
// is dereferenced by sessionId at the view layer through a records map, so a
// wrapper never embeds or duplicates the record. id is the tree-wide-unique
// composite the view sets on its TreeItem.
export interface ChatOccurrence {
  // The owning tag id (a real tag id, or the '__untagged__' sentinel).
  tagId: string;
  // The chat's sessionId (the shared ChatRecord key).
  chatId: string;
  // The composite node id `${tagId}:${chatId}`, unique tree-wide because the
  // (tagId, chatId) pair is unique: a chat appears at most once per tag.
  id: string;
}

// Build the composite occurrence id for a chat under a tag: `${tagId}:${chatId}`.
// Used for BOTH real tags and the synthetic Untagged bucket (tagId ===
// '__untagged__').
export function tagOccurrenceId(tagId: string, chatId: string): string {
  return tagId + TAG_OCCURRENCE_SEPARATOR + chatId;
}

// Construct a ChatOccurrence wrapper for a chat under a tag. The wrapper holds
// only the two ids and the composite id; the shared ChatRecord is resolved by the
// caller from chatId, so one record is never copied across the many occurrences
// that reference it.
export function makeOccurrence(tagId: string, chatId: string): ChatOccurrence {
  return { tagId, chatId, id: tagOccurrenceId(tagId, chatId) };
}

// Recover the owning tag id and chat id from an occurrence node id by splitting on
// the FIRST ':'. tagId is separator-free (factory-minted or the '__untagged__'
// sentinel) so the first ':' is always the grammar separator; chatId is a
// separator-free UUID so the remainder is the whole chat id. Returns null for a
// value that is not a well-formed occurrence id (no separator, or an empty tag or
// chat side). This is the PURE half of the provider's getParent: it yields the one
// owning tag id, which the view turns into the single parent TreeItem.
export function parseTagOccurrenceId(
  nodeId: string,
): { tagId: string; chatId: string } | null {
  const idx = nodeId.indexOf(TAG_OCCURRENCE_SEPARATOR);
  if (idx <= 0 || idx === nodeId.length - 1) {
    return null;
  }
  return {
    tagId: nodeId.slice(0, idx),
    chatId: nodeId.slice(idx + 1),
  };
}

// Node-object memoization reuse rule for an occurrence node (the PURE half of the
// provider's occurrenceItemFor). VSCode caches tree elements by object reference,
// so a refresh must REUSE the existing wrapper's TreeItem for an unchanged id
// rather than return a fresh object with the same id, or reveal and selection
// break (ARCHITECTURE.md "Memoize node objects by id across refreshes"). An
// occurrence's RENDERED content is the shared chat's title + timestamp, so a
// cached node may be reused only when both still match the current record (mirrors
// folderTree.canReuseChatMemberItem). timestamp is number | null, so the
// comparison treats null === null as unchanged.
export function canReuseOccurrenceItem(
  cached: { title: string; timestamp: number | null } | undefined,
  current: { title: string; timestamp: number | null },
): boolean {
  return (
    cached !== undefined &&
    cached.title === current.title &&
    cached.timestamp === current.timestamp
  );
}

// Generic memoize-by-id step (the PURE core of every *ItemFor in the providers).
// VSCode caches tree elements by object REFERENCE, so a refresh must return the
// SAME object for an unchanged id; this helper centralizes that rule so it can be
// unit-tested for object identity without the vscode host. It returns the cached
// node when canReuse(cached) is true, otherwise builds a fresh one, stores it by
// id, and returns it. cache is the provider's id -> node Map; the provider holds
// the real (vscode-bound) TreeItem objects but the reuse-vs-rebuild decision and
// the store-back live here.
export function memoizeById<T>(
  cache: Map<string, T>,
  id: string,
  canReuse: (cached: T | undefined) => boolean,
  build: () => T,
): T {
  const existing = cache.get(id);
  if (existing !== undefined && canReuse(existing)) {
    return existing;
  }
  const fresh = build();
  cache.set(id, fresh);
  return fresh;
}
