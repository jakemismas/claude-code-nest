import * as assert from 'assert';
import { MetadataStore } from '../../store/metadataStore';
import { metaKeyFor } from '../../store/schema';
import { FakeMemento } from './fakeMemento';

// Pure-logic unit tests for the MetadataStore against the FakeMemento double. The
// store depends only on the structural SyncMemento seam, so these run headless
// with no vscode import.

const DEVICE = 'dev-A';

// A controllable clock so per-record and per-project stamps are deterministic.
function clockFrom(start: number): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function makeStore(
  memento: FakeMemento,
  opts: { debounceMs?: number; now?: () => number } = {},
): MetadataStore {
  return new MetadataStore(memento, {
    deviceId: DEVICE,
    debounceMs: opts.debounceMs ?? 0,
    now: opts.now,
  });
}

const PK = 'c--proj-one';
const PK2 = 'c--proj-two';

describe('MetadataStore CRUD (folders, tags, chats, links)', () => {
  it('starts empty for an unknown project', () => {
    const store = makeStore(new FakeMemento());
    const meta = store.getProjectMeta(PK);
    assert.deepStrictEqual(meta.folders, {});
    assert.deepStrictEqual(meta.tags, {});
    assert.deepStrictEqual(meta.chats, {});
  });

  it('upserts and deletes a folder, detaching its member chats', async () => {
    const mem = new FakeMemento();
    const store = makeStore(mem);
    store.upsertFolder(PK, { id: 'f1', name: 'Inbox', parentId: null, order: 0 });
    store.setChatFolder(PK, 'chatX', 'f1');
    await store.flush();

    let meta = store.getProjectMeta(PK);
    assert.strictEqual(meta.folders.f1.name, 'Inbox');
    assert.strictEqual(meta.chats.chatX.folderId, 'f1');

    store.deleteFolder(PK, 'f1');
    await store.flush();
    meta = store.getProjectMeta(PK);
    assert.ok(!('f1' in meta.folders));
    // The chat is detached (unfiled), not deleted.
    assert.strictEqual(meta.chats.chatX.folderId, null);
  });

  it('upserts and deletes a tag, pruning it from chats', async () => {
    const mem = new FakeMemento();
    const store = makeStore(mem);
    store.upsertTag(PK, { id: 't1', label: 'urgent', color: '#aabbcc' });
    store.addChatTag(PK, 'chatX', 't1');
    await store.flush();
    assert.deepStrictEqual(store.getProjectMeta(PK).chats.chatX.tags, ['t1']);

    store.deleteTag(PK, 't1');
    await store.flush();
    const meta = store.getProjectMeta(PK);
    assert.ok(!('t1' in meta.tags));
    assert.deepStrictEqual(meta.chats.chatX.tags, []);
  });

  it('adds and removes chat tags idempotently', async () => {
    const mem = new FakeMemento();
    const store = makeStore(mem);
    store.addChatTag(PK, 'c', 't1');
    store.addChatTag(PK, 'c', 't1'); // duplicate is a no-op
    store.addChatTag(PK, 'c', 't2');
    await store.flush();
    assert.deepStrictEqual(store.getProjectMeta(PK).chats.c.tags, ['t1', 't2']);

    store.removeChatTag(PK, 'c', 't1');
    await store.flush();
    assert.deepStrictEqual(store.getProjectMeta(PK).chats.c.tags, ['t2']);
  });

  it('adds and removes links idempotently and by kind', async () => {
    const mem = new FakeMemento();
    const store = makeStore(mem);
    store.addLink(PK, 'a', { targetChatId: 'b', kind: 'parent' });
    store.addLink(PK, 'a', { targetChatId: 'b', kind: 'parent' }); // dup no-op
    store.addLink(PK, 'a', { targetChatId: 'b', kind: 'related' }); // different kind
    await store.flush();
    assert.deepStrictEqual(store.getProjectMeta(PK).chats.a.links, [
      { targetChatId: 'b', kind: 'parent' },
      { targetChatId: 'b', kind: 'related' },
    ]);

    store.removeLink(PK, 'a', 'b', 'parent');
    await store.flush();
    assert.deepStrictEqual(store.getProjectMeta(PK).chats.a.links, [
      { targetChatId: 'b', kind: 'related' },
    ]);
  });

  it('persists each project under its own meta key, isolated', async () => {
    const mem = new FakeMemento();
    const store = makeStore(mem);
    store.upsertTag(PK, { id: 't', label: 'one' });
    store.upsertTag(PK2, { id: 't', label: 'two' });
    await store.flush();
    assert.ok(mem.get(metaKeyFor(PK)) !== undefined);
    assert.ok(mem.get(metaKeyFor(PK2)) !== undefined);
    assert.strictEqual(store.getProjectMeta(PK).tags.t.label, 'one');
    assert.strictEqual(store.getProjectMeta(PK2).tags.t.label, 'two');
  });

  it('serves read-your-writes before a flush', () => {
    const store = makeStore(new FakeMemento(), { debounceMs: 150 });
    store.upsertFolder(PK, { id: 'f', name: 'Pending', parentId: null, order: 0 });
    // Not yet flushed, but the in-memory pending document is served.
    assert.strictEqual(store.getProjectMeta(PK).folders.f.name, 'Pending');
  });
});

