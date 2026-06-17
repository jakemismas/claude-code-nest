// Orchestration-level tests for reconcileAllProjects -- the multi-project loop
// that actually runs on activation and onDidChangeWindowState. The pure per-project
// decision (reconcileProjectSync) is covered by reconcileSync.test.ts; this file
// pins the loop's hardest logic: the acceptedKeys-vs-mergedKeys split (lines
// 244-309 of exportImportCommands.ts).
//
// The hazard guarded here (per the code comments at lines 246-253 and 280-283, and
// the TESTING.md step-4 manual check): a foreign-merge that produces changed:false
// must STILL advance the shadow (acceptedKeys), and a changed:true merge must
// finalize the shadow from the POST-FLUSH re-stamped value (mergedKeys). Either
// gap re-classifies the same live value as foreign on the next focus poll, re-runs
// the merge, and re-fires the LWW warning toast on EVERY focus-gain.
//
// vscodeStub MUST be imported first so require('vscode') resolves before the
// command module's top-level import runs.
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

// Stores created per test, disposed in afterEach. A MetadataStore with
// debounceMs:0 still drains its writes on a real setTimeout(0) macro-task; an
// undisposed store can leak that drain into a later test and make these
// reconcile assertions (which await a SECOND reconcile pass) order-dependent.
// Disposing every store after each test cancels the timer and flushes, so the
// data-loss regression guard is deterministic regardless of file/run order.
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

