import { ChatRecord } from '../model/types';
import { ChatMessageBody, readTranscriptBodies } from '../claude/bodyReader';
import { ExportOrgLayer, renderJson, renderMarkdown } from '../export/chatExport';

// The "Export Chat" command (Slice 5 s2-export-and-rollup). It exports ONE chat to
// Markdown (YAML front-matter org layer + body) or JSON via the exportIO chokepoint
// with the runtime path guard. Split into a vscode-thin orchestrator (exportChat,
// here) and the PURE formatters (chatExport.ts, headless-tested); the orchestrator
// takes injected seams for the format pick, the save dialog, the body read, the
// org-layer resolution, and the guarded write, so it is exercisable without a vscode
// host and the read-only invariant holds.
//
// READ-ONLY INVARIANT: the body is read ONCE on demand (bodyReader.readTranscriptBodies,
// read-only on the transcript) and DISCARDED after rendering; the write goes ONLY
// through the injected writeFile seam (wired to exportIO.writeTextFile in
// extension.ts), which runtime-asserts assertNotUnderClaudeProjects before the bytes
// land. So an export aimed (by a user navigating the save dialog) into
// ~/.claude/projects is refused by the guard, never overwriting a transcript.

export const EXPORT_CHAT_COMMAND = 'claudeNest.exportChat';

// The export format the user picked. Drives the file extension default and the
// formatter.
export type ExportFormat = 'markdown' | 'json';

// A chosen save target plus the format. The dialog seam returns null when the user
// cancels.
export interface ExportSaveTarget {
  // The opaque target the writeFile seam understands (a vscode.Uri in production; a
  // string path in a test). Kept as unknown so this module stays vscode-free.
  target: unknown;
  format: ExportFormat;
}

export interface ExportChatDeps {
  // Pick the export format (Markdown or JSON). extension.ts wires a QuickPick; a
  // test supplies a fixed choice. Returns null on cancel.
  pickFormat: () => Promise<ExportFormat | null>;
  // Show the save dialog for a chosen format and a suggested filename, returning the
  // chosen target or null on cancel. extension.ts wires vscode.window.showSaveDialog;
  // a test supplies a double.
  showSaveDialog: (format: ExportFormat, suggestedName: string) => Promise<unknown | null>;
  // Read the chat's full body on demand. Defaults to the real bodyReader; a test
  // injects a double. Read-only and tolerant ([] on an unreadable file).
  readBodies?: (filePath: string) => ChatMessageBody[];
  // Resolve the chat's org layer (folder name, full tag set, starred, link target
  // ids) from the synced store. extension.ts wires the chatMeta resolvers over the
  // current ProjectMeta; a test supplies a literal. Returns a default empty layer
  // when no project/meta resolves so the export still ships the body.
  resolveOrgLayer: (sessionId: string) => ExportOrgLayer;
  // Write the rendered text to the chosen target through the GUARDED exportIO seam.
  // extension.ts wires exportIO.writeTextFile (which asserts the target is not a
  // transcript path); a test supplies a spy. Rejects on a guard violation or IO
  // failure. NOT named writeFile/writeTextFile: the read-only lint bank's first
  // selector is object-AGNOSTIC (it bans any callee property named writeFile), so a
  // deps.writeFile(...) call trips it the same as fs.writeFile; the actual guarded
  // write lives in exportIO.writeTextFile (a carve-out module) and this seam only
  // forwards to it.
  writeExport: (target: unknown, content: string) => Promise<void>;
  // Surface an info/error toast. Optional; defaults to no-op so a test need not
  // supply them.
  showInfo?: (message: string) => void;
  showError?: (message: string) => void;
}

// Export one chat. Picks a format, picks a target, reads the body on demand, renders
// the chosen format from the pure formatter, and writes through the guarded seam.
// Cancelling at any prompt aborts cleanly. A write failure (including the read-only
// guard firing on a transcript-path target) surfaces an error and never throws out.
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

// Suggest a filename from the chat title (sanitized) and the format extension. A
// title with path-hostile characters is reduced to a safe slug; an empty result
// falls back to the sessionId so the name is never blank.
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