describe('MetadataStore stamps (per-record and per-project updatedAt + deviceId)', () => {
  it('stamps the touched record and the project on a mutation', async () => {
    const clock = clockFrom(1000);
    const mem = new FakeMemento();
    const store = makeStore(mem, { now: clock.now });
    store.setChatFolder(PK, 'c', 'f');
    await store.flush();
    const meta = store.getProjectMeta(PK);
    assert.strictEqual(meta.chats.c.updatedAt, 1000);
    assert.strictEqual(meta.chats.c.deviceId, DEVICE);
    assert.strictEqual(meta.updatedAt, 1000);
    assert.strictEqual(meta.deviceId, DEVICE);
  });

  it('advances the stamp on a later mutation', async () => {
    const clock = clockFrom(1000);
    const mem = new FakeMemento();
    const store = makeStore(mem, { now: clock.now });
    store.addChatTag(PK, 'c', 't1');
    await store.flush();
    clock.advance(500);
    store.addChatTag(PK, 'c', 't2');
    await store.flush();
    assert.strictEqual(store.getProjectMeta(PK).chats.c.updatedAt, 1500);
    assert.strictEqual(store.getProjectMeta(PK).updatedAt, 1500);
  });
});

describe('MetadataStore sync registration (per-project keys, refresh-on-new-key)', () => {
  it('registers a project key for sync on first write', () => {
    const mem = new FakeMemento();
    const store = makeStore(mem);
    store.upsertTag(PK, { id: 't', label: 'x' });
    assert.deepStrictEqual(store.registeredSyncProjectKeys(), [PK]);
    assert.deepStrictEqual(mem.lastSyncRegistration(), [metaKeyFor(PK)]);
  });

  it('does NOT register a key merely for being read', () => {
    const mem = new FakeMemento();
    const store = makeStore(mem);
    store.getProjectMeta(PK);
    assert.deepStrictEqual(store.registeredSyncProjectKeys(), []);
    assert.strictEqual(mem.syncRegistrations.length, 0);
  });

  // The fit-patch-required assertion: when a NEW project key first appears, the
  // store calls setKeysForSync with the UNION of all known meta keys.
  it('refreshes setKeysForSync with the UNION when a new project key appears', () => {
    const mem = new FakeMemento();
    const store = makeStore(mem);

    store.upsertTag(PK, { id: 't', label: 'x' });
    assert.deepStrictEqual(new Set(mem.lastSyncRegistration()), new Set([metaKeyFor(PK)]));

    // A second, NEW project key triggers a refresh registering BOTH keys.
    store.upsertTag(PK2, { id: 't', label: 'y' });
    assert.deepStrictEqual(
      new Set(mem.lastSyncRegistration()),
      new Set([metaKeyFor(PK), metaKeyFor(PK2)]),
    );
    assert.deepStrictEqual(
      new Set(store.registeredSyncProjectKeys()),
      new Set([PK, PK2]),
    );
  });

  it('does NOT re-register when an already-known project key is written again', () => {
    const mem = new FakeMemento();
    const store = makeStore(mem);
    store.upsertTag(PK, { id: 't', label: 'x' });
    const afterFirst = mem.syncRegistrations.length;
    store.upsertTag(PK, { id: 't2', label: 'z' });
    assert.strictEqual(mem.syncRegistrations.length, afterFirst);
  });

  it('re-establishes the full sync union from a Memento that already holds meta keys (reload)', () => {
    const mem = new FakeMemento();
    // Simulate a prior session having persisted two projects.
    mem.seed(metaKeyFor(PK), { schemaVersion: 1, folders: {}, tags: {}, chats: {}, updatedAt: 1, deviceId: 'd' });
    mem.seed(metaKeyFor(PK2), { schemaVersion: 1, folders: {}, tags: {}, chats: {}, updatedAt: 1, deviceId: 'd' });
    // A non-meta and a local key must NOT be swept into the sync union.
    mem.seed('nest.local.v1::' + PK, { schemaVersion: 1, chats: {} });
    mem.seed('nest.deviceId.v1', 'dev-A');

    const store = makeStore(mem);
    assert.deepStrictEqual(
      new Set(store.registeredSyncProjectKeys()),
      new Set([PK, PK2]),
    );
    assert.deepStrictEqual(
      new Set(mem.lastSyncRegistration()),
      new Set([metaKeyFor(PK), metaKeyFor(PK2)]),
    );
  });

  it('never registers the LOCAL companion key for sync', async () => {
    const mem = new FakeMemento();
    const store = makeStore(mem);
    await store.setLocalChatState(PK, 'c', { missingSince: 1, archived: false, tombstone: false });
    // setLocalChatState writes the local key but must not touch sync registration.
    for (const reg of mem.syncRegistrations) {
      for (const k of reg) {
        assert.ok(!k.startsWith('nest.local.v1'), 'local key leaked into sync set: ' + k);
      }
    }
  });
});

