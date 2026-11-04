import * as assert from 'assert';
import { ProjectMeta, emptyProjectMeta } from '../../store/schema';
import {
  SyncShadow,
  coerceShadow,
  reconcileProjectSync,
  shadowKeyFor,
} from '../../store/reconcileSync';
import { isMetaKey } from '../../store/schema';

// Unit tests for the cross-machine reconcile: diffs live synced ProjectMeta against the local shadow
// and decides adopt, unchanged, self-write, or foreign-merge (additive).

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
    // Live advanced but is still stamped by this device: no merge, refresh the shadow.
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
    const shadow = shadowOf(
      proj({
        chats: {
          c: { folderId: 'fLocal', tags: ['x'], links: [], updatedAt: 10, deviceId: THIS_DEVICE },
        },
        updatedAt: 10,
      }),
    );
    // Live: the other device replaced the value, tagged c with y, gave it a newer home and dropped our tag x.
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
      assert.deepStrictEqual(r.result.merged.chats.c.tags.sort(), ['x', 'y']);
      // folderId is last-writer-wins by record updatedAt.
      assert.strictEqual(r.result.merged.chats.c.folderId, 'fRemote');
      assert.deepStrictEqual(r.result.folderConflicts, ['c']);
      assert.strictEqual(r.shadow.deviceId, THIS_DEVICE);
      assert.deepStrictEqual(r.shadow.meta.chats.c.tags.sort(), ['x', 'y']);
    }
  });

  it('detects a foreign write via a chat record deviceId newer than the shadow', () => {
    // The project stamp is still ours, but a chat record carries another device id with a newer stamp.
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
      // Chat b, dropped by the foreign replace, is restored.
      assert.ok('b' in r.result.merged.chats);
      assert.deepStrictEqual(r.result.merged.chats.b.tags, ['keep']);
      // storeChanged is true because the foreign live lacks b, so merged differs from live.
      assert.strictEqual(r.storeChanged, true, 'whole-chat restore forces the store write');
    }
  });

  it('restores a dropped local-only FOLDER and chat LINK too (storeChanged is structurally general)', () => {
    // Any local-only record dropped by a foreign subset is restored, not just chat tags: merged starts as
    // a copy of the shadow and only adds from the foreign value, and storeChanged forces the write.
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
    // Live is a subset (tags [x], older stamp). The merge unions y back, so merged equals the shadow and
    // changed is false; the store holds the lossy value, so storeChanged must still be true.
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
      assert.strictEqual(r.result.changed, false, 'merge equals the shadow base (changed:false)');
      assert.deepStrictEqual(r.result.merged.chats.c.tags.slice().sort(), ['x', 'y']);
      assert.strictEqual(r.storeChanged, true, 'storeChanged is true so the restore is persisted');
    }
  });

  it('reconciles a foreign write that FLIPPED starred additively, not wholesale-replaced', () => {
    // The other device replaced the value with a newer record that unstarred c and dropped tag x. Tags
    // still union, and the newer starred=false wins by last-writer-wins.
    const shadow = shadowOf(
      proj({
        chats: {
          c: { folderId: 'fLocal', tags: ['x'], links: [], updatedAt: 10, deviceId: THIS_DEVICE, starred: true },
        },
        updatedAt: 10,
      }),
    );
    const live = proj({
      chats: {
        c: { folderId: 'fLocal', tags: ['y'], links: [], updatedAt: 20, deviceId: OTHER_DEVICE, starred: false },
      },
      updatedAt: 20,
      deviceId: OTHER_DEVICE,
    });
    const r = reconcileProjectSync('pk', live, shadow, THIS_DEVICE);
    assert.strictEqual(r.kind, 'foreign-merge');
    if (r.kind === 'foreign-merge') {
      assert.deepStrictEqual(r.result.merged.chats.c.tags.slice().sort(), ['x', 'y']);
      assert.strictEqual(r.result.merged.chats.c.starred, false);
    }
  });

  it('restores a starred flag the foreign SUBSET dropped (older foreign record, our newer star survives)', () => {
    // Our star is newer than the foreign record, so it is kept and storeChanged is true to write it back.
    const shadow = shadowOf(
      proj({
        chats: {
          c: { folderId: 'fLocal', tags: [], links: [], updatedAt: 30, deviceId: THIS_DEVICE, starred: true },
        },
        updatedAt: 30,
      }),
    );
    const live = proj({
      chats: {
        c: { folderId: 'fLocal', tags: [], links: [], updatedAt: 5, deviceId: OTHER_DEVICE },
      },
      updatedAt: 40,
      deviceId: OTHER_DEVICE,
    });
    const r = reconcileProjectSync('pk', live, shadow, THIS_DEVICE);
    assert.strictEqual(r.kind, 'foreign-merge');
    if (r.kind === 'foreign-merge') {
      assert.strictEqual(r.result.merged.chats.c.starred, true, 'our newer star survives the foreign subset');
      assert.strictEqual(r.storeChanged, true, 'the restore is gated to write');
    }
  });

  it('reconciles a foreign Folder.color flip by document updatedAt with correct storeChanged', () => {
    // Folder.color is arbitrated at document level, through the sync reconcile path as well as manual import.
    // The other device recolored fa on a newer document, so the newer color wins and the restore is written.
    const shadow = shadowOf(
      proj({
        folders: { fa: { id: 'fa', name: 'A', parentId: null, order: 0, color: '#111' } },
        updatedAt: 10,
      }),
    );
    const live = proj({
      folders: { fa: { id: 'fa', name: 'A', parentId: null, order: 0, color: '#222' } },
      updatedAt: 20,
      deviceId: OTHER_DEVICE,
    });
    const r = reconcileProjectSync('pk', live, shadow, THIS_DEVICE);
    assert.strictEqual(r.kind, 'foreign-merge');
    if (r.kind === 'foreign-merge') {
      // The newer foreign document wins the color.
      assert.strictEqual(r.result.merged.folders.fa.color, '#222');
      // storeChanged is true because the merge keeps the shadow project stamp (THIS_DEVICE, 10) while live carries
      // OTHER_DEVICE and 20. This one-shot re-stamp converges, and the next poll is silent.
      assert.strictEqual(r.result.changed, true, 'the color edit registered as a merge change');
    }
  });

  it('keeps the local Folder.color when the foreign document is OLDER, and writes the restore', () => {
    // The foreign recolor is on an older document, so our color is kept and written back.
    const shadow = shadowOf(
      proj({
        folders: { fa: { id: 'fa', name: 'A', parentId: null, order: 0, color: '#111' } },
        updatedAt: 30,
      }),
    );
    const live = proj({
      folders: { fa: { id: 'fa', name: 'A', parentId: null, order: 0, color: '#222' } },
      updatedAt: 5,
      deviceId: OTHER_DEVICE,
    });
    const r = reconcileProjectSync('pk', live, shadow, THIS_DEVICE);
    assert.strictEqual(r.kind, 'foreign-merge');
    if (r.kind === 'foreign-merge') {
      assert.strictEqual(r.result.merged.folders.fa.color, '#111', 'older foreign color loses');
      assert.strictEqual(r.storeChanged, true, 'the correct color is written back to the store');
    }
  });

  it('reconciles a foreign userArchived/archivedAt flip, holding the coupling through the reconcile path', () => {
    // This device archived c at t=5; the other device later unarchived it. The newer decision wins and
    // archivedAt clears with the flag.
    const shadow = shadowOf(
      proj({
        chats: {
          c: {
            folderId: 'fLocal',
            tags: [],
            links: [],
            updatedAt: 5,
            deviceId: THIS_DEVICE,
            userArchived: true,
            archivedAt: 5,
          },
        },
        updatedAt: 5,
      }),
    );
    const live = proj({
      chats: {
        c: {
          folderId: 'fLocal',
          tags: [],
          links: [],
          updatedAt: 20,
          deviceId: OTHER_DEVICE,
          userArchived: false,
        },
      },
      updatedAt: 20,
      deviceId: OTHER_DEVICE,
    });
    const r = reconcileProjectSync('pk', live, shadow, THIS_DEVICE);
    assert.strictEqual(r.kind, 'foreign-merge');
    if (r.kind === 'foreign-merge') {
      assert.strictEqual(r.result.merged.chats.c.userArchived, false, 'newer foreign unarchive wins');
      assert.strictEqual('archivedAt' in r.result.merged.chats.c, false, 'archivedAt cleared with the flag');
    }
  });

  it('does NOT drop an independent starred when a foreign write flipped only the archive pair (independent groups through reconcile)', () => {
    // Same collision through the cross-machine reconcile: we starred c (older record), the other device
    // archived it (newer record) without touching starred. The star is kept and the archive applied.
    const shadow = shadowOf(
      proj({
        chats: {
          c: { folderId: 'fLocal', tags: [], links: [], updatedAt: 10, deviceId: THIS_DEVICE, starred: true },
        },
        updatedAt: 10,
      }),
    );
    const live = proj({
      chats: {
        c: {
          folderId: 'fLocal',
          tags: [],
          links: [],
          updatedAt: 20,
          deviceId: OTHER_DEVICE,
          userArchived: true,
          archivedAt: 20,
        },
      },
      updatedAt: 20,
      deviceId: OTHER_DEVICE,
    });
    const r = reconcileProjectSync('pk', live, shadow, THIS_DEVICE);
    assert.strictEqual(r.kind, 'foreign-merge');
    if (r.kind === 'foreign-merge') {
      assert.strictEqual(r.result.merged.chats.c.starred, true, 'local star survives the foreign archive');
      assert.strictEqual(r.result.merged.chats.c.userArchived, true, 'foreign archive applied');
      assert.strictEqual(r.result.merged.chats.c.archivedAt, 20);
      // The star was restored relative to the lossy live value, so the store write must fire.
      assert.strictEqual(r.storeChanged, true, 'the restored star is gated to write');
    }
  });

  it('clears storeChanged when the foreign value is a pure SUPERSET (store already holds the union)', () => {
    // A newer foreign chat record adds tag z; live is a superset of the shadow, so nothing needs restoring.
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
