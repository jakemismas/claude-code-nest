import * as assert from 'assert';
import {
  SCHEMA_VERSION,
  emptyProjectMeta,
  isMetaKey,
  metaKeyFor,
  migrateProjectMeta,
  projectKeyFromMetaKey,
} from '../../store/schema';

// Pure-logic unit tests for the ProjectMeta schema, the per-project key encoding,
// and the defensive migration. No vscode import, no filesystem.

const DEVICE = 'dev-test';
const NOW = 1_700_000_000_000;

describe('schema key encoding', () => {
  it('builds the versioned per-project key', () => {
    assert.strictEqual(
      metaKeyFor('c--Users-JakeMismas-Documents-Claude-Code---Nest'),
      'nest.meta.v1::c--Users-JakeMismas-Documents-Claude-Code---Nest',
    );
  });

  it('recognizes its own meta keys and rejects foreign ones', () => {
    assert.strictEqual(isMetaKey('nest.meta.v1::abc'), true);
    assert.strictEqual(isMetaKey('nest.local.v1::abc'), false);
    assert.strictEqual(isMetaKey('nest.deviceId.v1'), false);
    assert.strictEqual(isMetaKey('some.other.key'), false);
  });

  it('round-trips a project key through the meta key', () => {
    const projectKey = 'c--Users-JakeMismas-proj';
    assert.strictEqual(projectKeyFromMetaKey(metaKeyFor(projectKey)), projectKey);
  });

  it('returns null recovering a project key from a non-meta key', () => {
    assert.strictEqual(projectKeyFromMetaKey('nest.local.v1::abc'), null);
  });
});

describe('schema emptyProjectMeta', () => {
  it('produces a well-formed empty document at the current version with the stamp', () => {
    const meta = emptyProjectMeta(DEVICE, NOW);
    assert.strictEqual(meta.schemaVersion, SCHEMA_VERSION);
    assert.deepStrictEqual(meta.folders, {});
    assert.deepStrictEqual(meta.tags, {});
    assert.deepStrictEqual(meta.chats, {});
    assert.strictEqual(meta.updatedAt, NOW);
    assert.strictEqual(meta.deviceId, DEVICE);
  });
});

