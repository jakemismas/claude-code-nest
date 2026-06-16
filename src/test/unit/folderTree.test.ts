import * as assert from 'assert';
import { Folder } from '../../store/schema';
import {
  UNFILED_FOLDER_ID,
  assembleFolderTree,
  buildChatHomeIndex,
  canReuseChatMemberItem,
  canReuseFolderItem,
  chatNodeId,
  descendantFolderIds,
  expandFolderPath,
  findChildByName,
  isUnfiledId,
  parseChatNodeId,
  resolveChatHomeFolderId,
  splitFolderPath,
} from '../../model/folderTree';

// Pure-logic unit tests for the folder tree model: slash-path expansion
// (interpretation (b): a slash name becomes a CHAIN of real parent-child Folder
// records), the single-home invariant, tree assembly from flat records, and the
// composite-id grammar. No vscode import, no filesystem.

// A deterministic id minter so expansion output is assertable.
function counterMint(): () => string {
  let n = 0;
  return () => `id${n++}`;
}

function foldersByIdFrom(list: Folder[]): { [id: string]: Folder } {
  const map: { [id: string]: Folder } = {};
  for (const f of list) {
    map[f.id] = f;
  }
  return map;
}

describe('splitFolderPath', () => {
  it('splits on slash and drops empty/whitespace segments', () => {
    assert.deepStrictEqual(splitFolderPath('Work/ClientA'), ['Work', 'ClientA']);
    assert.deepStrictEqual(splitFolderPath(' Work / ClientA / '), ['Work', 'ClientA']);
    assert.deepStrictEqual(splitFolderPath('Work//ClientA'), ['Work', 'ClientA']);
    assert.deepStrictEqual(splitFolderPath('/'), []);
    assert.deepStrictEqual(splitFolderPath('   '), []);
  });
});

