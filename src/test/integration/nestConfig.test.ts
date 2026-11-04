import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { ConfigReloader } from '../../fleet/configSource';
import { watchFile } from '../../fleet/fleetWatcher';
import { ParsedNestConfig } from '../../fleet/nestConfig';
import { OPEN_LAYOUT_FILE_COMMAND, openLayoutFile } from '../../commands/openLayoutFile';
import { createOpenLayoutDeps } from '../../commands/openLayoutFileHost';

// Runs only in the Extension Development Host (npm run test:integration, human-run,
// needs a display). It proves a save to .nest/config.json reaches the parsed layout
// within 500 ms through the real vscode watcher, and that the Open Layout File command
// creates nothing on disk.

describe('nest config (host)', () => {
  it('reloads the layout within 500 ms of a save', async function () {
    this.timeout(15000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-config-it-'));
    fs.mkdirSync(path.join(dir, '.nest'));
    const file = path.join(dir, '.nest', 'config.json');
    fs.writeFileSync(file, '{"groupBy":"auto"}', 'utf8');

    let latest: ParsedNestConfig | undefined;
    const reloader = new ConfigReloader({ getPath: () => file, onChange: (p) => (latest = p) });
    const watch = watchFile(file, () => reloader.notifyFileEvent());
    try {
      await reloader.reload();
      assert.strictEqual(latest?.config.groupBy, 'auto');
      // Give the watcher time to register before the write.
      await new Promise((r) => setTimeout(r, 500));
      const savedAt = Date.now();
      fs.writeFileSync(file, '{"groupBy":"date"}', 'utf8');
      while (reloader.getParsed().config.groupBy !== 'date' && Date.now() - savedAt < 10000) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.strictEqual(reloader.getParsed().config.groupBy, 'date');
      assert.ok(Date.now() - savedAt <= 500, `reload took ${Date.now() - savedAt} ms`);
    } finally {
      watch.dispose();
      reloader.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('registers the open layout command on activation', async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension('jakemismas.claude-code-nest');
    assert.ok(ext, 'the extension is loaded');
    await ext.activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes(OPEN_LAYOUT_FILE_COMMAND));
  });

  it('opens an untitled starter at .nest/config.json and writes no file', async function () {
    this.timeout(15000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-layout-it-'));
    const target = path.join(dir, '.nest', 'config.json');
    const extensionUri = vscode.Uri.file(path.resolve(__dirname, '../../../'));
    try {
      await openLayoutFile(createOpenLayoutDeps(dir, extensionUri));
      assert.ok(!fs.existsSync(target), 'the command must not create the layout file');
      const doc = vscode.window.activeTextEditor?.document;
      assert.ok(doc?.isUntitled, 'an untitled editor opens');
      assert.strictEqual(doc?.uri.scheme, 'untitled');
      assert.strictEqual(doc?.uri.path, vscode.Uri.file(target).path, 'the editor sits at the config path');
      const parsed = JSON.parse(doc?.getText() ?? '{}') as { $schema?: string };
      assert.ok(parsed.$schema?.endsWith('schemas/nest-config.schema.json'), 'the starter includes a resolvable $schema');
      assert.ok(
        fs.existsSync(vscode.Uri.parse(parsed.$schema ?? '').fsPath),
        'the $schema reference resolves to the shipped file',
      );
    } finally {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opens the existing file when present', async function () {
    this.timeout(15000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-layout-it-'));
    fs.mkdirSync(path.join(dir, '.nest'));
    const target = path.join(dir, '.nest', 'config.json');
    fs.writeFileSync(target, '{"groupBy":"date"}', 'utf8');
    try {
      await openLayoutFile(createOpenLayoutDeps(dir, vscode.Uri.file(path.resolve(__dirname, '../../../'))));
      const doc = vscode.window.activeTextEditor?.document;
      assert.strictEqual(doc?.isUntitled, false);
      assert.strictEqual(doc?.uri.fsPath, vscode.Uri.file(target).fsPath);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
