// vscodeStub MUST be imported first so require('vscode') resolves before the
// command module's (AutoExporter's) top-level import runs.
import './vscodeStub';
import { vscodeHarness } from './vscodeStub';

import * as assert from 'assert';
import {
  RETENTION_COUNT,
  computeRetentionPrune,
  isSnapshotName,
  retentionSnapshotName,
} from '../../store/autoExport';
import { MetadataStore } from '../../store/metadataStore';
import { FakeMemento } from './fakeMemento';
import {
  AutoExporter,
  ExportImportDeps,
} from '../../commands/exportImportCommands';

// Pure-logic unit tests for the auto-export retention policy. No vscode, no
// filesystem: the command module supplies the dir listing and does the deletes;
// this module decides the name and the prune set.

describe('autoExport retentionSnapshotName', () => {
  it('embeds a fixed-width epoch-ms stamp so name order is chronological', () => {
    const a = retentionSnapshotName(1000);
    const b = retentionSnapshotName(2000);
    assert.ok(isSnapshotName(a));
    assert.ok(isSnapshotName(b));
    // Lexicographic order matches time order (later stamp sorts greater).
    assert.ok(a < b);
  });

  it('produces a recognizable, parseable snapshot name', () => {
    const name = retentionSnapshotName(1_700_000_000_000);
    assert.ok(name.startsWith('nest-autoexport-'));
    assert.ok(name.endsWith('.json'));
  });
});

describe('autoExport isSnapshotName', () => {
  it('recognizes only our own snapshot files', () => {
    assert.strictEqual(isSnapshotName('nest-autoexport-00001700000000000.json'), true);
    assert.strictEqual(isSnapshotName('claude-code-nest-export.json'), false);
    assert.strictEqual(isSnapshotName('nest-autoexport-.json'), false);
    assert.strictEqual(isSnapshotName('readme.txt'), false);
  });
});

describe('autoExport computeRetentionPrune', () => {
  it('returns nothing to prune when at or below the retention count', () => {
    const names = [];
    for (let i = 0; i < RETENTION_COUNT; i++) {
      names.push(retentionSnapshotName(1000 + i));
    }
    assert.deepStrictEqual(computeRetentionPrune(names), []);
  });

  it('prunes the OLDEST beyond the retention count, keeping the newest N', () => {
    const names: string[] = [];
    const total = RETENTION_COUNT + 3;
    for (let i = 0; i < total; i++) {
      names.push(retentionSnapshotName(1000 + i));
    }
    const toDelete = computeRetentionPrune(names);
    assert.strictEqual(toDelete.length, 3);
    // The three pruned are the three oldest (smallest stamps).
    const expected = [
      retentionSnapshotName(1000),
      retentionSnapshotName(1001),
      retentionSnapshotName(1002),
    ];
    assert.deepStrictEqual(toDelete.sort(), expected.sort());
  });

  it('ignores non-snapshot files entirely (never returns them for deletion)', () => {
    const names = ['readme.txt', 'claude-code-nest-export.json', 'random.json'];
    for (let i = 0; i < RETENTION_COUNT + 5; i++) {
      names.push(retentionSnapshotName(1000 + i));
    }
    const toDelete = computeRetentionPrune(names);
    for (const name of toDelete) {
      assert.ok(isSnapshotName(name), 'only snapshots are ever pruned: ' + name);
    }
    assert.strictEqual(toDelete.length, 5);
  });

  it('honors an explicit retention count override', () => {
    const names = [
      retentionSnapshotName(1000),
      retentionSnapshotName(2000),
      retentionSnapshotName(3000),
    ];
    const toDelete = computeRetentionPrune(names, 1);
    assert.strictEqual(toDelete.length, 2);
    // Only the newest (3000) is kept.
    assert.ok(!toDelete.includes(retentionSnapshotName(3000)));
  });
});

