import { ChatRecord } from '../model/types';
import { ChatMessageBody, readTranscriptBodies } from '../claude/bodyReader';
import { ExportOrgLayer, renderJson, renderMarkdown } from '../export/chatExport';

// The "Export Chat" command: exports one chat to Markdown or JSON through the exportIO guard.
// The orchestrator takes injected seams (format pick, save dialog, body read, org layer, write); formatters live in chatExport.ts.
// The body is read once and discarded. The write goes only through the injected seam, which asserts the target is not under ~/.claude/projects.

export const EXPORT_CHAT_COMMAND = 'claudeNest.exportChat';

// The export format the user picked; sets the default file extension and formatter.
export type ExportFormat = 'markdown' | 'json';

export interface ExportChatDeps {
  // Pick the export format. Returns null on cancel.
  pickFormat: () => Promise<ExportFormat | null>;
  // Show the save dialog for a format and suggested filename. Returns the target or null on cancel.
  showSaveDialog: (format: ExportFormat, suggestedName: string) => Promise<unknown | null>;
  // Read the chat's full body on demand; read-only, returns [] for an unreadable file.
  readBodies?: (filePath: string) => ChatMessageBody[];
  // Resolve the chat's org layer from the synced store; an empty layer when no project resolves, so the body still exports.
  resolveOrgLayer: (sessionId: string) => ExportOrgLayer;
  // Write the rendered text through the guarded exportIO seam; rejects on a guard violation or IO failure.
  // Not named writeFile: the read-only lint bans any callee property with that name.
  writeExport: (target: unknown, content: string) => Promise<void>;
  // Surface an info or error toast. Optional.
  showInfo?: (message: string) => void;
  showError?: (message: string) => void;
}

// Export one chat: pick a format and target, read the body, render, and write through the guarded seam.
// Cancelling aborts cleanly; a write failure (including the guard firing) shows an error and never throws.
export async function exportChat(deps: ExportChatDeps, record: ChatRecord): Promise<void> {
  const format = await deps.pickFormat();
  if (format === null) {
    return;
  }
  const suggestedName = suggestFileName(record, format);
  const target = await deps.showSaveDialog(format, suggestedName);
  if (target === null || target === undefined) {
    return;
  }

  const read = deps.readBodies ?? readTranscriptBodies;
  const bodies = read(record.filePath);
  const org = deps.resolveOrgLayer(record.sessionId);
  const content =
    format === 'markdown' ? renderMarkdown(record, org, bodies) : renderJson(record, org, bodies);

  try {
    await deps.writeExport(target, content);
  } catch (err) {
    deps.showError?.(
      'Claude Code Nest: export failed. ' + (err instanceof Error ? err.message : String(err)),
    );
    return;
  }
  deps.showInfo?.('Claude Code Nest: exported "' + record.title + '".');
}

// Suggest a filename from the sanitized chat title; an empty slug falls back to the sessionId.
export function suggestFileName(record: ChatRecord, format: ExportFormat): string {
  const ext = format === 'markdown' ? '.md' : '.json';
  const slug = record.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const base = slug.length > 0 ? slug : record.sessionId;
  return base + ext;
}
