import * as assert from 'assert';
import * as vscode from 'vscode';

import {
  ORGANIZE_APPLY_COMMAND,
  ORGANIZE_PREVIEW_COMMAND,
  ORGANIZE_UNDO_COMMAND,
  OrganizeDeps,
  applyOrganize,
  undoOrganize,
} from '../../commands/organizeCommands';
import { parseNestConfig } from '../../fleet/nestConfig';
import { MetadataStore } from '../../store/metadataStore';

// Runs only in the Extension Development Host.
describe('organize commands (host)', () => {
  it('registers Preview, Apply and Undo on activation', async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension('jakemismas.claude-code-nest');
    assert.ok(ext, 'the extension is loaded');
    await ext.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const id of [ORGANIZE_PREVIEW_COMMAND, ORGANIZE_APPLY_COMMAND, ORGANIZE_UNDO_COMMAND]) {
      assert.ok(commands.includes(id), `${id} is registered`);
    }
  });
});

// Apply then Undo through the real command functions inside the host, with a store fake
// behind an asynchronous barrier that stands in for the reconcile step.
describe('organize Apply then Undo (host)', () => {
  it('writes only after the barrier settles and Undo restores the prior state', async function () {
    this.timeout(30000);
    const memento = new Map<string, unknown>();
    const store = new MetadataStore(
      {
        get: <T>(key: string): T | undefined => memento.get(key) as T | undefined,
        update: (key: string, value: unknown): Thenable<void> => {
          if (value === undefined) {
            memento.delete(key);
          } else {
            memento.set(key, value);
          }
          return Promise.resolve();
        },
        keys: () => Array.from(memento.keys()),
        setKeysForSync: () => undefined,
      },
      { deviceId: 'organize-host-test', debounceMs: 0 },
    );
    const order: string[] = [];
    const rules = parseNestConfig(JSON.stringify({ rules: [{ match: { role: 'qa' }, folder: 'QA', tags: ['qa'] }] })).config
      .rules;
    const key = 'c--organize-host';
    const deps: OrganizeDeps = {
      store,
      getProjectKey: () => key,
      getSubjects: () => [
        {
          sessionId: 'chat-1',
          title: 'One',
          name: 'One',
          ticket: null,
          role: 'qa',
          agent: '',
          cwd: null,
          fleetTitle: '',
          subfolder: '',
        },
      ],
      getRules: () => rules,
      getTagColors: () => ({}),
      homedir: '/h',
      barrier: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push('barrier');
      },
      refresh: () => {
        order.push('refresh');
      },
    };
    const applied = await applyOrganize(deps);
    assert.strictEqual(applied.kind, 'applied');
    assert.strictEqual(order[0], 'barrier');
    assert.ok(order.includes('refresh'));
    assert.strictEqual(Object.keys(store.getProjectMeta(key).folders).length, 1);
    const undone = await undoOrganize(deps);
    assert.strictEqual(undone.kind, 'undone');
    const meta = store.getProjectMeta(key);
    assert.deepStrictEqual(Object.keys(meta.folders), []);
    assert.deepStrictEqual(Object.keys(meta.tags), []);
    assert.strictEqual(meta.chats['chat-1'].folderId, null);
  });
});
