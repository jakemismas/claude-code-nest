// The PURE, vscode-free AUTO-ARCHIVE policy (slice s3b-settings-overlay, issue
// #86). It decides, for ONE live chat, whether the auto-archive engine should
// ARCHIVE it (flip userArchived + write a Nest-owned body copy), write a starred
// PROTECTIVE COPY only (never archiving a starred chat), or do NOTHING. It decides
// from plain data only: {lastActivity, starred, archived, hasCopy, keepWindowDays,
// now}. No clock, no config, no filesystem, no vscode access, so the headless unit
// gate exercises it deterministically and the boundary case (now - lastActivity
// exactly == keepWindowDays * MS_PER_DAY) is exact rather than wall-clock dependent.
//
// TWO DISTINCT WINDOWS (fit patch item 1; DECISIONS.md s3b-settings-overlay Fork 2):
// this module is SEPARATE from src/store/archiveRetention.ts. archiveRetention
// decides keep|prune for an already-archived chat's Nest-owned COPY against
// claudeNest.archiveKeepWindowDays. This module decides auto-archiving of a LIVE
// chat against the NEW auto-archive window (defaulting to the effective Claude
// cleanupPeriodDays). Do NOT conflate them.
//
// The keepWindowDays is read in the vscode-thin layer and passed in as a plain
// number, NEVER read from getConfiguration or workspaceState inside this module
// (reading either here would break the headless gate), mirroring
// archiveRetention.decideRetention.
//
// Binding rules (fit patch item 3, reusing the archiveRetention convention):
// - never sentinel: keepWindowDays <= 0 means NEVER auto-archive (keep all live).
//   This is how the "Never" window is encoded, and it also makes a negative or
//   absent day count fail safe toward leaving the chat live.
// - STARRED exemption: a starred chat is NEVER auto-archived (its live transcript
//   is never touched by the flag flip). It DOES receive a protective body copy once
//   older than the window (AC #5), so a starred chat past the window with no copy
//   yet resolves to 'copy' rather than 'none'; a starred chat that already has a
//   copy resolves to 'none' (idempotent, no re-copy).
// - inclusive boundary: age exactly == window is still within it (kept); age
//   STRICTLY greater triggers, matching decideRetention.
// - a chat with no lastActivity cannot be proven past-window and is left live.
// - an already-archived chat is 'none' (the engine never re-archives; the copy is
//   written by the archive path already).

// Milliseconds per day. The window is configured in days and compared against an
// epoch-ms age, so the policy converts once here. Kept local to this module (not
// imported from archiveRetention) so the two windows stay structurally independent.
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

// The plain inputs the policy decides from for ONE chat.
// - lastActivity: the epoch ms of the chat's most recent user/assistant turn
//   (ChatRecord.timestamp), or null when the transcript carried no timestamped line.
// - starred: the chat's synced star flag.
// - archived: the chat's synced userArchived flag (already archived -> nothing to do).
// - hasCopy: whether a Nest-owned body copy already exists for this chat (so a
//   starred protective copy is written at most once).
// - archiveWindowDays: the AUTO-ARCHIVE window in days for an UNSTARRED chat (<= 0
//   means never auto-archive; the "Never" setting). This is the user's chosen window.
// - protectiveWindowDays: the window in days after which a STARRED chat receives a
//   protective body copy (AC #5: the EFFECTIVE Claude cleanup age, NOT the user's
//   auto-archive window). It is INDEPENDENT of archiveWindowDays so that choosing
//   "Never" (or a longer window) for auto-archiving does NOT disable the starred
//   copy, which is the chat's only durable form after Claude cleans up the transcript.
//   <= 0 disables the protective copy (defensive; the caller supplies the effective
//   cleanup age, which is positive).
// - now: the caller-supplied current epoch ms (injected, never read from a clock).
export interface AutoArchiveInput {
  lastActivity: number | null;
  starred: boolean;
  archived: boolean;
  hasCopy: boolean;
  archiveWindowDays: number;
  protectiveWindowDays: number;
  now: number;
}

// The decision for one chat:
// - 'archive': flip userArchived + write the Nest-owned body copy (unstarred, past the
//   archive window).
// - 'copy': write a protective body copy WITHOUT archiving (starred, past the
//   protective window, no copy yet; AC #5).
// - 'none': leave the chat untouched.
export type AutoArchiveDecision = 'archive' | 'copy' | 'none';

// True when `age` STRICTLY exceeds `windowDays`. Boundary is inclusive of the window
// edge (age exactly == window is NOT past), matching archiveRetention.decideRetention.
// A window <= 0 is never-past (the window is disabled), and a null age cannot be
// proven past.
function isPastWindow(lastActivity: number | null, windowDays: number, now: number): boolean {
  if (windowDays <= 0 || lastActivity === null) {
    return false;
  }
  return now - lastActivity > windowDays * MS_PER_DAY;
}

// Decide the action for one live chat. Pure: the result depends ONLY on the inputs,
// with no clock or config access, so it is deterministic and the boundary test (age
// exactly == window) is exact.
//
// Order of precedence:
//   1. an already-archived chat: 'none' (never re-archive).
//   2. STARRED: never auto-archived. It gets a protective 'copy' ONLY when it is past
//      the PROTECTIVE window (the effective Claude cleanup age, independent of the
//      archive window) AND has no copy yet; else 'none'. This is why choosing "Never"
//      for auto-archiving does not strip a starred chat of its durable copy (AC #5).
//   3. UNSTARRED: 'archive' when past the ARCHIVE window (the user's chosen window,
//      <= 0 = Never = disabled), else 'none'.
export function decideAutoArchive(input: AutoArchiveInput): AutoArchiveDecision {
  if (input.archived) {
    return 'none';
  }
  if (input.starred) {
    // Never auto-archive a starred chat; give it a protective copy once, keyed off the
    // effective Claude cleanup age (protectiveWindowDays), NOT the archive window.
    if (input.hasCopy) {
      return 'none';
    }
    return isPastWindow(input.lastActivity, input.protectiveWindowDays, input.now)
      ? 'copy'
      : 'none';
  }
  return isPastWindow(input.lastActivity, input.archiveWindowDays, input.now)
    ? 'archive'
    : 'none';
}

// The set of allowed auto-archive window values in DAYS, matching the design's
// select (7 / 14 / 30 / 90 / 1 year / Never). 0 is the Never sentinel. Ordered as
// the select renders them so the vscode-thin layer and the webview agree on the
// vocabulary without either importing the other.
export const AUTO_ARCHIVE_WINDOW_DAYS = [7, 14, 30, 90, 365, 0] as const;

// Coerce a raw persisted auto-archive window value (a number, or a string from the
// webview/workspaceState) into a valid keepWindowDays, falling back to the supplied
// effective default (the effective Claude cleanupPeriodDays, 30 when unset) when the
// value is absent or not one of the allowed values. A value of 0 is the Never
// sentinel and is preserved. Pure so the reader and its test agree on the mapping
// without importing vscode.
export function coerceAutoArchiveWindowDays(raw: unknown, effectiveDefault: number): number {
  const asNum =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^\d+$/.test(raw.trim())
        ? Number(raw.trim())
        : NaN;
  if (Number.isFinite(asNum) && (AUTO_ARCHIVE_WINDOW_DAYS as readonly number[]).includes(asNum)) {
    return asNum;
  }
  // An out-of-range or absent value falls back to the effective default; a
  // non-positive effective default fails safe toward the Never sentinel (0).
  return effectiveDefault > 0 ? effectiveDefault : 0;
}
