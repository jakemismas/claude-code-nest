// A chat you move to Unsorted by hand stays there: the mark lives in the per-device local
// document, and the fleet grouping honors it over a later organize event.
import * as assert from 'assert';
import { FakeMemento } from './fakeMemento';
import { MetadataStore } from '../../store/metadataStore';
import { SCHEMA_VERSION, emptyLocalProjectMeta } from '../../store/schema';
import { handleWebviewDrop } from '../../dnd/webviewDropAdapter';
import { UNFILED_FOLDER_ID } from '../../model/folderTree';
import { ChatRecord } from '../../model/types';
import { buildFleetSections } from '../../fleet/groupModel';
import { FleetEntry } from '../../fleet/types';
import { fleetModelChats, fleetModelFolders } from '../../views/orgPanelModel';

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
});
