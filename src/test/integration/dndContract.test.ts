import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

import {
  NestDragAndDropController,
  FOLDERS_RESERVED_MIME,
  TAGS_RESERVED_MIME,
} from '../../dnd/dndController';
import { NEST_CHAT_MIME } from '../../dnd/dropReducer';
import {
  MetadataStore,
  SyncMemento,
} from '../../store/metadataStore';
import {
  FoldersProvider,
  FolderItem,
  ChatMemberItem,
  FolderTreeNode,
} from '../../views/foldersProvider';
import {
  TagsProvider,
  TagItem,
  ChatOccurrenceItem,
  TagTreeNode,
} from '../../views/tagsProvider';
import { makeOccurrence } from '../../model/occurrence';
import { ChatRecord } from '../../model/types';

// The DEFERRED electron-host integration test PLAN.md Slice 4 calls for: "one
// electron test asserting controllers register and MIME types match
// package.json", expanded per TESTING.md to also drive a real cross-tree drag and
// assert the store mutation lands. It runs ONLY in the Extension Development Host
// (out/test/integration via runTest.js), never in the headless `npm test` gate,
// because the things it verifies CANNOT be reached headless:
//   1. A real vscode.DataTransfer / DataTransferItem round-trip (the host's own
//      types, not a fake), including the cross-tree carrier behavior where the
//      host strips the shared custom chat MIME and leaves only the source tree's
//      reserved MIME between two trees of the same extension.
//   2. The controller's node-dispatch helpers (chatIdsFromSource, targetIdFor)
//      using `instanceof vscode.TreeItem` subclasses (FolderItem, ChatMemberItem,
//      TagItem, ChatOccurrenceItem), which only have real prototypes in the host.
//   3. The reserved-MIME literals equaling the value VSCode auto-derives from the
//      contributed view ids in package.json (application/vnd.code.tree.<id>),
//      cross-checked against the manifest the host actually loads.
//
// The headless dropReducer / dropPayload unit tests cover the pure interpretation
// and tolerant payload parsing; this test covers the host seam they cannot.

// A minimal in-memory SyncMemento for the store, mirroring the unit suite's
// fakeMemento but kept local so this spec is self-contained (it runs in a
// different mocha process than the unit suite). setKeysForSync is a no-op here;
// the sync-registration behavior is unit-tested elsewhere. This is test-only and
// exempt from the read-only chokepoint (src/test/** override in .eslintrc).
class MemMemento implements SyncMemento {
  private readonly map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }
  keys(): readonly string[] {
    return Array.from(this.map.keys());
  }
  setKeysForSync(_keys: readonly string[]): void {
    // no-op for the contract test
  }
}

// Derive the reserved MIME VSCode computes from a contributed view id, per its
// documented rule: application/vnd.code.tree.<viewidlowercase>. Asserting the
// code's literals equal THIS (computed from the manifest the host loaded) is the
// package.json<->reserved-MIME contract the finding flagged as unverified.
function reservedMimeForViewId(viewId: string): string {
  return 'application/vnd.code.tree.' + viewId.toLowerCase();
}

function readContributedViewIds(): { folders: string; tags: string } {
  // Read the SAME package.json the host loaded as the Extension Manifest. The repo
  // root is three levels up from out/test/integration.
  const manifestPath = path.resolve(__dirname, '../../../package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    contributes: { views: { claudeNest: { id: string }[] } };
  };
  const views = manifest.contributes.views.claudeNest;
  const folders = views.find((v) => v.id === 'claudeNest.folders');
  const tags = views.find((v) => v.id === 'claudeNest.tags');
  assert.ok(folders, 'package.json must contribute the claudeNest.folders view');
  assert.ok(tags, 'package.json must contribute the claudeNest.tags view');
  return { folders: folders.id, tags: tags.id };
}

const PROJECT_KEY = 'integration-test-project';

function chatRecord(sessionId: string): ChatRecord {
  return {
    sessionId,
    title: 'Chat ' + sessionId,
    timestamp: 1_700_000_000_000,
    filePath: '/tmp/' + sessionId + '.jsonl',
  };
}

// Build a fresh store plus both controllers wired exactly as extension.ts wires
// them: each controller declares its own reserved MIME and a fixed project-key
// resolver. The providers are constructed only so a refresh has a target; the
// drop logic reads the store directly.
function buildHarness() {
  const store = new MetadataStore(new MemMemento(), {
    deviceId: 'integration-device',
    debounceMs: 0,
  });
  const foldersProvider = new FoldersProvider(undefined, store);
  const tagsProvider = new TagsProvider(undefined, store);

  const foldersDnd = new NestDragAndDropController<FolderTreeNode>(
    {
      store,
      getProjectKey: () => PROJECT_KEY,
      provider: { refresh: () => foldersProvider.refresh() },
    },
    'claudeNest.folders',
    FOLDERS_RESERVED_MIME,
  );
  const tagsDnd = new NestDragAndDropController<TagTreeNode>(
    {
      store,
      getProjectKey: () => PROJECT_KEY,
      provider: { refresh: () => tagsProvider.refresh() },
    },
    'claudeNest.tags',
    TAGS_RESERVED_MIME,
  );

  return { store, foldersDnd, tagsDnd };
}

