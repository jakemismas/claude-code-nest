// Tests for reconcileAllProjects, the multi-project loop that runs on activation and window-state changes.
// A foreign merge with changed:false must still advance the shadow (acceptedKeys), and a changed:true
// merge must finalize the shadow from the post-flush re-stamped value (mergedKeys). Otherwise the same
// live value reads as foreign on every focus-gain and re-fires the warning toast.
// Import vscodeStub first so require('vscode') resolves before the command module loads.
import './vscodeStub';
import { vscodeHarness } from './vscodeStub';

import * as assert from 'assert';
import { MetadataStore } from '../../store/metadataStore';
import { ProjectMeta, ChatMeta, emptyProjectMeta, metaKeyFor } from '../../store/schema';
import { coerceShadow, shadowKeyFor, SyncShadow } from '../../store/reconcileSync';
import { FakeMemento } from './fakeMemento';
import {
  ExportImportDeps,
  reconcileAllProjects,
} from '../../commands/exportImportCommands';

const DEVICE = 'dev-this';
const OTHER = 'dev-other';
const NOW = 1_700_000_000_000;

function proj(overrides: Partial<ProjectMeta> = {}): ProjectMeta {
  return { ...emptyProjectMeta(DEVICE, NOW), ...overrides };
}

function chat(overrides: Partial<ChatMeta> = {}): ChatMeta {
  return {
    folderId: null,
    tags: [],
    links: [],
    updatedAt: NOW,
    deviceId: DEVICE,
    ...overrides,
  };
}

// Stores are disposed after each test: a debounceMs:0 store still drains on a real setTimeout,
// and an undisposed one can leak that drain into a later test.
const openStores: MetadataStore[] = [];

function makeDeps(
  mem: FakeMemento,
  storeNow = NOW,
): { deps: ExportImportDeps; store: MetadataStore; refreshes: () => number } {
  const store = new MetadataStore(mem, {
    deviceId: DEVICE,
    debounceMs: 0,
    now: () => storeNow,
  });
  openStores.push(store);
  let refreshes = 0;
  const deps: ExportImportDeps = {
    store,
    globalStorageUri: { fsPath: '/storage', scheme: 'file' } as never,
    flags: { get: () => undefined, update: () => Promise.resolve() },
    deviceId: DEVICE,
    refresh: () => {
      refreshes++;
    },
    now: () => NOW,
  };
  return { deps, store, refreshes: () => refreshes };
}

// Seed a project doc and its shadow directly so the first pass sees the intended diff.
function seedProjectAndShadow(
  mem: FakeMemento,
  pk: string,
  live: ProjectMeta,
  shadow: SyncShadow | null,
): void {
  mem.seed(metaKeyFor(pk), live);
  if (shadow) {
    mem.seed(shadowKeyFor(pk), shadow);
  }
}

function shadowOf(meta: ProjectMeta, deviceId = DEVICE): SyncShadow {
  return { meta: JSON.parse(JSON.stringify(meta)), deviceId };
}

