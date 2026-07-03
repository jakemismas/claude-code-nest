// Launches a NEW Claude Code chat, best-effort (UI-SPEC.md data mapping, deviation
// 6; slice s3a-design-shell, issue #80). The org panel's New session pill posts a
// message the host routes here.
//
// BUILD-TIME PROBE of the actual new-chat entry point (2026-07-02, against the
// installed anthropic.claude-code 2.1.197 and 2.1.198 package.json contributes):
// the extension contributes the command "claude-vscode.newConversation" ("Claude
// Code: New Conversation", keybound cmd+n). That is the real NEW-chat entry point.
// The public URI handler's "/open?session=<id>" path (src/launch/uriLauncher.ts)
// only RESUMES an existing session and cannot start a fresh one, so it is not used
// here. "claude-vscode.sidebar.open" ("Claude Code: Open in Side Bar") is the
// fallback: if newConversation is absent or throws (a different Claude Code build,
// or the extension not installed), opening the sidebar at least surfaces Claude so
// the user is not left with a dead button. When both fail, the host shows a graceful
// toast (UI-SPEC.md deviation 6). See DECISIONS.md slice s3a-design-shell.
//
// The command runner is INJECTED so this module is unit-testable with a spy and
// imports no vscode here, mirroring uriLauncher.ts's injected openExternal. The
// extension host passes vscode.commands.executeCommand.

// The probed contributed commands, most-specific first. The launcher tries each in
// order until one resolves; the first that does not reject wins.
export const NEW_SESSION_COMMANDS: readonly string[] = [
  'claude-vscode.newConversation',
  'claude-vscode.sidebar.open',
];

// An injected command runner. In production this is vscode.commands.executeCommand;
// in tests it is a spy. The return type is unknown so it accepts the Thenable
// executeCommand returns without depending on the vscode module here. A runner that
// REJECTS (command not registered, or the command threw) signals failure and the
// launcher falls through to the next candidate.
export type RunCommand = (command: string) => unknown;

// Try each candidate command in order; resolve true on the first that does not
// reject, false when every candidate rejects (or the list is empty). Never throws:
// a rejecting or throwing runner is caught and treated as that candidate failing, so
// the caller can show a single graceful toast on a false result.
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
