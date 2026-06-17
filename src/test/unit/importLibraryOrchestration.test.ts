// Orchestration-level tests for importLibrary (the command, not its replayed
// internals). The pure pieces (validateEnvelope -> migrateEnvelope ->
// buildImportPlan) and the validate-before-swap SEQUENCE are covered by
// exportImportStore.test.ts; this file covers the COMMAND's own apply loop and the
// POST-FLUSH per-project shadow finalize (exportImportCommands.ts lines 173-195),
// whose inline comment warns that without it "the very next window-focus poll would
// misclassify the just-imported state as a FOREIGN write, re-run the merge, and
// re-show the LWW warning a second time after a normal restore."
//
// vscodeStub MUST be imported first so require('vscode') resolves before the
// command module's top-level import runs.
import './vscodeStub';
import { vscodeHarness } from './vscodeStub';

import * as assert from 'assert';
import { MetadataStore } from '../../store/metadataStore';
import { ProjectMeta, emptyProjectMeta, metaKeyFor } from '../../store/schema';
import { coerceShadow, SyncShadow } from '../../store/reconcileSync';
import { FakeMemento } from './fakeMemento';
import {
  ExportImportDeps,
  importLibrary,
  reconcileAllProjects,
} from '../../commands/exportImportCommands';

const DEVICE = 'dev-import';
const NOW = 1_700_000_000_000;

function proj(overrides: Partial<ProjectMeta> = {}): ProjectMeta {
  return { ...emptyProjectMeta(DEVICE, NOW), ...overrides };
}

function makeDeps(
  mem: FakeMemento,
  opts: { storeNow?: number; depsNow?: number } = {},
): { deps: ExportImportDeps; store: MetadataStore; refreshes: () => number } {
  const store = new MetadataStore(mem, {
    deviceId: DEVICE,
    debounceMs: 0,
    now: () => opts.storeNow ?? NOW,
  });
  let refreshes = 0;
  const deps: ExportImportDeps = {
    store,
    globalStorageUri: { fsPath: '/storage', scheme: 'file' } as never,
    flags: {
      get: () => undefined,
      update: () => Promise.resolve(),
    },
    deviceId: DEVICE,
    refresh: () => {
      refreshes++;
    },
    now: () => opts.depsNow ?? NOW,
  };
  return { deps, store, refreshes: () => refreshes };
}

function envelopeText(projects: { [pk: string]: ProjectMeta }): string {
  return JSON.stringify({ version: 1, exportedAt: NOW, projects });
}

