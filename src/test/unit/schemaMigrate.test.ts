import * as assert from 'assert';
import {
  EXPORT_FORMAT_VERSION,
  MAX_ENVELOPE_PROJECTS,
  buildEnvelope,
  migrateEnvelope,
  validateEnvelope,
} from '../../store/schemaMigrate';
import { ProjectMeta, SCHEMA_VERSION, emptyProjectMeta } from '../../store/schema';

// Pure-logic unit tests for the EXPORT-FILE ENVELOPE validation and migration.
// This is DISTINCT from schema.test.ts, which exercises the per-project document
// migration. No vscode, no filesystem.

const DEVICE = 'dev-import';
const NOW = 1_700_000_000_000;

function projectWith(overrides: Partial<ProjectMeta> = {}): ProjectMeta {
  return { ...emptyProjectMeta(DEVICE, NOW), ...overrides };
}

describe('schemaMigrate validateEnvelope (shape gate)', () => {
  it('accepts a well-formed envelope', () => {
    const env = {
      version: 1,
      exportedAt: NOW,
      projects: { 'c--proj': projectWith() },
    };
    const v = validateEnvelope(env);
    assert.strictEqual(v.ok, true);
    if (v.ok) {
      assert.strictEqual(v.envelope.version, 1);
      assert.strictEqual(v.envelope.exportedAt, NOW);
      assert.ok('c--proj' in v.envelope.projects);
    }
  });

  it('accepts an empty projects map', () => {
    const v = validateEnvelope({ version: 1, exportedAt: NOW, projects: {} });
    assert.strictEqual(v.ok, true);
  });

  it('tolerates a missing exportedAt by treating it as 0', () => {
    const v = validateEnvelope({ version: 1, projects: {} });
    assert.strictEqual(v.ok, true);
    if (v.ok) {
      assert.strictEqual(v.envelope.exportedAt, 0);
    }
  });

  it('rejects a non-object', () => {
    assert.strictEqual(validateEnvelope(null).ok, false);
    assert.strictEqual(validateEnvelope('x').ok, false);
    assert.strictEqual(validateEnvelope(42).ok, false);
    assert.strictEqual(validateEnvelope([]).ok, false);
  });

  it('rejects a missing or non-numeric version', () => {
    assert.strictEqual(validateEnvelope({ projects: {} }).ok, false);
    assert.strictEqual(
      validateEnvelope({ version: 'one', projects: {} }).ok,
      false,
    );
  });

  it('rejects a version below 1', () => {
    assert.strictEqual(validateEnvelope({ version: 0, projects: {} }).ok, false);
  });

  it('rejects a non-object projects field', () => {
    assert.strictEqual(
      validateEnvelope({ version: 1, projects: 'nope' }).ok,
      false,
    );
    assert.strictEqual(
      validateEnvelope({ version: 1, projects: [] }).ok,
      false,
    );
  });

  // Security fix pass (import-envelope hardening, revised in review round 2): a
  // project KEY from the file is minted verbatim into a synced globalState key
  // and registered with setKeysForSync (no removal path), so the wrapper gate
  // bounds its length, charset, and count before any migration runs. A failing
  // ENTRY is SKIPPED AND COUNTED rather than rejecting the whole file: v0.1.x
  // accepted any non-empty key, so a user's own pre-0.2.0 backup can carry one
  // legacy-invalid key among legitimate projects, and wholesale rejection would
  // make every project in that backup unrestorable.
  it('skips a non-object project value and keeps the valid remainder', () => {
    const v = validateEnvelope({
      version: 1,
      exportedAt: NOW,
      projects: { 'c--bad': 'not-an-object', 'c--good': projectWith() },
    });
    assert.strictEqual(v.ok, true);
    if (v.ok) {
      assert.deepStrictEqual(Object.keys(v.envelope.projects), ['c--good']);
      assert.strictEqual(v.envelope.skippedProjects, 1);
    }
  });

  it('skips an over-long project key and keeps the valid remainder', () => {
    const v = validateEnvelope({
      version: 1,
      exportedAt: NOW,
      projects: { ['a'.repeat(100000)]: projectWith(), 'c--good': projectWith() },
    });
    assert.strictEqual(v.ok, true);
    if (v.ok) {
      assert.deepStrictEqual(Object.keys(v.envelope.projects), ['c--good']);
      assert.strictEqual(v.envelope.skippedProjects, 1);
    }
  });

  it('skips every project key with characters outside the encoder alphabet', () => {
    for (const key of ['../../evil', 'nest.meta.v1::x', 'has space', 'under_score', '__proto__']) {
      const v = validateEnvelope({
        version: 1,
        exportedAt: NOW,
        projects: { [key]: projectWith() },
      });
      assert.strictEqual(v.ok, true, 'wrapper stays valid for key: ' + key);
      if (v.ok) {
        assert.strictEqual(
          Object.keys(v.envelope.projects).length,
          0,
          'must skip key: ' + key,
        );
        assert.strictEqual(v.envelope.skippedProjects, 1);
      }
    }
  });

  it('skips a bare prototype-member project key', () => {
    const v = validateEnvelope({
      version: 1,
      exportedAt: NOW,
      projects: { constructor: projectWith() },
    });
    assert.strictEqual(v.ok, true);
    if (v.ok) {
      assert.strictEqual(Object.keys(v.envelope.projects).length, 0);
      assert.strictEqual(v.envelope.skippedProjects, 1);
    }
  });

  it('rejects an envelope with more than MAX_ENVELOPE_PROJECTS projects', () => {
    const projects: { [k: string]: unknown } = {};
    for (let i = 0; i <= MAX_ENVELOPE_PROJECTS; i++) {
      projects['c--proj-' + String(i)] = projectWith();
    }
    const v = validateEnvelope({ version: 1, exportedAt: NOW, projects });
    assert.strictEqual(v.ok, false);
  });

  it('accepts an envelope at exactly MAX_ENVELOPE_PROJECTS projects', () => {
    const projects: { [k: string]: unknown } = {};
    for (let i = 0; i < MAX_ENVELOPE_PROJECTS; i++) {
      projects['c--proj-' + String(i)] = projectWith();
    }
    const v = validateEnvelope({ version: 1, exportedAt: NOW, projects });
    assert.strictEqual(v.ok, true);
  });
});

