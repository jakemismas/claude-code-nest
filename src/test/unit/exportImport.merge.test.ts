import * as assert from 'assert';
import { ChatMeta, Folder, ProjectMeta, emptyProjectMeta } from '../../store/schema';
import { mergeProjectMeta } from '../../store/exportImport';

// Pure-logic unit tests for the Slice 3 per-scalar LWW extension of
// mergeProjectMeta: starred / userArchived / archivedAt arbitrated by the single
// per-record updatedAt (archivedAt coupled to userArchived), and Folder.color
// arbitrated by the document-level updatedAt via foldersEqual/cloneFolder. The
// tag/link union and folderId conflict floor are unchanged; a couple of guards
// here confirm the extension did not disturb them. No vscode, no filesystem.

const DEVICE = 'dev-A';
const NOW = 1_700_000_000_000;

function proj(overrides: Partial<ProjectMeta> = {}): ProjectMeta {
  return { ...emptyProjectMeta(DEVICE, NOW), ...overrides };
}

describe('exportImport mergeProjectMeta: chat curation scalar LWW (starred/userArchived/archivedAt)', () => {
  it('takes the FILE scalars when the file record stamp is newer', () => {
    const live = proj({
      chats: {
        c: { folderId: null, tags: [], links: [], updatedAt: 10, deviceId: 'd', starred: false },
      },
    });
    const file = proj({
      chats: {
        c: {
          folderId: null,
          tags: [],
          links: [],
          updatedAt: 20,
          deviceId: 'd2',
          starred: true,
          userArchived: true,
          archivedAt: 555,
        },
      },
    });
    const c = mergeProjectMeta('pk', live, file).merged.chats.c;
    assert.strictEqual(c.starred, true);
    assert.strictEqual(c.userArchived, true);
    assert.strictEqual(c.archivedAt, 555);
  });

  it('keeps the LIVE scalars when the live record stamp is newer', () => {
    const live = proj({
      chats: {
        c: {
          folderId: null,
          tags: [],
          links: [],
          updatedAt: 20,
          deviceId: 'd',
          starred: true,
          userArchived: true,
          archivedAt: 100,
        },
      },
    });
    const file = proj({
      chats: {
        c: { folderId: null, tags: [], links: [], updatedAt: 10, deviceId: 'd2', starred: false },
      },
    });
    const c = mergeProjectMeta('pk', live, file).merged.chats.c;
    assert.strictEqual(c.starred, true);
    assert.strictEqual(c.userArchived, true);
    assert.strictEqual(c.archivedAt, 100);
  });

  it('breaks a TIE for the live side (local-wins bias, same as folderId)', () => {
    const live = proj({
      chats: {
        c: { folderId: null, tags: [], links: [], updatedAt: 10, deviceId: 'd', starred: true },
      },
    });
    const file = proj({
      chats: {
        c: { folderId: null, tags: [], links: [], updatedAt: 10, deviceId: 'd2', starred: false },
      },
    });
    assert.strictEqual(mergeProjectMeta('pk', live, file).merged.chats.c.starred, true);
  });

  it('couples archivedAt to userArchived: a newer UNarchive on the file clears both', () => {
    // Live had the chat archived at t=100. The file UNarchived it later (no
    // archivedAt). The newer file side wins, so userArchived flips false AND the
    // stale archivedAt does not linger from the live side.
    const live = proj({
      chats: {
        c: {
          folderId: null,
          tags: [],
          links: [],
          updatedAt: 10,
          deviceId: 'd',
          userArchived: true,
          archivedAt: 100,
        },
      },
    });
    const file = proj({
      chats: {
        c: {
          folderId: null,
          tags: [],
          links: [],
          updatedAt: 20,
          deviceId: 'd2',
          userArchived: false,
        },
      },
    });
    const c = mergeProjectMeta('pk', live, file).merged.chats.c;
    assert.strictEqual(c.userArchived, false);
    // archivedAt travels with the winning (file) side, which has none.
    assert.strictEqual('archivedAt' in c, false);
  });

  it('a scalar-only flip is detected as a change', () => {
    const live = proj({
      chats: {
        c: { folderId: null, tags: [], links: [], updatedAt: 10, deviceId: 'd', starred: false },
      },
      updatedAt: 10,
    });
    const file = proj({
      chats: {
        c: { folderId: null, tags: [], links: [], updatedAt: 20, deviceId: 'd2', starred: true },
      },
      updatedAt: 20,
    });
    assert.strictEqual(mergeProjectMeta('pk', live, file).changed, true);
  });

  it('carries the scalars onto a FILE-ONLY chat (clone path)', () => {
    const live = proj({});
    const file = proj({
      chats: {
        c: {
          folderId: 'f',
          tags: ['x'],
          links: [],
          updatedAt: 5,
          deviceId: 'd2',
          starred: true,
          userArchived: true,
          archivedAt: 7,
        },
      },
    });
    const c = mergeProjectMeta('pk', live, file).merged.chats.c;
    assert.strictEqual(c.starred, true);
    assert.strictEqual(c.userArchived, true);
    assert.strictEqual(c.archivedAt, 7);
  });

  it('does not invent scalars on a chat that has none on either side', () => {
    const live = proj({
      chats: { c: { folderId: null, tags: [], links: [], updatedAt: 10, deviceId: 'd' } },
    });
    const file = proj({
      chats: { c: { folderId: null, tags: ['y'], links: [], updatedAt: 20, deviceId: 'd2' } },
    });
    const c = mergeProjectMeta('pk', live, file).merged.chats.c;
    assert.strictEqual('starred' in c, false);
    assert.strictEqual('userArchived' in c, false);
    assert.strictEqual('archivedAt' in c, false);
    // The unrelated tag union still works.
    assert.deepStrictEqual(c.tags, ['y']);
  });

  it('carries the LOSER starred when the newer side set ONLY the archive pair (independent groups)', () => {
    // Machine A starred c (older stamp). Machine B later archived a DIFFERENT
    // decision on the same record (newer stamp) and never touched starred. The
    // newer side wins the archive pair, but starred is orthogonal: the older
    // side's star must survive, not be dropped with the rest of the loser.
    const live = proj({
      chats: {
        c: { folderId: null, tags: [], links: [], updatedAt: 10, deviceId: 'dA', starred: true },
      },
    });
    const file = proj({
      chats: {
        c: {
          folderId: null,
          tags: [],
          links: [],
          updatedAt: 20,
          deviceId: 'dB',
          userArchived: true,
          archivedAt: 20,
        },
      },
    });
    const c = mergeProjectMeta('pk', live, file).merged.chats.c;
    assert.strictEqual(c.starred, true, 'older independent star survives the newer archive');
    assert.strictEqual(c.userArchived, true);
    assert.strictEqual(c.archivedAt, 20);
  });

  it('carries the LOSER archive pair when the newer side set ONLY starred (reverse direction, no silent un-archive)', () => {
    // Machine A archived c (older stamp). Machine B later starred it (newer
    // stamp) and never touched the archive flag. The newer side wins starred, but
    // the archive decision must NOT silently vanish (the worse direction: a drop
    // here un-archives a chat the user archived).
    const live = proj({
      chats: {
        c: {
          folderId: null,
          tags: [],
          links: [],
          updatedAt: 10,
          deviceId: 'dA',
          userArchived: true,
          archivedAt: 5,
        },
      },
    });
    const file = proj({
      chats: {
        c: { folderId: null, tags: [], links: [], updatedAt: 20, deviceId: 'dB', starred: true },
      },
    });
    const c = mergeProjectMeta('pk', live, file).merged.chats.c;
    assert.strictEqual(c.starred, true, 'newer star wins');
    assert.strictEqual(c.userArchived, true, 'older independent archive decision survives');
    assert.strictEqual(c.archivedAt, 5, 'coupled archivedAt rides with the surviving archive flag');
  });

  it('a TIE carries each independent group from whichever side set it (live wins a contested group)', () => {
    // Equal stamps. live set starred, file set the archive pair. Neither group is
    // contested, so BOTH survive; the tie rule (keep live) only decides a group
    // BOTH sides set.
    const live = proj({
      chats: {
        c: { folderId: null, tags: [], links: [], updatedAt: 10, deviceId: 'dA', starred: true },
      },
    });
    const file = proj({
      chats: {
        c: {
          folderId: null,
          tags: [],
          links: [],
          updatedAt: 10,
          deviceId: 'dB',
          userArchived: true,
          archivedAt: 9,
        },
      },
    });
    const c = mergeProjectMeta('pk', live, file).merged.chats.c;
    assert.strictEqual(c.starred, true);
    assert.strictEqual(c.userArchived, true);
    assert.strictEqual(c.archivedAt, 9);
  });

  it('when BOTH sides set the SAME group the stamp-winner takes it (LWW within a group)', () => {
    // Both set starred AND the archive pair; the newer file side wins both groups.
    const live = proj({
      chats: {
        c: {
          folderId: null,
          tags: [],
          links: [],
          updatedAt: 10,
          deviceId: 'dA',
          starred: false,
          userArchived: true,
          archivedAt: 5,
        },
      },
    });
    const file = proj({
      chats: {
        c: {
          folderId: null,
          tags: [],
          links: [],
          updatedAt: 20,
          deviceId: 'dB',
          starred: true,
          userArchived: false,
        },
      },
    });
    const c = mergeProjectMeta('pk', live, file).merged.chats.c;
    assert.strictEqual(c.starred, true);
    assert.strictEqual(c.userArchived, false);
    assert.strictEqual('archivedAt' in c, false, 'newer side cleared archive, no stale timestamp');
  });

  it('arbitrates folderId and the new scalars together by the same record stamp', () => {
    // The newer side wins BOTH the folderId scalar and the curation scalars off
    // the SAME updatedAt, and a differing-non-null folderId is still the floor.
    const live = proj({
      chats: {
        c: { folderId: 'fLive', tags: [], links: [], updatedAt: 10, deviceId: 'd', starred: false },
      },
    });
    const file = proj({
      chats: {
        c: { folderId: 'fFile', tags: [], links: [], updatedAt: 20, deviceId: 'd2', starred: true },
      },
    });
    const r = mergeProjectMeta('pk', live, file);
    assert.strictEqual(r.merged.chats.c.folderId, 'fFile');
    assert.strictEqual(r.merged.chats.c.starred, true);
    assert.deepStrictEqual(r.folderConflicts, ['c']);
  });
});

