import { MetadataStore } from '../store/metadataStore';
import { ChatMessageBody } from '../claude/bodyReader';

// curationCommands (Slice 4 s2-star-archive): STAR / UNSTAR / ARCHIVE / RESTORE.
// Every curation flag write goes through MetadataStore's slice-3 mutations, which
// stamp updatedAt/deviceId and coalesce into the existing pending write, and the
// affected views are refreshed ONCE after the store flush (refresh coalescing,
// ARCHITECTURE.md). The deps mirror folderCommands/linkCommands: a store, a
// structural refresher, an on-demand getProjectKey, plus the archive-body and
// body-reader seams so the orchestration is exercisable headless without vscode.
//
// FLAG SEMANTICS (slice patch "NAMING-COLLISION GUARD"):
// - ARCHIVE writes the SYNCED ChatMeta.userArchived flag via store.setChatArchived
//   (which sets archivedAt coupled to the flag). It NEVER touches the local-only
//   LocalChatState.archived (the orphan-reconcile flag on the separate nest.local.v1
//   document); the two are deliberately distinct.
// - RESTORE calls store.setChatArchived(false), which CLEARS archivedAt (the store
//   couples the two), and is independent of starred (a restored chat keeps its
//   star). It also deletes the now-redundant Nest-owned body copy.
// - STAR/UNSTAR write ChatMeta.starred via store.setChatStarred, INDEPENDENT of the
//   archive flag. Starring an archived chat exempts its body copy from the
//   keep-window prune (archiveRetention), so the star flag on the body copy is kept
//   current via the body store.
//
// READ-ONLY INVARIANT: ARCHIVE reads the chat's full body ONCE via the injected
// readBody seam (bodyReader.readTranscriptBodies, read-only on the transcript) and
// writes a Nest-owned COPY to globalStorage via the injected writeBody seam
// (archiveBodyStore -> exportIO, guarded). Nothing here writes, renames, moves, or
// deletes anything under ~/.claude/projects.

export const STAR_CHAT_COMMAND = 'claudeNest.starChat';
export const UNSTAR_CHAT_COMMAND = 'claudeNest.unstarChat';
export const ARCHIVE_CHAT_COMMAND = 'claudeNest.archiveChat';
export const RESTORE_CHAT_COMMAND = 'claudeNest.restoreChat';

// The minimal chat identity the commands need: a sessionId, the file path to read
// the body from on archive, and the title to stamp onto the body copy. extension.ts
// resolves these from the clicked chat row (any view); a test supplies a literal.
export interface CurationTarget {
  sessionId: string;
  filePath: string;
  title: string;
}

export interface CurationCommandDeps {
  store: MetadataStore;
  // Only refresh() is used; the wiring also schedules the opt-in auto-export
  // snapshot after a curation mutation (a synced scalar changed).
  provider: { refresh(): void };
  getProjectKey: () => string | undefined;
  // Read the chat's full body for the archive copy. Wired to
  // bodyReader.readTranscriptBodies in extension.ts; a test supplies a stub. Reads
  // the transcript read-only and returns the ordered bodies, [] when unreadable.
  readBody: (filePath: string) => ChatMessageBody[];
  // Write the Nest-owned body copy to globalStorage. Wired to
  // archiveBodyStore.writeArchivedBody; returns true on success. Best-effort: a
  // false result does not block the archive flag flip.
  writeBody: (envelope: {
    sessionId: string;
    title: string;
    archivedAt: number;
    starred: boolean;
    bodies: ChatMessageBody[];
  }) => Promise<boolean>;
  // Delete the Nest-owned body copy (on restore). Wired to
  // archiveBodyStore.deleteArchivedBody. Best-effort.
  deleteBody: (sessionId: string) => Promise<void>;
  // Update the starred flag recorded on an existing body copy so a later prune
  // reads the right exemption. Wired to archiveBodyStore.updateStarFlag.
  updateBodyStarFlag: (sessionId: string, starred: boolean) => Promise<void>;
  // Injected clock for the archive timestamp / determinism. Defaults to Date.now in
  // the wiring; a test supplies a fixed value.
  now: () => number;
  // Surface an info/error toast. Optional; defaults to no-op so a test need not
  // supply it.
  showInfo?: (message: string) => void;
  showError?: (message: string) => void;
}

