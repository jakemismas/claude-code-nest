// Batched auto-archive pass: applies autoArchivePolicy to scanned chats through injected seams, so it runs without vscode.
// The only transcript contact is a read-only body read; copies are written through the injected writer.
import { ChatMessageBody } from '../claude/bodyReader';
import { decideAutoArchive } from './autoArchivePolicy';

// Per-chat input for the pass: scan identity plus the synced curation flags.
export interface AutoArchiveChat {
  sessionId: string;
  filePath: string;
  title: string;
  lastActivity: number | null;
  starred: boolean;
  archived: boolean;
  // Last deliberate restore; counts as activity so the next pass does not re-archive the chat.
  restoredAt?: number | null;
}

export interface AutoArchiveEngineDeps {
  // Stage the synced userArchived flag for one chat; flushed once after the loop.
  setArchived: (sessionId: string) => void;
  // Persist pending store writes once, after all flags are staged.
  flush: () => Promise<void>;
  // Read one chat's full body for the copy; [] when unreadable.
  readBody: (filePath: string) => ChatMessageBody[];
  // Write the body copy; false on failure, which does not undo the archive flag.
  writeBody: (envelope: {
    sessionId: string;
    title: string;
    archivedAt: number;
    starred: boolean;
    bodies: ChatMessageBody[];
  }) => Promise<boolean>;
  // Whether a copy already exists, so a starred protective copy is written once.
  hasBody: (sessionId: string) => Promise<boolean>;
  // Store-stamped archivedAt read after flush so the copy agrees with the synced value; null falls back to now.
  getArchivedAt: (sessionId: string) => number | null;
  // Injected clock in epoch ms, so boundary cases are deterministic.
  now: () => number;
}

// Counts for the caller's notification. changed is true when the pass staged any store write.
export interface AutoArchiveResult {
  archived: number;
  protectiveCopies: number;
  changed: boolean;
}

// Runs one batched auto-archive pass. archiveWindowDays archives unstarred chats (<= 0 is Never).
// protectiveWindowDays is independent and gives starred chats a copy without archiving them.
// Flag flips are flushed once, then copies are written; per-chat read or write failures are swallowed
// so one bad transcript never aborts the pass.
export async function runAutoArchivePass(
  deps: AutoArchiveEngineDeps,
  chats: AutoArchiveChat[],
  archiveWindowDays: number,
  protectiveWindowDays: number,
): Promise<AutoArchiveResult> {
  const now = deps.now();
  // Do not stop on archiveWindowDays alone: starred protective copies still run when auto-archive is Never.
  if (archiveWindowDays <= 0 && protectiveWindowDays <= 0) {
    return { archived: 0, protectiveCopies: 0, changed: false };
  }

  const toArchive: AutoArchiveChat[] = [];
  const toCopyStarred: AutoArchiveChat[] = [];

  for (const chat of chats) {
    // hasCopy only matters for starred chats, so resolve it lazily to avoid a read per chat.
    let decision = decideAutoArchive({
      lastActivity: chat.lastActivity,
      starred: chat.starred,
      archived: chat.archived,
      hasCopy: false,
      archiveWindowDays,
      protectiveWindowDays,
      now,
      restoredAt: chat.restoredAt ?? null,
    });
    if (decision === 'copy') {
      // Re-run with the real hasCopy so an existing copy resolves to none.
      const hasCopy = await deps.hasBody(chat.sessionId);
      decision = decideAutoArchive({
        lastActivity: chat.lastActivity,
        starred: chat.starred,
        archived: chat.archived,
        hasCopy,
        archiveWindowDays,
        protectiveWindowDays,
        now,
        restoredAt: chat.restoredAt ?? null,
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
    await deps.flush();
  }

  // Write copies after the flush so an archived chat's copy carries the store-stamped archivedAt.
  for (const chat of toArchive) {
    const archivedAt = deps.getArchivedAt(chat.sessionId) ?? now;
    await writeCopy(deps, chat, archivedAt, chat.starred);
  }
  for (const chat of toCopyStarred) {
    // A protective copy is not archived, so there is no stamped archivedAt; use now.
    await writeCopy(deps, chat, now, true);
  }

  return {
    archived: toArchive.length,
    protectiveCopies: toCopyStarred.length,
    changed: changed || toCopyStarred.length > 0,
  };
}

// Reads a chat's body and writes the copy, swallowing failures since the copy is durability, not the source of truth.
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
