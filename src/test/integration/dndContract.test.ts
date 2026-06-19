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

// The DEFERRED electron-host integration test PLAN.md Slice 4 calls for: "one
// electron test asserting controllers register and MIME types match
// package.json", expanded per TESTING.md to also drive a real cross-tree drag and
// assert the store mutation lands. It runs ONLY in the Extension Development Host
// (out/test/integration via runTest.js), never in the headless `npm test` gate,
// because the things it verifies CANNOT be reached headless:
//   1. A real vscode.DataTransfer / DataTransferItem round-trip (the host's own
//      types, not a fake). On a CROSS-tree drop the host does NOT deliver the
//      source controller's custom DataTransferItem to the peer controller (it
//      re-applies the source handleDrag items only when source view === dest
//      view), so the cross-view payload rides the in-process dragContext stash,
//      not the DataTransfer. This test reproduces the cross-tree drop by handing
//      the peer controller a transfer that carries NONE of our payload values
//      (only a host-style opaque reserved-MIME handle), so the drop MUST come from
//      the stash or it fails - the previous version copied the source's own
//      overwritten value into the drop transfer and so could never catch a real
//      cross-controller delivery failure.
//   2. The controller's node-dispatch helpers (chatIdsFromSource, resolveTarget)
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
    prNumber: null,
    prUrl: null,
    prRepository: null,
    gitBranch: null,
    leadingMessageUuids: [],
    messageCount: 0,
    lastMessageText: null,
    lastMessageRole: null,
    tokenTotals: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    filesTouched: [],
    models: [],
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
  // Reproduce the host's REAL cross-tree drop. VSCode 1.66 does NOT hand the source
  // controller's custom DataTransferItem to the PEER controller's handleDrop: it
  // re-applies the source handleDrag items only when the source and destination
  // views match. On a cross-tree drop the peer controller's transfer carries none
  // of OUR payload values - at most the host's own internal opaque reserved-MIME
  // handle. We model that worst case here: the drop transfer carries the source
  // reserved MIME set to a host-style opaque value that parseChatIds REJECTS (it is
  // not our JSON id array), so the chat ids MUST come from the in-process
  // dragContext stash that handleDrag set, or the drop is a no-op and the assertion
  // fails. This is the carrier behavior the headless tests cannot exercise (they
  // never build a real DataTransfer nor cross controllers), and it is what the
  // previous copy-the-source-value version could not catch.
  function crossTreeTransfer(sourceReservedMime: string): vscode.DataTransfer {
    const out = new vscode.DataTransfer();
    // A host-internal opaque handle, NOT our chat-id JSON. parseChatIds returns []
    // for it, so any code path that trusted this value cross-tree would silently
    // no-op - which is exactly the failure mode the stash carrier fixes.
    out.set(
      sourceReservedMime,
      new vscode.DataTransferItem({ itemHandles: ['0'], hostInternal: true }),
    );
    return out;
  }

  it('a Folders chat dragged onto a Tags tag adds the tag without losing its folder home', async () => {
    const { store, foldersDnd, tagsDnd } = buildHarness();
    // Seed: chat c1 homed in folder f1; tag t1 exists.
    store.setChatFolder(PROJECT_KEY, 'c1', 'f1');
    await store.flush();

    // The dragged node is a real Folders-view ChatMemberItem (instanceof
    // vscode.TreeItem), exercising chatIdsFromSource's instanceof dispatch. The
    // drag stashes the chat ids in dragContext (the cross-view carrier).
    const dragged = new ChatMemberItem('f1', chatRecord('c1'));
    const dragTransfer = new vscode.DataTransfer();
    foldersDnd.handleDrag([dragged], dragTransfer);

    // The host hands the peer (Tags) controller a transfer with NO usable payload
    // value: the cross-view chat ids must ride the stash, not this transfer.
    const dropTransfer = crossTreeTransfer(FOLDERS_RESERVED_MIME);
    // The drop target is a real TagItem t1 (instanceof dispatch in resolveTarget).
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

    // The dragged node is a real Tags-view ChatOccurrenceItem; the drag stashes c2.
    const occurrence = makeOccurrence('t1', 'c2');
    const dragged = new ChatOccurrenceItem(occurrence, chatRecord('c2'));
    const dragTransfer = new vscode.DataTransfer();
    tagsDnd.handleDrag([dragged], dragTransfer);

    // Cross-tree: the Folders controller gets no usable payload value; the chat id
    // rides the stash.
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

    // A within-view drop in the SAME tree: the host preserves the full
    // DataTransfer, so the shared chat MIME is present. Pass the drag transfer
    // straight through (no stripping); the DataTransfer payload wins here.
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

    // No handleDrag ran for this drop, so there is no Nest stash; consume any
    // leftover stash from a prior test so this case is genuinely stash-free.
    clearDrag();

    // A DataTransfer carrying only a foreign tree's MIME: the controller finds no
    // recognized payload and no stash, and must not mutate.
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
    // Regression for the LinkedChildItem drop-target unfile bug: a drop on a
    // linked-child row must resolve to the child chat's home folder, not undefined
    // (which the reducer would map to unfile). The Folders controller is given a
    // resolveChatHome that reports the linked child's home folder f3.
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
    // Seed: dragged chat c5 currently homed in f1.
    store.setChatFolder(PROJECT_KEY, 'c5', 'f1');
    await store.flush();

    const dragged = new ChatMemberItem('f1', chatRecord('c5'));
    const dragTransfer = new vscode.DataTransfer();
    foldersDnd.handleDrag([dragged], dragTransfer);

    // The drop target is a real LinkedChildItem whose underlying chat is childChat.
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
