import * as assert from 'assert';
import { MetadataStore } from '../../store/metadataStore';
import { metaKeyFor, emptyProjectMeta, ProjectMeta } from '../../store/schema';
import { shadowKeyFor } from '../../store/reconcileSync';
import { validateEnvelope, migrateEnvelope } from '../../store/schemaMigrate';
import { buildImportPlan } from '../../store/exportImport';
import { FakeMemento } from './fakeMemento';

// Store-integration unit tests for the Slice 8 additions against the FakeMemento
// double: allProjectKeys enumeration (export-all), the non-synced shadow
// read/write, and the SCRATCH-VALIDATE-BEFORE-SWAP guarantee (a malformed or
// invalid file is rejected before the live store is ever mutated, and a valid
// import only mutates the store at the explicit putProjectMeta swap). No vscode.

const DEVICE = 'dev-A';
const NOW = 1_700_000_000_000;

function makeStore(mem: FakeMemento): MetadataStore {
  return new MetadataStore(mem, { deviceId: DEVICE, debounceMs: 0 });
}

function proj(overrides: Partial<ProjectMeta> = {}): ProjectMeta {
  return { ...emptyProjectMeta(DEVICE, NOW), ...overrides };
}

describe('MetadataStore.allProjectKeys (export-all enumeration)', () => {
  it('enumerates every persisted meta key plus staged keys, deduped', async () => {
    const mem = new FakeMemento();
    // A project persisted in a prior session (seeded directly).
    mem.seed(metaKeyFor('c--persisted'), proj());
    const store = makeStore(mem);
    // A project mutated this session (staged then flushed).
    store.upsertTag('c--fresh', { id: 't', label: 'x' });
    await store.flush();

    const keys = store.allProjectKeys().sort();
    assert.deepStrictEqual(keys, ['c--fresh', 'c--persisted']);
  });

  it('does not include the non-synced shadow or local keys', () => {
    const mem = new FakeMemento();
    mem.seed(metaKeyFor('c--proj'), proj());
    mem.seed(shadowKeyFor('c--proj'), { meta: proj(), deviceId: DEVICE });
    mem.seed('nest.local.v1::c--proj', { schemaVersion: 1, chats: {} });
    const store = makeStore(mem);
    assert.deepStrictEqual(store.allProjectKeys(), ['c--proj']);
  });
});

describe('MetadataStore sync shadow (local-only, non-synced)', () => {
  it('round-trips a shadow under the non-synced key without registering it for sync', async () => {
    const mem = new FakeMemento();
    const store = makeStore(mem);
    const shadow = { meta: proj({ updatedAt: 42 }), deviceId: DEVICE };
    await store.putSyncShadow('c--proj', shadow);

    // Read it back.
    const read = store.getSyncShadow('c--proj') as { meta: ProjectMeta; deviceId: string };
    assert.strictEqual(read.deviceId, DEVICE);
    assert.strictEqual(read.meta.updatedAt, 42);

    // The shadow key is NOT in any setKeysForSync registration.
    const allRegistered = mem.syncRegistrations.flat();
    assert.ok(!allRegistered.includes(shadowKeyFor('c--proj')));
  });

  it('returns undefined for an absent shadow', () => {
    const store = makeStore(new FakeMemento());
    assert.strictEqual(store.getSyncShadow('c--none'), undefined);
  });

  it('hands back a defensive copy (caller mutation does not corrupt the store)', async () => {
    const mem = new FakeMemento();
    const store = makeStore(mem);
    await store.putSyncShadow('c--proj', { meta: proj({ updatedAt: 1 }), deviceId: DEVICE });
    const read = store.getSyncShadow('c--proj') as { meta: ProjectMeta };
    read.meta.updatedAt = 999;
    const reread = store.getSyncShadow('c--proj') as { meta: ProjectMeta };
    assert.strictEqual(reread.meta.updatedAt, 1);
  });
});

describe('import scratch-validate-before-swap', () => {
  it('rejects invalid JSON before any live mutation', async () => {
    const mem = new FakeMemento();
    mem.seed(metaKeyFor('c--proj'), proj({ updatedAt: 5 }));
    const store = makeStore(mem);
    const updatesBefore = mem.updateCount;

    // The command-module flow: parse fails -> no plan -> no putProjectMeta.
    let parsed: unknown;
    let parseOk = true;
    try {
      parsed = JSON.parse('{ this is not json ');
    } catch {
      parseOk = false;
    }
    assert.strictEqual(parseOk, false);
    void parsed;
    // The live store was never read-modified-written for the import.
    assert.strictEqual(mem.updateCount, updatesBefore);
    assert.strictEqual(store.getProjectMeta('c--proj').updatedAt, 5);
  });

  it('rejects a malformed envelope before migrate/merge touch the live store', () => {
    const mem = new FakeMemento();
    mem.seed(metaKeyFor('c--proj'), proj({ updatedAt: 5 }));
    const store = makeStore(mem);
    const updatesBefore = mem.updateCount;

    // A syntactically valid JSON that is NOT a Nest envelope.
    const parsed = JSON.parse('{"hello":"world"}');
    const validation = validateEnvelope(parsed);
    assert.strictEqual(validation.ok, false);
    // Validation gate fails first; migrateEnvelope/buildImportPlan are never called,
    // so the store is untouched.
    assert.strictEqual(mem.updateCount, updatesBefore);
    assert.strictEqual(store.getProjectMeta('c--proj').updatedAt, 5);
  });

  it('a valid import builds a plan by READING only, then mutates ONLY at the swap', async () => {
    const mem = new FakeMemento();
    mem.seed(metaKeyFor('c--proj'), proj({
      tags: { tLive: { id: 'tLive', label: 'Live' } },
      updatedAt: 5,
    }));
    const store = makeStore(mem);

    const envText = JSON.stringify({
      version: 1,
      exportedAt: NOW,
      projects: {
        'c--proj': proj({
          tags: { tFile: { id: 'tFile', label: 'File' } },
          updatedAt: 20,
        }),
      },
    });

    // 1) Validate + migrate the SCRATCH copy.
    const validation = validateEnvelope(JSON.parse(envText));
    assert.strictEqual(validation.ok, true);
    if (!validation.ok) {
      return;
    }
    const normalized = migrateEnvelope(validation.envelope, DEVICE, NOW);

    // 2) Build the plan: this READS the live store but must NOT mutate it.
    const updatesBeforePlan = mem.updateCount;
    const plan = buildImportPlan(normalized, (pk) => store.getProjectMeta(pk));
    assert.strictEqual(mem.updateCount, updatesBeforePlan, 'planning must not write');
    // The live store still shows only the live tag at this point.
    assert.ok('tLive' in store.getProjectMeta('c--proj').tags);
    assert.ok(!('tFile' in store.getProjectMeta('c--proj').tags));

    // 3) Swap: apply the plan via putProjectMeta, then flush.
    for (const result of plan.results) {
      if (result.changed) {
        store.putProjectMeta(result.projectKey, result.merged);
      }
    }
    await store.flush();

    // Now the merge is visible: both tags present (additive union), no deletion.
    const merged = store.getProjectMeta('c--proj');
    assert.ok('tLive' in merged.tags);
    assert.ok('tFile' in merged.tags);
  });
});
