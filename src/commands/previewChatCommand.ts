import { ChatRecord } from '../model/types';
import { ChatMessageBody, readTranscriptBodies } from '../claude/bodyReader';
import type { ArchivedBodyEnvelope } from '../store/archiveBodyStore';

// The "Preview Full Chat" command: the slice-1 ON-DEMAND single-chat body reader's
// production caller. The hover card and the row badge ride the bounded tier-A
// snapshot and never read a body; this command is the one place a user explicitly
// asks for a chat's FULL prose, so it reads exactly ONE transcript's bodies via
// bodyReader.readTranscriptBodies, formats them, opens them in a read-only editor
// document, and DISCARDS the bodies (no provider holds them) — exactly the
// ARCHITECTURE.md tier-A rule ("full message BODIES are read on demand for one chat
// and discarded"). This wires the headline reader into the running extension rather
// than leaving it dead until a later slice.
//
// Split into a PURE formatter (formatBodyPreview, vscode-free, headless-testable)
// and a vscode-thin orchestrator (previewChatBody) that takes injected seams for
// the body read and the document open. extension.ts supplies the real
// vscode.workspace.openTextDocument + vscode.window.showTextDocument.

export const PREVIEW_CHAT_COMMAND = 'claudeNest.previewChat';

// The "Preview Archived Copy" command id: opens the Nest-owned archived body copy
// (globalStorage), NOT the live transcript. This is the read path that makes the
// archive's cleanup-survival promise real: once Claude deletes ~/.claude/projects,
// the copy is the chat's only durable form and THIS command renders it.
export const PREVIEW_ARCHIVED_CHAT_COMMAND = 'claudeNest.previewArchivedChat';

// The injected seams. The orchestrator stays vscode-free: extension.ts wires the
// real document-open; a test supplies a double and asserts the formatted text.
export interface PreviewChatDeps {
  // Read one transcript file's bodies on demand. Defaults to the real bodyReader;
  // a test injects a double. Read-only and tolerant ([] on an unreadable file).
  readBodies?: (filePath: string) => ChatMessageBody[];
  // Open the formatted preview text in a read-only document. extension.ts wires
  // vscode.workspace.openTextDocument({ content, language }) +
  // vscode.window.showTextDocument.
  openPreview(content: string): void | Promise<void>;
  // Surface a non-blocking notice when the chat has no readable body. Worded so it
  // never blames Claude (the read is Nest's read-only view of the transcript).
  showInfo(message: string): void;
}

// Open a read-only preview of ONE chat's full body. Reads the bodies on demand,
// formats them, opens the document, then lets the bodies fall out of scope. A chat
// with no readable body surfaces an info notice rather than an empty document.
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

// The injected seams for the archived-copy preview. Mirrors PreviewChatDeps but the
// body source is the Nest-owned globalStorage copy (by sessionId), not a transcript
// path, so this path keeps working after Claude cleans up ~/.claude/projects.
export interface PreviewArchivedChatDeps {
  // Read one archived chat's Nest-owned body copy by sessionId. extension.ts wires
  // archiveBodyStore.readArchivedBody bound to the globalStorage Uri; a test injects
  // a double. Returns null when no copy exists (absent/unreadable/malformed).
  readArchivedBody(sessionId: string): Promise<ArchivedBodyEnvelope | null>;
  // Open the formatted preview text in a read-only document (same seam shape as
  // PreviewChatDeps.openPreview).
  openPreview(content: string): void | Promise<void>;
  // Surface a non-blocking notice when no archived copy is readable for this chat.
  showInfo(message: string): void;
}

// Open a read-only preview of ONE archived chat from its Nest-owned body copy. This
// is the read counterpart to writeArchivedBody: it surfaces env.bodies to the user
// so the saved copy is reachable AFTER Claude has cleaned up the live transcript
// (the exact scenario the archive feature exists to handle). A missing copy (never
// written, pruned, or unreadable) surfaces an info notice rather than an empty
// document. Reuses the same pure formatter as the live preview so the rendering is
// identical; the envelope carries the title, sessionId, and ordered bodies the
// formatter needs.
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

// PURE: format an archived body envelope into the same readable preview as the live
// reader. The envelope carries title/sessionId/bodies directly (no ChatRecord), so
// this adapts it to the shared formatBodyPreview via a minimal record-shaped header
// source. vscode-free so the headless gate covers it.
export function formatArchivedPreview(envelope: ArchivedBodyEnvelope): string {
  return formatPreviewLines(envelope.title, envelope.sessionId, envelope.bodies);
}

// PURE: format a chat's ordered bodies into a readable plain-text preview. A header
// names the chat and the message count; each genuine turn is a labelled paragraph
// in transcript order. Textless turns (a pure tool_use assistant turn or a
// tool_result-only user line, both carried by the reader as text:null) render a
// compact "(no text in this turn)" placeholder so the turn sequence stays honest
// without dumping tool payloads. vscode-free so the headless gate covers it.
export function formatBodyPreview(record: ChatRecord, bodies: readonly ChatMessageBody[]): string {
  return formatPreviewLines(record.title, record.sessionId, bodies);
}

// PURE shared renderer: header (title, session, count) plus one labelled paragraph
// per turn in order. Both the live-transcript preview and the archived-copy preview
// route through this so the two outputs are byte-identical.
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
