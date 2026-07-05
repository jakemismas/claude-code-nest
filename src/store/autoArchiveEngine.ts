import { ChatMessageBody } from '../claude/bodyReader';
import { decideAutoArchive } from './autoArchivePolicy';

// The auto-archive ENGINE (slice s3b-settings-overlay, issue #86 AC #4/#5). It runs
// a BATCHED pass over the workspace's scanned chats: for each chat the PURE
// autoArchivePolicy.decideAutoArchive says to archive, it flips the synced
// userArchived flag AND writes a Nest-owned body copy; for each starred chat the
// policy says to protectively copy, it writes the body copy only (never archiving a
// starred chat). All flag flips are staged first and coalesced into ONE store flush
// (refresh coalescing, ARCHITECTURE.md), then the caller refreshes once.
//
// This module is a thin ORCHESTRATOR over injected seams (mirroring
// curationCommands / archiveBodyStore's caller shape), so it is exercised headlessly
// without vscode: the store mutation, the body read, the body write, the copy-exists
// check, and the clock are all injected. The DECISION is the pure policy; this module
// only sequences the seams the decision selects.
//
// READ-ONLY INVARIANT: the only transcript contact is the injected readBody
// (bodyReader.readTranscriptBodies, read-only) to source the copy; the copy is
// written to globalStorage via the injected writeBody seam (archiveBodyStore ->
// exportIO, guarded). Nothing here writes, renames, moves, or deletes anything under
// ~/.claude/projects, and NO new fs write path is added: the write reuses
// store.setChatArchived + archiveBodyStore.writeArchivedBody exactly as the
// interactive archive command does.

// The minimal per-chat identity the engine needs from the scan: a sessionId, the
// transcript path to read the body from, the resolved title to stamp on the copy,
// the last-activity epoch ms (ChatRecord.timestamp), and the synced curation flags
// (starred / archived) read from ProjectMeta at the call site.
export interface AutoArchiveChat {
  sessionId: string;
  filePath: string;
  title: string;
  lastActivity: number | null;
  starred: boolean;
  archived: boolean;
}

export interface AutoArchiveEngineDeps {
  // Stage the synced userArchived flag for one chat (store.setChatArchived, which
  // stamps archivedAt coupled to the flag). Staged for every chat the policy
  // archives; the caller flushes ONCE after the loop so the writes coalesce.
  setArchived: (sessionId: string) => void;
  // Persist the pending store writes once (store.flush). Awaited after all flags are
  // staged so a single flush covers the whole batch.
  flush: () => Promise<void>;
  // Read one chat's full body for the copy (bodyReader.readTranscriptBodies,
  // read-only). Returns the ordered bodies, [] when unreadable.
  readBody: (filePath: string) => ChatMessageBody[];
  // Write the Nest-owned body copy (archiveBodyStore.writeArchivedBody). Returns true
  // on success; best-effort (a false result does not undo the archive flag).
  writeBody: (envelope: {
    sessionId: string;
    title: string;
    archivedAt: number;
    starred: boolean;
    bodies: ChatMessageBody[];
  }) => Promise<boolean>;
  // Whether a Nest-owned body copy already exists for a chat
  // (archiveBodyStore.hasArchivedBody), so a starred protective copy is written at
  // most once and the pass is idempotent.
  hasBody: (sessionId: string) => Promise<boolean>;
  // Read the store-stamped archivedAt for a chat AFTER setArchived + flush, so the
  // copy's archivedAt agrees with the synced scalar (the store stamps with its own
  // clock, so read it back rather than guessing). Returns null when unavailable
  // (then the copy falls back to `now`).
  getArchivedAt: (sessionId: string) => number | null;
  // Injected clock (epoch ms), threaded into the pure decision and used as the copy
  // fallback archivedAt. Defaults to Date.now in the wiring; a test supplies a fixed
  // value so the boundary cases are deterministic.
  now: () => number;
}

// The result of one auto-archive pass, for the caller's first-run notification and
// for the test to assert. archived is the count of chats newly userArchived;
// protectiveCopies is the count of starred chats that received a protective copy
// without being archived. changed is true when the pass staged any store write, so
// the caller only flushes + refreshes + notifies when something actually happened.
export interface AutoArchiveResult {
  archived: number;
  protectiveCopies: number;
  changed: boolean;
}

