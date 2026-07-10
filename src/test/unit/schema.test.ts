import * as assert from 'assert';
import {
  MAX_DEVICE_ID_LENGTH,
  MAX_UNKNOWN_ESCROW_LENGTH,
  ProjectMeta,
  SCHEMA_VERSION,
  emptyProjectMeta,
  isMetaKey,
  isSafeProjectKey,
  metaKeyFor,
  migrateProjectMeta,
  nullProtoMaps,
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
        good: { id: 'good', label: 'keep', color: '#aabbcc', junk: true },
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
    assert.strictEqual(meta.tags.good.color, '#aabbcc');
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

describe('schema curation scalars (Slice 3): normalize round-trip and additive migration', () => {
  it('carries Folder.color through normalize when present and omits it when absent', () => {
    const doc = {
      schemaVersion: SCHEMA_VERSION,
      folders: {
        colored: { id: 'colored', name: 'C', parentId: null, order: 0, color: '#aabbcc' },
        plain: { id: 'plain', name: 'P', parentId: null, order: 1 },
      },
      tags: {},
      chats: {},
      updatedAt: 1,
      deviceId: 'd',
    };
    const meta = migrateProjectMeta(doc, DEVICE, NOW);
    assert.strictEqual(meta.folders.colored.color, '#aabbcc');
    // Absent color is omitted, not defaulted to a value.
    assert.strictEqual('color' in meta.folders.plain, false);
  });

  it('drops a non-string Folder.color rather than carrying garbage', () => {
    const doc = {
      schemaVersion: SCHEMA_VERSION,
      folders: { f: { id: 'f', name: 'F', parentId: null, order: 0, color: 42 } },
      tags: {},
      chats: {},
      updatedAt: 1,
      deviceId: 'd',
    };
    const meta = migrateProjectMeta(doc, DEVICE, NOW);
    assert.strictEqual('color' in meta.folders.f, false);
  });

  it('keeps a strict #rrggbb Folder.color and drops any non-matching string', () => {
    // A folder color travels in a synced, importable library document and later
    // reaches a CSS sink (background: var(--chip-color)) in the webview. Only the
    // exact #rrggbb form the native picker emits may survive normalize; anything
    // else (a CSS url() exfil token, a named color, a 3-digit hex, a bad hex) is
    // dropped at the boundary so no CSS token can ride through.
    function colorOf(value: unknown): string | undefined {
      const doc = {
        schemaVersion: SCHEMA_VERSION,
        folders: { f: { id: 'f', name: 'F', parentId: null, order: 0, color: value } },
        tags: {},
        chats: {},
        updatedAt: 1,
        deviceId: 'd',
      };
      return migrateProjectMeta(doc, DEVICE, NOW).folders.f.color;
    }
    // A valid 6-digit hex color is kept verbatim.
    assert.strictEqual(colorOf('#aabbcc'), '#aabbcc');
    // The CSS exfiltration payload from the finding is dropped (color omitted).
    assert.strictEqual(colorOf('url(https://evil/x)'), undefined);
    // A named color is dropped (the picker never emits one).
    assert.strictEqual(colorOf('red'), undefined);
    // A 3-digit hex is intentionally rejected by the strict pattern.
    assert.strictEqual(colorOf('#fff'), undefined);
    // A malformed hex (non-hex digits) is dropped.
    assert.strictEqual(colorOf('#GGGGGG'), undefined);
  });

  it('keeps a strict #rrggbb Tag.color and drops any non-matching string', () => {
    // A tag color travels the SAME attacker-influenceable synced/import path as a
    // folder color and reaches the SAME --chip-color CSS sink (buildTagChips ->
    // media/orgPanel.js). normalizeTag is the sole boundary (tag color has no
    // postMessage setter), so it must enforce the strict #rrggbb shape exactly as
    // normalizeFolder does: only the hex form the native picker emits survives;
    // anything else (a CSS url() exfil token, a named color, a 3-digit hex, a bad
    // hex) is dropped at the boundary so no CSS token can ride through.
    function colorOf(value: unknown): string | undefined {
      const doc = {
        schemaVersion: SCHEMA_VERSION,
        folders: {},
        tags: { t: { id: 't', label: 'T', color: value } },
        chats: {},
        updatedAt: 1,
        deviceId: 'd',
      };
      return migrateProjectMeta(doc, DEVICE, NOW).tags.t.color;
    }
    // A valid 6-digit hex color is kept verbatim.
    assert.strictEqual(colorOf('#aabbcc'), '#aabbcc');
    // The CSS exfiltration payload from the finding is dropped (color omitted).
    assert.strictEqual(colorOf('url(https://evil/x)'), undefined);
    // A named color is dropped (the picker never emits one).
    assert.strictEqual(colorOf('red'), undefined);
    // A 3-digit hex is intentionally rejected by the strict pattern.
    assert.strictEqual(colorOf('#fff'), undefined);
    // A malformed hex (non-hex digits) is dropped.
    assert.strictEqual(colorOf('#GGGGGG'), undefined);
  });

  it('carries chat starred/userArchived/archivedAt through normalize when present', () => {
    const doc = {
      schemaVersion: SCHEMA_VERSION,
      folders: {},
      tags: {},
      chats: {
        c: {
          folderId: null,
          tags: [],
          links: [],
          updatedAt: 10,
          deviceId: 'd',
          starred: true,
          userArchived: true,
          archivedAt: 123,
        },
      },
      updatedAt: 1,
      deviceId: 'd',
    };
    const meta = migrateProjectMeta(doc, DEVICE, NOW);
    assert.strictEqual(meta.chats.c.starred, true);
    assert.strictEqual(meta.chats.c.userArchived, true);
    assert.strictEqual(meta.chats.c.archivedAt, 123);
  });

  it('omits the chat curation scalars when absent (default-absent, not false/0)', () => {
    const doc = {
      schemaVersion: SCHEMA_VERSION,
      folders: {},
      tags: {},
      chats: { c: { folderId: null, tags: [], links: [], updatedAt: 10, deviceId: 'd' } },
      updatedAt: 1,
      deviceId: 'd',
    };
    const meta = migrateProjectMeta(doc, DEVICE, NOW);
    assert.strictEqual('starred' in meta.chats.c, false);
    assert.strictEqual('userArchived' in meta.chats.c, false);
    assert.strictEqual('archivedAt' in meta.chats.c, false);
  });

  it('drops a non-boolean starred / non-number archivedAt rather than carrying garbage', () => {
    const doc = {
      schemaVersion: SCHEMA_VERSION,
      folders: {},
      tags: {},
      chats: {
        c: {
          folderId: null,
          tags: [],
          links: [],
          updatedAt: 10,
          deviceId: 'd',
          starred: 'yes',
          userArchived: 1,
          archivedAt: 'soon',
        },
      },
      updatedAt: 1,
      deviceId: 'd',
    };
    const meta = migrateProjectMeta(doc, DEVICE, NOW);
    assert.strictEqual('starred' in meta.chats.c, false);
    assert.strictEqual('userArchived' in meta.chats.c, false);
    assert.strictEqual('archivedAt' in meta.chats.c, false);
  });

  it('migrates an OLDER document lacking the new scalars with NO version bump (additive)', () => {
    // A pre-Slice-3 document has no starred/userArchived/archivedAt/color. It must
    // migrate cleanly, stay at SCHEMA_VERSION (no bump), and gain no escrow.
    const older = {
      schemaVersion: SCHEMA_VERSION,
      folders: { f: { id: 'f', name: 'F', parentId: null, order: 0 } },
      tags: {},
      chats: { c: { folderId: 'f', tags: [], links: [], updatedAt: 10, deviceId: 'd' } },
      updatedAt: 1,
      deviceId: 'd',
    };
    const meta = migrateProjectMeta(older, DEVICE, NOW);
    assert.strictEqual(meta.schemaVersion, SCHEMA_VERSION);
    assert.strictEqual(meta.__unknown, undefined);
    assert.strictEqual('color' in meta.folders.f, false);
    assert.strictEqual('starred' in meta.chats.c, false);
  });
});

describe('schema normalizeChat record-id validation (data-integrity hardening)', () => {
  // An imported library document is untrusted input. The id alphabet admits the
  // bare Object.prototype member names (constructor, prototype, toString,
  // valueOf, hasOwnProperty), which would resolve to inherited values at a
  // downstream bare-object lookup and produce phantom folder/tag labels. The
  // normalize boundary must reject a folderId or tag id that is not in the safe
  // record-id shape, mirroring how it already drops other malformed fields.
  function chatDoc(chat: Record<string, unknown>) {
    return {
      schemaVersion: SCHEMA_VERSION,
      folders: {},
      tags: {},
      chats: { c: chat },
      updatedAt: 1,
      deviceId: 'd',
    };
  }

  it('drops a folderId of "constructor" (prototype name) to null', () => {
    const meta = migrateProjectMeta(
      chatDoc({ folderId: 'constructor', tags: [], links: [], updatedAt: 10, deviceId: 'd' }),
      DEVICE,
      NOW,
    );
    assert.strictEqual(meta.chats.c.folderId, null);
  });

  it('drops a prototype-name tag id but keeps a valid one', () => {
    const meta = migrateProjectMeta(
      chatDoc({
        folderId: null,
        tags: ['toString', 'realtag'],
        links: [],
        updatedAt: 10,
        deviceId: 'd',
      }),
      DEVICE,
      NOW,
    );
    assert.deepStrictEqual(meta.chats.c.tags, ['realtag']);
  });

  it('keeps a well-formed folderId unchanged', () => {
    const meta = migrateProjectMeta(
      chatDoc({ folderId: 'folder_1', tags: [], links: [], updatedAt: 10, deviceId: 'd' }),
      DEVICE,
      NOW,
    );
    assert.strictEqual(meta.chats.c.folderId, 'folder_1');
  });

  it('drops a malformed folderId (too long / illegal chars) to null', () => {
    const tooLong = 'a'.repeat(65);
    const longMeta = migrateProjectMeta(
      chatDoc({ folderId: tooLong, tags: [], links: [], updatedAt: 10, deviceId: 'd' }),
      DEVICE,
      NOW,
    );
    assert.strictEqual(longMeta.chats.c.folderId, null);
    const illegalMeta = migrateProjectMeta(
      chatDoc({ folderId: 'has space', tags: [], links: [], updatedAt: 10, deviceId: 'd' }),
      DEVICE,
      NOW,
    );
    assert.strictEqual(illegalMeta.chats.c.folderId, null);
  });

  it('filters every prototype-name and malformed tag id, keeping only safe ones', () => {
    const meta = migrateProjectMeta(
      chatDoc({
        folderId: null,
        tags: ['constructor', 'prototype', 'valueOf', 'hasOwnProperty', '', 'good-1', 'good_2'],
        links: [],
        updatedAt: 10,
        deviceId: 'd',
      }),
      DEVICE,
      NOW,
    );
    assert.deepStrictEqual(meta.chats.c.tags, ['good-1', 'good_2']);
  });
});

describe('schema normalizeProjectMeta MAP-KEY validation (path-traversal + prototype hardening)', () => {
  // The CRITICAL boundary: a normalize pass re-keys folders/tags/chats with the
  // RAW imported/synced map KEY verbatim. An attacker-authored import or a
  // foreign-device synced document can introduce a record under a path-traversal
  // key ('../../../../Users/victim/evil') or a prototype-member name. The chat key
  // flows to the archive body-file path sink, where Uri.joinPath collapses '..' and
  // escapes globalStorage. Every map KEY (not just the references inside a record)
  // must be dropped here when it fails the safe record-id shape.
  function docWith(maps: {
    folders?: Record<string, unknown>;
    tags?: Record<string, unknown>;
    chats?: Record<string, unknown>;
  }) {
    return {
      schemaVersion: SCHEMA_VERSION,
      folders: maps.folders ?? {},
      tags: maps.tags ?? {},
      chats: maps.chats ?? {},
      updatedAt: 1,
      deviceId: 'd',
    };
  }

  function chat(): Record<string, unknown> {
    return { folderId: null, tags: [], links: [], updatedAt: 10, deviceId: 'd' };
  }
  function folder(name: string): Record<string, unknown> {
    return { name, parentId: null, order: 0 };
  }
  function tag(label: string): Record<string, unknown> {
    return { label };
  }

  it('drops a chat whose MAP KEY is a path-traversal string', () => {
    const meta = migrateProjectMeta(
      docWith({ chats: { '../../../../Users/victim/evil': chat() } }),
      DEVICE,
      NOW,
    );
    assert.deepStrictEqual(Object.keys(meta.chats), [], 'the traversal-keyed chat is dropped');
  });

  it('drops a folder/tag/chat whose MAP KEY is the prototype name "constructor"', () => {
    const meta = migrateProjectMeta(
      docWith({
        folders: { constructor: folder('Phantom') },
        tags: { constructor: tag('Phantom') },
        chats: { constructor: chat() },
      }),
      DEVICE,
      NOW,
    );
    assert.deepStrictEqual(Object.keys(meta.folders), []);
    assert.deepStrictEqual(Object.keys(meta.tags), []);
    assert.deepStrictEqual(Object.keys(meta.chats), []);
    // The dropped key must NOT survive as a phantom own key, and the bare-object
    // index must not resolve to an inherited member (null-proto backstop).
    assert.strictEqual('constructor' in meta.folders, false);
    assert.strictEqual(meta.chats['constructor' as keyof typeof meta.chats], undefined);
  });

  it('drops a "__proto__" map key without polluting the prototype', () => {
    // A literal `__proto__:` sets the prototype, not an own key, so define it as a
    // genuine OWN enumerable key to model the attacker map Object.entries iterates.
    const evilFolders: Record<string, unknown> = {};
    Object.defineProperty(evilFolders, '__proto__', {
      value: folder('Polluter'),
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const meta = migrateProjectMeta(docWith({ folders: evilFolders }), DEVICE, NOW);
    assert.deepStrictEqual(Object.keys(meta.folders), []);
    // The global Object prototype was not mutated by the malicious key.
    assert.strictEqual(({} as Record<string, unknown>).order, undefined);
  });

  it('PRESERVES a valid UUID chat key and minted folder/tag keys (no real data lost)', () => {
    const uuid = '0a1b2c3d-4e5f-6789-abcd-ef0123456789';
    const folderId = 'f-18f0a-1a2b3c4d5e6f';
    const tagId = 't-18f0a-9a8b7c6d5e4f';
    const meta = migrateProjectMeta(
      docWith({
        folders: { [folderId]: folder('Inbox') },
        tags: { [tagId]: tag('urgent') },
        chats: { [uuid]: { ...chat(), folderId, tags: [tagId] } },
      }),
      DEVICE,
      NOW,
    );
    assert.deepStrictEqual(Object.keys(meta.folders), [folderId]);
    assert.deepStrictEqual(Object.keys(meta.tags), [tagId]);
    assert.deepStrictEqual(Object.keys(meta.chats), [uuid]);
    assert.strictEqual(meta.chats[uuid].folderId, folderId);
    assert.deepStrictEqual(meta.chats[uuid].tags, [tagId]);
  });

  it('drops only the unsafe-keyed entries and keeps the safe ones alongside', () => {
    const uuid = '0a1b2c3d-4e5f-6789-abcd-ef0123456789';
    const meta = migrateProjectMeta(
      docWith({
        chats: {
          '../escape': chat(),
          [uuid]: chat(),
          hasOwnProperty: chat(),
        },
      }),
      DEVICE,
      NOW,
    );
    assert.deepStrictEqual(Object.keys(meta.chats), [uuid], 'only the UUID-keyed chat survives');
  });
});

describe('schema nullProtoMaps (write-path defense-in-depth backstop)', () => {
  // The write-path clones use JSON.parse(JSON.stringify(...)), which re-attaches
  // Object.prototype to the folders/tags/chats maps and voids the null-prototype
  // hygiene normalize builds. nullProtoMaps rebuilds those three maps with a null
  // prototype after such a clone so an unsafe index can never reach an inherited
  // Object member, and a write through the map cannot land on Object.prototype.
  function cloned(meta: ProjectMeta): ProjectMeta {
    // Model the exact clone the store/merge sites perform before the backstop.
    return JSON.parse(JSON.stringify(meta)) as ProjectMeta;
  }

  it('rebuilds folders/tags/chats with a null prototype after a JSON clone', () => {
    const base = emptyProjectMeta(DEVICE, NOW);
    base.folders.f1 = { id: 'f1', name: 'Inbox', parentId: null, order: 0 };
    const clone = cloned(base);
    // After the JSON round-trip the maps inherit Object.prototype again.
    assert.strictEqual(Object.getPrototypeOf(clone.folders), Object.prototype);

    const fixed = nullProtoMaps(clone);
    assert.strictEqual(Object.getPrototypeOf(fixed.folders), null);
    assert.strictEqual(Object.getPrototypeOf(fixed.tags), null);
    assert.strictEqual(Object.getPrototypeOf(fixed.chats), null);
    // A non-own prototype-name index now resolves to undefined, not the inherited
    // Object member it would have on a normal-prototype map.
    assert.strictEqual(
      (fixed.folders as Record<string, unknown>).constructor,
      undefined,
    );
    assert.strictEqual(
      (fixed.chats as Record<string, unknown>).hasOwnProperty,
      undefined,
    );
  });

  it('preserves every own entry and the other document fields unchanged', () => {
    const base = emptyProjectMeta(DEVICE, NOW);
    base.folders.f1 = { id: 'f1', name: 'Inbox', parentId: null, order: 0 };
    base.tags.t1 = { id: 't1', label: 'urgent' };
    base.chats.c1 = {
      folderId: 'f1',
      tags: ['t1'],
      links: [],
      updatedAt: NOW,
      deviceId: DEVICE,
    };
    const fixed = nullProtoMaps(cloned(base));
    assert.deepStrictEqual(Object.keys(fixed.folders), ['f1']);
    assert.deepStrictEqual(Object.keys(fixed.tags), ['t1']);
    assert.deepStrictEqual(Object.keys(fixed.chats), ['c1']);
    assert.strictEqual(fixed.folders.f1.name, 'Inbox');
    assert.strictEqual(fixed.chats.c1.folderId, 'f1');
    assert.strictEqual(fixed.schemaVersion, SCHEMA_VERSION);
    assert.strictEqual(fixed.deviceId, DEVICE);
    // The maps still JSON-serialize as ordinary objects (sync/export unchanged).
    assert.strictEqual(
      JSON.stringify(fixed.folders),
      JSON.stringify({ f1: { id: 'f1', name: 'Inbox', parentId: null, order: 0 } }),
    );
  });
});

// Security fix pass round 1: the shared free-text cap at the normalize ingest
// boundary (import / sync-merge). Over-long names are TRUNCATED, not dropped, so
// a foreign document keeps its records while the oversized payload (which could
// break the project's Settings Sync item) never re-enters the synced store. The
// restoredAt scalar (deliberate-restore intent) must also round-trip.
describe('schema normalize: free-text caps and restoredAt carry-through', () => {
  const DEVICE = 'dev-T';
  const NOW = 1_700_000_000_000;

  it('truncates an over-long folder name to MAX_NAME_LENGTH instead of dropping the folder', () => {
    const raw = {
      schemaVersion: SCHEMA_VERSION,
      folders: { f1: { name: 'n'.repeat(50000), parentId: null, order: 0 } },
      tags: {},
      chats: {},
      updatedAt: NOW,
      deviceId: DEVICE,
    };
    const meta = migrateProjectMeta(raw, DEVICE, NOW);
    assert.ok('f1' in meta.folders, 'the record survives');
    assert.strictEqual(meta.folders.f1.name.length, 200);
  });

  it('truncates an over-long tag label to MAX_NAME_LENGTH instead of dropping the tag', () => {
    const raw = {
      schemaVersion: SCHEMA_VERSION,
      folders: {},
      tags: { t1: { label: 'l'.repeat(50000) } },
      chats: {},
      updatedAt: NOW,
      deviceId: DEVICE,
    };
    const meta = migrateProjectMeta(raw, DEVICE, NOW);
    assert.ok('t1' in meta.tags);
    assert.strictEqual(meta.tags.t1.label.length, 200);
  });

  it('leaves a normal-length name/label untouched', () => {
    const raw = {
      schemaVersion: SCHEMA_VERSION,
      folders: { f1: { name: 'Inbox', parentId: null, order: 0 } },
      tags: { t1: { label: 'auth' } },
      chats: {},
      updatedAt: NOW,
      deviceId: DEVICE,
    };
    const meta = migrateProjectMeta(raw, DEVICE, NOW);
    assert.strictEqual(meta.folders.f1.name, 'Inbox');
    assert.strictEqual(meta.tags.t1.label, 'auth');
  });

  it('clamps an unbounded deviceId at both the project and per-chat stamps', () => {
    const huge = 'd'.repeat(5000);
    const raw = {
      schemaVersion: SCHEMA_VERSION,
      folders: {},
      tags: {},
      chats: {
        c: { folderId: null, tags: [], links: [], updatedAt: 1, deviceId: huge },
      },
      updatedAt: NOW,
      deviceId: huge,
    };
    const meta = migrateProjectMeta(raw, DEVICE, NOW);
    assert.strictEqual(meta.deviceId.length, MAX_DEVICE_ID_LENGTH);
    assert.strictEqual(meta.chats.c.deviceId.length, MAX_DEVICE_ID_LENGTH);
    // A normal UUID-length stamp is untouched.
    const uuid = '0a1b2c3d-4e5f-6789-abcd-ef0123456789';
    const normal = migrateProjectMeta({ ...raw, deviceId: uuid }, DEVICE, NOW);
    assert.strictEqual(normal.deviceId, uuid);
  });

  it('carries restoredAt through normalize and drops a non-number restoredAt', () => {
    const raw = {
      schemaVersion: SCHEMA_VERSION,
      folders: {},
      tags: {},
      chats: {
        a: { folderId: null, tags: [], links: [], updatedAt: 1, deviceId: 'd', userArchived: false, restoredAt: 4242 },
        b: { folderId: null, tags: [], links: [], updatedAt: 1, deviceId: 'd', restoredAt: 'evil' },
      },
      updatedAt: NOW,
      deviceId: DEVICE,
    };
    const meta = migrateProjectMeta(raw, DEVICE, NOW);
    assert.strictEqual(meta.chats.a.restoredAt, 4242);
    assert.strictEqual('restoredAt' in meta.chats.b, false);
  });
});

// Security fix pass (import-envelope hardening): reference-id gates that mirror
// the store sinks, exactly one rule at both boundaries.
describe('schema normalize: reference-id gates (parentId, link targetChatId)', () => {
  function docWithFolder(folder: Record<string, unknown>) {
    return {
      schemaVersion: SCHEMA_VERSION,
      folders: { f1: folder },
      tags: {},
      chats: {},
      updatedAt: 1,
      deviceId: 'd',
    };
  }
  function docWithLinks(links: unknown[]) {
    return {
      schemaVersion: SCHEMA_VERSION,
      folders: {},
      tags: {},
      chats: { c: { folderId: null, tags: [], links, updatedAt: 1, deviceId: 'd' } },
      updatedAt: 1,
      deviceId: 'd',
    };
  }

  it('drops a prototype-name or unbounded folder parentId to null and keeps a valid one', () => {
    const proto = migrateProjectMeta(
      docWithFolder({ name: 'F', parentId: 'constructor', order: 0 }),
      DEVICE,
      NOW,
    );
    assert.strictEqual(proto.folders.f1.parentId, null);
    const huge = migrateProjectMeta(
      docWithFolder({ name: 'F', parentId: 'x'.repeat(100000), order: 0 }),
      DEVICE,
      NOW,
    );
    assert.strictEqual(huge.folders.f1.parentId, null);
    const traversal = migrateProjectMeta(
      docWithFolder({ name: 'F', parentId: '../../evil', order: 0 }),
      DEVICE,
      NOW,
    );
    assert.strictEqual(traversal.folders.f1.parentId, null);
    const valid = migrateProjectMeta(
      docWithFolder({ name: 'F', parentId: 'top', order: 0 }),
      DEVICE,
      NOW,
    );
    assert.strictEqual(valid.folders.f1.parentId, 'top');
  });

  it('drops a link whose targetChatId is prototype-named, unbounded, or malformed', () => {
    const meta = migrateProjectMeta(
      docWithLinks([
        { targetChatId: 'valueOf', kind: 'parent' },
        { targetChatId: 'x'.repeat(100000), kind: 'related' },
        { targetChatId: 'has space', kind: 'related' },
        { targetChatId: 'good-1', kind: 'parent' },
      ]),
      DEVICE,
      NOW,
    );
    assert.deepStrictEqual(meta.chats.c.links, [
      { targetChatId: 'good-1', kind: 'parent' },
    ]);
  });
});

// Security fix pass (import-envelope hardening): the __unknown escrow size cap.
// The escrow replays on every synced write; a forward-schemaVersion claim from
// an attacker-authored import must not carry an unbounded blob onto the synced
// surface.
describe('schema migrateProjectMeta __unknown escrow size cap', () => {
  function forwardDoc(extra: Record<string, unknown>) {
    return {
      schemaVersion: SCHEMA_VERSION + 5,
      folders: {},
      tags: {},
      chats: {},
      updatedAt: 1,
      deviceId: 'd',
      ...extra,
    };
  }

  it('drops an unknown field whose serialized size exceeds the escrow budget', () => {
    const blob = 'x'.repeat(MAX_UNKNOWN_ESCROW_LENGTH + 1);
    const meta = migrateProjectMeta(forwardDoc({ hugeBlob: blob }), DEVICE, NOW);
    assert.strictEqual(meta.__unknown, undefined);
  });

  it('keeps the small legitimate fields when one oversized field is dropped', () => {
    const blob = 'x'.repeat(MAX_UNKNOWN_ESCROW_LENGTH + 1);
    const meta = migrateProjectMeta(
      forwardDoc({ pinnedChats: ['c1'], hugeBlob: blob, smartRules: { a: 1 } }),
      DEVICE,
      NOW,
    );
    assert.deepStrictEqual(meta.__unknown, {
      pinnedChats: ['c1'],
      smartRules: { a: 1 },
    });
  });

  it('keeps an escrow comfortably under the budget verbatim', () => {
    const meta = migrateProjectMeta(
      forwardDoc({ note: 'n'.repeat(1000) }),
      DEVICE,
      NOW,
    );
    assert.deepStrictEqual(meta.__unknown, { note: 'n'.repeat(1000) });
  });

  it('preserves the escrow across a SECOND migration (persisted docs nest it under __unknown)', () => {
    // The write path persists the ProjectMeta as-is, so a round-tripped stored
    // document carries the escrowed fields NESTED under __unknown rather than
    // at top level. A re-read must fold them back into the escrow, or the
    // foreign machine's fields survive exactly one write and are then lost.
    const first = migrateProjectMeta(forwardDoc({ pinnedChats: ['c1'] }), DEVICE, NOW);
    assert.deepStrictEqual(first.__unknown, { pinnedChats: ['c1'] });
    const second = migrateProjectMeta(
      JSON.parse(JSON.stringify(first)),
      DEVICE,
      NOW,
    );
    assert.deepStrictEqual(second.__unknown, { pinnedChats: ['c1'] });
  });

  it('prefers a live top-level field over a stale nested-escrow entry of the same name', () => {
    const meta = migrateProjectMeta(
      forwardDoc({ pinnedChats: ['fresh'], __unknown: { pinnedChats: ['stale'], legacy: 1 } }),
      DEVICE,
      NOW,
    );
    assert.deepStrictEqual(meta.__unknown, { pinnedChats: ['fresh'], legacy: 1 });
  });

  it('applies the size budget to nested-escrow entries too', () => {
    const blob = 'x'.repeat(MAX_UNKNOWN_ESCROW_LENGTH + 1);
    const meta = migrateProjectMeta(
      forwardDoc({ __unknown: { hugeBlob: blob, small: 1 } }),
      DEVICE,
      NOW,
    );
    assert.deepStrictEqual(meta.__unknown, { small: 1 });
  });

  it('escrows an own "__proto__" field as an own key without rebinding the map prototype', () => {
    // JSON.parse creates '__proto__' as an OWN key; model that exact input.
    const raw = JSON.parse(
      '{"schemaVersion":' +
        String(SCHEMA_VERSION + 5) +
        ',"folders":{},"tags":{},"chats":{},"updatedAt":1,"deviceId":"d",' +
        '"__proto__":{"polluted":true},"other":1}',
    ) as Record<string, unknown>;
    const meta = migrateProjectMeta(raw, DEVICE, NOW);
    const escrow = meta.__unknown as Record<string, unknown>;
    assert.ok(escrow !== undefined);
    assert.strictEqual(escrow.other, 1);
    // The field survives as an OWN key (not a prototype rebind) so it replays
    // on write, and the global prototype is untouched.
    assert.ok(Object.prototype.hasOwnProperty.call(escrow, '__proto__'));
    assert.strictEqual(Object.getPrototypeOf(escrow), Object.prototype);
    assert.strictEqual(({} as Record<string, unknown>).polluted, undefined);
  });
});

// Security fix pass (import-envelope hardening): the project-key predicate that
// gates the import envelope and the store's write sink.
describe('schema isSafeProjectKey', () => {
  it('accepts real encodeProjectKey outputs', () => {
    assert.strictEqual(
      isSafeProjectKey('c--Users-JakeMismas-Documents-Claude-Code---Nest'),
      true,
    );
    assert.strictEqual(isSafeProjectKey('c--proj'), true);
    assert.strictEqual(isSafeProjectKey('integration-test-project'), true);
  });

  it('rejects an empty, over-long, or illegal-charset key', () => {
    assert.strictEqual(isSafeProjectKey(''), false);
    assert.strictEqual(isSafeProjectKey('a'.repeat(257)), false);
    assert.strictEqual(isSafeProjectKey('a'.repeat(256)), true);
    assert.strictEqual(isSafeProjectKey('../../evil'), false);
    assert.strictEqual(isSafeProjectKey('nest.meta.v1::x'), false);
    assert.strictEqual(isSafeProjectKey('__proto__'), false);
    assert.strictEqual(isSafeProjectKey('has space'), false);
    assert.strictEqual(isSafeProjectKey('under_score'), false);
    assert.strictEqual(isSafeProjectKey(42), false);
  });

  it('rejects the bare prototype member names that pass the charset', () => {
    assert.strictEqual(isSafeProjectKey('constructor'), false);
    assert.strictEqual(isSafeProjectKey('toString'), false);
    assert.strictEqual(isSafeProjectKey('hasOwnProperty'), false);
  });
});