describe('Slice 4 drag-and-drop controller registration and MIME contract (electron host)', () => {
  it('both views register a real TreeDragAndDropController', () => {
    const { foldersDnd, tagsDnd } = buildHarness();
    // The createTreeView option accepts a TreeDragAndDropController; constructing a
    // real tree view with each controller proves the host accepts the shape (and
    // disposes cleanly). This is the "controllers register" assertion.
    const foldersProvider = new FoldersProvider(undefined, buildHarness().store);
    const tagsProvider = new TagsProvider(undefined, buildHarness().store);
    const foldersView = vscode.window.createTreeView('claudeNest.folders', {
      treeDataProvider: foldersProvider,
      dragAndDropController: foldersDnd,
      canSelectMany: true,
    });
    const tagsView = vscode.window.createTreeView('claudeNest.tags', {
      treeDataProvider: tagsProvider,
      dragAndDropController: tagsDnd,
      canSelectMany: true,
    });
    try {
      assert.ok(foldersView, 'Folders tree view created with a DnD controller');
      assert.ok(tagsView, 'Tags tree view created with a DnD controller');
    } finally {
      foldersView.dispose();
      tagsView.dispose();
    }
  });

  it('each controller drags its OWN reserved MIME plus the shared chat MIME', () => {
    const { foldersDnd, tagsDnd } = buildHarness();
    assert.deepStrictEqual(foldersDnd.dragMimeTypes, [
      FOLDERS_RESERVED_MIME,
      NEST_CHAT_MIME,
    ]);
    assert.deepStrictEqual(tagsDnd.dragMimeTypes, [TAGS_RESERVED_MIME, NEST_CHAT_MIME]);
  });

  it('each controller drops BOTH reserved MIMEs plus the shared chat MIME (peer tree is a drop target)', () => {
    const { foldersDnd, tagsDnd } = buildHarness();
    const expected = [NEST_CHAT_MIME, FOLDERS_RESERVED_MIME, TAGS_RESERVED_MIME];
    // Sets, because the cross-view contract is about MEMBERSHIP (the peer reserved
    // MIME must be present), not order.
    assert.deepStrictEqual(new Set(foldersDnd.dropMimeTypes), new Set(expected));
    assert.deepStrictEqual(new Set(tagsDnd.dropMimeTypes), new Set(expected));
    // Both peer MIMEs must be droppable on each view, or a cross-view drag is never
    // offered the peer tree as a target.
    for (const ctrl of [foldersDnd, tagsDnd]) {
      assert.ok(ctrl.dropMimeTypes.includes(FOLDERS_RESERVED_MIME));
      assert.ok(ctrl.dropMimeTypes.includes(TAGS_RESERVED_MIME));
      assert.ok(ctrl.dropMimeTypes.includes(NEST_CHAT_MIME));
    }
  });

  it('the reserved-MIME literals equal application/vnd.code.tree.<viewidlowercase> derived from package.json', () => {
    const ids = readContributedViewIds();
    assert.strictEqual(FOLDERS_RESERVED_MIME, reservedMimeForViewId(ids.folders));
    assert.strictEqual(TAGS_RESERVED_MIME, reservedMimeForViewId(ids.tags));
    // And the controllers actually carry those literals.
    const { foldersDnd, tagsDnd } = buildHarness();
    assert.ok(foldersDnd.dragMimeTypes.includes(reservedMimeForViewId(ids.folders)));
    assert.ok(tagsDnd.dragMimeTypes.includes(reservedMimeForViewId(ids.tags)));
  });
});

