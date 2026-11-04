// Pure, vscode-free auto-archive policy for one live chat: archive it, write a protective copy for a
// starred chat, or do nothing. It uses plain data and no clock or config, so unit tests are deterministic.
// This window is separate from archiveRetention, which prunes copies of chats that are already archived.

// Milliseconds per day. Kept local so this window stays independent of archiveRetention.
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

// lastActivity is the chat's latest transcript turn in epoch ms (null when untimestamped).
// protectiveWindowDays is independent of archiveWindowDays so choosing Never for auto-archive does not
// disable the starred copy, which is the chat's only durable form after Claude cleans up the transcript.
// restoredAt is the last deliberate restore; it counts as activity for archiving but not for the copy.
export interface AutoArchiveInput {
  lastActivity: number | null;
  starred: boolean;
  archived: boolean;
  hasCopy: boolean;
  archiveWindowDays: number;
  protectiveWindowDays: number;
  now: number;
  restoredAt?: number | null;
}

// 'archive' flips userArchived and writes a body copy; 'copy' writes a protective copy without
// archiving; 'none' leaves the chat untouched.
export type AutoArchiveDecision = 'archive' | 'copy' | 'none';

// True when age strictly exceeds windowDays. A window <= 0 or a null age is never past.
function isPastWindow(lastActivity: number | null, windowDays: number, now: number): boolean {
  if (windowDays <= 0 || lastActivity === null) {
    return false;
  }
  return now - lastActivity > windowDays * MS_PER_DAY;
}

// Decides the action for one live chat from the inputs only. Archived chats get 'none'. Starred chats
// get 'copy' once past the protective window and 'none' otherwise. Unstarred chats get 'archive' once
// past the archive window, counting a deliberate restore as activity.
export function decideAutoArchive(input: AutoArchiveInput): AutoArchiveDecision {
  if (input.archived) {
    return 'none';
  }
  if (input.starred) {
    // A starred chat is never archived. Its protective copy keys off transcript age, so restoredAt
    // does not delay it.
    if (input.hasCopy) {
      return 'none';
    }
    return isPastWindow(input.lastActivity, input.protectiveWindowDays, input.now)
      ? 'copy'
      : 'none';
  }
  // A deliberate restore counts as activity so the chat stays live for a full window after it.
  // restoredAt never stands in for a missing transcript timestamp.
  const restoredAt = typeof input.restoredAt === 'number' ? input.restoredAt : null;
  const archiveActivity =
    input.lastActivity === null
      ? null
      : restoredAt === null
        ? input.lastActivity
        : Math.max(input.lastActivity, restoredAt);
  return isPastWindow(archiveActivity, input.archiveWindowDays, input.now)
    ? 'archive'
    : 'none';
}

// Allowed auto-archive windows in days, in the order the settings select renders them. 0 is Never.
export const AUTO_ARCHIVE_WINDOW_DAYS = [7, 14, 30, 90, 365, 0] as const;

// Coerces a persisted window value (number, or string from the webview) to an allowed day count.
// An absent or disallowed value falls back to effectiveDefault; 0 is the Never sentinel.
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
  // A non-positive effective default fails safe toward the Never sentinel (0).
  return effectiveDefault > 0 ? effectiveDefault : 0;
}
