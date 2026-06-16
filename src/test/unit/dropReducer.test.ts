import * as assert from 'assert';
import {
  DropInput,
  NEST_CHAT_MIME,
  reduceDrop,
} from '../../dnd/dropReducer';
import { UNFILED_FOLDER_ID } from '../../model/folderTree';
import { UNTAGGED_TAG_ID } from '../../model/untagged';

// Headless unit tests for the PURE drop reducer. The reducer imports no vscode
// types (only plain data in/out), so this test never transitively requires the
// vscode module (ARCHITECTURE.md unit-gate rule). It covers the MIME guard,
// folder-move vs tag-add interpretation BY TARGET VIEW, multi-node batching, and
// the synthetic-bucket edge cases.

function input(over: Partial<DropInput>): DropInput {
  return {
    payloadMime: NEST_CHAT_MIME,
    sourceChatIds: ['c1'],
    targetView: 'claudeNest.folders',
    targetId: undefined,
    ...over,
  };
}

describe('reduceDrop MIME guard', () => {
  it('rejects a foreign reserved MIME as a no-op (empty intents)', () => {
    const intents = reduceDrop(
      input({
        payloadMime: 'application/vnd.code.tree.someOtherTree',
        targetView: 'claudeNest.tags',
        targetId: 't1',
      }),
    );
    assert.deepStrictEqual(intents, []);
  });

  it('rejects an undefined payload MIME as a no-op', () => {
    const intents = reduceDrop(
      input({ payloadMime: undefined, targetView: 'claudeNest.tags', targetId: 't1' }),
    );
    assert.deepStrictEqual(intents, []);
  });

  it('rejects a per-view reserved MIME as a cross-view payload (only the shared chat MIME crosses)', () => {
    // A Folders reserved MIME must NOT be honored as a tag-add payload, or a
    // same-view reorder could tag a chat.
    const intents = reduceDrop(
      input({
        payloadMime: 'application/vnd.code.tree.claudenest.folders',
        targetView: 'claudeNest.tags',
        targetId: 't1',
      }),
    );
    assert.deepStrictEqual(intents, []);
  });

  it('accepts the shared chat MIME', () => {
    const intents = reduceDrop(
      input({ targetView: 'claudeNest.tags', targetId: 't1' }),
    );
    assert.deepStrictEqual(intents, [{ kind: 'addTag', chatId: 'c1', tagId: 't1' }]);
  });
});

describe('reduceDrop interprets by the TARGET view', () => {
  it('a drop on the Folders view sets the single home (folder-move), never a tag', () => {
    const intents = reduceDrop(
      input({ targetView: 'claudeNest.folders', targetId: 'f1' }),
    );
    assert.deepStrictEqual(intents, [
      { kind: 'setFolder', chatId: 'c1', folderId: 'f1' },
    ]);
  });

  it('a drop on the Tags view adds the target tag (tag-add), never a folder move', () => {
    const intents = reduceDrop(
      input({ targetView: 'claudeNest.tags', targetId: 't1' }),
    );
    assert.deepStrictEqual(intents, [{ kind: 'addTag', chatId: 'c1', tagId: 't1' }]);
  });

  it('the SAME payload yields a folder move on Folders and a tag add on Tags (target decides)', () => {
    const base = { payloadMime: NEST_CHAT_MIME, sourceChatIds: ['c1'] };
    const onFolders = reduceDrop({
      ...base,
      targetView: 'claudeNest.folders',
      targetId: 'f1',
    });
    const onTags = reduceDrop({
      ...base,
      targetView: 'claudeNest.tags',
      targetId: 'f1',
    });
    assert.deepStrictEqual(onFolders, [
      { kind: 'setFolder', chatId: 'c1', folderId: 'f1' },
    ]);
    // Same targetId string, but the Tags view interprets it as a tag id to add.
    assert.deepStrictEqual(onTags, [{ kind: 'addTag', chatId: 'c1', tagId: 'f1' }]);
  });
});