describe('reconcileAllProjects orchestration loop', () => {
  beforeEach(() => vscodeHarness.reset());
  afterEach(async () => {
    while (openStores.length > 0) {
      await openStores.pop()!.dispose();
    }
  });

  it('no projects -> no toast, no refresh', async () => {
    const mem = new FakeMemento();
    const { deps, refreshes } = makeDeps(mem);
    await reconcileAllProjects(deps);
    assert.strictEqual(vscodeHarness.messages.length, 0);
    assert.strictEqual(refreshes(), 0);
  });

  it('adopts a project on first sight (no shadow) and writes the shadow', async () => {
    const mem = new FakeMemento();
    const live = proj({ updatedAt: 10 });
    seedProjectAndShadow(mem, 'c--a', live, null);
    const { deps, store } = makeDeps(mem);

    await reconcileAllProjects(deps);

    const shadow = coerceShadow(store.getSyncShadow('c--a')) as SyncShadow;
    assert.ok(shadow, 'a shadow was written on adopt');
    assert.deepStrictEqual(shadow.meta, live);
    assert.strictEqual(vscodeHarness.warnings().length, 0);
  });

  it('foreign SUBSET that dropped a local-only tag is RESTORED to the store (no silent data loss)', async () => {
    // Shadow: chat c has tags [x,y], with y added locally and never synced. Live: the other device
    // re-stamped the project and delivered c as a subset (tags [x], older stamp). The merge unions y back,
    // so the merged document equals the shadow (changed is false) while the store holds the lossy live
    // value. The store must still be rewritten (storeChanged), or y is lost permanently.
    const mem = new FakeMemento();
    const shadowMeta = proj({
      chats: { c: chat({ folderId: 'fLocal', tags: ['x', 'y'], updatedAt: 10 }) },
      updatedAt: 10,
    });
    const live = proj({
      chats: {
        c: chat({ folderId: 'fLocal', tags: ['x'], updatedAt: 5, deviceId: OTHER }),
      },
      updatedAt: 20,
      deviceId: OTHER,
    });
    seedProjectAndShadow(mem, 'c--a', live, shadowOf(shadowMeta));
    const { deps, store, refreshes } = makeDeps(mem, NOW + 7_000);

    await reconcileAllProjects(deps);

    // The store holds the restored document: y is back, re-stamped by this device.
    const persisted = store.getProjectMeta('c--a');
    assert.deepStrictEqual(
      [...persisted.chats.c.tags].sort(),
      ['x', 'y'],
      'the dropped local-only tag y was restored to the store',
    );
    assert.strictEqual(persisted.deviceId, DEVICE, 'restored doc re-stamped by THIS device');
    assert.strictEqual(persisted.updatedAt, NOW + 7_000, 'restored doc re-stamped at storeNow');
    assert.strictEqual(refreshes(), 1, 'one refresh after the restore write');
    assert.strictEqual(vscodeHarness.warnings().length, 0, 'no LWW warning for a pure restore');
    const shadow = coerceShadow(store.getSyncShadow('c--a')) as SyncShadow;
    assert.deepStrictEqual(shadow.meta, persisted, 'shadow finalized to the restored value');

    // A second reconcile must be silent: the restore converged.
    vscodeHarness.reset();
    const writesBeforeSecond = mem.updateCount;
    await reconcileAllProjects(deps);
    assert.strictEqual(mem.updateCount, writesBeforeSecond, 'second pass writes nothing');
    assert.strictEqual(vscodeHarness.messages.length, 0, 'second pass is silent');
  });

  it('foreign SUPERSET (storeChanged:false) advances the shadow with NO store write (acceptedKeys path)', async () => {
    // The other device added tag z via a newer chat record. The union equals live, so storeChanged is
    // false: no store write, and the shadow advances so the next poll is silent.
    const mem = new FakeMemento();
    const shadowMeta = proj({
      chats: { c: chat({ folderId: 'fLocal', tags: ['x'], updatedAt: 10 }) },
      updatedAt: 10,
    });
    const live = proj({
      chats: {
        c: chat({ folderId: 'fLocal', tags: ['x', 'z'], updatedAt: 20, deviceId: OTHER }),
      },
      updatedAt: 10,
    });
    seedProjectAndShadow(mem, 'c--a', live, shadowOf(shadowMeta));
    const { deps, store, refreshes } = makeDeps(mem);

    await reconcileAllProjects(deps);

    // The live doc is kept verbatim; a re-stamp would prove a write happened.
    const persisted = store.getProjectMeta('c--a');
    assert.deepStrictEqual(
      [...persisted.chats.c.tags].sort(),
      ['x', 'z'],
      'store already held the union; not rewritten',
    );
    assert.strictEqual(persisted.chats.c.deviceId, OTHER, 'no re-stamp write occurred');
    assert.strictEqual(refreshes(), 0, 'no refresh when nothing was written');
    const shadow = coerceShadow(store.getSyncShadow('c--a')) as SyncShadow;
    assert.deepStrictEqual(shadow.meta, persisted, 'shadow advanced to current live value');

    vscodeHarness.reset();
    const writesBeforeSecond = mem.updateCount;
    await reconcileAllProjects(deps);
    assert.strictEqual(mem.updateCount, writesBeforeSecond, 'second pass is unchanged: no write');
    assert.strictEqual(vscodeHarness.messages.length, 0, 'second pass is silent');
  });

  it('CHANGED:TRUE foreign-merge finalizes the shadow from the re-stamped value; toast does NOT re-fire', async () => {
    // Live gives c a different non-null home (LWW plus warning), a newer stamp and tag [y]. The merge is
    // changed:true, so the store is re-written and re-stamped at storeNow, then the shadow is finalized.
    const mem = new FakeMemento();
    const shadowMeta = proj({
      chats: { c: chat({ folderId: 'fLocal', tags: ['x'], updatedAt: 10 }) },
      updatedAt: 10,
    });
    const live = proj({
      chats: {
        c: chat({ folderId: 'fRemote', tags: ['y'], updatedAt: 50, deviceId: OTHER }),
      },
      updatedAt: 50,
      deviceId: OTHER,
    });
    seedProjectAndShadow(mem, 'c--a', live, shadowOf(shadowMeta));
    // storeNow differs from every record stamp so a stale pre-flush finalize shows as a mismatch.
    const { deps, store, refreshes } = makeDeps(mem, NOW + 7_000);

    await reconcileAllProjects(deps);

    assert.strictEqual(vscodeHarness.warnings().length, 1, 'one LWW warning on the conflict');
    assert.strictEqual(refreshes(), 1, 'one refresh after a changed merge');

    const persisted = store.getProjectMeta('c--a');
    assert.strictEqual(persisted.updatedAt, NOW + 7_000, 'store re-stamped the merged write');
    assert.deepStrictEqual([...persisted.chats.c.tags].sort(), ['x', 'y']);

    // The shadow must equal the post-flush live value, or the next poll reads it as foreign.
    const shadow = coerceShadow(store.getSyncShadow('c--a')) as SyncShadow;
    assert.deepStrictEqual(
      shadow.meta,
      persisted,
      'shadow finalized from the post-flush re-stamped live value',
    );

    vscodeHarness.reset();
    const writesBeforeSecond = mem.updateCount;
    await reconcileAllProjects(deps);
    assert.deepStrictEqual(
      vscodeHarness.warnings(),
      [],
      'the LWW warning must NOT re-fire on the next focus poll',
    );
    assert.strictEqual(mem.updateCount, writesBeforeSecond, 'second pass writes nothing');
  });

  it('a mixed batch: one adopt, one changed-foreign, one accepted-foreign, one unchanged', async () => {
    const mem = new FakeMemento();

    // P1: first sight is adopted.
    seedProjectAndShadow(mem, 'c--adopt', proj({ updatedAt: 1 }), null);

    // P2: a changed foreign merge with a folder conflict adds one conflict.
    const p2Shadow = proj({
      chats: { c: chat({ folderId: 'fLocal', tags: ['x'], updatedAt: 10 }) },
      updatedAt: 10,
    });
    const p2Live = proj({
      chats: { c: chat({ folderId: 'fRemote', tags: ['y'], updatedAt: 50, deviceId: OTHER }) },
      updatedAt: 50,
      deviceId: OTHER,
    });
    seedProjectAndShadow(mem, 'c--changed', p2Live, shadowOf(p2Shadow));

    // P3: a foreign superset (tag z added) is accepted with no store write, conflict or toast.
    // A foreign subset that dropped a local-only record is restored and written instead.
    const p3Shadow = proj({
      chats: { c: chat({ folderId: 'fLocal', tags: ['x'], updatedAt: 10 }) },
      updatedAt: 10,
    });
    const p3Live = proj({
      chats: { c: chat({ folderId: 'fLocal', tags: ['x', 'z'], updatedAt: 20, deviceId: OTHER }) },
      updatedAt: 10,
    });
    seedProjectAndShadow(mem, 'c--accepted', p3Live, shadowOf(p3Shadow));

    // P4: live equals shadow, so nothing is rewritten.
    const p4 = proj({ updatedAt: 30 });
    seedProjectAndShadow(mem, 'c--unchanged', p4, shadowOf(p4));

    const { deps, store, refreshes } = makeDeps(mem, NOW + 7_000);

    await reconcileAllProjects(deps);

    // One conflict across the batch gives one combined warning.
    assert.strictEqual(vscodeHarness.warnings().length, 1, 'one combined LWW warning');
    assert.strictEqual(refreshes(), 1, 'one refresh because at least one project changed');

    // Every project ends with shadow equal to live, so the next poll is silent.
    for (const pk of ['c--adopt', 'c--changed', 'c--accepted', 'c--unchanged']) {
      const shadow = coerceShadow(store.getSyncShadow(pk)) as SyncShadow;
      assert.ok(shadow, 'shadow exists for ' + pk);
      assert.deepStrictEqual(
        shadow.meta,
        store.getProjectMeta(pk),
        'shadow == live for ' + pk,
      );
    }

    // A second pass is silent and writes nothing.
    vscodeHarness.reset();
    const writesBeforeSecond = mem.updateCount;
    await reconcileAllProjects(deps);
    assert.strictEqual(vscodeHarness.messages.length, 0, 'second pass silent');
    assert.strictEqual(mem.updateCount, writesBeforeSecond, 'second pass writes nothing');
  });
});
