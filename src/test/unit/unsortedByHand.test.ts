// A chat you move to Unsorted by hand stays there: the mark lives in the per-device local
// document, and the fleet grouping honors it over a later organize event.
import './vscodeStub';

import * as assert from 'assert';
import { FakeMemento } from './fakeMemento';
import { MetadataStore } from '../../store/metadataStore';
import { MAX_LEDGER_CHATS, SCHEMA_VERSION, emptyLocalProjectMeta } from '../../store/schema';
import { handleWebviewDrop } from '../../dnd/webviewDropAdapter';
import { UNFILED_FOLDER_ID } from '../../model/folderTree';
import { ChatRecord } from '../../model/types';
import { buildFleetSections } from '../../fleet/groupModel';
import { FleetEntry } from '../../fleet/types';
import { fleetModelChats, fleetModelFolders } from '../../views/orgPanelModel';
import { parseNestConfig } from '../../fleet/nestConfig';
import { RuleSubject } from '../../fleet/rules';
import { OrganizeDeps, previewOrganize } from '../../commands/organizeCommands';
import { FleetSections } from '../../fleet/groupModel';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { OrgPanelProvider } = require('../../views/orgPanelWebview') as {
  OrgPanelProvider: new (...args: unknown[]) => {
    setLayout(layout: unknown): void;
    getFleetSections(active: boolean): FleetSections;
  };
};

const KEY = 'proj';
const NOW = new Date(2026, 5, 17, 12, 0, 0).getTime();

function newStore(): { store: MetadataStore; memento: FakeMemento } {
  const memento = new FakeMemento();
  return { store: new MetadataStore(memento, { deviceId: 'dev', debounceMs: 0, now: () => NOW }), memento };
}

function drop(store: MetadataStore, chatIds: string[], targetId: string | undefined): Promise<number> {
  return handleWebviewDrop(
    { store, getProjectKey: () => KEY, refresh: () => undefined },
    { sourceChatIds: chatIds, targetKind: 'folder', targetId },
  );
}

function record(sessionId: string): ChatRecord {
  return {
    sessionId,
    title: sessionId,
    timestamp: NOW - 1000,
    filePath: '/x.jsonl',
    prNumber: null,
    prUrl: null,
    prRepository: null,
    gitBranch: null,
    cwd: null,
    leadingMessageUuids: [],
    messageCount: 1,
    firstMessageText: null,
    firstMessageRole: null,
    lastMessageText: null,
    lastMessageRole: null,
    tokenTotals: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    filesTouched: [],
    models: [],
  };
}

function organized(sessionId: string, folder: string): FleetEntry {
  return {
    sessionId, name: 'T-1 build', ticket: 'T-1', role: null, agent: 'build', launchedBy: '', cwd: '', client: '', folder,
    tags: [], stage: null, ended: false, outcome: null, firstAt: null, lastAt: null, isBackfill: false,
  };
}

