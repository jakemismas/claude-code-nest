import * as assert from 'assert';
import * as vscode from 'vscode';

import {
  NestDragAndDropController,
  FOLDERS_RESERVED_MIME,
  TAGS_RESERVED_MIME,
} from '../../dnd/dndController';
import { NEST_CHAT_MIME, DropTargetView } from '../../dnd/dropReducer';
import { clearDrag } from '../../dnd/dragContext';
import {
  MetadataStore,
  SyncMemento,
} from '../../store/metadataStore';
import {
  FoldersProvider,
  FolderItem,
  ChatMemberItem,
  LinkedChildItem,
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

// Extension Development Host test of drag-and-drop: controllers register, their MIME types match package.json,
// and a real cross-tree drag lands its store mutation. It never runs headless because it needs:
//   1. A real DataTransfer round-trip. On a cross-tree drop the host does not deliver the source controller's
//      item to the peer, so the payload rides the in-process dragContext stash. The test hands the peer a
//      transfer with only an opaque reserved-MIME handle, so the drop fails unless it comes from the stash.
//   2. Real TreeItem prototypes for the node-dispatch helpers (chatIdsFromSource, resolveTarget).
//   3. The reserved-MIME literals equal the value VSCode derives from a view id (application/vnd.code.tree.<id>),
//      checked against the frozen DropTargetView literals in dropReducer.ts. The native Folders and Tags trees
//      are no longer contributed, but the controller and its MIMEs remain.

// Minimal in-memory SyncMemento, kept local because this suite runs in a different mocha process than the unit suite.
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

// Derives the reserved MIME VSCode computes from a view id: application/vnd.code.tree.<viewidlowercase>.
function reservedMimeForViewId(viewId: string): string {
  return 'application/vnd.code.tree.' + viewId.toLowerCase();
}

// Frozen drop-target view ids the native controller uses. They are no longer contributed in package.json but
// remain the DropTargetView contract; the annotation fails the build if that union changes.
const FROZEN_TARGET_VIEWS: { folders: DropTargetView; tags: DropTargetView } = {
  folders: 'claudeNest.folders',
  tags: 'claudeNest.tags',
};

const PROJECT_KEY = 'integration-test-project';

function chatRecord(sessionId: string): ChatRecord {
  return {
    sessionId,
    title: 'Chat ' + sessionId,
    timestamp: 1_700_000_000_000,
    filePath: '/tmp/' + sessionId + '.jsonl',
    prNumber: null,
    prUrl: null,
    prRepository: null,
    gitBranch: null,
    leadingMessageUuids: [],
    messageCount: 0,
    firstMessageText: null,
    firstMessageRole: null,
    lastMessageText: null,
    lastMessageRole: null,
    tokenTotals: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    filesTouched: [],
    models: [],
  };
}

// Builds a store and both controllers as extension.ts wires them; providers exist only as refresh targets.
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

describe('drag-and-drop controller registration and MIME contract (electron host)', () => {
  it('both controllers expose a valid TreeDragAndDropController shape (native trees retired)', () => {
    // The native trees are no longer contributed, so the controllers are not attached via createTreeView
    // (it would throw on uncontributed ids); assert the host accepts their shape instead.
    const { foldersDnd, tagsDnd } = buildHarness();
    for (const ctrl of [foldersDnd, tagsDnd]) {
      assert.ok(Array.isArray(ctrl.dragMimeTypes), 'dragMimeTypes is an array');
      assert.ok(Array.isArray(ctrl.dropMimeTypes), 'dropMimeTypes is an array');
      assert.strictEqual(typeof ctrl.handleDrag, 'function', 'handleDrag is callable');
      assert.strictEqual(typeof ctrl.handleDrop, 'function', 'handleDrop is callable');
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
    // Compared as sets: the contract is membership, not order.
    assert.deepStrictEqual(new Set(foldersDnd.dropMimeTypes), new Set(expected));
    assert.deepStrictEqual(new Set(tagsDnd.dropMimeTypes), new Set(expected));
    // Both peer MIMEs must be droppable on each view, or a cross-view drag never offers the peer tree.
    for (const ctrl of [foldersDnd, tagsDnd]) {
      assert.ok(ctrl.dropMimeTypes.includes(FOLDERS_RESERVED_MIME));
      assert.ok(ctrl.dropMimeTypes.includes(TAGS_RESERVED_MIME));
      assert.ok(ctrl.dropMimeTypes.includes(NEST_CHAT_MIME));
    }
  });

  it('the reserved-MIME literals equal application/vnd.code.tree.<viewidlowercase> derived from the frozen DropTargetView ids', () => {
    const ids = FROZEN_TARGET_VIEWS;
    assert.strictEqual(FOLDERS_RESERVED_MIME, reservedMimeForViewId(ids.folders));
    assert.strictEqual(TAGS_RESERVED_MIME, reservedMimeForViewId(ids.tags));
    const { foldersDnd, tagsDnd } = buildHarness();
    assert.ok(foldersDnd.dragMimeTypes.includes(reservedMimeForViewId(ids.folders)));
    assert.ok(tagsDnd.dragMimeTypes.includes(reservedMimeForViewId(ids.tags)));
  });
});

describe('cross-tree drag carrier (electron host, real DataTransfer)', () => {
  // Models the real cross-tree drop: the host does not hand the source controller's DataTransferItem to the peer,
  // so the transfer carries only an opaque reserved-MIME value that parseChatIds rejects. The chat ids must
  // come from the dragContext stash, or the drop is a no-op and the assertion fails.
  function crossTreeTransfer(sourceReservedMime: string): vscode.DataTransfer {
    const out = new vscode.DataTransfer();
    // An opaque host handle, not our chat-id JSON: parseChatIds returns [], so trusting it would silently no-op.
    out.set(
      sourceReservedMime,
      new vscode.DataTransferItem({ itemHandles: ['0'], hostInternal: true }),
    );
    return out;
  }

  it('a Folders chat dragged onto a Tags tag adds the tag without losing its folder home', async () => {
    const { store, foldersDnd, tagsDnd } = buildHarness();
    store.setChatFolder(PROJECT_KEY, 'c1', 'f1');
    await store.flush();

    // A real ChatMemberItem exercises the instanceof dispatch; the drag stashes the chat ids.
    const dragged = new ChatMemberItem('f1', chatRecord('c1'));
    const dragTransfer = new vscode.DataTransfer();
    foldersDnd.handleDrag([dragged], dragTransfer);

    // The peer controller gets no usable payload, so the ids must ride the stash.
    const dropTransfer = crossTreeTransfer(FOLDERS_RESERVED_MIME);
    const target = new TagItem('t1', 'Tag One', false);
    await tagsDnd.handleDrop(target, dropTransfer);
    await store.flush();

    const meta = store.getProjectMeta(PROJECT_KEY);
    assert.deepStrictEqual(meta.chats['c1'].tags, ['t1'], 'tag t1 added');
    assert.strictEqual(meta.chats['c1'].folderId, 'f1', 'folder home preserved');
  });

  it('a Tags occurrence dragged onto a folder moves its single home without losing its tags', async () => {
    const { store, foldersDnd, tagsDnd } = buildHarness();
    store.addChatTag(PROJECT_KEY, 'c2', 't1');
    await store.flush();

    const occurrence = makeOccurrence('t1', 'c2');
    const dragged = new ChatOccurrenceItem(occurrence, chatRecord('c2'));
    const dragTransfer = new vscode.DataTransfer();
    tagsDnd.handleDrag([dragged], dragTransfer);

    const dropTransfer = crossTreeTransfer(TAGS_RESERVED_MIME);
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

    // Within one tree the host keeps the full DataTransfer, so the payload wins; pass the drag transfer through.
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

  it('a foreign drag source is a no-op (no recognized MIME, no stash)', async () => {
    const { store, tagsDnd } = buildHarness();
    store.addChatTag(PROJECT_KEY, 'c4', 't1');
    await store.flush();

    // No drag ran for this case; consume any stash left by a prior test.
    clearDrag();

    // Only a foreign tree's MIME and no stash: the controller must not mutate.
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

  it('dropping a chat onto a linked-child row files it alongside (never silently unfiles)', async () => {
    // A drop on a linked-child row must resolve to the child chat's home folder, not undefined (which would unfile).
    // The Folders controller gets a resolveChatHome that reports f3.
    const store = new MetadataStore(new MemMemento(), {
      deviceId: 'integration-device',
      debounceMs: 0,
    });
    const foldersProvider = new FoldersProvider(undefined, store);
    const foldersDnd = new NestDragAndDropController<FolderTreeNode>(
      {
        store,
        getProjectKey: () => PROJECT_KEY,
        provider: { refresh: () => foldersProvider.refresh() },
        resolveChatHome: (chatId: string) => (chatId === 'childChat' ? 'f3' : undefined),
      },
      'claudeNest.folders',
      FOLDERS_RESERVED_MIME,
    );
    store.setChatFolder(PROJECT_KEY, 'c5', 'f1');
    await store.flush();

    const dragged = new ChatMemberItem('f1', chatRecord('c5'));
    const dragTransfer = new vscode.DataTransfer();
    foldersDnd.handleDrag([dragged], dragTransfer);

    const child = {
      chatId: 'childChat',
      parentChatId: 'parentChat',
      id: 'parentChat>link>childChat',
      depth: 1,
      broken: false,
    };
    const target = new LinkedChildItem(child, chatRecord('childChat'), false);
    await foldersDnd.handleDrop(target, dragTransfer);
    await store.flush();

    const meta = store.getProjectMeta(PROJECT_KEY);
    assert.strictEqual(
      meta.chats['c5'].folderId,
      'f3',
      'dropped chat filed alongside the linked child (home f3), NOT unfiled',
    );
  });
});