describe('reduceDrop synthetic-bucket and empty-target handling', () => {
  it('a Folders drop on the Unfiled bucket unfiles (folderId null)', () => {
    const intents = reduceDrop(
      input({ targetView: 'claudeNest.folders', targetId: UNFILED_FOLDER_ID }),
    );
    assert.deepStrictEqual(intents, [
      { kind: 'setFolder', chatId: 'c1', folderId: null },
    ]);
  });

  it('a Folders drop on empty space / the view root unfiles (folderId null)', () => {
    const intents = reduceDrop(
      input({ targetView: 'claudeNest.folders', targetId: undefined }),
    );
    assert.deepStrictEqual(intents, [
      { kind: 'setFolder', chatId: 'c1', folderId: null },
    ]);
  });

  it('a Tags drop on the Untagged bucket is a no-op (no real tag to add)', () => {
    const intents = reduceDrop(
      input({ targetView: 'claudeNest.tags', targetId: UNTAGGED_TAG_ID }),
    );
    assert.deepStrictEqual(intents, []);
  });

  it('a Tags drop on empty space / the view root is a no-op', () => {
    const intents = reduceDrop(
      input({ targetView: 'claudeNest.tags', targetId: undefined }),
    );
    assert.deepStrictEqual(intents, []);
  });
});

describe('reduceDrop multi-node batching', () => {
  it('emits one intent per dragged chat in source order (folder move)', () => {
    const intents = reduceDrop(
      input({
        sourceChatIds: ['c1', 'c2', 'c3'],
        targetView: 'claudeNest.folders',
        targetId: 'f1',
      }),
    );
    assert.deepStrictEqual(intents, [
      { kind: 'setFolder', chatId: 'c1', folderId: 'f1' },
      { kind: 'setFolder', chatId: 'c2', folderId: 'f1' },
      { kind: 'setFolder', chatId: 'c3', folderId: 'f1' },
    ]);
  });

  it('emits one intent per dragged chat (tag add)', () => {
    const intents = reduceDrop(
      input({
        sourceChatIds: ['c1', 'c2'],
        targetView: 'claudeNest.tags',
        targetId: 't1',
      }),
    );
    assert.deepStrictEqual(intents, [
      { kind: 'addTag', chatId: 'c1', tagId: 't1' },
      { kind: 'addTag', chatId: 'c2', tagId: 't1' },
    ]);
  });

  it('de-duplicates a chat listed twice in the selection (one intent per chat)', () => {
    const intents = reduceDrop(
      input({
        sourceChatIds: ['c1', 'c1', 'c2'],
        targetView: 'claudeNest.tags',
        targetId: 't1',
      }),
    );
    assert.deepStrictEqual(intents, [
      { kind: 'addTag', chatId: 'c1', tagId: 't1' },
      { kind: 'addTag', chatId: 'c2', tagId: 't1' },
    ]);
  });

  it('drops empty / blank chat ids from the selection', () => {
    const intents = reduceDrop(
      input({
        sourceChatIds: ['', 'c1', ''],
        targetView: 'claudeNest.folders',
        targetId: 'f1',
      }),
    );
    assert.deepStrictEqual(intents, [
      { kind: 'setFolder', chatId: 'c1', folderId: 'f1' },
    ]);
  });

  it('an empty selection is a no-op even with a valid MIME and target', () => {
    const intents = reduceDrop(
      input({ sourceChatIds: [], targetView: 'claudeNest.tags', targetId: 't1' }),
    );
    assert.deepStrictEqual(intents, []);
  });
});

describe('reduceDrop synthetic sentinel literals match the model contract', () => {
  it('uses the same UNFILED and UNTAGGED sentinels the model exports', () => {
    // The reducer hard-codes these sentinel literals to stay free of any import
    // that could pull vscode in; assert they still equal the model's values so a
    // future rename cannot silently break the bucket handling.
    assert.strictEqual(UNFILED_FOLDER_ID, '__unfiled__');
    assert.strictEqual(UNTAGGED_TAG_ID, '__untagged__');
  });
});