describe('MetadataStore debounce + serialize (coalescing, last-writer-wins)', () => {
  it('coalesces rapid mutations into a SINGLE persisted write per project', async () => {
    const mem = new FakeMemento();
    const store = makeStore(mem, { debounceMs: 30 });
    store.addChatTag(PK, 'c', 't1');
    store.addChatTag(PK, 'c', 't2');
    store.addChatTag(PK, 'c', 't3');
    // Nothing persisted yet (still within the debounce window).
    assert.strictEqual(mem.updateCount, 0);
    await store.flush();
    // All three coalesced into exactly one update for the project.
    assert.strictEqual(mem.updateCount, 1);
    assert.deepStrictEqual(store.getProjectMeta(PK).chats.c.tags, ['t1', 't2', 't3']);
  });

  it('the last queued state wins after a burst (last-writer-wins in-process)', async () => {
    const mem = new FakeMemento();
    const store = makeStore(mem, { debounceMs: 20 });
    store.setChatFolder(PK, 'c', 'fA');
    store.setChatFolder(PK, 'c', 'fB');
    store.setChatFolder(PK, 'c', 'fC');
    await store.flush();
    assert.strictEqual(mem.updateCount, 1);
    assert.strictEqual(store.getProjectMeta(PK).chats.c.folderId, 'fC');
    // The persisted value matches the last write.
    const persisted = mem.get<{ chats: Record<string, { folderId: string }> }>(metaKeyFor(PK));
    assert.strictEqual(persisted?.chats.c.folderId, 'fC');
  });

  it('serializes writes so two projects in one burst both persist exactly once', async () => {
    const mem = new FakeMemento();
    const store = makeStore(mem, { debounceMs: 20 });
    store.upsertTag(PK, { id: 't', label: 'one' });
    store.upsertTag(PK2, { id: 't', label: 'two' });
    await store.flush();
    // One update each, batched on the single serialized chain.
    assert.strictEqual(mem.updateCount, 2);
    assert.strictEqual(store.getProjectMeta(PK).tags.t.label, 'one');
    assert.strictEqual(store.getProjectMeta(PK2).tags.t.label, 'two');
  });

  it('flush resolves cleanly when there is nothing pending', async () => {
    const store = makeStore(new FakeMemento(), { debounceMs: 20 });
    await store.flush();
    assert.ok(true);
  });
});

describe('MetadataStore mutation during an in-flight write (no silent data loss)', () => {
  // Reproduces the data-loss case: a mutation lands while the prior write is
  // in flight (the Memento update has not yet resolved). The drained value must
  // stay readable so the new mutation folds onto it rather than rebuilding from
  // the stale Memento and overwriting the drained change.
  function makeGate(): {
    gate: (key: string, value: unknown) => Promise<void>;
    release: () => void;
  } {
    let pending: Array<() => void> = [];
    return {
      gate: () =>
        new Promise<void>((resolve) => {
          pending.push(resolve);
        }),
      release: () => {
        const toRun = pending;
        pending = [];
        for (const r of toRun) {
          r();
        }
      },
    };
  }

  it('keeps an in-flight write readable so a late mutation does not drop it (debounceMs 0)', async () => {
    const mem = new FakeMemento();
    const { gate, release } = makeGate();
    mem.onUpdate = gate;
    const store = makeStore(mem, { debounceMs: 0 });

    store.addChatTag(PK, 'c', 't1');
    // Let the deferred drain fire (macro task) so the write is now in flight,
    // blocked on the gated update.
    await new Promise((r) => setTimeout(r, 0));

    // A second mutation lands while t1's write is still in flight.
    store.addChatTag(PK, 'c', 't2');

    // Release the in-flight update, then flush the second write to completion.
    release();
    // The second write's update is also gated; release as it drains.
    const flushed = store.flush();
    await new Promise((r) => setTimeout(r, 0));
    release();
    await flushed;

    mem.onUpdate = null;
    const persisted = mem.get<{ chats: Record<string, { tags: string[] }> }>(
      metaKeyFor(PK),
    );
    assert.deepStrictEqual(persisted?.chats.c.tags, ['t1', 't2']);
    assert.deepStrictEqual(store.getProjectMeta(PK).chats.c.tags, ['t1', 't2']);
  });

  it('reads the in-flight value (not the stale Memento) during an in-flight write', async () => {
    const mem = new FakeMemento();
    const { gate, release } = makeGate();
    mem.onUpdate = gate;
    const store = makeStore(mem, { debounceMs: 0 });

    store.addChatTag(PK, 'c', 't1');
    await new Promise((r) => setTimeout(r, 0)); // write now in flight, gated

    // Memento is still empty (update gated), but the read must see t1.
    assert.strictEqual(mem.get(metaKeyFor(PK)), undefined);
    assert.deepStrictEqual(store.getProjectMeta(PK).chats.c.tags, ['t1']);

    release();
    await store.flush();
    mem.onUpdate = null;
  });
});

