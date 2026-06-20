import { TokenTotals } from '../model/types';
import { ProjectMeta } from '../store/schema';
import { rollupByFolder, rollupByTag } from '../rollup/tokenRollup';
import { renderRollupReport } from '../rollup/rollupReport';

// The "Show Token Cost Rollup" command (Slice 5 s2-export-and-rollup). It rolls up
// tier-A token totals by folder and by tag and opens the report in a read-only
// document. tokens only, NO USD (slice non-goal).
//
// RENDER TARGET (slice patch "ROLLUP UI SURFACE"): the lightest surface that meets
// the AC is a virtual/untitled read-only document built from the PURE reducer +
// renderer output, which avoids a webview/CSP dependency. The orchestrator is
// vscode-thin and takes injected seams (the snapshot inputs and the document open),
// so the headless gate covers the reducer + renderer and the command stays a thin
// shell. The contributed command + a command-palette/view-title menu entry are added
// in package.json, mirroring the Slice 4 curation-command contributions.

export const SHOW_TOKEN_ROLLUP_COMMAND = 'claudeNest.showTokenRollup';

export interface TokenRollupDeps {
  // The scanned chats' ids (the authoritative member set) and their tier-A token
  // totals. extension.ts supplies these from FoldersProvider.chatRecords() (the id
  // set) and the new FoldersProvider.tokenTotalsByChat() seam; a test supplies
  // literals. A chat absent from the token map contributes 0 tokens but is still
  // counted as a member.
  getChatIds: () => string[];
  getTokenTotals: () => Map<string, TokenTotals>;
  // The current project's curation document (folder/tag membership + labels).
  // extension.ts reads store.getProjectMeta(projectKey); a test supplies a literal.
  // Returns null when no project resolves, in which case the command surfaces a
  // notice rather than an empty report.
  getProjectMeta: () => ProjectMeta | null;
  // Open the rendered report in a read-only document. extension.ts wires
  // vscode.workspace.openTextDocument({ content }) + showTextDocument.
  openReport: (content: string) => void | Promise<void>;
  // Surface a non-blocking notice when there is nothing to roll up.
  showInfo: (message: string) => void;
}

// Build and show the rollup report. When no project/meta resolves or there are no
// scanned chats, surface an info notice instead of an empty document.
export async function showTokenRollup(deps: TokenRollupDeps): Promise<void> {
  const meta = deps.getProjectMeta();
  const chatIds = deps.getChatIds();
  if (meta === null || chatIds.length === 0) {
    deps.showInfo(
      'Claude Code Nest: no chats to roll up yet for this workspace.',
    );
    return;
  }
  const tokensByChat = deps.getTokenTotals();
  const input = { chatIds, tokensByChat, meta };
  const report = renderRollupReport(rollupByFolder(input), rollupByTag(input));
  await deps.openReport(report);
}
