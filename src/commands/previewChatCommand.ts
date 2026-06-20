import { ChatRecord } from '../model/types';
import { ChatMessageBody, readTranscriptBodies } from '../claude/bodyReader';

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

// PURE: format a chat's ordered bodies into a readable plain-text preview. A header
// names the chat and the message count; each genuine turn is a labelled paragraph
// in transcript order. Textless turns (a pure tool_use assistant turn or a
// tool_result-only user line, both carried by the reader as text:null) render a
// compact "(no text in this turn)" placeholder so the turn sequence stays honest
// without dumping tool payloads. vscode-free so the headless gate covers it.
export function formatBodyPreview(record: ChatRecord, bodies: readonly ChatMessageBody[]): string {
  const lines: string[] = [];
  lines.push(record.title);
  lines.push('Session: ' + record.sessionId);
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
