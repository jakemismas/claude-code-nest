import * as assert from 'assert';
import { ProjectMeta, emptyProjectMeta } from '../../store/schema';
import {
  SyncShadow,
  coerceShadow,
  reconcileProjectSync,
  shadowKeyFor,
} from '../../store/reconcileSync';
import { isMetaKey } from '../../store/schema';

// Pure-logic unit tests for the cross-machine reconcile algorithm. No vscode, no
// filesystem. The reconcile diffs a live synced ProjectMeta against the local-only
// shadow and decides: adopt (first sight), unchanged, self-write (our own later
// write), or foreign-merge (another device wrote it -> additive merge).

const THIS_DEVICE = 'dev-this';
const OTHER_DEVICE = 'dev-other';
const NOW = 1_700_000_000_000;

function proj(overrides: Partial<ProjectMeta> = {}): ProjectMeta {
  return { ...emptyProjectMeta(THIS_DEVICE, NOW), ...overrides };
}

function shadowOf(meta: ProjectMeta, deviceId = THIS_DEVICE): SyncShadow {
  return { meta: JSON.parse(JSON.stringify(meta)), deviceId };
}

describe('reconcileSync shadow key is non-synced', () => {
  it('builds a nest.shadow.v1:: key that isMetaKey rejects (never swept into sync)', () => {
    const key = shadowKeyFor('c--proj');
    assert.strictEqual(key, 'nest.shadow.v1::c--proj');
    assert.strictEqual(isMetaKey(key), false);
  });
});

