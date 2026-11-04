import { TokenTotals } from '../model/types';
import { ProjectMeta } from '../store/schema';

// Pure reducers that sum each chat's summary token totals by folder and by tag (tokens only, no USD).
// By folder a chat counts once (no folder or a stale id goes to Unfiled); by tag it counts once per tag, so tag totals can exceed the library total.
// A chat missing from the token map counts as a member with 0 tokens.

// Display keys for the synthetic buckets, rendered as Unfiled and Untagged; not stored ids.
export const UNFILED_BUCKET_KEY = '__unfiled__';
export const UNTAGGED_BUCKET_KEY = '__untagged__';

export interface RollupBucket {
  label: string;
  chatCount: number;
  tokenTotal: number;
  synthetic: boolean;
}

// Rollup rows sorted by token total descending, then label. libraryTokenTotal counts each chat once, so by-tag rows can sum past it.
export interface RollupResult {
  buckets: RollupBucket[];
  libraryChatCount: number;
  libraryTokenTotal: number;
}

// Chats the rollup ranges over: chatIds is the member set, tokensByChat their totals (absent counts 0), meta supplies membership and labels.
export interface RollupInput {
  chatIds: readonly string[];
  tokensByChat: ReadonlyMap<string, TokenTotals>;
  meta: ProjectMeta;
}

// Roll up by folder: each chat counts once, in its home folder or Unfiled.
export function rollupByFolder(input: RollupInput): RollupResult {
  const buckets = new Map<string, { label: string; chatCount: number; tokenTotal: number; synthetic: boolean }>();
  let libraryTokenTotal = 0;
  let libraryChatCount = 0;

  for (const chatId of input.chatIds) {
    const tokens = totalFor(input.tokensByChat.get(chatId));
    libraryTokenTotal += tokens;
    libraryChatCount++;

    // A null or unresolvable folderId falls back to Unfiled.
    const folderKey = resolveFolderKey(input.meta, chatId);
    const resolved = input.meta.folders[folderKey];
    const bucketKey = resolved !== undefined ? folderKey : UNFILED_BUCKET_KEY;
    const isUnfiled = bucketKey === UNFILED_BUCKET_KEY;
    addToBucket(buckets, bucketKey, isUnfiled ? 'Unfiled' : resolved.name, tokens, isUnfiled);
  }

  return finalize(buckets, libraryChatCount, libraryTokenTotal);
}

// Roll up by tag: a chat counts once per tag, and an untagged chat in Untagged.
export function rollupByTag(input: RollupInput): RollupResult {
  const buckets = new Map<string, { label: string; chatCount: number; tokenTotal: number; synthetic: boolean }>();
  let libraryTokenTotal = 0;
  let libraryChatCount = 0;

  for (const chatId of input.chatIds) {
    const tokens = totalFor(input.tokensByChat.get(chatId));
    libraryTokenTotal += tokens;
    libraryChatCount++;

    const tagIds = resolveTagIds(input.meta, chatId);
    if (tagIds.length === 0) {
      addToBucket(buckets, UNTAGGED_BUCKET_KEY, 'Untagged', tokens, true);
      continue;
    }
    // Dedupe the chat's tag ids so a repeated id does not double-count in one bucket.
    const seen = new Set<string>();
    for (const tagId of tagIds) {
      if (seen.has(tagId)) {
        continue;
      }
      seen.add(tagId);
      const tag = input.meta.tags[tagId];
      if (tag === undefined) {
        // Skip a tag id that no longer resolves.
        continue;
      }
      addToBucket(buckets, tagId, tag.label, tokens, false);
    }
  }

  return finalize(buckets, libraryChatCount, libraryTokenTotal);
}

// ---- internals ----

function totalFor(totals: TokenTotals | undefined): number {
  if (totals === undefined) {
    return 0;
  }
  return totals.input + totals.output + totals.cacheCreation + totals.cacheRead;
}

// The folder bucket key: the stored folderId, or the unfiled sentinel; the caller maps stale ids to Unfiled.
function resolveFolderKey(meta: ProjectMeta, chatId: string): string {
  const chat = meta.chats[chatId];
  const folderId = chat ? chat.folderId : null;
  if (folderId === null || folderId === undefined) {
    return UNFILED_BUCKET_KEY;
  }
  return folderId;
}

function resolveTagIds(meta: ProjectMeta, chatId: string): string[] {
  const chat = meta.chats[chatId];
  if (chat === undefined || !Array.isArray(chat.tags)) {
    return [];
  }
  return chat.tags;
}

function addToBucket(
  buckets: Map<string, { label: string; chatCount: number; tokenTotal: number; synthetic: boolean }>,
  key: string,
  label: string,
  tokens: number,
  synthetic: boolean,
): void {
  const existing = buckets.get(key);
  if (existing === undefined) {
    buckets.set(key, { label, chatCount: 1, tokenTotal: tokens, synthetic });
    return;
  }
  existing.chatCount++;
  existing.tokenTotal += tokens;
}

// Sort by token total descending, then label, for a deterministic order.
function finalize(
  buckets: Map<string, { label: string; chatCount: number; tokenTotal: number; synthetic: boolean }>,
  libraryChatCount: number,
  libraryTokenTotal: number,
): RollupResult {
  const rows: RollupBucket[] = Array.from(buckets.values()).map((b) => ({
    label: b.label,
    chatCount: b.chatCount,
    tokenTotal: b.tokenTotal,
    synthetic: b.synthetic,
  }));
  rows.sort((a, b) => {
    if (b.tokenTotal !== a.tokenTotal) {
      return b.tokenTotal - a.tokenTotal;
    }
    return a.label.localeCompare(b.label);
  });
  return { buckets: rows, libraryChatCount, libraryTokenTotal };
}