describe('exportImport mergeProjectMeta: Folder.color LWW (document-level)', () => {
  function coloredFolder(color?: string): { [id: string]: Folder } {
    const f: Folder = { id: 'a', name: 'A', parentId: null, order: 0 };
    if (color !== undefined) {
      f.color = color;
    }
    return { a: f };
  }

  it('a color-only edit is NOT a silent no-op: the higher document updatedAt wins', () => {
    // This is the documented trap. foldersEqual must see a color-only diff as a
    // difference, and the newer-document side must replace the folder.
    const live = proj({ folders: coloredFolder('#111'), updatedAt: 10 });
    const file = proj({ folders: coloredFolder('#222'), updatedAt: 20 });
    const r = mergeProjectMeta('pk', live, file);
    assert.strictEqual(r.merged.folders.a.color, '#222');
    assert.strictEqual(r.changed, true);
  });

  it('a color-only edit on the OLDER file does not overwrite live', () => {
    const live = proj({ folders: coloredFolder('#111'), updatedAt: 20 });
    const file = proj({ folders: coloredFolder('#222'), updatedAt: 10 });
    const r = mergeProjectMeta('pk', live, file);
    assert.strictEqual(r.merged.folders.a.color, '#111');
    assert.strictEqual(r.changed, false);
  });

  it('setting a color where live had none (newer file) carries it through', () => {
    const live = proj({ folders: coloredFolder(undefined), updatedAt: 10 });
    const file = proj({ folders: coloredFolder('#abc'), updatedAt: 20 });
    const r = mergeProjectMeta('pk', live, file);
    assert.strictEqual(r.merged.folders.a.color, '#abc');
    assert.strictEqual(r.changed, true);
  });

  it('identical color is not a change', () => {
    const live = proj({ folders: coloredFolder('#abc'), updatedAt: 10 });
    const file = proj({ folders: coloredFolder('#abc'), updatedAt: 20 });
    assert.strictEqual(mergeProjectMeta('pk', live, file).changed, false);
  });

  it('a file-only colored folder is added with its color', () => {
    const live = proj({ updatedAt: 10 });
    const file = proj({ folders: coloredFolder('#fff'), updatedAt: 20 });
    const r = mergeProjectMeta('pk', live, file);
    assert.strictEqual(r.merged.folders.a.color, '#fff');
  });
});