describe('reconcileSync reconcileProjectSync', () => {
  it('adopts the live value as the shadow on first sight (no shadow yet)', () => {
    const live = proj({ updatedAt: 10 });
    const r = reconcileProjectSync('pk', live, null, THIS_DEVICE);
    assert.strictEqual(r.kind, 'adopt');
    if (r.kind === 'adopt') {
      assert.deepStrictEqual(r.shadow.meta, live);
      assert.strictEqual(r.shadow.deviceId, THIS_DEVICE);
    }
  });

  it('reports unchanged when the live value equals the shadow', () => {
    const live = proj({ updatedAt: 10 });
    const r = reconcileProjectSync('pk', live, shadowOf(live), THIS_DEVICE);
    assert.strictEqual(r.kind, 'unchanged');
  });

  it('classifies a change still stamped by THIS device as a self-write', () => {
    const shadow = shadowOf(proj({ updatedAt: 10 }));
    // The live value advanced but is still stamped by this device: our own later
    // write the shadow has not caught up to. No merge; refresh the shadow.
    const live = proj({
      folders: { a: { id: 'a', name: 'A', parentId: null, order: 0 } },
      updatedAt: 20,
      deviceId: THIS_DEVICE,
    });
    const r = reconcileProjectSync('pk', live, shadow, THIS_DEVICE);
    assert.strictEqual(r.kind, 'self-write');
    if (r.kind === 'self-write') {
      assert.deepStrictEqual(r.shadow.meta, live);
    }
  });

  it('detects a FOREIGN project-level write and merges additively', () => {
    // Shadow: this device had filed chat c into fLocal and tagged it x.
    const shadow = shadowOf(
      proj({
        chats: {
          c: { folderId: 'fLocal', tags: ['x'], links: [], updatedAt: 10, deviceId: THIS_DEVICE },
        },
        updatedAt: 10,
      }),
    );
    // Live: the OTHER device wholesale-replaced the synced value. It tagged c with
    // y and gave it a newer home fRemote, and it does NOT carry our tag x.
    const live = proj({
      chats: {
        c: { folderId: 'fRemote', tags: ['y'], links: [], updatedAt: 20, deviceId: OTHER_DEVICE },
      },
      updatedAt: 20,
      deviceId: OTHER_DEVICE,
    });
    const r = reconcileProjectSync('pk', live, shadow, THIS_DEVICE);
    assert.strictEqual(r.kind, 'foreign-merge');
    if (r.kind === 'foreign-merge') {
      // Tags are unioned: our x survives, their y is added (additive, no loss).
      assert.deepStrictEqual(r.result.merged.chats.c.tags.sort(), ['x', 'y']);
      // folderId is LWW by record updatedAt: the newer remote home wins.
      assert.strictEqual(r.result.merged.chats.c.folderId, 'fRemote');
      // The same-scalar conflict is surfaced.
      assert.deepStrictEqual(r.result.folderConflicts, ['c']);
      // The refreshed shadow is the merged value, stamped by this device.
      assert.strictEqual(r.shadow.deviceId, THIS_DEVICE);
      assert.deepStrictEqual(r.shadow.meta.chats.c.tags.sort(), ['x', 'y']);
    }
  });

  it('detects a foreign write via a chat record deviceId newer than the shadow', () => {
    // Project-level deviceId is still ours (a partial/foreign record write), but a
    // chat record carries another device id with a newer stamp than the shadow.
    const shadow = shadowOf(
      proj({
        chats: {
          c: { folderId: 'fLocal', tags: [], links: [], updatedAt: 10, deviceId: THIS_DEVICE },
        },
        updatedAt: 10,
      }),
    );
    const live = proj({
      chats: {
        c: { folderId: 'fRemote', tags: [], links: [], updatedAt: 20, deviceId: OTHER_DEVICE },
      },
      updatedAt: 10,
      deviceId: THIS_DEVICE,
    });
    const r = reconcileProjectSync('pk', live, shadow, THIS_DEVICE);
    assert.strictEqual(r.kind, 'foreign-merge');
  });

  it('foreign-merge restores a local-only record the foreign value dropped', () => {
    // Shadow knows about two chats; the foreign live value dropped chat b entirely.
    const shadow = shadowOf(
      proj({
        chats: {
          a: { folderId: 'fa', tags: [], links: [], updatedAt: 10, deviceId: THIS_DEVICE },
          b: { folderId: 'fb', tags: ['keep'], links: [], updatedAt: 10, deviceId: THIS_DEVICE },
        },
        updatedAt: 10,
      }),
    );
    const live = proj({
      chats: {
        a: { folderId: 'fa', tags: [], links: [], updatedAt: 20, deviceId: OTHER_DEVICE },
      },
      updatedAt: 20,
      deviceId: OTHER_DEVICE,
    });
    const r = reconcileProjectSync('pk', live, shadow, THIS_DEVICE);
    assert.strictEqual(r.kind, 'foreign-merge');
    if (r.kind === 'foreign-merge') {
      // Chat b (local-only, dropped by the foreign wholesale-replace) is restored.
      assert.ok('b' in r.result.merged.chats);
      assert.deepStrictEqual(r.result.merged.chats.b.tags, ['keep']);
      // ...and storeChanged is true so reconcileAllProjects actually writes it back
      // (the foreign live lacks b, so merged != live).
      assert.strictEqual(r.storeChanged, true, 'whole-chat restore forces the store write');
    }
  });

  it('restores a dropped local-only FOLDER and chat LINK too (storeChanged is structurally general)', () => {
    // The data-loss finding was about ANY local-only record a foreign subset drops,
    // not just chat tags. merged starts as a deep copy of the shadow base and only
    // ADDS from the foreign value, so a dropped folder and a dropped chat link are
    // restored exactly like a dropped tag, and storeChanged forces the write.
    const shadow = shadowOf(
      proj({
        folders: {
          fa: { id: 'fa', name: 'A', parentId: null, order: 0 },
          fb: { id: 'fb', name: 'B', parentId: null, order: 1 },
        },
        chats: {
          c: {
            folderId: 'fa',
            tags: [],
            links: [{ targetChatId: 't', kind: 'related' }],
            updatedAt: 10,
            deviceId: THIS_DEVICE,
          },
        },
        updatedAt: 10,
      }),
    );
    // The foreign value dropped folder fb and chat c's link, and re-stamped the project.
    const live = proj({
      folders: { fa: { id: 'fa', name: 'A', parentId: null, order: 0 } },
      chats: {
        c: { folderId: 'fa', tags: [], links: [], updatedAt: 5, deviceId: OTHER_DEVICE },
      },
      updatedAt: 20,
      deviceId: OTHER_DEVICE,
    });
    const r = reconcileProjectSync('pk', live, shadow, THIS_DEVICE);
    assert.strictEqual(r.kind, 'foreign-merge');
    if (r.kind === 'foreign-merge') {
      assert.ok('fb' in r.result.merged.folders, 'dropped folder fb restored');
      assert.deepStrictEqual(
        r.result.merged.chats.c.links,
        [{ targetChatId: 't', kind: 'related' }],
        'dropped chat link restored',
      );
      assert.strictEqual(r.storeChanged, true, 'the restore is gated to write');
    }
  });

  it('sets storeChanged when a foreign SUBSET dropped a local-only tag (changed:false but the store is wrong)', () => {
    // Shadow: chat c tagged [x, y] by THIS device. Live: the OTHER device delivered a
    // SUBSET (tags [x] only, OLDER per-chat stamp) and re-stamped the project. The
    // merge unions y back, so merged == shadow and result.changed is false. The store
    // holds the lossy live value, so storeChanged MUST be true: gating the command's
    // write on result.changed would skip the restore and lose y permanently.
    const shadow = shadowOf(
      proj({
        chats: { c: { folderId: 'fLocal', tags: ['x', 'y'], links: [], updatedAt: 10, deviceId: THIS_DEVICE } },
        updatedAt: 10,
      }),
    );
    const live = proj({
      chats: { c: { folderId: 'fLocal', tags: ['x'], links: [], updatedAt: 5, deviceId: OTHER_DEVICE } },
      updatedAt: 20,
      deviceId: OTHER_DEVICE,
    });
    const r = reconcileProjectSync('pk', live, shadow, THIS_DEVICE);
    assert.strictEqual(r.kind, 'foreign-merge');
    if (r.kind === 'foreign-merge') {
      // The union restored y, so the merge equals its SHADOW base: changed is false.
      assert.strictEqual(r.result.changed, false, 'merge equals the shadow base (changed:false)');
      assert.deepStrictEqual(r.result.merged.chats.c.tags.slice().sort(), ['x', 'y']);
      // ...but merged differs from the live STORE value, so the write MUST happen.
      assert.strictEqual(r.storeChanged, true, 'storeChanged is true so the restore is persisted');
    }
  });

  it('clears storeChanged when the foreign value is a pure SUPERSET (store already holds the union)', () => {
    // Project stayed ours; the foreign signal is a chat record the OTHER device wrote
    // with a NEWER stamp, ADDING tag z. Live is a superset of the shadow, so the union
    // equals live: nothing to restore, no store write needed.
    const shadow = shadowOf(
      proj({
        chats: { c: { folderId: 'fLocal', tags: ['x'], links: [], updatedAt: 10, deviceId: THIS_DEVICE } },
        updatedAt: 10,
      }),
    );
    const live = proj({
      chats: { c: { folderId: 'fLocal', tags: ['x', 'z'], links: [], updatedAt: 20, deviceId: OTHER_DEVICE } },
      updatedAt: 10,
      deviceId: THIS_DEVICE,
    });
    const r = reconcileProjectSync('pk', live, shadow, THIS_DEVICE);
    assert.strictEqual(r.kind, 'foreign-merge');
    if (r.kind === 'foreign-merge') {
      assert.deepStrictEqual(r.result.merged.chats.c.tags.slice().sort(), ['x', 'z']);
      assert.strictEqual(r.storeChanged, false, 'merged equals live: no redundant write');
    }
  });
});

describe('reconcileSync coerceShadow (defensive load of the non-synced shadow)', () => {
  it('returns null for absent/corrupt values (treated as first sight)', () => {
    assert.strictEqual(coerceShadow(undefined), null);
    assert.strictEqual(coerceShadow(null), null);
    assert.strictEqual(coerceShadow('x'), null);
    assert.strictEqual(coerceShadow({ meta: 'no' }), null);
    assert.strictEqual(coerceShadow({ meta: {}, deviceId: 5 }), null);
  });

  it('accepts a well-formed shadow', () => {
    const s = coerceShadow({ meta: proj(), deviceId: THIS_DEVICE });
    assert.notStrictEqual(s, null);
    if (s) {
      assert.strictEqual(s.deviceId, THIS_DEVICE);
    }
  });
});