describe('MetadataStore survives a rejected memento.update (no session-wide loss)', () => {
  // Reproduces the wedge: a single rejected memento.update must not poison the
  // serialized write chain. Before the fix, one transient rejection left the
  // chain permanently rejected, so every later write silently never persisted.
  it('a transient rejection does not wedge the chain; a later write to a DIFFERENT project still persists', async () => {
    const mem = new FakeMemento();
    let failNext = true;
    mem.onUpdate = async (): Promise<void> => {
      if (failNext) {
        failNext = false;
        throw new Error('transient storage fault');
      }
    };
    const store = makeStore(mem, { debounceMs: 0 });

    // First write hits the rejecting update.
    store.upsertTag(PK, { id: 't', label: 'first' });
    await store.flush();

    // A later write to a completely different project must still persist; the
    // chain must not be wedged.
    store.upsertTag(PK2, { id: 't', label: 'second' });
    await store.flush();

    mem.onUpdate = null;
    assert.strictEqual(
      store.getProjectMeta(PK2).tags.t.label,
      'second',
      'later write read-your-writes',
    );
    const persisted2 = mem.get<{ tags: Record<string, { label: string }> }>(
      metaKeyFor(PK2),
    );
    assert.strictEqual(
      persisted2?.tags.t.label,
      'second',
      'later write actually persisted after a prior rejection',
    );
  });

  it('re-stages a failed write so a retry persists it once storage recovers', async () => {
    const mem = new FakeMemento();
    let failNext = true;
    mem.onUpdate = async (): Promise<void> => {
      if (failNext) {
        failNext = false;
        throw new Error('transient storage fault');
      }
    };
    const store = makeStore(mem, { debounceMs: 0 });

    store.upsertTag(PK, { id: 't', label: 'kept' });
    // flush loops with bounded retries; the second drain round retries the
    // re-staged write against the now-recovered memento.
    await store.flush();

    mem.onUpdate = null;
    const persisted = mem.get<{ tags: Record<string, { label: string }> }>(
      metaKeyFor(PK),
    );
    assert.strictEqual(persisted?.tags.t.label, 'kept', 'failed write retried and persisted');
  });

  it('flush returns (does not hang) under a persistently failing memento', async () => {
    const mem = new FakeMemento();
    mem.onUpdate = async (): Promise<void> => {
      throw new Error('permanent storage fault');
    };
    const store = makeStore(mem, { debounceMs: 0 });
    store.upsertTag(PK, { id: 't', label: 'x' });
    // Must resolve within the bounded retry cap rather than spinning forever.
    await store.flush();
    // Read-your-writes still serves the change even though it never persisted.
    assert.strictEqual(store.getProjectMeta(PK).tags.t.label, 'x');
    mem.onUpdate = null;
  });
});

describe('MetadataStore forward-compat escrow round-trip (no foreign-machine clobber)', () => {
  it('mutating a newer-schema document preserves the unknown fields on persist', async () => {
    const mem = new FakeMemento();
    // A newer machine wrote a richer document with fields this build does not
    // understand, at a higher schemaVersion.
    mem.seed(metaKeyFor(PK), {
      schemaVersion: 99,
      folders: {},
      tags: {},
      chats: {},
      updatedAt: 1,
      deviceId: 'newer-machine',
      pinnedChats: ['c1'],
      futureWidget: { enabled: true },
    });

    const store = makeStore(mem);
    // The very first mutation on that project used to down-normalize and drop
    // pinnedChats/futureWidget, clobbering the newer machine on the next sync.
    store.upsertTag(PK, { id: 't', label: 'local-edit' });
    await store.flush();

    const persisted = mem.get<{
      schemaVersion: number;
      tags: Record<string, { label: string }>;
      pinnedChats?: unknown;
      futureWidget?: unknown;
      __unknown?: Record<string, unknown>;
    }>(metaKeyFor(PK));
    // Local edit landed.
    assert.strictEqual(persisted?.tags.t.label, 'local-edit');
    // The newer machine's unknown fields survived the round-trip via the escrow.
    assert.deepStrictEqual(persisted?.__unknown, {
      pinnedChats: ['c1'],
      futureWidget: { enabled: true },
    });
    // The higher schemaVersion is preserved, not down-stamped.
    assert.strictEqual(persisted?.schemaVersion, 99);
  });
});

describe('MetadataStore dispose() flushes staged writes', () => {
  it('persists a write staged within the debounce window on dispose', async () => {
    const mem = new FakeMemento();
    const store = makeStore(mem, { debounceMs: 150 });
    store.upsertTag(PK, { id: 't', label: 'kept' });
    assert.strictEqual(mem.updateCount, 0); // still debounced, nothing persisted

    await store.dispose();

    assert.strictEqual(mem.updateCount, 1);
    const persisted = mem.get<{ tags: Record<string, { label: string }> }>(
      metaKeyFor(PK),
    );
    assert.strictEqual(persisted?.tags.t.label, 'kept');
  });
});