describe('importLibrary orchestration (apply loop + post-flush shadow finalize)', () => {
  beforeEach(() => vscodeHarness.reset());

  it('cancelling the open dialog applies nothing and shows no toast', async () => {
    const mem = new FakeMemento();
    mem.seed(metaKeyFor('c--proj'), proj({ updatedAt: 5 }));
    const { deps, store, refreshes } = makeDeps(mem);
    vscodeHarness.openDialogResult = null; // cancelled

    await importLibrary(deps);

    assert.strictEqual(refreshes(), 0);
    assert.strictEqual(vscodeHarness.messages.length, 0);
    assert.strictEqual(store.getProjectMeta('c--proj').updatedAt, 5);
  });

  it('applies the additive merge through the store and reports it', async () => {
    const mem = new FakeMemento();
    mem.seed(
      metaKeyFor('c--proj'),
      proj({ tags: { tLive: { id: 'tLive', label: 'Live' } }, updatedAt: 5 }),
    );
    const { deps, store } = makeDeps(mem);

    const path = '/import.json';
    vscodeHarness.seedFile(
      path,
      envelopeText({
        'c--proj': proj({ tags: { tFile: { id: 'tFile', label: 'File' } }, updatedAt: 20 }),
      }),
    );
    vscodeHarness.openDialogResult = path;

    await importLibrary(deps);

    const merged = store.getProjectMeta('c--proj');
    assert.ok('tLive' in merged.tags, 'live tag preserved');
    assert.ok('tFile' in merged.tags, 'file tag unioned in');
    const infos = vscodeHarness.infos();
    assert.strictEqual(infos.length, 1);
    assert.ok(infos[0].includes('1 changed'), infos[0]);
    assert.ok(infos[0].includes('No projects were deleted.'), infos[0]);
  });

  it('finalizes the shadow so a follow-up focus reconcile does NOT re-fire the LWW toast', async () => {
    // Two machines disagree on a chat's folder. The import file is NEWER, so on
    // import its folder wins and the same-scalar conflict is recorded -> one LWW
    // toast at import time. The regression guarded here: the apply loop's
    // post-flush shadow finalize (lines 189-195) must stamp the shadow from the
    // RE-STAMPED live value, so the immediate next reconcile (window focus) sees
    // the live value equal to the shadow and stays silent.
    const mem = new FakeMemento();
    mem.seed(
      metaKeyFor('c--proj'),
      proj({
        chats: {
          c: { folderId: 'fLocal', tags: ['x'], links: [], updatedAt: 10, deviceId: DEVICE },
        },
        updatedAt: 10,
      }),
    );
    // The store re-stamps writes at storeNow; keep it distinct from the file stamps
    // so a missing finalize (which would leave a stale shadow) is observable.
    const { deps, store, refreshes } = makeDeps(mem, { storeNow: NOW + 9_000, depsNow: NOW });

    const path = '/import.json';
    vscodeHarness.seedFile(
      path,
      envelopeText({
        'c--proj': proj({
          chats: {
            c: {
              folderId: 'fRemote',
              tags: ['y'],
              links: [],
              updatedAt: 50,
              deviceId: 'dev-other',
            },
          },
          updatedAt: 50,
        }),
      }),
    );
    vscodeHarness.openDialogResult = path;

    await importLibrary(deps);

    // Exactly one LWW warning at import time (the folderId conflict).
    assert.deepStrictEqual(
      vscodeHarness.warnings().length,
      1,
      'import should surface exactly one LWW warning',
    );
    assert.strictEqual(refreshes(), 1, 'one refresh after the apply');

    // The shadow must equal the post-flush, re-stamped live value.
    const live = store.getProjectMeta('c--proj');
    const shadow = coerceShadow(store.getSyncShadow('c--proj')) as SyncShadow;
    assert.ok(shadow, 'shadow must exist after import');
    assert.deepStrictEqual(
      shadow.meta,
      live,
      'shadow.meta must be finalized from the post-flush re-stamped live value',
    );
    assert.strictEqual(shadow.deviceId, DEVICE);

    // The smoking gun: a window-focus reconcile right after the import must be
    // silent. A missing/stale finalize would re-classify the just-imported state as
    // foreign, re-merge, and re-fire the toast here.
    vscodeHarness.reset();
    await reconcileAllProjects(deps);
    assert.deepStrictEqual(
      vscodeHarness.warnings(),
      [],
      'the LWW warning must NOT re-fire on the next focus reconcile after import',
    );
  });

  it('a no-op merge (file older everywhere) writes nothing and reports 0 changed', async () => {
    const mem = new FakeMemento();
    mem.seed(
      metaKeyFor('c--proj'),
      proj({ tags: { tLive: { id: 'tLive', label: 'Live' } }, updatedAt: 100 }),
    );
    const { deps, store } = makeDeps(mem);
    const updatesBefore = mem.updateCount;

    const path = '/import.json';
    // The file carries only the SAME tag the live doc already has, so the union is
    // a no-op and the per-project result is changed:false.
    vscodeHarness.seedFile(
      path,
      envelopeText({
        'c--proj': proj({ tags: { tLive: { id: 'tLive', label: 'Live' } }, updatedAt: 1 }),
      }),
    );
    vscodeHarness.openDialogResult = path;

    await importLibrary(deps);

    assert.strictEqual(
      mem.updateCount,
      updatesBefore,
      'a changed:false merge must not write the store or a shadow',
    );
    const infos = vscodeHarness.infos();
    assert.ok(infos[0].includes('0 changed'), infos[0]);
    assert.strictEqual(store.getProjectMeta('c--proj').updatedAt, 100);
  });

  it('surfaces a validation error and leaves the store untouched', async () => {
    const mem = new FakeMemento();
    mem.seed(metaKeyFor('c--proj'), proj({ updatedAt: 5 }));
    const { deps, store } = makeDeps(mem);
    const updatesBefore = mem.updateCount;

    const path = '/bad.json';
    vscodeHarness.seedFile(path, '{"hello":"world"}'); // valid JSON, not an envelope
    vscodeHarness.openDialogResult = path;

    await importLibrary(deps);

    assert.strictEqual(vscodeHarness.errors().length, 1, 'one error toast');
    assert.strictEqual(mem.updateCount, updatesBefore, 'no live mutation on rejection');
    assert.strictEqual(store.getProjectMeta('c--proj').updatedAt, 5);
  });
});
