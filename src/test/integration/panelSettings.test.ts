import * as assert from 'assert';
import * as vscode from 'vscode';

import { getOrgPanelProviderForTests } from '../../extension';
import { robinConfigTarget } from '../../views/orgPanelWebview';

// Runs only in the Extension Development Host. It attaches a fake view to the live panel
// provider so the messages the panel would send to its webview can be read back.

type Posted = { type: string; [key: string]: unknown };

function attachFakeView(): { posted: Posted[]; send: (m: unknown) => void } {
  const provider = getOrgPanelProviderForTests();
  assert.ok(provider, 'the panel provider exists after activation');
  const posted: Posted[] = [];
  let handler: ((raw: unknown) => void) | undefined;
  const noop = { dispose: (): void => undefined };
  const webview = {
    options: {},
    cspSource: 'x:',
    html: '',
    asWebviewUri: (u: vscode.Uri): vscode.Uri => u,
    onDidReceiveMessage: (cb: (raw: unknown) => void): vscode.Disposable => {
      handler = cb;
      return noop as vscode.Disposable;
    },
    postMessage: (m: Posted): Thenable<boolean> => {
      posted.push(m);
      return Promise.resolve(true);
    },
  };
  provider.resolveWebviewView({
    webview,
    visible: true,
    onDidChangeVisibility: () => noop,
    onDidDispose: () => noop,
  } as unknown as vscode.WebviewView);
  return { posted, send: (m) => handler?.(m) };
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check() && Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('panel settings apply live (host)', () => {
  before(async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension('jakemismas.claude-code-nest');
    assert.ok(ext, 'extension is present');
    await ext.activate();
  });

  it('re-groups the panel model when the group-by override changes', async function () {
    this.timeout(15000);
    const { posted, send } = attachFakeView();
    send({ type: 'ready' });
    try {
      send({ type: 'setGroupBy', mode: 'date' });
      await until(() => posted.some((m) => m.type === 'fleet' && m.mode === 'date'));
      assert.ok(posted.some((m) => m.type === 'fleet' && m.mode === 'date'), 'a date-grouped model is posted');
      assert.ok(posted.some((m) => m.type === 'settings' && m.groupByOverride === 'date'));
    } finally {
      send({ type: 'setGroupBy', mode: 'auto' });
    }
  });

  it('posts the new robin setting when claudeNest.robin.animations changes', async function () {
    this.timeout(15000);
    const config = vscode.workspace.getConfiguration('claudeNest');
    const before = config.inspect<boolean>('robin.animations')?.globalValue;
    const { posted, send } = attachFakeView();
    send({ type: 'ready' });
    try {
      await config.update('robin.animations', false, vscode.ConfigurationTarget.Global);
      await until(() => posted.some((m) => m.type === 'settings' && m.robinAnimations === false));
      assert.ok(posted.some((m) => m.type === 'settings' && m.robinAnimations === false));
      await config.update('robin.animations', true, vscode.ConfigurationTarget.Global);
      const lastSettings = (): Posted | undefined => [...posted].reverse().find((m) => m.type === 'settings');
      await until(() => lastSettings()?.robinAnimations === true);
      assert.strictEqual(lastSettings()?.robinAnimations, true);
    } finally {
      await config.update('robin.animations', before, vscode.ConfigurationTarget.Global);
    }
  });

  it('chooses the configuration target the effective value comes from', () => {
    assert.strictEqual(robinConfigTarget(undefined), vscode.ConfigurationTarget.Global);
    assert.strictEqual(robinConfigTarget({}), vscode.ConfigurationTarget.Global);
    assert.strictEqual(robinConfigTarget({ workspaceValue: false }), vscode.ConfigurationTarget.Workspace);
    assert.strictEqual(
      robinConfigTarget({ workspaceValue: false, workspaceFolderValue: true }),
      vscode.ConfigurationTarget.WorkspaceFolder,
    );
  });
});
