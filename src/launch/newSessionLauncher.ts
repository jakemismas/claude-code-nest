// Launches a new Claude Code chat, best-effort, for the org panel's New session pill.
// Probed against anthropic.claude-code 2.1.197 and 2.1.198: "claude-vscode.newConversation" is the real new-chat command; the URI handler's "/open?session=<id>" only resumes (see uriLauncher.ts).
// "claude-vscode.sidebar.open" is the fallback so the button is never dead; when both fail the host shows a toast. The command runner is injected so tests use a spy.

// The probed commands, most specific first; the first one that does not reject wins.
export const NEW_SESSION_COMMANDS: readonly string[] = [
  'claude-vscode.newConversation',
  'claude-vscode.sidebar.open',
];

// An injected command runner (vscode.commands.executeCommand in production). A rejection means the command is missing or threw, so the launcher tries the next candidate.
export type RunCommand = (command: string) => unknown;

// Try each candidate in order; resolve true on the first that does not reject, false when all reject or the list is empty. Never throws, so the caller can show one toast on false.
export async function launchNewSession(
  run: RunCommand,
  commands: readonly string[] = NEW_SESSION_COMMANDS,
): Promise<boolean> {
  for (const command of commands) {
    try {
      await run(command);
      return true;
    } catch {
      // This entry point is unavailable in this environment; try the next.
    }
  }
  return false;
}