describe('expandFolderPath (interpretation (b): a chain of real records)', () => {
  it('mints a parent-child CHAIN for a fresh slash path; no literal slash in a name', () => {
    const result = expandFolderPath('Work/ClientA', {}, { mint: counterMint() });
    assert.strictEqual(result.chain.length, 2);

    const [work, clientA] = result.chain;
    assert.strictEqual(work.folder.name, 'Work');
    assert.strictEqual(work.folder.parentId, null);
    assert.strictEqual(work.mintNew, true);

    assert.strictEqual(clientA.folder.name, 'ClientA');
    assert.strictEqual(clientA.folder.parentId, work.folder.id);
    assert.strictEqual(clientA.mintNew, true);

    // The leaf is the deepest segment; the assignment/creation target.
    assert.strictEqual(result.leafFolderId, clientA.folder.id);

    // No segment name ever carries a literal '/'.
    for (const seg of result.chain) {
      assert.ok(!seg.folder.name.includes('/'), 'a segment name kept a literal slash');
    }
  });

  it('reuses an existing segment by (parentId, name) and mints only the missing tail', () => {
    const work: Folder = { id: 'W', name: 'Work', parentId: null, order: 0 };
    const existing = foldersByIdFrom([work]);

    const result = expandFolderPath('Work/ClientA', existing, { mint: counterMint() });
    assert.strictEqual(result.chain.length, 2);
    assert.strictEqual(result.chain[0].folder.id, 'W', 'did not reuse existing Work');
    assert.strictEqual(result.chain[0].mintNew, false);
    assert.strictEqual(result.chain[1].mintNew, true);
    assert.strictEqual(result.chain[1].folder.parentId, 'W');
  });

  it('is idempotent: expanding the same path twice mints nothing the second time', () => {
    const mint = counterMint();
    const first = expandFolderPath('Work/ClientA', {}, { mint });
    const after = foldersByIdFrom(first.chain.map((s) => s.folder));

    const second = expandFolderPath('Work/ClientA', after, { mint });
    assert.strictEqual(second.chain.every((s) => s.mintNew === false), true);
    assert.strictEqual(second.leafFolderId, first.leafFolderId);
  });

  it('reuses an earlier-in-this-call sibling for a repeated segment name', () => {
    // 'A/B' and a second top-level 'A' would both want a root 'A'; within one
    // expansion the working view grows so 'A/B/C' reuses the 'A' minted for 'A/B'.
    const result = expandFolderPath('A/B/C', {}, { mint: counterMint() });
    assert.strictEqual(result.chain.length, 3);
    assert.strictEqual(result.chain[0].folder.parentId, null);
    assert.strictEqual(result.chain[1].folder.parentId, result.chain[0].folder.id);
    assert.strictEqual(result.chain[2].folder.parentId, result.chain[1].folder.id);
  });

  it('distinguishes same-named folders under different parents', () => {
    // One shared minter across both expansions mirrors the global id factory, so
    // distinct folders genuinely get distinct ids.
    const mint = counterMint();
    const result = expandFolderPath('Work/Shared', {}, { mint });
    const after = foldersByIdFrom(result.chain.map((s) => s.folder));
    // A second 'Shared' under a different parent must NOT reuse the Work/Shared one.
    const second = expandFolderPath('Personal/Shared', after, { mint });
    const workShared = result.chain[1].folder.id;
    const personalShared = second.chain[1].folder.id;
    assert.notStrictEqual(workShared, personalShared);
    // And the two Shared folders hang under different parents.
    assert.notStrictEqual(
      result.chain[1].folder.parentId,
      second.chain[1].folder.parentId,
    );
  });

  it('returns an empty chain and null leaf for a slash-only or blank path', () => {
    assert.deepStrictEqual(expandFolderPath('/', {}), { chain: [], leafFolderId: null });
    assert.deepStrictEqual(expandFolderPath('   ', {}), { chain: [], leafFolderId: null });
  });

  it('roots the expansion under a supplied startParentId (clicked-parent id, not a name path)', () => {
    const work: Folder = { id: 'W', name: 'Work', parentId: null, order: 0 };
    const existing = foldersByIdFrom([work]);
    const result = expandFolderPath('ClientB', existing, {
      mint: counterMint(),
      startParentId: 'W',
    });
    // The new chain does NOT re-include the parent; only the new descendant.
    assert.strictEqual(result.chain.length, 1);
    assert.strictEqual(result.chain[0].folder.name, 'ClientB');
    assert.strictEqual(result.chain[0].folder.parentId, 'W', 'child hangs under the supplied parent id');
    assert.strictEqual(result.chain[0].mintNew, true);
    assert.strictEqual(result.leafFolderId, result.chain[0].folder.id);
  });

  it('attaches the new child to the EXACT clicked parent even when a same-named sibling exists', () => {
    // Two distinct root folders share the name 'Work' (the rename path permits a
    // sibling-name collision). A name-path round-trip would resolve 'Work' via
    // findChildByName to the FIRST match (w1) regardless of which the user clicked.
    // startParentId carries the authoritative clicked id, so the child lands under
    // w2, not w1.
    const w1: Folder = { id: 'w1', name: 'Work', parentId: null, order: 0 };
    const w2: Folder = { id: 'w2', name: 'Work', parentId: null, order: 1 };
    const existing = foldersByIdFrom([w1, w2]);
    const underW2 = expandFolderPath('Child', existing, {
      mint: counterMint(),
      startParentId: 'w2',
    });
    assert.strictEqual(underW2.chain.length, 1);
    assert.strictEqual(underW2.chain[0].folder.parentId, 'w2', 'child hung under the wrong same-named sibling');

    // And the first match (w1) is what a name-path round-trip WOULD have resolved,
    // proving the two parents are genuinely ambiguous by name.
    assert.strictEqual(findChildByName(existing, null, 'Work')?.id, 'w1');
  });

  it('reuses an existing child under the supplied startParentId rather than minting a duplicate', () => {
    const work: Folder = { id: 'W', name: 'Work', parentId: null, order: 0 };
    const client: Folder = { id: 'C', name: 'ClientA', parentId: 'W', order: 0 };
    const existing = foldersByIdFrom([work, client]);
    const result = expandFolderPath('ClientA/Q1', existing, {
      mint: counterMint(),
      startParentId: 'W',
    });
    assert.strictEqual(result.chain.length, 2);
    assert.strictEqual(result.chain[0].folder.id, 'C', 'reused the existing ClientA under W');
    assert.strictEqual(result.chain[0].mintNew, false);
    assert.strictEqual(result.chain[1].folder.name, 'Q1');
    assert.strictEqual(result.chain[1].folder.parentId, 'C');
    assert.strictEqual(result.chain[1].mintNew, true);
  });
});

describe('findChildByName', () => {
  it('matches on (parentId, name) and returns null otherwise', () => {
    const a: Folder = { id: 'a', name: 'X', parentId: null, order: 0 };
    const b: Folder = { id: 'b', name: 'X', parentId: 'a', order: 0 };
    const map = foldersByIdFrom([a, b]);
    assert.strictEqual(findChildByName(map, null, 'X')?.id, 'a');
    assert.strictEqual(findChildByName(map, 'a', 'X')?.id, 'b');
    assert.strictEqual(findChildByName(map, null, 'Y'), null);
  });
});