// Run one batched auto-archive pass over the supplied chats.
//
// TWO windows (AC #4 vs AC #5):
//   - archiveWindowDays: the user's chosen auto-archive window. An UNSTARRED chat older
//     than this is archived. <= 0 (Never) disables archiving.
//   - protectiveWindowDays: the effective Claude cleanup age. A STARRED chat older than
//     this receives a protective body copy (once), WITHOUT being archived. This is
//     INDEPENDENT of archiveWindowDays, so a user who sets auto-archiving to "Never"
//     still keeps their starred chats safe from Claude's cleanup (AC #5). The pass does
//     NOT short-circuit on archiveWindowDays <= 0: the protective-copy work still runs.
//
// For each chat: decideAutoArchive over its inputs.
//   - 'archive': stage setArchived (staged now, flushed once after the loop) and mark
//     it for a body copy.
//   - 'copy': mark a starred chat for a protective copy without archiving.
//   - 'none': skip.
// After the loop the flags are flushed ONCE, then the marked body copies are written
// (each reads the transcript body once on demand and discards it). The copy for an
// archived chat carries the store-stamped archivedAt; the protective copy for a
// starred chat carries `now` (it is not archived, so there is no stamped archivedAt).
// Best-effort throughout: a per-chat body read/write failure is swallowed so one bad
// transcript never aborts the pass, and the synced flag (authoritative for
// membership) still flips even if its copy fails.
export async function runAutoArchivePass(
  deps: AutoArchiveEngineDeps,
  chats: AutoArchiveChat[],
  archiveWindowDays: number,
  protectiveWindowDays: number,
): Promise<AutoArchiveResult> {
  const now = deps.now();
  // Both windows disabled (or non-positive): nothing to do. Note we do NOT short on
  // archiveWindowDays alone, because a positive protectiveWindowDays must still run the
  // starred protective-copy pass even when auto-archiving is "Never".
  if (archiveWindowDays <= 0 && protectiveWindowDays <= 0) {
    return { archived: 0, protectiveCopies: 0, changed: false };
  }

  const toArchive: AutoArchiveChat[] = [];
  const toCopyStarred: AutoArchiveChat[] = [];

  for (const chat of chats) {
    // hasCopy is only consulted by the policy for the starred-'copy' branch, so
    // resolve it lazily: an unstarred past-window chat archives regardless of a copy,
    // and a within-window chat is 'none' regardless. Checking every chat's copy would
    // be an unnecessary read per chat.
    let decision = decideAutoArchive({
      lastActivity: chat.lastActivity,
      starred: chat.starred,
      archived: chat.archived,
      hasCopy: false,
      archiveWindowDays,
      protectiveWindowDays,
      now,
    });
    if (decision === 'copy') {
      // Re-run with the real hasCopy so an existing protective copy resolves to
      // 'none' (idempotent).
      const hasCopy = await deps.hasBody(chat.sessionId);
      decision = decideAutoArchive({
        lastActivity: chat.lastActivity,
        starred: chat.starred,
        archived: chat.archived,
        hasCopy,
        archiveWindowDays,
        protectiveWindowDays,
        now,
      });
    }
    if (decision === 'archive') {
      deps.setArchived(chat.sessionId);
      toArchive.push(chat);
    } else if (decision === 'copy') {
      toCopyStarred.push(chat);
    }
  }

  const changed = toArchive.length > 0;
  if (changed) {
    // ONE flush for the whole batch of flag flips (refresh coalescing).
    await deps.flush();
  }

  // Write the body copies after the flush so an archived chat's copy carries the
  // store-stamped archivedAt. Each read is on demand and discarded.
  for (const chat of toArchive) {
    const archivedAt = deps.getArchivedAt(chat.sessionId) ?? now;
    await writeCopy(deps, chat, archivedAt, chat.starred);
  }
  for (const chat of toCopyStarred) {
    // A starred protective copy is NOT archived, so it has no stamped archivedAt; use
    // `now` as the copy's timestamp. starred is true by construction here.
    await writeCopy(deps, chat, now, true);
  }

  return {
    archived: toArchive.length,
    protectiveCopies: toCopyStarred.length,
    changed: changed || toCopyStarred.length > 0,
  };
}

// Read one chat's body and write the Nest-owned copy. Best-effort: a read/write
// failure is swallowed (the copy is durability, not the source of truth).
async function writeCopy(
  deps: AutoArchiveEngineDeps,
  chat: AutoArchiveChat,
  archivedAt: number,
  starred: boolean,
): Promise<void> {
  try {
    const bodies = deps.readBody(chat.filePath);
    await deps.writeBody({
      sessionId: chat.sessionId,
      title: chat.title,
      archivedAt,
      starred,
      bodies,
    });
  } catch {
    // Swallow: one unreadable transcript or storage hiccup must not abort the pass.
  }
}
