// Unit tests for choosing the settings target of the robin option. A workspace inside the Claude
// transcript folder must write user-level configuration, never the workspace-level file.

import './vscodeStub';
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { robinConfigTarget } from '../../views/orgPanelWebview';
import { claudeProjectsRoot, isUnderClaudeProjects } from '../../store/exportPathGuard';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { OrgPanelProvider } = require('../../views/orgPanelWebview') as {
  OrgPanelProvider: new (...args: unknown[]) => { resolveWebviewView(view: unknown): void };
};

describe('robinConfigTarget', () => {
  it('keeps the existing choice when the workspace is outside the Claude folder', () => {
    assert.strictEqual(
      robinConfigTarget({ workspaceFolderValue: true }),
      vscode.ConfigurationTarget.WorkspaceFolder,
    );
    assert.strictEqual(robinConfigTarget({ workspaceValue: false }), vscode.ConfigurationTarget.Workspace);
  });

  it('writes user-level configuration when the workspace is inside the Claude folder', () => {
    const inspected = { workspaceFolderValue: true, workspaceValue: false };
    assert.strictEqual(robinConfigTarget(inspected, true), vscode.ConfigurationTarget.Global);
    assert.strictEqual(robinConfigTarget(undefined, true), vscode.ConfigurationTarget.Global);
  });
});

// Drives the real setRobinAnimations handler. The fake configuration records each update and
// simulates where a workspace-level write would land, so the test can check that nothing does.
describe('setRobinAnimations handler', () => {
  const ws = vscode.workspace as unknown as { getConfiguration: unknown };
  const win = vscode.window as unknown as { showInformationMessage: unknown };

  async function runHandler(
    workspace: string,
    inspected: { workspaceFolderValue?: unknown; workspaceValue?: unknown },
  ): Promise<{ targets: number[]; writtenPaths: string[]; notices: string[] }> {
    const targets: number[] = [];
    const writtenPaths: string[] = [];
    const notices: string[] = [];
    const savedGet = ws.getConfiguration;
    const savedInfo = win.showInformationMessage;
    let handler: ((raw: unknown) => void) | undefined;
    ws.getConfiguration = (): unknown => ({
      inspect: (): unknown => inspected,
      update: (_key: string, _value: unknown, target: number): Promise<void> => {
        targets.push(target);
        if (target !== vscode.ConfigurationTarget.Global) {
          writtenPaths.push(path.join(workspace, '.vscode', 'settings.json'));
        }
        return Promise.resolve();
      },
    });
    win.showInformationMessage = (message: string): Promise<undefined> => {
      notices.push(message);
      return Promise.resolve(undefined);
    };
    try {
      const provider = new OrgPanelProvider(
        { fsPath: '/ext', scheme: 'file' },
        workspace,
        { getProjectMeta: (): unknown => ({ folders: {}, tags: {}, chats: {} }), flush: (): Promise<void> => Promise.resolve() },
        () => undefined,
        {},
        { store: undefined, getProjectKey: () => undefined, refresh: () => undefined },
        { get: (): undefined => undefined, set: (): void => undefined },
        { getMap: (): Map<string, number> => new Map(), markSeen: (): void => undefined, seedIfFirstRun: (): boolean => false },
        undefined,
      );
      provider.resolveWebviewView({
        webview: {
          options: {},
          cspSource: 'vscode-resource:',
          asWebviewUri: (u: unknown): unknown => u,
          html: '',
          onDidReceiveMessage: (cb: (raw: unknown) => void): { dispose(): void } => {
            handler = cb;
            return { dispose: (): void => undefined };
          },
          postMessage: (): Promise<boolean> => Promise.resolve(true),
        },
        visible: true,
        onDidChangeVisibility: (): { dispose(): void } => ({ dispose: (): void => undefined }),
        onDidDispose: (): { dispose(): void } => ({ dispose: (): void => undefined }),
      });
      handler?.({ type: 'setRobinAnimations', on: true });
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      ws.getConfiguration = savedGet;
      win.showInformationMessage = savedInfo;
    }
    return { targets, writtenPaths, notices };
  }

  it('writes no file into the Claude folder when the workspace is inside it', async () => {
    const workspace = path.join(claudeProjectsRoot(), 'proj');
    const result = await runHandler(workspace, { workspaceFolderValue: undefined, workspaceValue: undefined });
    assert.deepStrictEqual(result.targets, [vscode.ConfigurationTarget.Global]);
    assert.strictEqual(result.writtenPaths.filter((p) => isUnderClaudeProjects(p)).length, 0);
    assert.deepStrictEqual(result.notices, []);
  });

  it('tells the user when a workspace value masks the switch inside the Claude folder', async () => {
    const workspace = path.join(claudeProjectsRoot(), 'proj');
    const result = await runHandler(workspace, { workspaceValue: false });
    assert.deepStrictEqual(result.targets, [vscode.ConfigurationTarget.Global]);
    assert.strictEqual(result.writtenPaths.filter((p) => isUnderClaudeProjects(p)).length, 0);
    assert.strictEqual(result.notices.length, 1);
  });
});