// Star a chat (synced ChatMeta.starred = true). Independent of archive. When the
// chat is currently archived, the body copy's starred flag is updated so the
// keep-window prune exemption is current. Refreshes once after the flush.
export async function starChat(deps: CurationCommandDeps, target: CurationTarget): Promise<void> {
  const projectKey = deps.getProjectKey();
  if (projectKey === undefined) {
    deps.showError?.('No Claude Code project is resolved for this workspace yet.');
    return;
  }
  deps.store.setChatStarred(projectKey, target.sessionId, true);
  await deps.store.flush();
  // Keep the body copy's exemption flag current (no-op when no copy exists).
  await deps.updateBodyStarFlag(target.sessionId, true);
  deps.provider.refresh();
}

// Unstar a chat (synced ChatMeta.starred = false). Independent of archive. Removes
// the prune exemption on the body copy when one exists.
export async function unstarChat(deps: CurationCommandDeps, target: CurationTarget): Promise<void> {
  const projectKey = deps.getProjectKey();
  if (projectKey === undefined) {
    deps.showError?.('No Claude Code project is resolved for this workspace yet.');
    return;
  }
  deps.store.setChatStarred(projectKey, target.sessionId, false);
  await deps.store.flush();
  await deps.updateBodyStarFlag(target.sessionId, false);
  deps.provider.refresh();
}

// Archive a chat: flip the SYNCED userArchived flag (store.setChatArchived(true),
// which sets archivedAt), then write a Nest-owned copy of the full body to
// globalStorage so the chat survives Claude's cleanup. The flag flip is
// authoritative for membership; the body copy is best-effort durability, so a
// failed copy still leaves the chat archived. Reads the body AFTER the flush so the
// archivedAt the store stamped (this.now()) matches the copy's archivedAt: both use
// the same injected clock value captured once here.
export async function archiveChat(deps: CurationCommandDeps, target: CurationTarget): Promise<void> {
  const projectKey = deps.getProjectKey();
  if (projectKey === undefined) {
    deps.showError?.('No Claude Code project is resolved for this workspace yet.');
    return;
  }
  // Capture the archive timestamp ONCE so the synced archivedAt and the body
  // copy's archivedAt agree exactly (the store stamps with its own clock, so read
  // the stamped value back rather than guessing). Flip the flag first.
  deps.store.setChatArchived(projectKey, target.sessionId, true);
  // Read the starred flag and the store-stamped archivedAt back for the copy.
  const meta = deps.store.getProjectMeta(projectKey);
  const chat = meta.chats[target.sessionId];
  const archivedAt = chat?.archivedAt ?? deps.now();
  const starred = chat?.starred === true;
  await deps.store.flush();

  // Read the full body once and write the Nest-owned copy. Best-effort: a failure
  // is reported but does not undo the archive flag (the chat is still archived; only
  // the durable copy is missing, and a re-archive retries).
  const bodies = deps.readBody(target.filePath);
  const ok = await deps.writeBody({
    sessionId: target.sessionId,
    title: target.title,
    archivedAt,
    starred,
    bodies,
  });
  if (!ok) {
    deps.showError?.(
      'Chat archived, but saving the Nest-owned copy failed; the copy will not survive ' +
        'Claude cleanup until you re-archive.',
    );
  } else {
    deps.showInfo?.('Chat archived. A Nest-owned copy is kept so it survives Claude cleanup.');
  }
  deps.provider.refresh();
}

// Restore an archived chat: clear the SYNCED userArchived flag
// (store.setChatArchived(false), which also clears archivedAt per the coupling),
// independent of starred (the star survives a restore). Delete the now-redundant
// Nest-owned body copy. Refreshes once after the flush.
export async function restoreChat(deps: CurationCommandDeps, target: CurationTarget): Promise<void> {
  const projectKey = deps.getProjectKey();
  if (projectKey === undefined) {
    deps.showError?.('No Claude Code project is resolved for this workspace yet.');
    return;
  }
  // setChatArchived(false) clears archivedAt (the store couples them); starred is
  // untouched.
  deps.store.setChatArchived(projectKey, target.sessionId, false);
  await deps.store.flush();
  await deps.deleteBody(target.sessionId);
  deps.provider.refresh();
}