describe('assembleFolderTree (single-home invariant)', () => {
  const folders = foldersByIdFrom([
    { id: 'W', name: 'Work', parentId: null, order: 0 },
    { id: 'C', name: 'ClientA', parentId: 'W', order: 0 },
    { id: 'P', name: 'Personal', parentId: null, order: 1 },
  ]);

  it('places each chat under exactly one folder', () => {
    const tree = assembleFolderTree({
      folders,
      chatHomes: { c1: 'W', c2: 'C', c3: 'P', c4: null },
    });

    // Collect every (chatId, owningFolderId) occurrence across the whole tree.
    const occurrences = new Map<string, string[]>();
    const visit = (nodeId: string, chatIds: string[]) => {
      for (const chatId of chatIds) {
        const list = occurrences.get(chatId) ?? [];
        list.push(nodeId);
        occurrences.set(chatId, list);
      }
    };
    const walk = (nodes: typeof tree.roots) => {
      for (const node of nodes) {
        visit(node.id, node.chatIds);
        walk(node.childFolders);
      }
    };
    walk(tree.roots);
    visit(tree.unfiled.id, tree.unfiled.chatIds);

    // SINGLE HOME: every chat appears under exactly one node.
    for (const [chatId, homes] of occurrences) {
      assert.strictEqual(homes.length, 1, `${chatId} appeared under ${homes.length} folders`);
    }
    assert.deepStrictEqual(occurrences.get('c1'), ['W']);
    assert.deepStrictEqual(occurrences.get('c2'), ['C']);
    assert.deepStrictEqual(occurrences.get('c3'), ['P']);
    assert.deepStrictEqual(occurrences.get('c4'), [UNFILED_FOLDER_ID]);
  });

  it('routes a chat with a null/absent home to the Unfiled bucket', () => {
    const tree = assembleFolderTree({
      folders,
      chatHomes: { c1: null, c2: undefined },
    });
    assert.deepStrictEqual(new Set(tree.unfiled.chatIds), new Set(['c1', 'c2']));
  });

  it('routes a chat with a dangling (deleted) home folder to Unfiled, not lost', () => {
    const tree = assembleFolderTree({
      folders,
      chatHomes: { c1: 'GONE' },
    });
    assert.deepStrictEqual(tree.unfiled.chatIds, ['c1']);
    // And it is NOT placed under any real folder.
    const placedUnderReal = tree.roots.some((r) => r.chatIds.includes('c1'));
    assert.strictEqual(placedUnderReal, false);
  });

  it('nests child folders under their parent and keeps Unfiled last among roots conceptually', () => {
    const tree = assembleFolderTree({ folders, chatHomes: {} });
    const rootIds = tree.roots.map((r) => r.id);
    assert.deepStrictEqual(rootIds, ['W', 'P']);
    const work = tree.roots.find((r) => r.id === 'W');
    assert.deepStrictEqual(work?.childFolders.map((c) => c.id), ['C']);
    assert.strictEqual(tree.unfiled.synthetic, true);
    assert.strictEqual(tree.unfiled.id, UNFILED_FOLDER_ID);
  });

  it('treats a folder with a dangling parentId as a root rather than dropping it', () => {
    const orphanParent = foldersByIdFrom([
      { id: 'X', name: 'Orphan', parentId: 'MISSING', order: 0 },
    ]);
    const tree = assembleFolderTree({ folders: orphanParent, chatHomes: {} });
    assert.deepStrictEqual(tree.roots.map((r) => r.id), ['X']);
  });
});

describe('composite-id grammar', () => {
  it('builds and round-trips a chat member id splitting on the first #', () => {
    const id = chatNodeId('folder-1', 'session-uuid-2');
    assert.strictEqual(id, 'folder-1#session-uuid-2');
    assert.deepStrictEqual(parseChatNodeId(id), {
      folderId: 'folder-1',
      chatId: 'session-uuid-2',
    });
  });

  it('round-trips the Unfiled bucket composite id', () => {
    const id = chatNodeId(UNFILED_FOLDER_ID, 'sess');
    assert.deepStrictEqual(parseChatNodeId(id), {
      folderId: UNFILED_FOLDER_ID,
      chatId: 'sess',
    });
    assert.strictEqual(isUnfiledId(UNFILED_FOLDER_ID), true);
    assert.strictEqual(isUnfiledId('folder-1'), false);
  });

  it('returns null for a value that is not a chat member id', () => {
    assert.strictEqual(parseChatNodeId('no-separator'), null);
    assert.strictEqual(parseChatNodeId('#leading'), null);
    assert.strictEqual(parseChatNodeId('trailing#'), null);
  });
});

