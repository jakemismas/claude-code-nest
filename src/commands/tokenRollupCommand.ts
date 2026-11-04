import { TokenTotals } from '../model/types';
import { ProjectMeta } from '../store/schema';
import { rollupByFolder, rollupByTag } from '../rollup/tokenRollup';
import { renderRollupReport } from '../rollup/rollupReport';

// The "Show Token Cost Rollup" command: rolls up token totals by folder and tag and opens a read-only report (tokens only, no USD).
// It takes injected seams for the snapshot and document open, so the reducer and renderer run without vscode.

export const SHOW_TOKEN_ROLLUP_COMMAND = 'claudeNest.showTokenRollup';

export interface TokenRollupDeps {
  // The scanned chat ids (the member set) and their summary token totals; a chat absent from the map counts 0 tokens.
  getChatIds: () => string[];
  getTokenTotals: () => Map<string, TokenTotals>;
  // The current project's curation document, or null when no project resolves (the command then shows a notice).
  getProjectMeta: () => ProjectMeta | null;
  // Open the rendered report in a read-only document.
  openReport: (content: string) => void | Promise<void>;
  // Surface a non-blocking notice when there is nothing to roll up.
  showInfo: (message: string) => void;
}

// Build and show the report, or show an info notice when no project or chats resolve.
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
