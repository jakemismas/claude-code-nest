import { ChatRecord } from '../model/types';
import { ChatMessageBody, readTranscriptBodies } from '../claude/bodyReader';
import type { ArchivedBodyEnvelope } from '../store/archiveBodyStore';

// The "Preview Full Chat" command: reads one chat's transcript bodies on demand, formats them and opens a read-only document.
// The hover card and row badge never read bodies, so the bodies are discarded after the preview. A pure formatter (formatBodyPreview) is split from the orchestrator (previewChatBody), which takes injected seams.

export const PREVIEW_CHAT_COMMAND = 'claudeNest.previewChat';

// The "Preview Archived Copy" command id: opens the Nest-owned archived body copy (globalStorage), which survives after Claude deletes ~/.claude/projects.
export const PREVIEW_ARCHIVED_CHAT_COMMAND = 'claudeNest.previewArchivedChat';

// The injected seams; extension.ts wires the real document open and tests supply doubles.
export interface PreviewChatDeps {
  // Read one transcript's bodies on demand; read-only, returns [] for an unreadable file.
  readBodies?: (filePath: string) => ChatMessageBody[];
  // Open the formatted preview text in a read-only document.
  openPreview(content: string): void | Promise<void>;
  // Surface a non-blocking notice when the chat has no readable body, worded so it does not blame Claude.
  showInfo(message: string): void;
}

// Open a read-only preview of one chat's full body, or an info notice when no body is readable.
export async function previewChatBody(deps: PreviewChatDeps, record: ChatRecord): Promise<void> {
  const read = deps.readBodies ?? readTranscriptBodies;
  const bodies = read(record.filePath);
  if (bodies.length === 0) {
    deps.showInfo(
      'Claude Code Nest found no readable messages in "' + record.title + '". Your chat is unchanged.',
    );
    return;
  }
  await deps.openPreview(formatBodyPreview(record, bodies));
}

// Seams for the archived-copy preview. The body source is the Nest-owned copy by sessionId, which survives cleanup of ~/.claude/projects.
export interface PreviewArchivedChatDeps {
  // Read one archived chat's body copy by sessionId; null when no copy exists or it is unreadable.
  readArchivedBody(sessionId: string): Promise<ArchivedBodyEnvelope | null>;
  // Open the formatted preview text in a read-only document.
  openPreview(content: string): void | Promise<void>;
  // Surface a non-blocking notice when no archived copy is readable for this chat.
  showInfo(message: string): void;
}

// Open a read-only preview of one archived chat from its Nest-owned body copy, reusing the live preview formatter.
// A missing copy shows an info notice rather than an empty document.
export async function previewArchivedBody(
  deps: PreviewArchivedChatDeps,
  sessionId: string,
): Promise<void> {
  const envelope = await deps.readArchivedBody(sessionId);
  if (envelope === null || envelope.bodies.length === 0) {
    deps.showInfo(
      'Claude Code Nest has no saved copy to preview for this archived chat. ' +
        'Re-archive it while its transcript is still present to save one.',
    );
    return;
  }
  await deps.openPreview(formatArchivedPreview(envelope));
}

// Pure: format an archived body envelope into the same preview as the live reader.
export function formatArchivedPreview(envelope: ArchivedBodyEnvelope): string {
  return formatPreviewLines(envelope.title, envelope.sessionId, envelope.bodies);
}

// Pure: format a chat's ordered bodies into a plain-text preview with a header and one labelled paragraph per turn.
// Textless turns (tool-only) render a "(no text in this turn)" placeholder so the sequence stays honest.
export function formatBodyPreview(record: ChatRecord, bodies: readonly ChatMessageBody[]): string {
  return formatPreviewLines(record.title, record.sessionId, bodies);
}

// Shared renderer for the live and archived previews, so both outputs are identical.
function formatPreviewLines(
  title: string,
  sessionId: string,
  bodies: readonly ChatMessageBody[],
): string {
  const lines: string[] = [];
  lines.push(title);
  lines.push('Session: ' + sessionId);
  lines.push(bodies.length + ' message' + (bodies.length === 1 ? '' : 's'));
  lines.push('');
  for (const body of bodies) {
    lines.push(roleLabel(body.role));
    lines.push(body.text !== null && body.text.length > 0 ? body.text : '(no text in this turn)');
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

function roleLabel(role: 'user' | 'assistant'): string {
  return role === 'user' ? 'You:' : 'Claude:';
}
