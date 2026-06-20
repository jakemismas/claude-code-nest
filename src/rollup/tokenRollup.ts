import { TokenTotals } from '../model/types';
import { ProjectMeta } from '../store/schema';

// PURE, vscode-free token-cost rollup reducers (Slice 5 s2-export-and-rollup). They
// sum each chat's tier-A tokenTotals by folder and by tag. tokens only, NO USD
// (slice non-goal). The reducer NEVER reads the provider: the caller passes a plain
// {chatId -> TokenTotals} map (surfaced from the provider's full ChatRecords via the
// narrow tokenTotalsByChat seam) plus the ProjectMeta membership, keeping this module
// headless-testable.
//
// THE COUNTING RULE (slice patch "ROLLUP DOUBLE-COUNT RULE", pinned here and asserted
// in tokenRollup.test.ts):
//  - by FOLDER: a chat counts ONCE, in its SINGLE home folder. A chat with no folder
//    (folderId null/absent, or a folderId that no longer resolves) counts in the
//    synthetic UNFILED bucket. Every chat lands in exactly one folder bucket, so the
//    per-folder totals PARTITION the library: summing all folder buckets equals the
//    library total.
//  - by TAG: a chat counts ONCE per EACH of its tags. A chat with no tags counts in
//    the synthetic UNTAGGED bucket. A MULTI-TAG chat adds its full token total to
//    EVERY one of its tag buckets, so the per-tag totals are INTENTIONALLY NOT a
//    partition: summing all tag buckets can EXCEED the library total when chats are
//    multi-tagged. This is by design (a chat's cost is attributable to each of its
//    tags), not a bug; the surface labels the tag rollup so it does not read as one.
//    Only an UNTAGGED chat contributes to the untagged bucket, and an untagged chat
//    has no tag bucket, so the untagged bucket never double-counts.
//
// Token total per chat is the sum of the four trusted tier-A counts (input + output +
// cacheCreation + cacheRead). A chat absent from the token map contributes 0 (it is
// still counted as a member so the bucket's chatCount is honest).

// The synthetic bucket keys for chats with no folder / no tags. These are display
// keys, not stored ids; the surface renders them as "Unfiled" / "Untagged".
export const UNFILED_BUCKET_KEY = '__unfiled__';
export const UNTAGGED_BUCKET_KEY = '__untagged__';

// One rollup row: a bucket (a folder/tag, or the synthetic unfiled/untagged), the
// number of member chats counted into it, and their summed token total.
export interface RollupBucket {
  // The display label (the folder name, the tag label, or "Unfiled"/"Untagged").
  label: string;
  // The number of chats counted into this bucket.
  chatCount: number;
  // The summed token total across this bucket's chats (tokens only).
  tokenTotal: number;
  // True for the synthetic unfiled/untagged bucket so the surface can style it.
  synthetic: boolean;
}

// The full rollup result: the per-bucket rows (sorted by tokenTotal desc, then label
// asc for stability) plus the library-wide totals. libraryTokenTotal is the honest
// partition total (each counted chat once); for the by-tag rollup it can be LESS than
// the sum of the tag buckets when chats are multi-tagged (see the counting rule).
export interface RollupResult {
  buckets: RollupBucket[];
  libraryChatCount: number;
  libraryTokenTotal: number;
}

// The set of chats the rollup ranges over, with their token totals. chatIds is the
// authoritative member set (the scanned chats); tokensByChat supplies each chat's
// tier-A total (a chat absent from the map contributes 0). meta carries the folder
// and tag membership and the folder/tag label resolution. now is unused here (the
// rollup is timeless); kept out of the signature deliberately.
export interface RollupInput {
  chatIds: readonly string[];
  tokensByChat: ReadonlyMap<string, TokenTotals>;
  meta: ProjectMeta;
}

// Roll up token cost by folder. Each chat counts ONCE in its single home folder (or
// the synthetic Unfiled bucket). The per-folder totals partition the library.
export function rollupByFolder(input: RollupInput): RollupResult {
  const buckets = new Map<string, { label: string; chatCount: number; tokenTotal: number; synthetic: boolean }>();
  let libraryTokenTotal = 0;
  let libraryChatCount = 0;

  for (const chatId of input.chatIds) {
    const tokens = totalFor(input.tokensByChat.get(chatId));
    libraryTokenTotal += tokens;
    libraryChatCount++;

    // A folderId that is null/absent OR no longer resolves to a stored folder falls
    // back to the synthetic Unfiled bucket, so every chat lands in exactly one folder
    // bucket and the per-folder totals partition the library.
    const folderKey = resolveFolderKey(input.meta, chatId);
    const resolved = input.meta.folders[folderKey];
    const bucketKey = resolved !== undefined ? folderKey : UNFILED_BUCKET_KEY;
    const isUnfiled = bucketKey === UNFILED_BUCKET_KEY;
    addToBucket(buckets, bucketKey, isUnfiled ? 'Unfiled' : resolved.name, tokens, isUnfiled);
  }

  return finalize(buckets, libraryChatCount, libraryTokenTotal);
}

// Roll up token cost by tag. Each chat counts ONCE per EACH of its tags; an untagged
// chat counts in the synthetic Untagged bucket. The per-tag totals are intentionally
// NOT a partition (a multi-tag chat's tokens add to every tag bucket).
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
    // A multi-tag chat adds its full total to EACH tag bucket. Dedupe the chat's own
    // tag ids first so a chat tagged with the same id twice (malformed data) is not
    // counted twice in the same bucket.
    const seen = new Set<string>();
    for (const tagId of tagIds) {
      if (seen.has(tagId)) {
        continue;
      }
      seen.add(tagId);
      const tag = input.meta.tags[tagId];
      if (tag === undefined) {
        // A tag id that no longer resolves: skip it. If a chat's only tag ids all
        // fail to resolve it is effectively untagged, but it has already been
        // counted into libraryChatCount; it simply contributes to no tag bucket.
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

// The folder bucket KEY for a chat: its stored folderId, or the synthetic unfiled
// sentinel when it has none. (Whether the id resolves to a real folder is decided by
// the caller; a stale id is mapped to Unfiled there.)
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

// Sort buckets by tokenTotal desc, then label asc for a stable, deterministic order.
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
