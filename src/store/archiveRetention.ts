// The PURE, vscode-free archive keep-window retention policy (Slice 4
// s2-star-archive). It decides, for ONE archived chat's Nest-owned body copy,
// whether to KEEP or PRUNE that copy, from plain data only: {archivedAt,
// starred, keepWindowDays, now}. No clock, no config, no filesystem, no vscode
// access inside it, so the headless unit gate exercises it deterministically and
// the boundary case (now - archivedAt exactly == keepWindowDays * MS_PER_DAY) is
// exact rather than wall-clock dependent (slice patch "RETENTION-POLICY EDGE
// ENCODING").
//
// The keepWindow is read in the vscode-thin layer via
// vscode.workspace.getConfiguration('claudeNest') and passed in here as a plain
// keepWindowDays number, NEVER read from getConfiguration inside this module
// (slice patch "KEEP-WINDOW SETTING MECHANISM": reading config here would break
// the headless gate). The configured enum maps 7/30/90 to those day counts and
// "never" to 0.
//
// Binding rules (slice patch "RETENTION-POLICY EDGE ENCODING"):
// - never-prune sentinel: keepWindowDays <= 0 means NEVER prune (keep all). This
//   is how the "never" setting is encoded, and it also makes a negative or absent
//   day count fail safe toward keeping the copy.
// - STARRED exemption takes precedence over the window: a starred chat's copy is
//   ALWAYS kept, even past the window. Starring is the user's explicit "do not
//   lose this" signal, so it must outrank a time-based prune.
// - A copy with no archivedAt (the timestamp never desyncs from the flag in the
//   store, but a defensive policy must still total) is treated as just-archived
//   and kept (it cannot be proven past-window without a stamp).

// Milliseconds per day. The window is configured in days and compared against an
// epoch-ms age, so the policy converts once here.
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

// The plain inputs the policy decides from. archivedAt is the epoch ms when the
// chat was user-archived (null when unknown); starred is the chat's synced star
// flag; keepWindowDays is the configured window in days (<= 0 means never prune);
// now is the caller-supplied current epoch ms (injected, never read from a clock
// inside the policy).
export interface RetentionInput {
  archivedAt: number | null;
  starred: boolean;
  keepWindowDays: number;
  now: number;
}

// The decision for one archived chat's body copy.
export type RetentionDecision = 'keep' | 'prune';

// Decide keep|prune for one archived chat's Nest-owned body copy. Pure: the
// result depends ONLY on the four inputs, with no clock or config access, so it is
// deterministic and the boundary test (age exactly == window) is exact.
//
// Order of precedence (slice patch):
//   1. STARRED is always kept (exemption outranks the window).
//   2. never-prune sentinel (keepWindowDays <= 0) keeps everything.
//   3. no archivedAt cannot be proven past-window: keep.
//   4. otherwise prune only when the age STRICTLY EXCEEDS the window; an age
//      exactly equal to the window is still within it and kept (the boundary is
//      inclusive of the window edge), matching "7d prunes only PAST-window".
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
  // STRICTLY greater: an age equal to the window edge is kept (the window is
  // inclusive), so "7d prunes only past-window unstarred" holds and the boundary
  // case keeps rather than prunes.
  return age > windowMs ? 'prune' : 'keep';
}

// The default keep-window in days when the setting is absent or unreadable. 30
// days mirrors a sensible Claude cleanup horizon; the vscode-thin layer reads the
// configured value and falls back to this. Kept here so the policy module owns the
// day-count vocabulary, but this is a DEFAULT for the reader, never read inside
// decideRetention.
export const DEFAULT_KEEP_WINDOW_DAYS = 30;

// Coerce a raw configured keep-window value (a number from the settings
// contribution, possibly out of range or the wrong type) into a valid
// keepWindowDays. A non-finite or absent value falls back to the default; a
// value <= 0 is the never-prune sentinel and is preserved as 0. This lives in the
// pure module so both the reader and its test agree on the mapping without
// importing vscode.
export function coerceKeepWindowDays(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return DEFAULT_KEEP_WINDOW_DAYS;
  }
  if (raw <= 0) {
    return 0;
  }
  return Math.floor(raw);
}
