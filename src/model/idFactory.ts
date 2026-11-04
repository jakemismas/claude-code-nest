// Mints and validates folder and tag ids. Ids must not contain the composite-id
// separators ':' '#' '>' so a composite id splits unambiguously on its FIRST separator:
//   folder member  `${folderId}#${chatId}`
//   tag occurrence `${tagId}:${chatId}`
//   linked child   `${parentChatId}>link>${chatId}`

// A minted id containing any of these is rejected.
export const RESERVED_SEPARATORS = [':', '#', '>'] as const;

// Synthetic-node ids that share the id space with minted ids but are never minted, so a
// real folder or tag cannot collide with a synthetic bucket.
export const RESERVED_SENTINELS = new Set<string>([
  '__unfiled__',
  '__untagged__',
  '__smart_pr__',
  '__smart_ticket__',
  '__smart_branch__',
  '__smart_fork__',
  '__orchestrator__',
  '__past_orchestrators__',
  '__archived__',
  '__queue__',
]);

// True when the id contains none of the reserved separators.
export function isSeparatorFree(id: string): boolean {
  for (const sep of RESERVED_SEPARATORS) {
    if (id.includes(sep)) {
      return false;
    }
  }
  return true;
}

// True for a non-empty, separator-free id that is not a reserved sentinel.
export function isMintableId(id: string): boolean {
  return id.length > 0 && isSeparatorFree(id) && !RESERVED_SENTINELS.has(id);
}

// Throws when the id contains a reserved separator. context names the call site in the
// error.
export function assertSeparatorFree(id: string, context = 'id'): void {
  if (!isSeparatorFree(id)) {
    throw new Error(
      `Nest id-factory: ${context} "${id}" contains a reserved composite-id ` +
        `separator (one of ${RESERVED_SEPARATORS.join(' ')}); ids must be free of ` +
        `all three so composite ids split unambiguously.`,
    );
  }
}

// Throws when the id is not separator-free or is a reserved sentinel.
export function assertMintableId(id: string, context = 'id'): void {
  assertSeparatorFree(id, context);
  if (RESERVED_SENTINELS.has(id)) {
    throw new Error(
      `Nest id-factory: ${context} "${id}" is a reserved synthetic sentinel and ` +
        `must never name a real folder or tag.`,
    );
  }
}

// Retries a bounded number of times, then falls back to a counter and time id.
// prefix ('f' folder, 't' tag) keeps fallback ids distinct across kinds.
function mintId(prefix: string): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = randomId(prefix);
    if (isMintableId(candidate)) {
      return candidate;
    }
  }
  // Defensive: neither generator emits separators, but this function must not throw.
  return sanitize(prefix + '-' + Date.now().toString(36) + '-' + (counter++).toString(36));
}

// Mints a separator-free folder id (a v4 UUID contains no reserved separator).
export function mintFolderId(): string {
  return mintId('f');
}

// Mints a separator-free tag id, so the tag occurrence id splits on its first ':'.
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

// Replaces reserved separators with a hyphen in the last-resort id from mintId.
function sanitize(value: string): string {
  let out = value;
  for (const sep of RESERVED_SEPARATORS) {
    out = out.split(sep).join('-');
  }
  return out;
}
