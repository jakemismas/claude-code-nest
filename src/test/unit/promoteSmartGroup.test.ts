import * as assert from 'assert';
import { MetadataStore } from '../../store/metadataStore';
import { FakeMemento } from './fakeMemento';
import {
  PromoteDeps,
  promoteGroupToFolder,
  promoteGroupToTag,
  findTagByLabel,
} from '../../commands/promoteSmartGroup';

// Unit tests for the promotion command orchestration against a REAL MetadataStore
// (debounceMs 0) over the headless FakeMemento and a fake refreshable provider.
// They assert: (1) a promote produces the correct store mutations (folder + filed
// members, tag + tagged members); (2) it is idempotent on chat MEMBERSHIP; and
// (3) it is idempotent on GROUP IDENTITY (reuse-by-name, no duplicate folder/tag).

const PROJECT_KEY = 'promote-test-project';

interface Harness {
  store: MetadataStore;
  deps: PromoteDeps;
  refreshCount: () => number;
}

function harness(): Harness {
  const memento = new FakeMemento();
  const store = new MetadataStore(memento, { deviceId: 'dev-1', debounceMs: 0 });
  let refreshes = 0;
  const deps: PromoteDeps = {
    store,
    provider: { refresh: () => { refreshes++; } },
    getProjectKey: () => PROJECT_KEY,
  };
  return { store, deps, refreshCount: () => refreshes };
}

describe('promoteGroupToFolder', () => {
  it('creates a top-level folder and files every member into it', async () => {
    const { store, deps } = harness();
    const result = await promoteGroupToFolder(deps, {
      name: 'PR #1 (o/r)',
      memberChatIds: ['a', 'b', 'c'],
    });
    assert.ok(result);
    assert.strictEqual(result!.created, true);
    assert.strictEqual(result!.memberCount, 3);

    const meta = store.getProjectMeta(PROJECT_KEY);
    const folder = meta.folders[result!.id];
    assert.ok(folder, 'the folder was created');
    assert.strictEqual(folder.name, 'PR #1 (o/r)');
    assert.strictEqual(folder.parentId, null, 'a promoted folder is top-level');
    for (const chatId of ['a', 'b', 'c']) {
      assert.strictEqual(meta.chats[chatId].folderId, result!.id, chatId + ' is filed');
    }
  });

  it('is idempotent on GROUP IDENTITY: a second promote reuses the folder by name', async () => {
    const { store, deps } = harness();
    const first = await promoteGroupToFolder(deps, { name: 'PR #1', memberChatIds: ['a', 'b'] });
    const second = await promoteGroupToFolder(deps, { name: 'PR #1', memberChatIds: ['a', 'b'] });
    assert.ok(first && second);
    assert.strictEqual(first!.id, second!.id, 'same folder id reused');
    assert.strictEqual(second!.created, false, 'no new folder minted');

    const meta = store.getProjectMeta(PROJECT_KEY);
    const namedFolders = Object.values(meta.folders).filter((f) => f.name === 'PR #1');
    assert.strictEqual(namedFolders.length, 1, 'exactly one folder by that name');
  });

  it('is idempotent on MEMBERSHIP: re-promoting does not duplicate or move a filed chat', async () => {
    const { store, deps } = harness();
    const first = await promoteGroupToFolder(deps, { name: 'G', memberChatIds: ['a', 'b'] });
    await promoteGroupToFolder(deps, { name: 'G', memberChatIds: ['a', 'b', 'c'] });
    const meta = store.getProjectMeta(PROJECT_KEY);
    // a and b stay in the same folder; c is newly added; no second folder.
    assert.strictEqual(meta.chats['a'].folderId, first!.id);
    assert.strictEqual(meta.chats['b'].folderId, first!.id);
    assert.strictEqual(meta.chats['c'].folderId, first!.id);
    assert.strictEqual(Object.keys(meta.folders).length, 1);
  });

  it('no-ops on no project or empty members', async () => {
    const { store } = harness();
    const noProject: PromoteDeps = {
      store,
      provider: { refresh: () => undefined },
      getProjectKey: () => undefined,
    };
    assert.strictEqual(await promoteGroupToFolder(noProject, { name: 'G', memberChatIds: ['a'] }), null);

    const ok: PromoteDeps = { store, provider: { refresh: () => undefined }, getProjectKey: () => PROJECT_KEY };
    assert.strictEqual(await promoteGroupToFolder(ok, { name: 'G', memberChatIds: [] }), null);
    assert.strictEqual(await promoteGroupToFolder(ok, { name: '  ', memberChatIds: ['a'] }), null);
  });

  it('refreshes exactly once per promote (refresh coalescing)', async () => {
    const { deps, refreshCount } = harness();
    await promoteGroupToFolder(deps, { name: 'G', memberChatIds: ['a', 'b', 'c'] });
    assert.strictEqual(refreshCount(), 1, 'one refresh after one flush, not one per member');
  });
});

describe('promoteGroupToTag', () => {
  it('creates a tag and applies it to every member', async () => {
    const { store, deps } = harness();
    const result = await promoteGroupToTag(deps, { name: 'PR #1', memberChatIds: ['a', 'b'] });
    assert.ok(result);
    assert.strictEqual(result!.created, true);
    const meta = store.getProjectMeta(PROJECT_KEY);
    assert.strictEqual(meta.tags[result!.id].label, 'PR #1');
    assert.ok(meta.chats['a'].tags.includes(result!.id));
    assert.ok(meta.chats['b'].tags.includes(result!.id));
  });

  it('is idempotent on GROUP IDENTITY: reuses the tag by label', async () => {
    const { store, deps } = harness();
    const first = await promoteGroupToTag(deps, { name: 'PR #1', memberChatIds: ['a'] });
    const second = await promoteGroupToTag(deps, { name: 'PR #1', memberChatIds: ['a', 'b'] });
    assert.ok(first && second);
    assert.strictEqual(first!.id, second!.id);
    assert.strictEqual(second!.created, false);
    const meta = store.getProjectMeta(PROJECT_KEY);
    assert.strictEqual(Object.values(meta.tags).filter((t) => t.label === 'PR #1').length, 1);
  });

  it('is idempotent on MEMBERSHIP: addChatTag dedupes on re-promote', async () => {
    const { store, deps } = harness();
    const r = await promoteGroupToTag(deps, { name: 'T', memberChatIds: ['a'] });
    await promoteGroupToTag(deps, { name: 'T', memberChatIds: ['a'] });
    const meta = store.getProjectMeta(PROJECT_KEY);
    const occurrences = meta.chats['a'].tags.filter((t) => t === r!.id);
    assert.strictEqual(occurrences.length, 1, 'the tag id appears once, not twice');
  });

  it('findTagByLabel locates an existing tag and returns null otherwise', () => {
    const tags = { t1: { id: 't1', label: 'A' }, t2: { id: 't2', label: 'B' } };
    assert.strictEqual(findTagByLabel(tags, 'B')!.id, 't2');
    assert.strictEqual(findTagByLabel(tags, 'Z'), null);
  });
});