// Seed a project doc and its shadow directly so the reconcile sees the desired
// diff classification on the first pass.
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
    // Dispose every store this test created so no real setTimeout drain leaks
    // into a later test (keeps the data-loss regression guard order-independent).
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
    // Shadow: chat c has tags [x,y], home fLocal, stamped by THIS device. y is a
    // local-only tag this device added and never synced. Live: the OTHER device
    // re-stamped the project (deviceId=OTHER) and delivered chat c as a strict
    // SUBSET -- tags [x] only, same home, OLDER per-chat stamp. Merging live (file)
    // onto the shadow (base) unions y back, so the merged document equals the SHADOW
    // (result.changed is false). The STORE, however, holds the lossy live value, so
    // the reconcile MUST write the restored document (storeChanged). The historical
    // bug gated the write on result.changed, skipped it, and then advanced the
    // shadow to the lossy live value -- losing y permanently. This test pins the
    // restore: y comes back, re-stamped by THIS device.
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

    // The store now holds the RESTORED document: y is back, re-stamped by THIS
    // device at storeNow (the foreign OTHER project stamp is gone).
    const persisted = store.getProjectMeta('c--a');
    assert.deepStrictEqual(
      [...persisted.chats.c.tags].sort(),
      ['x', 'y'],
      'the dropped local-only tag y was restored to the store',
    );
    assert.strictEqual(persisted.deviceId, DEVICE, 'restored doc re-stamped by THIS device');
    assert.strictEqual(persisted.updatedAt, NOW + 7_000, 'restored doc re-stamped at storeNow');
    // A restore is a real change -> exactly one refresh.
    assert.strictEqual(refreshes(), 1, 'one refresh after the restore write');
    // Same home on both sides -> no folderId conflict -> no LWW warning.
    assert.strictEqual(vscodeHarness.warnings().length, 0, 'no LWW warning for a pure restore');
    // The shadow is finalized to the post-flush restored value.
    const shadow = coerceShadow(store.getSyncShadow('c--a')) as SyncShadow;
    assert.deepStrictEqual(shadow.meta, persisted, 'shadow finalized to the restored value');

    // The smoking gun: a SECOND reconcile (next focus) must be fully silent and
    // touch nothing -- the restore converged (live now equals the shadow).
    vscodeHarness.reset();
    const writesBeforeSecond = mem.updateCount;
    await reconcileAllProjects(deps);
    assert.strictEqual(mem.updateCount, writesBeforeSecond, 'second pass writes nothing');
    assert.strictEqual(vscodeHarness.messages.length, 0, 'second pass is silent');
  });

  it('foreign SUPERSET (storeChanged:false) advances the shadow with NO store write (acceptedKeys path)', async () => {
    // The genuine no-write foreign case: project stayed ours, but the OTHER device
    // ADDED tag z via a newer chat record. The union equals live (nothing local-only
    // was dropped), so storeChanged is false: no store write, the shadow simply
    // advances so the next poll is silent.
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

    // No store write: the live doc (foreign superset) is retained verbatim, still
    // stamped by OTHER at the chat record (a re-stamp would prove a write happened).
    const persisted = store.getProjectMeta('c--a');
    assert.deepStrictEqual(
      [...persisted.chats.c.tags].sort(),
      ['x', 'z'],
      'store already held the union; not rewritten',
    );
    assert.strictEqual(persisted.chats.c.deviceId, OTHER, 'no re-stamp write occurred');
    assert.strictEqual(refreshes(), 0, 'no refresh when nothing was written');
    // The shadow advanced to the current live value.
    const shadow = coerceShadow(store.getSyncShadow('c--a')) as SyncShadow;
    assert.deepStrictEqual(shadow.meta, persisted, 'shadow advanced to current live value');

    // Next focus poll: silent, writes nothing.
    vscodeHarness.reset();
    const writesBeforeSecond = mem.updateCount;
    await reconcileAllProjects(deps);
    assert.strictEqual(mem.updateCount, writesBeforeSecond, 'second pass is unchanged: no write');
    assert.strictEqual(vscodeHarness.messages.length, 0, 'second pass is silent');
  });

  it('CHANGED:TRUE foreign-merge finalizes the shadow from the re-stamped value; toast does NOT re-fire', async () => {
    // Shadow: chat c filed in fLocal, tagged [x], by THIS device.
    // Live: OTHER device gave c a DIFFERENT non-null home fRemote (a same-scalar
    // conflict -> LWW + warning), newer stamp, and tag [y] (not our x). The merge is
    // changed:true (adds y, possibly flips home), so the store is re-written and
    // re-stamped at storeNow, then the shadow is finalized from the post-flush value.
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
    // storeNow distinct from every record stamp so a stale (pre-flush) finalize is
    // observable as a shadow != live mismatch.
    const { deps, store, refreshes } = makeDeps(mem, NOW + 7_000);

    await reconcileAllProjects(deps);

    // Exactly one LWW warning (the fLocal vs fRemote conflict).
    assert.strictEqual(vscodeHarness.warnings().length, 1, 'one LWW warning on the conflict');
    assert.strictEqual(refreshes(), 1, 'one refresh after a changed merge');

    // The merge wrote the store and re-stamped it at storeNow.
    const persisted = store.getProjectMeta('c--a');
    assert.strictEqual(persisted.updatedAt, NOW + 7_000, 'store re-stamped the merged write');
    // Tags unioned (x kept, y added); a changed merge restored our x.
    assert.deepStrictEqual([...persisted.chats.c.tags].sort(), ['x', 'y']);

    // The shadow must equal the POST-FLUSH re-stamped live value, not the pre-flush
    // merge result. A finalize from the wrong (pre-restamp) value would leave a
    // mismatch that the next poll re-classifies as foreign.
    const shadow = coerceShadow(store.getSyncShadow('c--a')) as SyncShadow;
    assert.deepStrictEqual(
      shadow.meta,
      persisted,
      'shadow finalized from the post-flush re-stamped live value',
    );

    // Smoking gun: the immediate next focus reconcile is silent and writes nothing.
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

    // P1: first sight -> adopt.
    seedProjectAndShadow(mem, 'c--adopt', proj({ updatedAt: 1 }), null);

    // P2: changed:true foreign with a folder conflict -> contributes one conflict.
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

    // P3: storeChanged:false foreign SUPERSET (the OTHER device ADDED tag z via a
    // newer chat record while the project stayed ours) -> accepted, no store write,
    // no conflict, no toast. (A foreign SUBSET that dropped a local-only record is
    // NOT a no-op: it is restored and written -- see the dedicated restore test.)
    const p3Shadow = proj({
      chats: { c: chat({ folderId: 'fLocal', tags: ['x'], updatedAt: 10 }) },
      updatedAt: 10,
    });
    const p3Live = proj({
      chats: { c: chat({ folderId: 'fLocal', tags: ['x', 'z'], updatedAt: 20, deviceId: OTHER }) },
      updatedAt: 10,
    });
    seedProjectAndShadow(mem, 'c--accepted', p3Live, shadowOf(p3Shadow));

    // P4: live equals shadow -> unchanged, no shadow rewrite.
    const p4 = proj({ updatedAt: 30 });
    seedProjectAndShadow(mem, 'c--unchanged', p4, shadowOf(p4));

    const { deps, store, refreshes } = makeDeps(mem, NOW + 7_000);

    await reconcileAllProjects(deps);

    // Exactly one conflict across the whole batch -> one combined warning.
    assert.strictEqual(vscodeHarness.warnings().length, 1, 'one combined LWW warning');
    assert.strictEqual(refreshes(), 1, 'one refresh because at least one project changed');

    // Every project ends with shadow == its current live value (the invariant that
    // makes the next poll silent).
    for (const pk of ['c--adopt', 'c--changed', 'c--accepted', 'c--unchanged']) {
      const shadow = coerceShadow(store.getSyncShadow(pk)) as SyncShadow;
      assert.ok(shadow, 'shadow exists for ' + pk);
      assert.deepStrictEqual(
        shadow.meta,
        store.getProjectMeta(pk),
        'shadow == live for ' + pk,
      );
    }

    // The whole batch is now quiescent: a second pass is silent and writes nothing.
    vscodeHarness.reset();
    const writesBeforeSecond = mem.updateCount;
    await reconcileAllProjects(deps);
    assert.strictEqual(vscodeHarness.messages.length, 0, 'second pass silent');
    assert.strictEqual(mem.updateCount, writesBeforeSecond, 'second pass writes nothing');
  });
});