describe('MetadataStore returns defensive copies on read', () => {
  it('getProjectMeta returns a clone; caller mutation cannot corrupt the store', async () => {
    const mem = new FakeMemento();
    const store = makeStore(mem);
    store.upsertFolder(PK, { id: 'f1', name: 'Real', parentId: null, order: 0 });
    await store.flush();

    const read1 = store.getProjectMeta(PK);
    read1.folders.f1.name = 'HACKED';
    (read1.folders as Record<string, unknown>).injected = {
      id: 'x',
      name: 'x',
      parentId: null,
      order: 0,
    };

    // A subsequent read and the persisted value are unaffected.
    const read2 = store.getProjectMeta(PK);
    assert.strictEqual(read2.folders.f1.name, 'Real');
    assert.ok(!('injected' in read2.folders));
    const persisted = mem.get<{ folders: Record<string, { name: string }> }>(
      metaKeyFor(PK),
    );
    assert.strictEqual(persisted?.folders.f1.name, 'Real');
    assert.ok(!('injected' in (persisted?.folders ?? {})));
  });

  it('getLocalProjectMeta returns a clone; caller mutation cannot corrupt the store', async () => {
    const mem = new FakeMemento();
    const store = makeStore(mem);
    await store.setLocalChatState(PK, 'c', {
      missingSince: 1,
      archived: false,
      tombstone: false,
    });

    const local1 = store.getLocalProjectMeta(PK);
    local1.chats.c.archived = true;
    (local1.chats as Record<string, unknown>).injected = {
      missingSince: 9,
      archived: true,
      tombstone: true,
    };

    const local2 = store.getLocalProjectMeta(PK);
    assert.strictEqual(local2.chats.c.archived, false);
    assert.ok(!('injected' in local2.chats));
  });
});

describe('MetadataStore local orphan-state writes are serialized (no concurrent read-modify-write loss)', () => {
  // Reproduces the latent data-loss case the synced path was hardened against but
  // the local path was not: setLocalChatState does a read-modify-write of the
  // whole local document. Under a real async memento.update, two overlapping
  // calls (the second issued before the first awaits) each used to read the live
  // document before the other's write landed, so the second whole-document put
  // overwrote the first chat's state. The fix serializes both calls' entire
  // read-modify-write through one chain so the second reads what the first
  // persisted.

  // An async memento whose update lands on a later microtask/macrotask turn,
  // mimicking context.globalState.update (which does not resolve synchronously).
  function asyncMemento(): FakeMemento {
    const mem = new FakeMemento();
    mem.onUpdate = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
    return mem;
  }

  it('two overlapping setLocalChatState calls (second not awaiting the first) both survive', async () => {
    const mem = asyncMemento();
    const store = makeStore(mem);

    // Issue both WITHOUT awaiting the first, the exact pattern that dropped c1.
    const p1 = store.setLocalChatState(PK, 'c1', { missingSince: 1, archived: false, tombstone: false });
    const p2 = store.setLocalChatState(PK, 'c2', { missingSince: 2, archived: false, tombstone: false });
    await Promise.all([p1, p2]);

    const local = store.getLocalProjectMeta(PK);
    assert.ok('c1' in local.chats, 'c1 must survive (was dropped before serialization)');
    assert.ok('c2' in local.chats, 'c2 must survive');
    assert.strictEqual(local.chats.c1.missingSince, 1);
    assert.strictEqual(local.chats.c2.missingSince, 2);
  });

  it('a burst of fire-and-forget setLocalChatState calls all persist', async () => {
    const mem = asyncMemento();
    const store = makeStore(mem);

    const ids = ['c1', 'c2', 'c3', 'c4', 'c5'];
    const writes = ids.map((id, i) =>
      store.setLocalChatState(PK, id, { missingSince: i + 1, archived: false, tombstone: false }),
    );
    await Promise.all(writes);
    await store.flushLocal();

    const local = store.getLocalProjectMeta(PK);
    for (const id of ids) {
      assert.ok(id in local.chats, `${id} must survive the burst`);
    }
    assert.deepStrictEqual(Object.keys(local.chats).sort(), ids.slice().sort());
  });

  it('putLocalProjectMeta and setLocalChatState do not interleave (last queued op observes prior)', async () => {
    const mem = asyncMemento();
    const store = makeStore(mem);

    // Seed two chats, replace the whole doc with one chat, then add a third.
    const pa = store.setLocalChatState(PK, 'a', { missingSince: 1, archived: false, tombstone: false });
    const pb = store.setLocalChatState(PK, 'b', { missingSince: 2, archived: false, tombstone: false });
    const pPut = store.putLocalProjectMeta(PK, {
      schemaVersion: 1,
      chats: { only: { missingSince: 9, archived: true, tombstone: false } },
    });
    const pc = store.setLocalChatState(PK, 'c', { missingSince: 3, archived: false, tombstone: false });
    await Promise.all([pa, pb, pPut, pc]);

    const local = store.getLocalProjectMeta(PK);
    // The put replaced a/b with `only`; the trailing set added `c` on top of the
    // put's result (it read what the put persisted), so a/b are gone, only+c remain.
    assert.ok(!('a' in local.chats));
    assert.ok(!('b' in local.chats));
    assert.ok('only' in local.chats);
    assert.ok('c' in local.chats, 'the trailing set must fold onto the put result');
  });

  it('flushLocal resolves even when a local update rejects, and a later local write still persists', async () => {
    const mem = new FakeMemento();
    let failNext = true;
    mem.onUpdate = async (): Promise<void> => {
      if (failNext) {
        failNext = false;
        throw new Error('transient local storage fault');
      }
    };
    const store = makeStore(mem);

    // The first local write rejects; its caller promise rejects, but the chain
    // must not be wedged.
    await assert.rejects(
      store.setLocalChatState(PK, 'x', { missingSince: 1, archived: false, tombstone: false }),
    );

    // A later local write to the same project still persists.
    await store.setLocalChatState(PK, 'y', { missingSince: 2, archived: false, tombstone: false });
    await store.flushLocal();
    mem.onUpdate = null;

    const local = store.getLocalProjectMeta(PK);
    assert.ok('y' in local.chats, 'later local write persisted after a prior rejection');
  });
});