describe('schema migrateProjectMeta (defensive, total)', () => {
  it('returns an empty document for undefined (never-written key)', () => {
    const meta = migrateProjectMeta(undefined, DEVICE, NOW);
    assert.strictEqual(meta.schemaVersion, SCHEMA_VERSION);
    assert.deepStrictEqual(meta.chats, {});
    assert.strictEqual(meta.deviceId, DEVICE);
    assert.strictEqual(meta.updatedAt, NOW);
  });

  it('returns an empty document for a non-object (corrupt) value', () => {
    assert.deepStrictEqual(migrateProjectMeta('garbage', DEVICE, NOW).chats, {});
    assert.deepStrictEqual(migrateProjectMeta(42, DEVICE, NOW).folders, {});
    assert.deepStrictEqual(migrateProjectMeta([], DEVICE, NOW).tags, {});
    assert.deepStrictEqual(migrateProjectMeta(null, DEVICE, NOW).chats, {});
  });

  it('lifts a pre-versioned (schemaVersion absent) document and stamps it', () => {
    const old = {
      folders: { f1: { id: 'f1', name: 'Inbox', parentId: null, order: 0 } },
      tags: { t1: { id: 't1', label: 'urgent' } },
      chats: {
        c1: { folderId: 'f1', tags: ['t1'], links: [] },
      },
    };
    const meta = migrateProjectMeta(old, DEVICE, NOW);
    assert.strictEqual(meta.schemaVersion, SCHEMA_VERSION);
    assert.strictEqual(meta.folders.f1.name, 'Inbox');
    assert.strictEqual(meta.tags.t1.label, 'urgent');
    // A stamp-less chat is defaulted to the supplied stamp.
    assert.strictEqual(meta.chats.c1.updatedAt, NOW);
    assert.strictEqual(meta.chats.c1.deviceId, DEVICE);
  });

  it('drops unknown fields and malformed sub-records', () => {
    const messy = {
      schemaVersion: 1,
      bogusTopLevel: 'x',
      folders: {
        good: { id: 'good', name: 'Keep', parentId: null, order: 2, extra: 'drop' },
        nameless: { id: 'nameless', parentId: null, order: 0 },
        notObject: 5,
      },
      tags: {
        good: { id: 'good', label: 'keep', color: '#fff', junk: true },
        labelless: { id: 'labelless' },
      },
      chats: {
        good: {
          folderId: 'good',
          tags: ['good', 7, 'x'],
          links: [
            { targetChatId: 'z', kind: 'parent' },
            { targetChatId: 'q', kind: 'nonsense' },
            { kind: 'parent' },
            'not-a-link',
          ],
          updatedAt: 10,
          deviceId: 'd2',
        },
        notObject: 'nope',
      },
    };
    const meta = migrateProjectMeta(messy, DEVICE, NOW);
    // Unknown top-level dropped.
    assert.ok(!('bogusTopLevel' in meta));
    // Folder without a name dropped; the good one keeps only known fields.
    assert.ok('good' in meta.folders);
    assert.ok(!('nameless' in meta.folders));
    assert.ok(!('notObject' in meta.folders));
    assert.ok(!('extra' in (meta.folders.good as unknown as Record<string, unknown>)));
    // Tag without a label dropped.
    assert.ok('good' in meta.tags);
    assert.ok(!('labelless' in meta.tags));
    assert.strictEqual(meta.tags.good.color, '#fff');
    // Non-string tag ids filtered out of the chat's tag array.
    assert.deepStrictEqual(meta.chats.good.tags, ['good', 'x']);
    // Malformed links dropped; an unknown kind coerces to 'related'.
    assert.deepStrictEqual(meta.chats.good.links, [
      { targetChatId: 'z', kind: 'parent' },
      { targetChatId: 'q', kind: 'related' },
    ]);
    // Existing stamps preserved.
    assert.strictEqual(meta.chats.good.updatedAt, 10);
    assert.strictEqual(meta.chats.good.deviceId, 'd2');
    assert.ok(!('notObject' in meta.chats));
  });

  it('preserves known data AND escrows unknown fields from a FORWARD (newer) version value', () => {
    const future = {
      schemaVersion: SCHEMA_VERSION + 5,
      folders: { f: { id: 'f', name: 'F', parentId: null, order: 0 } },
      tags: {},
      chats: {},
      updatedAt: 999,
      deviceId: 'future-device',
      // Fields a newer extension added that this build does not understand.
      pinnedChats: ['c1', 'c2'],
      smartGroupRules: { byBranch: true },
    };
    const meta = migrateProjectMeta(future, DEVICE, NOW);
    // Known data preserved.
    assert.strictEqual(meta.folders.f.name, 'F');
    assert.strictEqual(meta.updatedAt, 999);
    assert.strictEqual(meta.deviceId, 'future-device');
    // The document is NOT down-stamped to our older version; it keeps the
    // writer's newer schemaVersion so a later mutate/persist does not advertise
    // the foreign machine's richer document as our older shape.
    assert.strictEqual(meta.schemaVersion, SCHEMA_VERSION + 5);
    // Unknown top-level fields are escrowed verbatim rather than dropped, so a
    // round-trip through this older build does not clobber the newer machine.
    assert.deepStrictEqual(meta.__unknown, {
      pinnedChats: ['c1', 'c2'],
      smartGroupRules: { byBranch: true },
    });
  });

  it('does not escrow anything for a same- or older-version document', () => {
    const sameVersion = {
      schemaVersion: SCHEMA_VERSION,
      folders: {},
      tags: {},
      chats: {},
      updatedAt: 1,
      deviceId: 'd',
      bogusTopLevel: 'x',
    };
    const meta = migrateProjectMeta(sameVersion, DEVICE, NOW);
    // Same-version unknown fields are still dropped (normal forward-compat for a
    // peer build is not in scope); __unknown escrow only engages for a strictly
    // newer writer.
    assert.strictEqual(meta.schemaVersion, SCHEMA_VERSION);
    assert.strictEqual(meta.__unknown, undefined);
    assert.ok(!('bogusTopLevel' in (meta as unknown as Record<string, unknown>)));
  });

  it('does not set __unknown when a forward document has no extra fields', () => {
    const futureNoExtra = {
      schemaVersion: SCHEMA_VERSION + 2,
      folders: {},
      tags: {},
      chats: {},
      updatedAt: 5,
      deviceId: 'd',
    };
    const meta = migrateProjectMeta(futureNoExtra, DEVICE, NOW);
    assert.strictEqual(meta.schemaVersion, SCHEMA_VERSION + 2);
    assert.strictEqual(meta.__unknown, undefined);
  });
});
