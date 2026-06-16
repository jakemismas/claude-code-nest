// The id factory: the single place folder ids (and any future minted id) are
// generated and validated. ARCHITECTURE.md "Separator-namespace discipline"
// mandates that tag, folder, and chat ids be free of the three composite-id
// separators ':' '#' '>', and that the rule be "enforced in the id factory".
// Slice 2 is the first slice to MINT folder ids, so the factory lands here.
//
// This module is PURE and vscode-free (build contract): no vscode import, no
// filesystem. The runtime entropy is crypto.randomUUID (always present in the
// VSCode 1.66 Electron runtime, mirroring deviceId.ts) with a separator-free
// fallback so the module never throws.
//
// Reserved separators (the composite-id grammar from ARCHITECTURE.md):
//   folder member id   `${folderId}#${chatId}`
//   tag occurrence id  `${tagId}:${chatId}`
//   linked-child id    `${parentChatId}>link>${chatId}`
// A minted id must contain none of ':' '#' '>' so a composite id always splits
// unambiguously on the FIRST separator back to its owning component id.

// The three reserved composite-id separators. A minted id is rejected if it
// contains any of these.
export const RESERVED_SEPARATORS = [':', '#', '>'] as const;

// Synthetic-node sentinels that live in the same id-space as minted ids but are
// NOT mintable. A real folder id must never collide with one of these, or a
// synthetic bucket and a real folder would share a composite-id prefix.
// '__unfiled__' is the Folders-view Unfiled bucket (this slice); '__untagged__'
// is the Tags-view Untagged bucket (slice 3). Both are separator-free by
// construction, so they cannot collide on the separator rule alone; this set is
// the second guard that keeps the factory from ever minting one.
export const RESERVED_SENTINELS = new Set<string>(['__unfiled__', '__untagged__']);

// True when a candidate id is free of every reserved separator. The check covers
// all three separators, not just one, so a value is valid only if it can never be
// misread when embedded in any composite id.
export function isSeparatorFree(id: string): boolean {
  for (const sep of RESERVED_SEPARATORS) {
    if (id.includes(sep)) {
      return false;
    }
  }
  return true;
}

// True when an id is a legal minted id: non-empty, separator-free, and not one of
// the reserved synthetic sentinels.
export function isMintableId(id: string): boolean {
  return id.length > 0 && isSeparatorFree(id) && !RESERVED_SENTINELS.has(id);
}

// Assert a candidate id is separator-free, throwing a descriptive error otherwise.
// This is the enforcement seam ARCHITECTURE.md points at: every mint runs through
// it, and callers that accept an externally supplied id (e.g. a migrated store)
// can run it too. context names the call site for the error message.
export function assertSeparatorFree(id: string, context = 'id'): void {
  if (!isSeparatorFree(id)) {
    throw new Error(
      `Nest id-factory: ${context} "${id}" contains a reserved composite-id ` +
        `separator (one of ${RESERVED_SEPARATORS.join(' ')}); ids must be free of ` +
        `all three so composite ids split unambiguously.`,
    );
  }
}

// Assert a candidate id is a legal minted id (separator-free AND not a reserved
// sentinel), throwing otherwise. Used to validate a minted or externally-supplied
// id before it is allowed to name a real folder/tag.
export function assertMintableId(id: string, context = 'id'): void {
  assertSeparatorFree(id, context);
  if (RESERVED_SENTINELS.has(id)) {
    throw new Error(
      `Nest id-factory: ${context} "${id}" is a reserved synthetic sentinel and ` +
        `must never name a real folder or tag.`,
    );
  }
}

// Mint a fresh, separator-free id with a bounded retry on the (vanishingly
// unlikely) chance an entropy source yields a non-mintable value, falling back to
// a guaranteed-legal counter+time id. prefix names the last-resort fallback id's
// kind ('f' folder, 't' tag) so a fallback collision across kinds is impossible;
// the UUID path is identical for every kind, which is correct because all minted
// ids share one separator-free namespace (ARCHITECTURE.md "Separator-namespace
// discipline" governs folder, tag, AND chat ids together).
function mintId(prefix: string): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = randomId(prefix);
    if (isMintableId(candidate)) {
      return candidate;
    }
  }
  // Unreachable with the UUID/fallback generators (both are separator-free), but
  // a total function never throws on its own entropy: derive a guaranteed-legal
  // id from a counter + time, stripped of any reserved separator.
  return sanitize(prefix + '-' + Date.now().toString(36) + '-' + (counter++).toString(36));
}

// Mint a fresh, separator-free folder id. A v4 UUID from crypto.randomUUID is
// hyphen-delimited hex with no reserved separator, so it is mintable by
// construction; the post-mint guard is defense-in-depth in case a future entropy
// source is swapped in.
export function mintFolderId(): string {
  return mintId('f');
}

// Mint a fresh, separator-free tag id (slice 3). Shares the same separator-free
// namespace and post-mint guard as a folder id: the create-tag command mints
// through here so a tag id can never carry ':' '#' '>' (or a reserved sentinel
// like '__untagged__'), which is what lets the tag-occurrence composite id
// `${tagId}:${chatId}` split unambiguously on the FIRST ':'.
export function mintTagId(): string {
  return mintId('t');
}

let counter = 0;

function randomId(prefix: string): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  return fallbackId(prefix);
}

function fallbackId(prefix: string): string {
  const time = Date.now().toString(16);
  let rand = '';
  for (let i = 0; i < 24; i++) {
    rand += Math.floor(Math.random() * 16).toString(16);
  }
  return prefix + '-' + time + '-' + rand;
}

// Replace any reserved separator with a hyphen. Only used by the unreachable
// last-resort branch in mintFolderId; kept tiny and total.
function sanitize(value: string): string {
  let out = value;
  for (const sep of RESERVED_SEPARATORS) {
    out = out.split(sep).join('-');
  }
  return out;
}