describe('MetadataStore putProjectMeta (whole-document replace primitive)', () => {
  it('replaces the document and re-stamps at the project level', async () => {
    const clock = clockFrom(1000);
    const mem = new FakeMemento();
    const store = makeStore(mem, { now: clock.now });
    store.upsertTag(PK, { id: 'old', label: 'old-tag' });
    await store.flush();

    clock.advance(500);
    store.putProjectMeta(PK, {
      schemaVersion: 1,
      folders: { f9: { id: 'f9', name: 'New', parentId: null, order: 0 } },
      tags: { t9: { id: 't9', label: 'new-tag' } },
      chats: { c9: { folderId: 'f9', tags: ['t9'], links: [], updatedAt: 1, deviceId: 'other' } },
      updatedAt: 1,
      deviceId: 'other',
    });
    await store.flush();

    const meta = store.getProjectMeta(PK);
    // The supplied document fully replaces the prior contents.
    assert.ok(!('old' in meta.tags));
    assert.strictEqual(meta.tags.t9.label, 'new-tag');
    assert.strictEqual(meta.folders.f9.name, 'New');
    assert.strictEqual(meta.chats.c9.folderId, 'f9');
    // The project-level stamp is re-written to this device and clock, not the
    // supplied document's stamp.
    assert.strictEqual(meta.updatedAt, 1500);
    assert.strictEqual(meta.deviceId, DEVICE);
  });

  it('does not alias the caller-supplied collections into the store', async () => {
    const mem = new FakeMemento();
    const store = makeStore(mem);
    const doc = {
      schemaVersion: 1,
      folders: { f1: { id: 'f1', name: 'A', parentId: null, order: 0 } },
      tags: {},
      chats: {},
      updatedAt: 1,
      deviceId: 'other',
    };
    store.putProjectMeta(PK, doc);
    await store.flush();

    // Mutating the caller's object after the put must not change the store.
    doc.folders.f1.name = 'MUTATED-AFTER-PUT';
    assert.strictEqual(store.getProjectMeta(PK).folders.f1.name, 'A');
  });
});

describe('MetadataStore curation scalar setters (Slice 3: star, archive, folder color)', () => {
  it('setChatStarred sets the flag, stamps the record, and coalesces into one write', async () => {
    const clock = clockFrom(1000);
    const mem = new FakeMemento();
    const store = makeStore(mem, { now: clock.now });
    store.setChatStarred(PK, 'c', true);
    await store.flush();
    let meta = store.getProjectMeta(PK);
    assert.strictEqual(meta.chats.c.starred, true);
    assert.strictEqual(meta.chats.c.updatedAt, 1000);
    assert.strictEqual(meta.chats.c.deviceId, DEVICE);

    clock.advance(500);
    store.setChatStarred(PK, 'c', false);
    await store.flush();
    meta = store.getProjectMeta(PK);
    assert.strictEqual(meta.chats.c.starred, false);
    assert.strictEqual(meta.chats.c.updatedAt, 1500);
  });

  it('setChatArchived couples archivedAt to the flag (set on archive, cleared on unarchive)', async () => {
    const clock = clockFrom(2000);
    const mem = new FakeMemento();
    const store = makeStore(mem, { now: clock.now });
    store.setChatArchived(PK, 'c', true);
    await store.flush();
    let meta = store.getProjectMeta(PK);
    assert.strictEqual(meta.chats.c.userArchived, true);
    assert.strictEqual(meta.chats.c.archivedAt, 2000);

    clock.advance(100);
    store.setChatArchived(PK, 'c', false);
    await store.flush();
    meta = store.getProjectMeta(PK);
    assert.strictEqual(meta.chats.c.userArchived, false);
    // archivedAt is cleared on unarchive so it never lingers.
    assert.strictEqual('archivedAt' in meta.chats.c, false);
  });

  it('setFolderColor sets and clears the color on an existing folder', async () => {
    const mem = new FakeMemento();
    const store = makeStore(mem);
    store.upsertFolder(PK, { id: 'f1', name: 'F', parentId: null, order: 0 });
    // Use a strict #rrggbb color: it must survive the flush + re-read round trip
    // (the read path re-normalizes through migrateProjectMeta, which drops any
    // non-#rrggbb color).
    store.setFolderColor(PK, 'f1', '#aabbcc');
    await store.flush();
    assert.strictEqual(store.getProjectMeta(PK).folders.f1.color, '#aabbcc');

    store.setFolderColor(PK, 'f1', null);
    await store.flush();
    assert.strictEqual('color' in store.getProjectMeta(PK).folders.f1, false);
  });

  it('setFolderColor on an unknown folder is a no-op (does not create a phantom folder)', async () => {
    const mem = new FakeMemento();
    const store = makeStore(mem);
    store.setFolderColor(PK, 'ghost', '#abc');
    await store.flush();
    assert.strictEqual('ghost' in store.getProjectMeta(PK).folders, false);
  });

  it('star and archive on the same chat coalesce into one coherent record', async () => {
    const mem = new FakeMemento();
    const store = makeStore(mem);
    store.setChatStarred(PK, 'c', true);
    store.setChatArchived(PK, 'c', true);
    await store.flush();
    const chat = store.getProjectMeta(PK).chats.c;
    assert.strictEqual(chat.starred, true);
    assert.strictEqual(chat.userArchived, true);
    assert.strictEqual(typeof chat.archivedAt, 'number');
  });
});

