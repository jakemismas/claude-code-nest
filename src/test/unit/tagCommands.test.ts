import * as assert from 'assert';
import { MetadataStore } from '../../store/metadataStore';
import { FakeMemento } from './fakeMemento';
import { isMintableId } from '../../model/idFactory';
import {
  TagCommandDeps,
  TagCommandUi,
  addTagToChat,
  createTag,
  deleteTag,
  removeTagFromChat,
} from '../../commands/tagCommands';
import type { TagsProvider, TagItem, ChatOccurrenceItem } from '../../views/tagsProvider';

// Headless unit tests for the Tags-view command orchestration. The commands depend
// only on the injectable TagCommandUi/TagCommandDeps seams, a real MetadataStore
// over the FakeMemento double, and a refresh-counting TagsProvider stub. No vscode
// host. Mirrors folderCommands.test.ts.

const DEVICE = 'dev-tag';
const PK = 'c--proj-tag';

function makeStore(): MetadataStore {
  return new MetadataStore(new FakeMemento(), { deviceId: DEVICE, debounceMs: 0 });
}

// A TagsProvider stub that only counts refreshes. The commands call exactly
// provider.refresh() once after each store flush (refresh coalescing).
function makeProvider(): { provider: TagsProvider; refreshCount: () => number } {
  let refreshes = 0;
  const stub = {
    refresh(): void {
      refreshes++;
    },
  };
  return {
    provider: stub as unknown as TagsProvider,
    refreshCount: () => refreshes,
  };
}

interface ScriptedUi extends TagCommandUi {
  promptCalls: { title: string; validate?: (v: string) => string | null }[];
  confirmCalls: { message: string; confirmLabel: string }[];
  pickCalls: { items: { label: string; tagId: string }[]; placeholder: string }[];
  errors: string[];
}

function makeUi(responses: {
  prompts?: (string | undefined)[];
  confirms?: boolean[];
  picks?: ({ tagId: string } | undefined)[];
}): ScriptedUi {
  const prompts = [...(responses.prompts ?? [])];
  const confirms = [...(responses.confirms ?? [])];
  const picks = [...(responses.picks ?? [])];
  const ui: ScriptedUi = {
    promptCalls: [],
    confirmCalls: [],
    pickCalls: [],
    errors: [],
    prompt(options): Thenable<string | undefined> {
      ui.promptCalls.push({ title: options.title, validate: options.validateInput });
      return Promise.resolve(prompts.shift());
    },
    confirmWarning(message, confirmLabel): Thenable<boolean> {
      ui.confirmCalls.push({ message, confirmLabel });
      return Promise.resolve(confirms.shift() ?? false);
    },
    pickTag(items, placeholder): Thenable<{ tagId: string } | undefined> {
      ui.pickCalls.push({ items, placeholder });
      return Promise.resolve(picks.shift());
    },
    showError(message): void {
      ui.errors.push(message);
    },
  };
  return ui;
}

function makeDeps(
  store: MetadataStore,
  provider: TagsProvider,
  ui: TagCommandUi,
  projectKey: string | undefined,
): TagCommandDeps {
  return { store, provider, getProjectKey: () => projectKey, ui };
}

function tagArg(tagId: string): TagItem {
  return { tagId } as unknown as TagItem;
}

function occArg(tagId: string, chatId: string, sessionId = chatId): ChatOccurrenceItem {
  return {
    occurrence: { tagId, chatId, id: `${tagId}:${chatId}` },
    record: { sessionId },
  } as unknown as ChatOccurrenceItem;
}

describe('createTag', () => {
  it('guards when no project is resolved and shows an error', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    const ui = makeUi({ prompts: ['Bug'] });
    const id = await createTag(makeDeps(store, provider, ui, undefined));
    assert.strictEqual(id, null);
    assert.strictEqual(ui.errors.length, 1);
    assert.strictEqual(refreshCount(), 0);
  });

  it('mints a separator-free id, persists the tag, and refreshes once', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    const ui = makeUi({ prompts: ['  Bug  '] });
    const id = await createTag(makeDeps(store, provider, ui, PK));
    assert.ok(id);
    // The minted id is separator-free (the occurrence grammar depends on it).
    assert.ok(isMintableId(id), 'created tag id must be separator-free / mintable');
    const tag = store.getProjectMeta(PK).tags[id];
    assert.ok(tag);
    assert.strictEqual(tag.label, 'Bug', 'label is trimmed');
    assert.strictEqual(refreshCount(), 1, 'refresh coalesced to one call');
  });

  it('returns null on a cancelled prompt without persisting or refreshing', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    const ui = makeUi({ prompts: [undefined] });
    const id = await createTag(makeDeps(store, provider, ui, PK));
    assert.strictEqual(id, null);
    assert.deepStrictEqual(store.getProjectMeta(PK).tags, {});
    assert.strictEqual(refreshCount(), 0);
  });

  it('rejects a blank label via validateInput and does not persist', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    const ui = makeUi({ prompts: ['   '] });
    const id = await createTag(makeDeps(store, provider, ui, PK));
    assert.strictEqual(id, null);
    assert.deepStrictEqual(store.getProjectMeta(PK).tags, {});
    assert.strictEqual(refreshCount(), 0);
    const validate = ui.promptCalls[0].validate;
    assert.ok(validate);
    assert.notStrictEqual(validate('   '), null);
    assert.strictEqual(validate('Bug'), null);
  });
});