describe('schemaMigrate migrateEnvelope (version migration, reuse migrateProjectMeta)', () => {
  it('normalizes every embedded project through the stored-document migration', () => {
    const env = validateEnvelope({
      version: 1,
      exportedAt: NOW,
      projects: {
        // A pre-versioned (schemaVersion-less) project, exactly the shape
        // migrateProjectMeta lifts.
        'c--proj': {
          folders: { f1: { id: 'f1', name: 'Inbox', parentId: null, order: 0 } },
          tags: { t1: { id: 't1', label: 'urgent' } },
          chats: { c1: { folderId: 'f1', tags: ['t1'], links: [] } },
        },
      },
    });
    assert.strictEqual(env.ok, true);
    if (!env.ok) {
      return;
    }
    const norm = migrateEnvelope(env.envelope, DEVICE, NOW);
    assert.strictEqual(norm.version, EXPORT_FORMAT_VERSION);
    const proj = norm.projects['c--proj'];
    assert.strictEqual(proj.schemaVersion, SCHEMA_VERSION);
    assert.strictEqual(proj.folders.f1.name, 'Inbox');
    assert.strictEqual(proj.tags.t1.label, 'urgent');
    // A stamp-less chat is defaulted to the supplied stamp by migrateProjectMeta.
    assert.strictEqual(proj.chats.c1.updatedAt, NOW);
    assert.strictEqual(proj.chats.c1.deviceId, DEVICE);
  });

  it('preserves a forward-version project __unknown escrow through the envelope', () => {
    const env = validateEnvelope({
      version: 1,
      exportedAt: NOW,
      projects: {
        'c--proj': {
          schemaVersion: SCHEMA_VERSION + 3,
          folders: {},
          tags: {},
          chats: {},
          updatedAt: 5,
          deviceId: 'future',
          // A newer build's field this build does not understand.
          pinnedChats: ['c1'],
        },
      },
    });
    assert.strictEqual(env.ok, true);
    if (!env.ok) {
      return;
    }
    const norm = migrateEnvelope(env.envelope, DEVICE, NOW);
    const proj = norm.projects['c--proj'];
    // The project keeps its newer schemaVersion and escrows the unknown field, so a
    // round-trip through this older build does not strip the newer machine's data.
    assert.strictEqual(proj.schemaVersion, SCHEMA_VERSION + 3);
    assert.deepStrictEqual(proj.__unknown, { pinnedChats: ['c1'] });
  });

  it('builds the migrated projects map with a null prototype (defense in depth)', () => {
    const env = validateEnvelope({
      version: 1,
      exportedAt: NOW,
      projects: { 'c--proj': projectWith() },
    });
    assert.strictEqual(env.ok, true);
    if (!env.ok) {
      return;
    }
    const norm = migrateEnvelope(env.envelope, DEVICE, NOW);
    // The keys come from an untrusted file: a non-own index must resolve to
    // undefined, never to an inherited Object member.
    assert.strictEqual(Object.getPrototypeOf(norm.projects), null);
    assert.strictEqual(
      (norm.projects as Record<string, unknown>).constructor,
      undefined,
    );
  });
});