// Defense-in-depth: the store mutation methods take a caller-supplied record id
// (chat/folder/tag) and index or re-key the folders/tags/chats maps with it. The
// normalize/merge boundaries already gate ids, but the write-path clones use
// JSON.parse(JSON.stringify(...)), which re-attaches Object.prototype to those
// maps; on a normal-prototype map an unsafe id like '__proto__' would write onto
// Object.prototype globally. These tests assert the SINK gate: an unsafe id is a
// safe no-op and Object.prototype is never polluted, while a valid id still works.
describe('MetadataStore record-id sink gating (prototype-pollution backstop)', () => {
  const UNSAFE_IDS = ['__proto__', 'constructor', 'prototype', '../x', '', 'a:b'];

  // Snapshot the bare-Object props the polluting payloads would write, so a leak
  // is detectable on a fresh {} after each mutation.
  function assertProtoClean(): void {
    const bare = {} as Record<string, unknown>;
    assert.strictEqual(bare.folderId, undefined, 'Object.prototype.folderId leaked');
    assert.strictEqual(bare.color, undefined, 'Object.prototype.color leaked');
    assert.strictEqual(bare.name, undefined, 'Object.prototype.name leaked');
    assert.strictEqual(bare.starred, undefined, 'Object.prototype.starred leaked');
    assert.strictEqual(bare.userArchived, undefined, 'Object.prototype.userArchived leaked');
  }

  it('upsertFolder with an unsafe id is a no-op and does not pollute the prototype', async () => {
    const store = makeStore(new FakeMemento());
    for (const id of UNSAFE_IDS) {
      store.upsertFolder(PK, { id, name: 'Polluter', parentId: null, order: 0 });
    }
    await store.flush();
    assert.deepStrictEqual(Object.keys(store.getProjectMeta(PK).folders), []);
    assertProtoClean();
  });

  it('upsertTag with an unsafe id is a no-op and does not pollute the prototype', async () => {
    const store = makeStore(new FakeMemento());
    for (const id of UNSAFE_IDS) {
      store.upsertTag(PK, { id, label: 'Polluter' });
    }
    await store.flush();
    assert.deepStrictEqual(Object.keys(store.getProjectMeta(PK).tags), []);
    assertProtoClean();
  });

  it('setChatFolder with an unsafe chatId is a no-op (creates no phantom chat)', async () => {
    const store = makeStore(new FakeMemento());
    for (const id of UNSAFE_IDS) {
      store.setChatFolder(PK, id, 'f1');
    }
    await store.flush();
    assert.deepStrictEqual(Object.keys(store.getProjectMeta(PK).chats), []);
    assertProtoClean();
  });

  it('setChatFolder with an unsafe folderId reference is a no-op', async () => {
    const store = makeStore(new FakeMemento());
    store.setChatFolder(PK, 'good-chat', '__proto__');
    await store.flush();
    // The chat was NOT created from a mutation that would store a prototype-name
    // folderId reference (the whole call is gated before ensureChat).
    assert.deepStrictEqual(Object.keys(store.getProjectMeta(PK).chats), []);
    assertProtoClean();
  });

  it('addChatTag/removeChatTag with an unsafe chatId or tagId is a no-op', async () => {
    const store = makeStore(new FakeMemento());
    for (const id of UNSAFE_IDS) {
      store.addChatTag(PK, id, 't1');
      store.addChatTag(PK, 'good-chat', id);
      store.removeChatTag(PK, id, 't1');
    }
    await store.flush();
    assert.deepStrictEqual(Object.keys(store.getProjectMeta(PK).chats), []);
    assertProtoClean();
  });

  it('addLink/removeLink with an unsafe chatId or targetChatId is a no-op', async () => {
    const store = makeStore(new FakeMemento());
    for (const id of UNSAFE_IDS) {
      store.addLink(PK, id, { targetChatId: 'good-target', kind: 'related' });
      store.addLink(PK, 'good-chat', { targetChatId: id, kind: 'related' });
      store.removeLink(PK, id, 'good-target', 'related');
    }
    await store.flush();
    assert.deepStrictEqual(Object.keys(store.getProjectMeta(PK).chats), []);
    assertProtoClean();
  });

  it('setChatStarred/setChatArchived with an unsafe chatId is a no-op', async () => {
    const store = makeStore(new FakeMemento());
    for (const id of UNSAFE_IDS) {
      store.setChatStarred(PK, id, true);
      store.setChatArchived(PK, id, true);
    }
    await store.flush();
    assert.deepStrictEqual(Object.keys(store.getProjectMeta(PK).chats), []);
    assertProtoClean();
  });

  it('setFolderColor with an unsafe folderId is a no-op (no prototype color write)', async () => {
    const store = makeStore(new FakeMemento());
    for (const id of UNSAFE_IDS) {
      store.setFolderColor(PK, id, '#aabbcc');
    }
    await store.flush();
    assert.deepStrictEqual(Object.keys(store.getProjectMeta(PK).folders), []);
    assertProtoClean();
  });

  it('deleteFolder/deleteTag with an unsafe id is a no-op (no prototype delete)', async () => {
    const store = makeStore(new FakeMemento());
    store.upsertFolder(PK, { id: 'f1', name: 'Inbox', parentId: null, order: 0 });
    store.upsertTag(PK, { id: 't1', label: 'urgent' });
    await store.flush();
    for (const id of UNSAFE_IDS) {
      store.deleteFolder(PK, id);
      store.deleteTag(PK, id);
    }
    await store.flush();
    const meta = store.getProjectMeta(PK);
    assert.deepStrictEqual(Object.keys(meta.folders), ['f1']);
    assert.deepStrictEqual(Object.keys(meta.tags), ['t1']);
    assertProtoClean();
  });

  it('survives an unsafe id driven through a genuine own __proto__ folder record', async () => {
    // Model the attacker payload precisely: a folder record whose id field is a
    // real own '__proto__' value (set via defineProperty, since a literal would set
    // the prototype). upsertFolder must reject it at the sink.
    const evil: { id: string; name: string; parentId: null; order: number } = {
      id: 'placeholder',
      name: 'Polluter',
      parentId: null,
      order: 0,
    };
    Object.defineProperty(evil, 'id', { value: '__proto__', enumerable: true });
    const store = makeStore(new FakeMemento());
    store.upsertFolder(PK, evil);
    await store.flush();
    assert.deepStrictEqual(Object.keys(store.getProjectMeta(PK).folders), []);
    assertProtoClean();
  });

  it('a valid UUID/minted id still mutates correctly after the gate', async () => {
    const uuid = '0a1b2c3d-4e5f-6789-abcd-ef0123456789';
    const folderId = 'f-18f0a-1a2b3c4d5e6f';
    const tagId = 't-18f0a-9a8b7c6d5e4f';
    const store = makeStore(new FakeMemento());
    store.upsertFolder(PK, { id: folderId, name: 'Inbox', parentId: null, order: 0 });
    store.upsertTag(PK, { id: tagId, label: 'urgent' });
    store.setChatFolder(PK, uuid, folderId);
    store.addChatTag(PK, uuid, tagId);
    store.setChatStarred(PK, uuid, true);
    store.setFolderColor(PK, folderId, '#aabbcc');
    await store.flush();

    const meta = store.getProjectMeta(PK);
    assert.deepStrictEqual(Object.keys(meta.folders), [folderId]);
    assert.deepStrictEqual(Object.keys(meta.tags), [tagId]);
    assert.deepStrictEqual(Object.keys(meta.chats), [uuid]);
    assert.strictEqual(meta.chats[uuid].folderId, folderId);
    assert.deepStrictEqual(meta.chats[uuid].tags, [tagId]);
    assert.strictEqual(meta.chats[uuid].starred, true);
    assert.strictEqual(meta.folders[folderId].color, '#aabbcc');
  });

  it('getProjectMeta hands readers ordinary JSON maps (prior public contract)', async () => {
    // The null-prototype backstop is applied to the INTERNAL staging copy, NOT the
    // reader copy, so a consumer's deepStrictEqual against a bare {} still holds and
    // the maps serialize as ordinary objects.
    const store = makeStore(new FakeMemento());
    store.upsertFolder(PK, { id: 'f1', name: 'Inbox', parentId: null, order: 0 });
    await store.flush();
    const meta = store.getProjectMeta(PK);
    assert.strictEqual(Object.getPrototypeOf(meta.folders), Object.prototype);
    assert.deepStrictEqual(Object.keys(meta.folders), ['f1']);
  });
});
