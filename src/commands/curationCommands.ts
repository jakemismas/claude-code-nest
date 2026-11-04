import { MetadataStore } from '../store/metadataStore';
import { ChatMessageBody } from '../claude/bodyReader';

// curationCommands: star, unstar, archive and restore, written through MetadataStore with one view refresh after the flush.
// Archive sets the synced userArchived flag (never the local-only LocalChatState.archived) and writes a Nest-owned body copy.
// Nothing here writes, renames or deletes under ~/.claude/projects; the body is read once through the injected readBody seam.

export const STAR_CHAT_COMMAND = 'claudeNest.starChat';
export const UNSTAR_CHAT_COMMAND = 'claudeNest.unstarChat';
export const ARCHIVE_CHAT_COMMAND = 'claudeNest.archiveChat';
export const RESTORE_CHAT_COMMAND = 'claudeNest.restoreChat';

// The minimal chat identity the commands need: sessionId, the transcript path to read on archive, and the title for the body copy.
export interface CurationTarget {
  sessionId: string;
  filePath: string;
  title: string;
}

export interface CurationCommandDeps {
  store: MetadataStore;
  // Only refresh() is used; the wiring also schedules the opt-in export snapshot after a mutation.
  provider: { refresh(): void };
  getProjectKey: () => string | undefined;
  // Read the chat's full body for the archive copy; read-only, [] when unreadable.
  readBody: (filePath: string) => ChatMessageBody[];
  // Write the Nest-owned body copy to globalStorage; returns true on success. Best-effort: a false result does not block the flag flip.
  writeBody: (envelope: {
    sessionId: string;
    title: string;
    archivedAt: number;
    starred: boolean;
    bodies: ChatMessageBody[];
  }) => Promise<boolean>;
  // Delete the Nest-owned body copy on restore. Best-effort.
  deleteBody: (sessionId: string) => Promise<void>;
  // Report whether the Claude transcript still exists (a read-only stat). Restore deletes the body copy only when it does.
  transcriptExists: (filePath: string) => boolean;
  // Update the starred flag on an existing body copy so a later prune reads the right exemption.
  updateBodyStarFlag: (sessionId: string, starred: boolean) => Promise<void>;
  // Injected clock for the archive timestamp; defaults to Date.now.
  now: () => number;
  // Surface an info or error toast. Optional.
  showInfo?: (message: string) => void;
  showError?: (message: string) => void;
}

// Star a chat (synced ChatMeta.starred = true). When the chat is archived, the body copy's starred flag is updated so the prune exemption stays current.
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

// Unstar a chat (synced ChatMeta.starred = false), removing the prune exemption on the body copy when one exists.
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

// Archive a chat: set the synced userArchived flag, then write a Nest-owned body copy so the chat survives Claude's cleanup.
// The flag flip is authoritative; the copy is best-effort, so a failed copy still leaves the chat archived.
export async function archiveChat(deps: CurationCommandDeps, target: CurationTarget): Promise<void> {
  const projectKey = deps.getProjectKey();
  if (projectKey === undefined) {
    deps.showError?.('No Claude Code project is resolved for this workspace yet.');
    return;
  }
  // Flip the flag first, then read the store-stamped archivedAt and starred flag back so the body copy matches the synced values.
  deps.store.setChatArchived(projectKey, target.sessionId, true);
  const meta = deps.store.getProjectMeta(projectKey);
  const chat = meta.chats[target.sessionId];
  const archivedAt = chat?.archivedAt ?? deps.now();
  const starred = chat?.starred === true;
  await deps.store.flush();

  // Best-effort: a failed copy is reported but does not undo the flag; a re-archive retries.
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

// Restore an archived chat: clear the synced userArchived flag (which also clears archivedAt); the star survives.
// Delete the body copy only when the live transcript still exists. On a copy-only row (Claude already cleaned up the transcript, so filePath is empty) the copy is the sole surviving form, so keep it.
// The existence check is a read-only stat.
export async function restoreChat(deps: CurationCommandDeps, target: CurationTarget): Promise<void> {
  const projectKey = deps.getProjectKey();
  if (projectKey === undefined) {
    deps.showError?.('No Claude Code project is resolved for this workspace yet.');
    return;
  }
  // setChatArchived(false) clears archivedAt; starred is untouched.
  deps.store.setChatArchived(projectKey, target.sessionId, false);
  await deps.store.flush();
  // Delete the copy only when the live transcript survives; otherwise keep it so the chat stays readable.
  const present = target.filePath.length > 0 && deps.transcriptExists(target.filePath);
  if (present) {
    await deps.deleteBody(target.sessionId);
  }
  deps.provider.refresh();
}