describe('deleteTag', () => {
  it('confirms, removes the tag, and strips it from every chat that had it', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    store.upsertTag(PK, { id: 't1', label: 'Bug' });
    store.upsertTag(PK, { id: 't2', label: 'Feature' });
    store.addChatTag(PK, 'c1', 't1');
    store.addChatTag(PK, 'c1', 't2');
    store.addChatTag(PK, 'c2', 't1');
    await store.flush();

    const ui = makeUi({ confirms: [true] });
    await deleteTag(makeDeps(store, provider, ui, PK), tagArg('t1'));

    assert.strictEqual(ui.confirmCalls.length, 1);
    assert.ok(/Bug/.test(ui.confirmCalls[0].message), 'message names the tag');
    assert.strictEqual(ui.confirmCalls[0].confirmLabel, 'Delete');

    const meta = store.getProjectMeta(PK);
    assert.ok(!('t1' in meta.tags), 'tag record removed');
    assert.ok('t2' in meta.tags, 'other tag survives');
    // t1 stripped from both chats; t2 retained on c1.
    assert.deepStrictEqual(meta.chats.c1.tags, ['t2']);
    assert.deepStrictEqual(meta.chats.c2.tags, []);
    assert.strictEqual(refreshCount(), 1);
  });

  it('does nothing when the deletion is not confirmed', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    store.upsertTag(PK, { id: 't1', label: 'Bug' });
    store.addChatTag(PK, 'c1', 't1');
    await store.flush();

    const ui = makeUi({ confirms: [false] });
    await deleteTag(makeDeps(store, provider, ui, PK), tagArg('t1'));
    const meta = store.getProjectMeta(PK);
    assert.ok('t1' in meta.tags, 'tag survives a declined delete');
    assert.deepStrictEqual(meta.chats.c1.tags, ['t1'], 'chat membership untouched');
    assert.strictEqual(refreshCount(), 0);
  });

  it('no-ops on an unknown tag without prompting', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    const ui = makeUi({ confirms: [true] });
    await deleteTag(makeDeps(store, provider, ui, PK), tagArg('gone'));
    assert.strictEqual(ui.confirmCalls.length, 0);
    assert.strictEqual(refreshCount(), 0);
  });

  it('guards when no project is resolved', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    const ui = makeUi({ confirms: [true] });
    await deleteTag(makeDeps(store, provider, ui, undefined), tagArg('t1'));
    assert.strictEqual(ui.confirmCalls.length, 0);
    assert.strictEqual(refreshCount(), 0);
  });
});

describe('addTagToChat', () => {
  it('applies a chosen tag to a chat and refreshes once (accepts a bare sessionId)', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    store.upsertTag(PK, { id: 't1', label: 'Bug' });
    await store.flush();

    const ui = makeUi({ picks: [{ tagId: 't1' }] });
    await addTagToChat(makeDeps(store, provider, ui, PK), 'chatString');
    assert.deepStrictEqual(store.getProjectMeta(PK).chats.chatString.tags, ['t1']);
    assert.strictEqual(refreshCount(), 1);
  });

  it('offers only the not-yet-applied tags for a chat', async () => {
    const store = makeStore();
    const { provider } = makeProvider();
    store.upsertTag(PK, { id: 't1', label: 'Bug' });
    store.upsertTag(PK, { id: 't2', label: 'Feature' });
    store.addChatTag(PK, 'c1', 't1');
    await store.flush();

    const ui = makeUi({ picks: [{ tagId: 't2' }] });
    await addTagToChat(makeDeps(store, provider, ui, PK), occArg('t1', 'c1'));
    // The picker offered only t2 (t1 is already applied).
    assert.deepStrictEqual(ui.pickCalls[0].items.map((i) => i.tagId), ['t2']);
    assert.deepStrictEqual(new Set(store.getProjectMeta(PK).chats.c1.tags), new Set(['t1', 't2']));
  });

  it('errors when there are no applicable tags and does not refresh', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    const ui = makeUi({});
    await addTagToChat(makeDeps(store, provider, ui, PK), 'c1');
    assert.strictEqual(ui.errors.length, 1);
    assert.strictEqual(ui.pickCalls.length, 0);
    assert.strictEqual(refreshCount(), 0);
  });

  it('does nothing when the pick is cancelled', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    store.upsertTag(PK, { id: 't1', label: 'Bug' });
    await store.flush();
    const ui = makeUi({ picks: [undefined] });
    await addTagToChat(makeDeps(store, provider, ui, PK), 'c1');
    assert.deepStrictEqual(store.getProjectMeta(PK).chats, {}, 'no chat record created on cancel');
    assert.strictEqual(refreshCount(), 0);
  });
});

describe('removeTagFromChat', () => {
  it('removes only the occurrence owning tag, keeping the other tags on the chat', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    store.upsertTag(PK, { id: 't1', label: 'Bug' });
    store.upsertTag(PK, { id: 't2', label: 'Feature' });
    store.addChatTag(PK, 'c1', 't1');
    store.addChatTag(PK, 'c1', 't2');
    await store.flush();

    // Right-click the c1 occurrence under t1: only t1 is removed.
    await removeTagFromChat(makeDeps(store, provider, makeUi({}), PK), occArg('t1', 'c1'));
    assert.deepStrictEqual(store.getProjectMeta(PK).chats.c1.tags, ['t2']);
    assert.strictEqual(refreshCount(), 1);
  });

  it('a chat that loses its last tag has an empty tag list (recomputes into Untagged)', async () => {
    const store = makeStore();
    const { provider } = makeProvider();
    store.upsertTag(PK, { id: 't1', label: 'Bug' });
    store.addChatTag(PK, 'c1', 't1');
    await store.flush();

    await removeTagFromChat(makeDeps(store, provider, makeUi({}), PK), occArg('t1', 'c1'));
    assert.deepStrictEqual(store.getProjectMeta(PK).chats.c1.tags, []);
  });

  it('guards when no project is resolved', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    await removeTagFromChat(makeDeps(store, provider, makeUi({}), undefined), occArg('t1', 'c1'));
    assert.strictEqual(refreshCount(), 0);
  });
});