// Behavior tests for the AutoExporter timer: the named "debounced" ship item, the
// opt-in gate, the coalesce-a-burst-into-one-snapshot rule, dispose cancellation,
// the best-effort swallow, and the prune WIRING (listDirectory -> compute -> delete)
// that the pure computeRetentionPrune tests above cannot reach. The debounce window
// is injected small so the timer is exercisable with short real timers (no
// fake-timer dependency exists in this project).
describe('AutoExporter (debounce, gate, coalesce, dispose, prune wiring)', () => {
  const NOW = 1_700_000_000_000;
  // A generous debounce relative to the sub-waits below: each burst sub-wait is
  // DEBOUNCE/5, so even a heavy event-loop stall (several x the sub-wait) cannot
  // let the timer fire mid-burst and break the coalesce assertion. The post-burst
  // wait is DEBOUNCE*3 so the single timer reliably fires before the assert.
  const DEBOUNCE = 40;
  const SNAP_DIR = '/storage/auto-export';

  const openStores: MetadataStore[] = [];
  const delay = (ms: number): Promise<void> =>
    new Promise((res) => setTimeout(res, ms));

  function makeDeps(enabled: boolean): { deps: ExportImportDeps; store: MetadataStore } {
    const store = new MetadataStore(new FakeMemento(), {
      deviceId: 'dev',
      debounceMs: 0,
      now: () => NOW,
    });
    openStores.push(store);
    const deps: ExportImportDeps = {
      store,
      globalStorageUri: { fsPath: '/storage', scheme: 'file' } as never,
      // schedule() only consults the enabled key; return the flag for any key.
      flags: { get: () => enabled, update: () => Promise.resolve() },
      deviceId: 'dev',
      refresh: () => undefined,
      now: () => NOW,
      autoExportDebounceMs: DEBOUNCE,
    };
    return { deps, store };
  }

  beforeEach(() => vscodeHarness.reset());
  afterEach(async () => {
    while (openStores.length > 0) {
      await openStores.pop()!.dispose();
    }
  });

  it('schedule() is a NO-OP when the opt-in flag is off (no snapshot ever written)', async () => {
    const { deps } = makeDeps(false);
    const exporter = new AutoExporter(deps);
    exporter.schedule();
    await delay(DEBOUNCE * 4);
    assert.strictEqual(vscodeHarness.writes.length, 0, 'disabled auto-export writes nothing');
  });

  it('schedule() writes exactly one snapshot after the debounce when enabled', async () => {
    const { deps } = makeDeps(true);
    const exporter = new AutoExporter(deps);
    exporter.schedule();
    await delay(DEBOUNCE * 4);
    assert.strictEqual(vscodeHarness.writes.length, 1, 'one snapshot written');
    assert.strictEqual(
      vscodeHarness.writes[0].path,
      SNAP_DIR + '/' + retentionSnapshotName(NOW),
      'snapshot written under the auto-export dir with the retention name',
    );
    assert.ok(
      vscodeHarness.createdDirs.includes(SNAP_DIR),
      'the auto-export dir is created before the write',
    );
  });

  it('coalesces a burst of schedule() calls into a SINGLE snapshot', async () => {
    const { deps } = makeDeps(true);
    const exporter = new AutoExporter(deps);
    // A burst within the debounce window: each call resets the timer, so only the
    // last one fires. Sub-waits are DEBOUNCE/5 so a stall cannot fire the timer
    // mid-burst; the final wait is DEBOUNCE*4 so the single timer reliably fires.
    exporter.schedule();
    await delay(DEBOUNCE / 5);
    exporter.schedule();
    await delay(DEBOUNCE / 5);
    exporter.schedule();
    await delay(DEBOUNCE * 4);
    assert.strictEqual(vscodeHarness.writes.length, 1, 'a burst coalesces to one snapshot');
  });

  it('dispose() cancels a pending snapshot (no write after dispose)', async () => {
    const { deps } = makeDeps(true);
    const exporter = new AutoExporter(deps);
    exporter.schedule();
    exporter.dispose();
    await delay(DEBOUNCE * 4);
    assert.strictEqual(vscodeHarness.writes.length, 0, 'dispose cancelled the pending snapshot');
  });

  it('snapshotNow() swallows a write failure (best-effort: does not throw)', async () => {
    const { deps } = makeDeps(true);
    const exporter = new AutoExporter(deps);
    vscodeHarness.writeErrors.add(SNAP_DIR + '/' + retentionSnapshotName(NOW));
    // Must resolve, not reject: the manual export is the authoritative backup.
    await exporter.snapshotNow();
    assert.strictEqual(vscodeHarness.writes.length, 0, 'the failed write recorded nothing');
  });

  it('prune wiring deletes only the OLDEST snapshots beyond retention, never other files', async () => {
    const { deps } = makeDeps(true);
    const exporter = new AutoExporter(deps);
    // Seed the directory listing the prune reads: RETENTION_COUNT + 2 snapshots
    // (oldest two should be pruned) plus an unrelated file that must never be touched.
    const FILE = 1; // vscode.FileType.File
    const entries: [string, number][] = [];
    for (let i = 0; i < RETENTION_COUNT + 2; i++) {
      entries.push([retentionSnapshotName(1000 + i), FILE]);
    }
    entries.push(['unrelated.json', FILE]);
    vscodeHarness.dirEntries.set(SNAP_DIR, entries);

    await exporter.snapshotNow();

    assert.strictEqual(vscodeHarness.deletes.length, 2, 'exactly the two oldest are pruned');
    const expected = [
      SNAP_DIR + '/' + retentionSnapshotName(1000),
      SNAP_DIR + '/' + retentionSnapshotName(1001),
    ];
    assert.deepStrictEqual(vscodeHarness.deletes.slice().sort(), expected.sort());
    assert.ok(
      !vscodeHarness.deletes.includes(SNAP_DIR + '/unrelated.json'),
      'a non-snapshot file is never pruned',
    );
  });

  it('prune swallows an individual delete failure (best-effort: does not throw, still prunes the rest)', async () => {
    const { deps } = makeDeps(true);
    const exporter = new AutoExporter(deps);
    const FILE = 1; // vscode.FileType.File
    const entries: [string, number][] = [];
    for (let i = 0; i < RETENTION_COUNT + 2; i++) {
      entries.push([retentionSnapshotName(1000 + i), FILE]);
    }
    vscodeHarness.dirEntries.set(SNAP_DIR, entries);
    // The oldest snapshot's delete fails; the prune must swallow it and still
    // delete the other prunable snapshot.
    vscodeHarness.deleteErrors.add(SNAP_DIR + '/' + retentionSnapshotName(1000));

    // Must resolve, not reject.
    await exporter.snapshotNow();

    // The failed delete recorded nothing; the second-oldest was still pruned.
    assert.ok(
      !vscodeHarness.deletes.includes(SNAP_DIR + '/' + retentionSnapshotName(1000)),
      'the failed delete recorded nothing',
    );
    assert.ok(
      vscodeHarness.deletes.includes(SNAP_DIR + '/' + retentionSnapshotName(1001)),
      'the other prunable snapshot was still deleted',
    );
  });
});
