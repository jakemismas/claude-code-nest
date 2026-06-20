import * as assert from 'assert';
import { FakeMemento } from './fakeMemento';
import { MetadataStore } from '../../store/metadataStore';
import {
  WebviewDropMessage,
  dropInputFromMessage,
  handleWebviewDrop,
} from '../../dnd/webviewDropAdapter';
import { NEST_CHAT_MIME } from '../../dnd/dropReducer';
import { UNFILED_FOLDER_ID } from '../../model/folderTree';
import { UNTAGGED_TAG_ID } from '../../model/untagged';

// Headless unit tests for the webview drop adapter. The adapter is vscode-free
// (it depends on the MetadataStore structural seam and the pure reducer), so this
// test never transitively requires vscode (ARCHITECTURE.md unit-gate rule). It
// covers the message-to-DropInput EXTRACTION mapping (the only new logic this
// slice adds on the drop path; the interpretation stays in the unchanged
// reduceDrop) and the intent application + no-op cases. It also asserts the adapter
// never reaches the cross-tree dragContext stash (a webview drop is in-process).

function newStore(): { store: MetadataStore; memento: FakeMemento } {
  const memento = new FakeMemento();
  const store = new MetadataStore(memento, { deviceId: 'dev', debounceMs: 0, now: () => 1000 });
  return { store, memento };
}

const KEY = 'proj';

describe('dropInputFromMessage extraction mapping', () => {
  it('maps a folder-row drop to the Folders target view with the shared chat MIME', () => {
    const msg: WebviewDropMessage = {
      sourceChatIds: ['c1', 'c2'],
      targetKind: 'folder',
      targetId: 'f1',
    };
    const input = dropInputFromMessage(msg);
    assert.deepStrictEqual(input, {
      payloadMime: NEST_CHAT_MIME,
      sourceChatIds: ['c1', 'c2'],
      targetView: 'claudeNest.folders',
      targetId: 'f1',
    });
  });

  it('maps a tag-chip drop to the Tags target view', () => {
    const input = dropInputFromMessage({ sourceChatIds: ['c1'], targetKind: 'tag', targetId: 't1' });
    assert.strictEqual(input.targetView, 'claudeNest.tags');
    assert.strictEqual(input.targetId, 't1');
    assert.strictEqual(input.payloadMime, NEST_CHAT_MIME);
  });

  it('maps an empty-space folder drop (undefined targetId) for the reducer to unfile', () => {
    const input = dropInputFromMessage({ sourceChatIds: ['c1'], targetKind: 'folder', targetId: undefined });
    assert.strictEqual(input.targetView, 'claudeNest.folders');
    assert.strictEqual(input.targetId, undefined);
  });

  it('maps the Unsorted sentinel for the reducer to unfile', () => {
    const input = dropInputFromMessage({
      sourceChatIds: ['c1'],
      targetKind: 'folder',
      targetId: UNFILED_FOLDER_ID,
    });
    assert.strictEqual(input.targetId, UNFILED_FOLDER_ID);
  });

  it('tolerates a non-array sourceChatIds by yielding an empty id list', () => {
    const input = dropInputFromMessage({
      sourceChatIds: undefined as unknown as string[],
      targetKind: 'folder',
      targetId: 'f1',
    });
    assert.deepStrictEqual(input.sourceChatIds, []);
  });
});