describe('Slice 4 cross-tree drag carrier (electron host, real DataTransfer)', () => {
  // Simulate the host's cross-tree drop: VSCode 1.66 preserves a custom MIME set
  // in handleDrag into handleDrop ONLY for a drop in the SAME tree. On a cross-tree
  // drop the host STRIPS the shared chat MIME and carries ONLY the source tree's
  // reserved MIME between two trees of the same extension. We reproduce that by
  // copying only the source reserved MIME item from the drag DataTransfer into a
  // fresh drop DataTransfer, which is exactly what the host delivers to the peer
  // controller's handleDrop. This is the one carrier behavior the headless
  // dropPayload/dropReducer tests cannot exercise (they never build a real
  // DataTransfer nor cross trees).
  function crossTreeTransfer(
    drag: vscode.DataTransfer,
    sourceReservedMime: string,
  ): vscode.DataTransfer {
    const out = new vscode.DataTransfer();
    const item = drag.get(sourceReservedMime);
    assert.ok(
      item,
      'handleDrag must have set the source reserved MIME (the cross-tree carrier)',
    );
    out.set(sourceReservedMime, item);
    return out;
  }

  it('a Folders chat dragged onto a Tags tag adds the tag without losing its folder home', async () => {
    const { store, foldersDnd, tagsDnd } = buildHarness();
    // Seed: chat c1 homed in folder f1; tag t1 exists.
    store.setChatFolder(PROJECT_KEY, 'c1', 'f1');
    await store.flush();

    // The dragged node is a real Folders-view ChatMemberItem (instanceof
    // vscode.TreeItem), exercising chatIdsFromSource's instanceof dispatch.
    const dragged = new ChatMemberItem('f1', chatRecord('c1'));
    const dragTransfer = new vscode.DataTransfer();
    foldersDnd.handleDrag([dragged], dragTransfer);

    // The host hands the peer (Tags) controller only the source reserved MIME.
    const dropTransfer = crossTreeTransfer(dragTransfer, FOLDERS_RESERVED_MIME);
    // The drop target is a real TagItem t1 (instanceof dispatch in targetIdFor).
    const target = new TagItem('t1', 'Tag One', false);
    await tagsDnd.handleDrop(target, dropTransfer);
    await store.flush();

    const meta = store.getProjectMeta(PROJECT_KEY);
    assert.deepStrictEqual(meta.chats['c1'].tags, ['t1'], 'tag t1 added');
    assert.strictEqual(meta.chats['c1'].folderId, 'f1', 'folder home preserved');
  });

  it('a Tags occurrence dragged onto a folder moves its single home without losing its tags', async () => {
    const { store, foldersDnd, tagsDnd } = buildHarness();
    // Seed: chat c2 tagged t1, currently unfiled.
    store.addChatTag(PROJECT_KEY, 'c2', 't1');
    await store.flush();

    // The dragged node is a real Tags-view ChatOccurrenceItem.
    const occurrence = makeOccurrence('t1', 'c2');
    const dragged = new ChatOccurrenceItem(occurrence, chatRecord('c2'));
    const dragTransfer = new vscode.DataTransfer();
    tagsDnd.handleDrag([dragged], dragTransfer);

    // Cross-tree: only the Tags reserved MIME survives to the Folders controller.
    const dropTransfer = crossTreeTransfer(dragTransfer, TAGS_RESERVED_MIME);
    const target = new FolderItem('f2', null, 'Folder Two', false);
    await foldersDnd.handleDrop(target, dropTransfer);
    await store.flush();

    const meta = store.getProjectMeta(PROJECT_KEY);
    assert.strictEqual(meta.chats['c2'].folderId, 'f2', 'home moved to f2');
    assert.deepStrictEqual(meta.chats['c2'].tags, ['t1'], 'tags preserved');
  });

  it('a within-view drop recovers the shared chat MIME (host preserves the custom item)', async () => {
    const { store, tagsDnd } = buildHarness();
    store.addChatTag(PROJECT_KEY, 'c3', 't1');
    await store.flush();

    // A within-view drop in the SAME tree: the host preserves the full
    // DataTransfer, so the shared chat MIME is present. Pass the drag transfer
    // straight through (no stripping).
    const occurrence = makeOccurrence('t1', 'c3');
    const dragged = new ChatOccurrenceItem(occurrence, chatRecord('c3'));
    const transfer = new vscode.DataTransfer();
    tagsDnd.handleDrag([dragged], transfer);

    const target = new TagItem('t2', 'Tag Two', false);
    await tagsDnd.handleDrop(target, transfer);
    await store.flush();

    const meta = store.getProjectMeta(PROJECT_KEY);
    assert.deepStrictEqual(meta.chats['c3'].tags.sort(), ['t1', 't2']);
  });

  it('a foreign drag source is a no-op (no recognized MIME)', async () => {
    const { store, tagsDnd } = buildHarness();
    store.addChatTag(PROJECT_KEY, 'c4', 't1');
    await store.flush();

    // A DataTransfer carrying only a foreign tree's MIME: the controller finds no
    // recognized payload and must not mutate.
    const transfer = new vscode.DataTransfer();
    transfer.set(
      'application/vnd.code.tree.someotherextension',
      new vscode.DataTransferItem('["c4"]'),
    );
    const target = new TagItem('t2', 'Tag Two', false);
    await tagsDnd.handleDrop(target, transfer);
    await store.flush();

    const meta = store.getProjectMeta(PROJECT_KEY);
    assert.deepStrictEqual(meta.chats['c4'].tags, ['t1'], 'no foreign-source mutation');
  });
});
