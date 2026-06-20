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

  it('reconciles a foreign write that FLIPPED starred additively, not wholesale-replaced (Slice 3)', () => {
    // Shadow: this device starred chat c (and tagged it x). The OTHER device
    // wholesale-replaced the synced value with a NEWER record that UNstarred c and
    // dropped tag x. The merge unions x back and the newer foreign starred=false
    // wins LWW; without the per-scalar arbitration the foreign opaque value would
    // wholesale-replace the curation scalar.
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
      // Tags are still unioned (additive): our x survives, their y is added.
      assert.deepStrictEqual(r.result.merged.chats.c.tags.slice().sort(), ['x', 'y']);
      // starred is LWW by record updatedAt: the newer foreign value (false) wins.
      assert.strictEqual(r.result.merged.chats.c.starred, false);
    }
  });

  it('restores a starred flag the foreign SUBSET dropped (older foreign record, our newer star survives)', () => {
    // Shadow: this device starred c with a NEWER stamp than the foreign value will
    // carry. The foreign wholesale-replace delivered an OLDER record without the
    // star and re-stamped the project. The merge keeps our newer star (LWW) AND
    // storeChanged is true so the restore is written back.
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

  it('reconciles a foreign Folder.color flip by document updatedAt with correct storeChanged (Slice 3)', () => {
    // Folder.color is arbitrated at the DOCUMENT level (not the per-record stamp),
    // and the real user hits this through the sync reconcile, not a manual import.
    // The OTHER device recolored folder fa on a NEWER document and re-stamped the
    // project; the newer document wins the color and the restore is written back.
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
      // The newer foreign document wins the color (document-level LWW). This is
      // the core assertion finding 2 asks for: color arbitrated through the sync
      // reconcile path, not just the manual-import unit.
      assert.strictEqual(r.result.merged.folders.fa.color, '#222');
      // storeChanged is true because the merge keeps the shadow base's
      // project-level stamp/deviceId (THIS_DEVICE, updatedAt 10) while the foreign
      // live carries OTHER_DEVICE/updatedAt 20, so merged != live at the document
      // level even though the color matches. This is the benign one-shot
      // re-stamp-and-converge documented on storeChanged; the write re-stamps and
      // the next poll is silent. (result.changed is the in-merge signal.)
      assert.strictEqual(r.result.changed, true, 'the color edit registered as a merge change');
    }
  });

  it('keeps the local Folder.color when the foreign document is OLDER, and writes the restore', () => {
    // The foreign value recolored fa but on an OLDER document. Document-level LWW
    // keeps our shadow color, so merged != live (live carries the losing color)
    // and storeChanged is true so the correct color is written back.
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

  it('reconciles a foreign userArchived/archivedAt flip, holding the coupling through the reconcile path (Slice 3)', () => {
    // Shadow: this device archived c at t=5. The OTHER device UNarchived it later
    // (newer record, no archivedAt) and re-stamped the project. The newer foreign
    // archive decision wins AND archivedAt stays coupled (cleared with the flag),
    // verified through the sync reconcile path, not just the manual-import unit.
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
    // The same independent-group collision finding, but exercised through the
    // CROSS-MACHINE reconcile (the path the user actually hits): this device
    // starred c (older record); the OTHER device later archived it (newer record)
    // without touching starred. The reconcile must keep the star AND apply the
    // newer archive, surfacing nothing as lost.
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
      // The star was restored relative to the lossy foreign live value, so the
      // store write must fire.
      assert.strictEqual(r.storeChanged, true, 'the restored star is gated to write');
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
