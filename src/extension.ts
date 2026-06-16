import * as vscode from 'vscode';
import { FlatProvider, OPEN_CHAT_COMMAND } from './views/flatProvider';
import { openChat, OpenUri } from './launch/uriLauncher';

// Entry point for the Claude Code Nest extension. Slice 0 contributes the
// claudeNest Activity Bar view container and the claudeNest.flat chat list, and
// wires the open-chat command to Claude's documented URI handler. Later slices
// add the Folders, Tags, Links, Smart Groups, and Settings surfaces here.
export function activate(context: vscode.ExtensionContext): void {
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const flatProvider = new FlatProvider(workspacePath);
  const flatView = vscode.window.createTreeView('claudeNest.flat', {
    treeDataProvider: flatProvider,
    showCollapseAll: false,
  });
  context.subscriptions.push(flatView);

  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_CHAT_COMMAND, (sessionId: string) => {
      // Compose vscode.Uri.from with vscode.env.openExternal as the injected
      // opener. The launcher builds the OpenUri; here we adapt it to a real Uri.
      return openChat(sessionId, (uri: OpenUri) =>
        vscode.env.openExternal(
          vscode.Uri.from({
            scheme: uri.scheme,
            authority: uri.authority,
            path: uri.path,
            query: uri.query,
          }),
        ),
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeNest.refresh', () => flatProvider.refresh()),
  );
}

export function deactivate(): void {
  // No teardown required beyond the disposables registered on the context.
}
