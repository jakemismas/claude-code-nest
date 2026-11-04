import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { setAttachableOverrideForTests } from '../../extension';
import { DEFAULT_TERMINAL_NAME, NOT_FOUND_WARNING, OPEN_IN_TERMINAL_COMMAND, attachInTerminal } from '../../launch/attachLauncher';

// Runs only in the Extension Development Host (npm run test:integration). It proves the
// real terminal factory gets the expected shell path and arguments, and that a missing
// claude binary raises one warning.

const ID = '3ffbf9b4-9d3a-4c98-8616-10b0bec221e4';

describe('open in terminal (host)', () => {
  let dir: string;
  let savedPath: string | undefined;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-attach-it-'));
    savedPath = process.env.PATH;
    process.env.PATH = dir;
  });

  after(() => {
    if (savedPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = savedPath;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('registers the command', async () => {
    const ext = vscode.extensions.getExtension('jakemismas.claude-code-nest');
    assert.ok(ext, 'extension is present');
    await ext.activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes(OPEN_IN_TERMINAL_COMMAND));
  });

  it('creates a terminal with the claude shell and attach arguments, then warns once when claude is missing', async () => {
    const warnings: string[] = [];
    const created: vscode.Terminal[] = [];
    const closed = new Promise<void>((resolve) => {
      const sub = vscode.window.onDidCloseTerminal((t) => {
        if (created.includes(t)) {
          sub.dispose();
          // The launcher's own listener runs for the same event; yield so it has run.
          setTimeout(resolve, 50);
        }
      });
    });
    const ok = attachInTerminal(ID, 'Attach test', {
      createTerminal: (options) => {
        const t = vscode.window.createTerminal({
          name: options.name,
          shellPath: options.shellPath,
          shellArgs: [...options.shellArgs],
        });
        created.push(t);
        return t;
      },
      onDidCloseTerminal: (listener) => vscode.window.onDidCloseTerminal((t) => listener(t)),
      warn: (m) => void warnings.push(m),
    });
    assert.strictEqual(ok, true);
    assert.strictEqual(created.length, 1);
    const opts = created[0].creationOptions as vscode.TerminalOptions;
    assert.strictEqual(opts.shellPath, 'claude');
    assert.deepStrictEqual(opts.shellArgs, ['attach', ID]);
    await closed;
    assert.deepStrictEqual(warnings, [NOT_FOUND_WARNING]);
  });

  describe('through the registered command', () => {
    let opened: vscode.Terminal[];
    let sub: vscode.Disposable;

    beforeEach(async () => {
      const ext = vscode.extensions.getExtension('jakemismas.claude-code-nest');
      assert.ok(ext, 'extension is present');
      await ext.activate();
      opened = [];
      sub = vscode.window.onDidOpenTerminal((t) => void opened.push(t));
      setAttachableOverrideForTests((id) => id === ID);
    });

    afterEach(() => {
      setAttachableOverrideForTests(null);
      sub.dispose();
      for (const t of opened) {
        t.dispose();
      }
    });

    it('creates the attach terminal for an attachable id', async () => {
      await vscode.commands.executeCommand(OPEN_IN_TERMINAL_COMMAND, ID, true);
      for (let i = 0; i < 100 && opened.length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.strictEqual(opened.length, 1);
      const opts = opened[0].creationOptions as vscode.TerminalOptions;
      assert.strictEqual(opts.shellPath, 'claude');
      assert.deepStrictEqual(opts.shellArgs, ['attach', ID]);
      assert.strictEqual(opts.name, DEFAULT_TERMINAL_NAME);
      assert.strictEqual(opened[0].name, DEFAULT_TERMINAL_NAME);
    });

    it('creates no terminal for a refused id', async () => {
      await vscode.commands.executeCommand(OPEN_IN_TERMINAL_COMMAND, 'abc; rm -rf', true);
      await new Promise((r) => setTimeout(r, 500));
      assert.strictEqual(opened.length, 0);
    });
  });
});