describe('buildChatHomeIndex + resolveChatHomeFolderId (the pure getParent rule)', () => {
  const folders = foldersByIdFrom([
    { id: 'W', name: 'Work', parentId: null, order: 0 },
    { id: 'C', name: 'ClientA', parentId: 'W', order: 0 },
    { id: 'P', name: 'Personal', parentId: null, order: 1 },
  ]);

  it('maps each chat to its ONE owning folder id, and unfiled chats to the Unfiled sentinel', () => {
    const tree = assembleFolderTree({
      folders,
      chatHomes: { c1: 'W', c2: 'C', c3: 'P', c4: null, c5: 'GONE' },
    });
    const index = buildChatHomeIndex(tree);

    // getParent for each chat resolves exactly one owning folder.
    assert.strictEqual(index.get('c1'), 'W');
    assert.strictEqual(index.get('c2'), 'C', 'a chat homed in a nested folder resolves to that child');
    assert.strictEqual(index.get('c3'), 'P');
    // A null home and a dangling home both route to Unfiled (the single home).
    assert.strictEqual(index.get('c4'), UNFILED_FOLDER_ID);
    assert.strictEqual(index.get('c5'), UNFILED_FOLDER_ID, 'dangling home falls into Unfiled');

    // Exactly one entry per placed chat (single-home invariant at the index level).
    assert.strictEqual(index.size, 5);
  });

  it('resolveChatHomeFolderId returns the indexed owner, else the hint, else the Unfiled sentinel', () => {
    const tree = assembleFolderTree({ folders, chatHomes: { c1: 'C' } });
    const index = buildChatHomeIndex(tree);
    // Known chat: the indexed owner wins over any hint.
    assert.strictEqual(resolveChatHomeFolderId(index, 'c1', 'IGNORED'), 'C');
    // Unknown chat with a hint (the member node's own folderId): the hint is used.
    assert.strictEqual(resolveChatHomeFolderId(index, 'cX', 'W'), 'W');
    // Unknown chat with no hint: defaults to the Unfiled sentinel so reveal still
    // resolves a parent rather than orphaning.
    assert.strictEqual(resolveChatHomeFolderId(index, 'cX'), UNFILED_FOLDER_ID);
  });
});

describe('node-object memoization reuse predicates', () => {
  it('reuses a folder item only when the cached name still matches', () => {
    assert.strictEqual(canReuseFolderItem('Work', 'Work'), true);
    assert.strictEqual(canReuseFolderItem('Work', 'Renamed'), false, 'a rename must rebuild');
    assert.strictEqual(canReuseFolderItem(undefined, 'Work'), false, 'no cached object => rebuild');
  });

  it('reuses a chat member item only when both title and timestamp still match', () => {
    const cached = { title: 'A chat', timestamp: 100 };
    assert.strictEqual(canReuseChatMemberItem(cached, { title: 'A chat', timestamp: 100 }), true);
    assert.strictEqual(
      canReuseChatMemberItem(cached, { title: 'Retitled', timestamp: 100 }),
      false,
      'a title change must rebuild',
    );
    assert.strictEqual(
      canReuseChatMemberItem(cached, { title: 'A chat', timestamp: 200 }),
      false,
      'a timestamp change must rebuild',
    );
    assert.strictEqual(
      canReuseChatMemberItem(undefined, { title: 'A chat', timestamp: 100 }),
      false,
      'no cached object => rebuild',
    );
  });
});

describe('descendantFolderIds (delete cascade)', () => {
  const folders = foldersByIdFrom([
    { id: 'W', name: 'Work', parentId: null, order: 0 },
    { id: 'C', name: 'ClientA', parentId: 'W', order: 0 },
    { id: 'G', name: 'Grandchild', parentId: 'C', order: 0 },
    { id: 'P', name: 'Personal', parentId: null, order: 1 },
  ]);

  it('collects a folder and all transitive descendants', () => {
    assert.deepStrictEqual(new Set(descendantFolderIds(folders, 'W')), new Set(['W', 'C', 'G']));
    assert.deepStrictEqual(descendantFolderIds(folders, 'P'), ['P']);
    assert.deepStrictEqual(descendantFolderIds(folders, 'G'), ['G']);
  });

  it('is bounded against a cyclic parent chain (corrupt store)', () => {
    const cyclic = foldersByIdFrom([
      { id: 'A', name: 'A', parentId: 'B', order: 0 },
      { id: 'B', name: 'B', parentId: 'A', order: 0 },
    ]);
    const result = descendantFolderIds(cyclic, 'A');
    assert.deepStrictEqual(new Set(result), new Set(['A', 'B']));
  });
});
