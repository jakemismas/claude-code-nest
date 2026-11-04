// Pure model for the Tags view's many-to-many membership: one wrapper per chat
// per tag, with composite id `${tagId}:${chatId}`. Has no vscode or filesystem
// dependency so the unit suite can run headless.

const TAG_OCCURRENCE_SEPARATOR = ':';

// One appearance of a chat under a tag. The shared ChatRecord is looked up by
// chatId at the view layer, so the wrapper never copies it.
export interface ChatOccurrence {
  // A real tag id, or the '__untagged__' sentinel.
  tagId: string;
  chatId: string;
  // Unique tree-wide because a chat appears at most once per tag.
  id: string;
}

// Builds the composite occurrence id; also used for the Untagged bucket.
export function tagOccurrenceId(tagId: string, chatId: string): string {
  return tagId + TAG_OCCURRENCE_SEPARATOR + chatId;
}

export function makeOccurrence(tagId: string, chatId: string): ChatOccurrence {
  return { tagId, chatId, id: tagOccurrenceId(tagId, chatId) };
}

// Splits on the FIRST ':' because tag ids never contain one. Returns null when the
// id has no separator or an empty side.
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

// VSCode caches tree elements by object reference, so a refresh must reuse the node
// for an unchanged id. Reuse only when the rendered title and timestamp still match.
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

// VSCode caches tree elements by object reference, so an unchanged id must return the
// same object. Returns the cached node when canReuse allows it, else builds and stores one.
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