describe('exportImport mergeProjectMeta: drops unsafe file-side MAP KEYS (path-traversal + prototype)', () => {
  // The merge re-keys merged.folders/tags/chats with the FILE-side map key
  // verbatim. mergeProjectMeta is public and called directly on import/reconcile,
  // so it must gate every file key the same way the normalize boundary does: an
  // untrusted '../../x' or prototype-name key must never re-enter the merged
  // document (a chat key reaches the archive body-file path sink).
  function chatRec(updatedAt = 20): ChatMeta {
    return { folderId: null, tags: [], links: [], updatedAt, deviceId: 'd' };
  }

  it('drops a file chat whose KEY is a path-traversal string, keeping a valid sibling', () => {
    const uuid = '0a1b2c3d-4e5f-6789-abcd-ef0123456789';
    const live = proj({ updatedAt: 10 });
    const file = proj({
      updatedAt: 20,
      chats: {
        '../../../../Users/victim/evil': chatRec(),
        [uuid]: chatRec(),
      },
    });
    const merged = mergeProjectMeta('pk', live, file).merged;
    assert.deepStrictEqual(Object.keys(merged.chats), [uuid], 'only the UUID-keyed chat merges in');
  });

  it('drops file folder/tag keys that are prototype names, never adding a phantom record', () => {
    const live = proj({ updatedAt: 10 });
    const file = proj({
      updatedAt: 20,
      folders: { constructor: { id: 'constructor', name: 'Phantom', parentId: null, order: 0 } },
      tags: { toString: { id: 'toString', label: 'Phantom' } },
    });
    const merged = mergeProjectMeta('pk', live, file).merged;
    assert.deepStrictEqual(Object.keys(merged.folders), []);
    assert.deepStrictEqual(Object.keys(merged.tags), []);
  });

  it('an import whose ONLY entries are unsafe-keyed merges as a no-op (changed=false)', () => {
    const live = proj({ updatedAt: 10 });
    // Build the unsafe-keyed map with explicit OWN keys. A literal `__proto__:`
    // would set the prototype rather than an own key, so define it as an own key
    // to model a genuine attacker-authored map.
    const evilChats: { [k: string]: ChatMeta } = { '../escape': chatRec() };
    Object.defineProperty(evilChats, 'constructor', {
      value: chatRec(),
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const file = proj({ updatedAt: 20, chats: evilChats });
    const result = mergeProjectMeta('pk', live, file);
    assert.deepStrictEqual(Object.keys(result.merged.chats), []);
    assert.strictEqual(result.changed, false, 'dropping all unsafe keys changes nothing');
  });

  it('PRESERVES a valid file-side UUID/minted key on merge (no real data lost)', () => {
    const uuid = '0a1b2c3d-4e5f-6789-abcd-ef0123456789';
    const folderId = 'f-18f0a-1a2b3c4d5e6f';
    const live = proj({ updatedAt: 10 });
    const file = proj({
      updatedAt: 20,
      folders: { [folderId]: { id: folderId, name: 'Inbox', parentId: null, order: 0 } },
      chats: { [uuid]: chatRec() },
    });
    const merged = mergeProjectMeta('pk', live, file).merged;
    assert.deepStrictEqual(Object.keys(merged.folders), [folderId]);
    assert.deepStrictEqual(Object.keys(merged.chats), [uuid]);
  });
});