describe('a chat moved to Unsorted by hand', () => {
  it('is marked on this device only, and filing it again clears the mark', async () => {
    const { store, memento } = newStore();
    store.upsertFolder(KEY, { id: 'f1', name: 'Mine', parentId: null, order: 0 });
    store.setChatFolder(KEY, 'c1', 'f1');
    await store.flush();

    assert.strictEqual(await drop(store, ['c1'], UNFILED_FOLDER_ID), 1);
    assert.ok(store.getUnsortedByHand(KEY).has('c1'), 'the drop on Unsorted marks the chat');
    assert.strictEqual(store.getProjectMeta(KEY).chats.c1.folderId, null);

    for (const key of new Set(memento.syncRegistrations.flat())) {
      assert.ok(!JSON.stringify(memento.get(key) ?? null).includes('unsortedByHand'), key + ' is synced and carries no mark');
    }
    assert.ok(!JSON.stringify(store.getProjectMeta(KEY)).includes('unsortedByHand'), 'the synced document has no mark');
    assert.strictEqual(store.getProjectMeta(KEY).schemaVersion, SCHEMA_VERSION);
    assert.strictEqual(store.getLocalProjectMeta(KEY).schemaVersion, SCHEMA_VERSION);

    await drop(store, ['c1'], 'f1');
    assert.ok(!store.getUnsortedByHand(KEY).has('c1'), 'filing the chat in a folder clears the mark');
  });

  it('keeps the mark when the orphan reconcile replaces the local document', async () => {
    const { store } = newStore();
    await drop(store, ['c2'], undefined);
    assert.ok(store.getUnsortedByHand(KEY).has('c2'), 'a drop on empty space unfiles by hand too');
    await store.putLocalProjectMeta(KEY, emptyLocalProjectMeta());
    assert.ok(store.getUnsortedByHand(KEY).has('c2'));
  });

  it('stays in Unsorted after a later fleet organize event names a folder for it', async () => {
    const { store } = newStore();
    await drop(store, ['c3'], UNFILED_FOLDER_ID);
    const meta = store.getProjectMeta(KEY);
    const build = (marks: ReadonlySet<string>) =>
      buildFleetSections({
        chats: fleetModelChats([record('c3')], meta, new Map(), marks),
        userFolders: fleetModelFolders(meta),
        fleet: { entries: [organized('c3', 'Fleet folder')], currentOrchestrator: null, pastOrchestrators: [] },
        statuses: new Map(),
        attachableIds: new Set(),
        queueRows: [],
        groupBy: 'tickets',
        workspaceRoot: '/ws',
        now: NOW,
        active: false,
      });
    const out = build(store.getUnsortedByHand(KEY));
    assert.deepStrictEqual(out.unsorted.map((r) => r.sessionId), ['c3']);
    assert.strictEqual(out.groups.length, 0);
    assert.strictEqual(build(new Set()).groups[0].label, 'Fleet folder', 'an unmarked chat still follows the fleet');
  });

  it('is read by the panel itself from the store, not only by the model', async () => {
    const { store } = newStore();
    store.setChatFolder(KEY, 'c4', null, true);
    const provider = new OrgPanelProvider(
      { fsPath: '/ext', scheme: 'file' },
      undefined,
      store,
      () => KEY,
      {},
      {},
      { get: (): undefined => undefined, set: (): void => undefined },
      { getMap: () => new Map(), markSeen: (): void => undefined, seedIfFirstRun: () => false },
      undefined,
    );
    (provider as unknown as { lastRecords: ChatRecord[] }).lastRecords = [record('c4'), record('c5')];
    const fleetState = { entries: [organized('c4', 'Fleet folder'), organized('c5', 'Fleet folder')], currentOrchestrator: null, pastOrchestrators: [] };
    provider.setLayout({ linkedFolders: [], groupBy: 'tickets', fleet: fleetState });
    const out = provider.getFleetSections(false);
    assert.deepStrictEqual(out.unsorted.map((r) => r.sessionId), ['c4']);
    assert.deepStrictEqual(out.groups.map((g) => g.rows.map((r) => r.sessionId)), [['c5']], 'the unmarked chat follows the fleet');
    const ctx = (provider as unknown as { placementContext(): { unsortedByHand?: ReadonlySet<string> } }).placementContext();
    assert.ok(ctx.unsortedByHand?.has('c4'), 'the classic panel placement gets the marks too');
  });

  it('is skipped by organize Preview, which still moves an unmarked chat', async () => {
    const { store } = newStore();
    const subject = (id: string): RuleSubject => ({
      sessionId: id, title: id, name: id, ticket: null, role: 'qa', agent: '', cwd: null, fleetTitle: '', subfolder: '',
    });
    const deps: OrganizeDeps = {
      store,
      getProjectKey: () => KEY,
      getSubjects: () => [subject('q1'), subject('q2')],
      getRules: () => parseNestConfig(JSON.stringify({ rules: [{ match: { role: 'qa' }, folder: 'QA' }] })).config.rules,
      getTagColors: () => ({}),
      homedir: '/h',
      barrier: async () => undefined,
      refresh: () => undefined,
    };
    store.setChatFolder(KEY, 'q1', null, true);
    const preview = previewOrganize(deps);
    assert.deepStrictEqual(preview.moves.map((m) => m.sessionId), ['q2']);
    assert.strictEqual(preview.skippedHandFiled, 1);
  });

  it('is seen at once, before its save lands, and flush waits for the save', async () => {
    const { store, memento } = newStore();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    memento.onUpdate = (key) => (key.startsWith('nest.local.v1') ? gate : Promise.resolve());
    store.setChatFolder(KEY, 'c6', null, true);
    assert.ok(store.getUnsortedByHand(KEY).has('c6'), 'the staged mark is visible before the save');
    let flushed = false;
    const flushing = store.flush().then(() => (flushed = true));
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(flushed, false, 'flush waits for the local save');
    release();
    await flushing;
    memento.onUpdate = null;
    assert.ok(JSON.stringify(memento.get('nest.local.v1::' + KEY)).includes('c6'), 'the mark is saved');
    assert.ok(store.getUnsortedByHand(KEY).has('c6'));
  });

  it('is cleared when any path files the chat, and filing an unmarked chat writes no local document', async () => {
    const { store, memento } = newStore();
    store.upsertFolder(KEY, { id: 'f1', name: 'Mine', parentId: null, order: 0 });
    const localWrites: string[] = [];
    memento.onUpdate = (key) => {
      if (key.startsWith('nest.local.v1')) {
        localWrites.push(key);
      }
      return Promise.resolve();
    };
    store.setChatFolder(KEY, 'c7', 'f1');
    await store.flush();
    assert.deepStrictEqual(localWrites, [], 'no mark, no local write');
    store.setChatFolder(KEY, 'c7', null, true);
    await store.flush();
    store.setChatFolder(KEY, 'c7', 'f1');
    await store.flush();
    assert.ok(!store.getUnsortedByHand(KEY).has('c7'), 'an Apply, Undo or promotion filing clears the mark');
    assert.ok(!JSON.stringify(memento.get('nest.local.v1::' + KEY) ?? {}).includes('c7'));
  });

  it('keeps the newest marks at the cap', async () => {
    const { store, memento } = newStore();
    const marks: { [id: string]: number } = {};
    for (let i = 0; i < MAX_LEDGER_CHATS; i += 1) {
      marks['old' + i] = i;
    }
    await memento.update('nest.local.v1::' + KEY, { ...emptyLocalProjectMeta(), unsortedByHand: marks });
    store.setChatFolder(KEY, 'fresh', null, true);
    await store.flush();
    const now = store.getUnsortedByHand(KEY);
    assert.strictEqual(now.size, MAX_LEDGER_CHATS);
    assert.ok(now.has('fresh'), 'the newest mark is kept');
    assert.ok(!now.has('old0'), 'the oldest mark goes');
  });
});
