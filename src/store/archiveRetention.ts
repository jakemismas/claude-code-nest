// Pure, vscode-free keep-window policy for the Nest-owned body copy of an archived chat.
// It takes plain data and no clock or config, so the headless unit tests are deterministic.
// Starred chats and keepWindowDays <= 0 (never) always keep; a copy with no archivedAt is kept.

// Milliseconds per day, for comparing an epoch-ms age against a window in days.
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

// archivedAt is epoch ms when the chat was archived (null when unknown); keepWindowDays <= 0 means
// never prune; now is injected so the policy never reads a clock.
export interface RetentionInput {
  archivedAt: number | null;
  starred: boolean;
  keepWindowDays: number;
  now: number;
}

export type RetentionDecision = 'keep' | 'prune';

// Decides keep or prune from the four inputs only, so the boundary case (age exactly equal to the
// window keeps) is exact. Starred, never-prune and missing archivedAt all keep.
export function decideRetention(input: RetentionInput): RetentionDecision {
  if (input.starred) {
    return 'keep';
  }
  if (input.keepWindowDays <= 0) {
    return 'keep';
  }
  if (input.archivedAt === null) {
    return 'keep';
  }
  const age = input.now - input.archivedAt;
  const windowMs = input.keepWindowDays * MS_PER_DAY;
  // Strictly greater: an age equal to the window edge is still kept.
  return age > windowMs ? 'prune' : 'keep';
}

// Default keep-window in days when the setting is absent or unreadable.
export const DEFAULT_KEEP_WINDOW_DAYS = 30;

// Coerces a raw configured value to keepWindowDays: a non-finite value falls back to the default, and a
// value <= 0 becomes the never-prune sentinel 0.
export function coerceKeepWindowDays(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return DEFAULT_KEEP_WINDOW_DAYS;
  }
  if (raw <= 0) {
    return 0;
  }
  return Math.floor(raw);
}