describe('handleWebviewDrop intent application', () => {
  it('files dragged chats into the target folder (one setFolder per chat, coalesced)', async () => {
    const { store, memento } = newStore();
    let refreshed = 0;
    const n = await handleWebviewDrop(
      { store, getProjectKey: () => KEY, refresh: () => (refreshed += 1) },
      { sourceChatIds: ['c1', 'c2'], targetKind: 'folder', targetId: 'f1' },
    );
    assert.strictEqual(n, 2, 'two intents applied');
    assert.strictEqual(refreshed, 1, 'one refresh');
    const meta = store.getProjectMeta(KEY);
    assert.strictEqual(meta.chats.c1.folderId, 'f1');
    assert.strictEqual(meta.chats.c2.folderId, 'f1');
    // The two granular writes coalesce into a single pending write (one update).
    assert.ok(memento.updateCount <= 1, 'the burst coalesced into one persisted write');
  });

  it('a drop on empty space / Unsorted unfiles (folderId null)', async () => {
    const { store } = newStore();
    store.setChatFolder(KEY, 'c1', 'f1');
    await store.flush();
    const n = await handleWebviewDrop(
      { store, getProjectKey: () => KEY, refresh: () => undefined },
      { sourceChatIds: ['c1'], targetKind: 'folder', targetId: undefined },
    );
    assert.strictEqual(n, 1);
    assert.strictEqual(store.getProjectMeta(KEY).chats.c1.folderId, null);
  });

  it('a tag-chip drop adds the tag to each chat', async () => {
    const { store } = newStore();
    const n = await handleWebviewDrop(
      { store, getProjectKey: () => KEY, refresh: () => undefined },
      { sourceChatIds: ['c1', 'c2'], targetKind: 'tag', targetId: 't1' },
    );
    assert.strictEqual(n, 2);
    assert.deepStrictEqual(store.getProjectMeta(KEY).chats.c1.tags, ['t1']);
    assert.deepStrictEqual(store.getProjectMeta(KEY).chats.c2.tags, ['t1']);
  });

  it('a tag drop on the Untagged sentinel is a no-op (no real tag to add)', async () => {
    const { store } = newStore();
    let refreshed = 0;
    const n = await handleWebviewDrop(
      { store, getProjectKey: () => KEY, refresh: () => (refreshed += 1) },
      { sourceChatIds: ['c1'], targetKind: 'tag', targetId: UNTAGGED_TAG_ID },
    );
    assert.strictEqual(n, 0, 'no intents');
    assert.strictEqual(refreshed, 0, 'no refresh on a no-op');
  });

  it('an empty selection is a no-op even with a valid folder target', async () => {
    const { store } = newStore();
    let refreshed = 0;
    const n = await handleWebviewDrop(
      { store, getProjectKey: () => KEY, refresh: () => (refreshed += 1) },
      { sourceChatIds: [], targetKind: 'folder', targetId: 'f1' },
    );
    assert.strictEqual(n, 0);
    assert.strictEqual(refreshed, 0);
  });

  it('an unresolved project key applies nothing and does not refresh', async () => {
    const { store } = newStore();
    let refreshed = 0;
    const n = await handleWebviewDrop(
      { store, getProjectKey: () => undefined, refresh: () => (refreshed += 1) },
      { sourceChatIds: ['c1'], targetKind: 'folder', targetId: 'f1' },
    );
    assert.strictEqual(n, 0);
    assert.strictEqual(refreshed, 0);
  });

  it('a multi-select drop with a duplicate chat id de-dupes to one intent per chat', async () => {
    const { store } = newStore();
    const n = await handleWebviewDrop(
      { store, getProjectKey: () => KEY, refresh: () => undefined },
      { sourceChatIds: ['c1', 'c1', 'c2'], targetKind: 'folder', targetId: 'f1' },
    );
    // The reducer de-dupes c1, so two intents (c1, c2).
    assert.strictEqual(n, 2);
  });
});

describe('webviewDropAdapter does not touch the cross-tree stash', () => {
  it('the adapter never writes the cross-tree stash (webview DnD is fully in-process)', async () => {
    // The dragContext stash is a module singleton other tests may have populated;
    // clear it first, then run a full adapter drop and confirm the stash is STILL
    // empty. The adapter never calls stashDrag (that exists only for the cross-tree
    // TreeView case); a populated stash here would prove the adapter wrongly went
    // through the cross-controller path.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const dragContext = require('../../dnd/dragContext') as {
      peekDrag: () => unknown;
      clearDrag: () => void;
    };
    dragContext.clearDrag();
    const { store } = newStore();
    await handleWebviewDrop(
      { store, getProjectKey: () => KEY, refresh: () => undefined },
      { sourceChatIds: ['c1'], targetKind: 'folder', targetId: 'f1' },
    );
    assert.strictEqual(dragContext.peekDrag(), undefined, 'the adapter never stashed a drag');
  });
});