describe('schemaMigrate buildEnvelope (round-trip foundation)', () => {
  it('wraps projects at the current format version with the timestamp', () => {
    const projects = { 'c--proj': projectWith({ updatedAt: 123 }) };
    const env = buildEnvelope(projects, NOW);
    assert.strictEqual(env.version, EXPORT_FORMAT_VERSION);
    assert.strictEqual(env.exportedAt, NOW);
    assert.strictEqual(env.projects['c--proj'].updatedAt, 123);
  });

  it('deep-copies so a later mutation of the source does not leak into the envelope', () => {
    const src = projectWith();
    src.folders.f1 = { id: 'f1', name: 'A', parentId: null, order: 0 };
    const projects = { 'c--proj': src };
    const env = buildEnvelope(projects, NOW);
    // Mutate the source after building.
    src.folders.f1.name = 'MUTATED';
    assert.strictEqual(env.projects['c--proj'].folders.f1.name, 'A');
  });

  it('round-trips build -> validate -> migrate back to the same logical projects', () => {
    const original = {
      'c--proj': projectWith({
        folders: { f1: { id: 'f1', name: 'Inbox', parentId: null, order: 0 } },
        tags: { t1: { id: 't1', label: 'urgent', color: '#aabbcc' } },
        chats: {
          c1: {
            folderId: 'f1',
            tags: ['t1'],
            links: [{ targetChatId: 'c2', kind: 'parent' as const }],
            updatedAt: 50,
            deviceId: 'd1',
          },
        },
        updatedAt: 99,
      }),
    };
    const env = buildEnvelope(original, NOW);
    const json = JSON.stringify(env);
    const parsed = JSON.parse(json);
    const v = validateEnvelope(parsed);
    assert.strictEqual(v.ok, true);
    if (!v.ok) {
      return;
    }
    const norm = migrateEnvelope(v.envelope, DEVICE, NOW);
    const proj = norm.projects['c--proj'];
    assert.strictEqual(proj.folders.f1.name, 'Inbox');
    assert.strictEqual(proj.tags.t1.color, '#aabbcc');
    assert.deepStrictEqual(proj.chats.c1.tags, ['t1']);
    assert.deepStrictEqual(proj.chats.c1.links, [
      { targetChatId: 'c2', kind: 'parent' },
    ]);
    assert.strictEqual(proj.chats.c1.updatedAt, 50);
    assert.strictEqual(proj.updatedAt, 99);
  });
});
