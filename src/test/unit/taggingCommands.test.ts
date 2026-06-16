import * as assert from 'assert';
import { MetadataStore } from '../../store/metadataStore';
import { FakeMemento } from './fakeMemento';
import {
  TaggingCommandDeps,
  TagMultiPickUi,
  commonAppliedTagIds,
  tagChats,
  tagSetDiff,
} from '../../commands/taggingCommands';

// Headless unit tests for the multi-select tagging command and its pure helpers.
// The command depends only on the injectable TagMultiPickUi seam, a real
// MetadataStore over the FakeMemento double, and a refresh-counting provider stub.
// No vscode host (the concrete QuickPick lives in ui/tagQuickPick.ts, not imported
// here). Mirrors tagCommands.test.ts.

const DEVICE = 'dev-tagging';
const PK = 'c--proj-tagging';

function makeStore(): MetadataStore {
  return new MetadataStore(new FakeMemento(), { deviceId: DEVICE, debounceMs: 0 });
}

function makeProvider(): { provider: { refresh(): void }; refreshCount: () => number } {
  let refreshes = 0;
  return {
    provider: {
      refresh(): void {
        refreshes++;
      },
    },
    refreshCount: () => refreshes,
  };
}

interface ScriptedUi extends TagMultiPickUi {
  pickCalls: { options: { tagId: string; label: string; picked: boolean }[]; placeholder: string }[];
  errors: string[];
}

function makeUi(picks: (string[] | undefined)[]): ScriptedUi {
  const queue = [...picks];
  const ui: ScriptedUi = {
    pickCalls: [],
    errors: [],
    pickTags(options, placeholder): Thenable<string[] | undefined> {
      ui.pickCalls.push({ options, placeholder });
      return Promise.resolve(queue.shift());
    },
    showError(message): void {
      ui.errors.push(message);
    },
  };
  return ui;
}

function makeDeps(
  store: MetadataStore,
  provider: { refresh(): void },
  ui: TagMultiPickUi,
  projectKey: string | undefined,
): TaggingCommandDeps {
  return { store, provider, getProjectKey: () => projectKey, ui };
}

describe('tagSetDiff', () => {
  it('adds selected-not-current and removes current-not-selected', () => {
    const delta = tagSetDiff(['t1', 't2'], ['t2', 't3']);
    assert.deepStrictEqual(delta.add, ['t3']);
    assert.deepStrictEqual(delta.remove, ['t1']);
  });

  it('an unchanged selection yields an empty delta (confirm-without-change is a no-op)', () => {
    const delta = tagSetDiff(['t1', 't2'], ['t2', 't1']);
    assert.deepStrictEqual(delta.add, []);
    assert.deepStrictEqual(delta.remove, []);
  });

  it('add follows selected order, remove follows current order, both de-duped', () => {
    const delta = tagSetDiff(['a', 'b', 'b'], ['c', 'c', 'd']);
    assert.deepStrictEqual(delta.add, ['c', 'd']);
    assert.deepStrictEqual(delta.remove, ['a', 'b']);
  });

  it('clearing the selection removes every current tag', () => {
    const delta = tagSetDiff(['t1', 't2'], []);
    assert.deepStrictEqual(delta.add, []);
    assert.deepStrictEqual(delta.remove, ['t1', 't2']);
  });
});

describe('commonAppliedTagIds', () => {
  it('keeps only tags applied to EVERY chat', () => {
    const common = commonAppliedTagIds([
      ['t1', 't2'],
      ['t2', 't3'],
      ['t2'],
    ]);
    assert.deepStrictEqual(common, ['t2']);
  });

  it('a single chat returns its own (de-duped) tag set in order', () => {
    assert.deepStrictEqual(commonAppliedTagIds([['t1', 't1', 't2']]), ['t1', 't2']);
  });

  it('an empty chat list yields an empty common set', () => {
    assert.deepStrictEqual(commonAppliedTagIds([]), []);
  });

  it('no shared tag yields an empty common set', () => {
    assert.deepStrictEqual(commonAppliedTagIds([['t1'], ['t2']]), []);
  });
});

describe('tagChats orchestration', () => {
  it('guards when no project is resolved and shows an error', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    const ui = makeUi([['t1']]);
    await tagChats(makeDeps(store, provider, ui, undefined), ['c1']);
    assert.strictEqual(ui.errors.length, 1);
    assert.strictEqual(ui.pickCalls.length, 0);
    assert.strictEqual(refreshCount(), 0);
  });

  it('errors when there are no tags and does not open the picker', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    const ui = makeUi([['t1']]);
    await tagChats(makeDeps(store, provider, ui, PK), ['c1']);
    assert.strictEqual(ui.errors.length, 1);
    assert.strictEqual(ui.pickCalls.length, 0);
    assert.strictEqual(refreshCount(), 0);
  });

  it('an empty chat selection is a no-op', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    store.upsertTag(PK, { id: 't1', label: 'Bug' });
    await store.flush();
    const ui = makeUi([['t1']]);
    await tagChats(makeDeps(store, provider, ui, PK), []);
    assert.strictEqual(ui.pickCalls.length, 0);
    assert.strictEqual(refreshCount(), 0);
  });

  it('applies the confirmed selection to a single chat and refreshes once', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    store.upsertTag(PK, { id: 't1', label: 'Bug' });
    store.upsertTag(PK, { id: 't2', label: 'Feature' });
    await store.flush();

    const ui = makeUi([['t1', 't2']]);
    await tagChats(makeDeps(store, provider, ui, PK), ['c1']);
    assert.deepStrictEqual(
      new Set(store.getProjectMeta(PK).chats.c1.tags),
      new Set(['t1', 't2']),
    );
    assert.strictEqual(refreshCount(), 1, 'one refresh for the whole mutation');
  });

  it('pre-checks the chat current tags and applies the diff (add + remove) in one refresh', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    store.upsertTag(PK, { id: 't1', label: 'Bug' });
    store.upsertTag(PK, { id: 't2', label: 'Feature' });
    store.upsertTag(PK, { id: 't3', label: 'Chore' });
    store.addChatTag(PK, 'c1', 't1');
    store.addChatTag(PK, 'c1', 't2');
    await store.flush();

    // t1 currently applied is pre-picked; the user unchecks t1 and checks t3,
    // keeps t2.
    const ui = makeUi([['t2', 't3']]);
    await tagChats(makeDeps(store, provider, ui, PK), ['c1']);

    const picked = ui.pickCalls[0].options.filter((o) => o.picked).map((o) => o.tagId);
    assert.deepStrictEqual(new Set(picked), new Set(['t1', 't2']), 'current tags pre-checked');
    assert.deepStrictEqual(
      new Set(store.getProjectMeta(PK).chats.c1.tags),
      new Set(['t2', 't3']),
      't1 removed, t3 added, t2 kept',
    );
    assert.strictEqual(refreshCount(), 1);
  });

  it('a confirm-without-change does not write or refresh', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    store.upsertTag(PK, { id: 't1', label: 'Bug' });
    store.addChatTag(PK, 'c1', 't1');
    await store.flush();

    const ui = makeUi([['t1']]);
    await tagChats(makeDeps(store, provider, ui, PK), ['c1']);
    assert.deepStrictEqual(store.getProjectMeta(PK).chats.c1.tags, ['t1']);
    assert.strictEqual(refreshCount(), 0, 'no refresh when nothing changed');
  });

  it('cancelling the picker writes nothing and does not refresh', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    store.upsertTag(PK, { id: 't1', label: 'Bug' });
    await store.flush();
    const ui = makeUi([undefined]);
    await tagChats(makeDeps(store, provider, ui, PK), ['c1']);
    assert.deepStrictEqual(store.getProjectMeta(PK).chats, {}, 'no chat record created on cancel');
    assert.strictEqual(refreshCount(), 0);
  });

  it('multi-chat: applies the selection to EVERY chat and pre-checks only the COMMON set, one refresh', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    store.upsertTag(PK, { id: 't1', label: 'Bug' });
    store.upsertTag(PK, { id: 't2', label: 'Feature' });
    // c1 has t1+t2; c2 has only t1. Common applied set is {t1}.
    store.addChatTag(PK, 'c1', 't1');
    store.addChatTag(PK, 'c1', 't2');
    store.addChatTag(PK, 'c2', 't1');
    await store.flush();

    const ui = makeUi([['t1', 't2']]);
    await tagChats(makeDeps(store, provider, ui, PK), ['c1', 'c2']);

    const picked = ui.pickCalls[0].options.filter((o) => o.picked).map((o) => o.tagId);
    assert.deepStrictEqual(picked, ['t1'], 'only the common tag is pre-checked');
    // Confirming {t1, t2} adds t2 to c2 (it lacked it) and leaves c1 unchanged.
    assert.deepStrictEqual(
      new Set(store.getProjectMeta(PK).chats.c1.tags),
      new Set(['t1', 't2']),
    );
    assert.deepStrictEqual(
      new Set(store.getProjectMeta(PK).chats.c2.tags),
      new Set(['t1', 't2']),
    );
    assert.strictEqual(refreshCount(), 1, 'a single refresh for the multi-chat batch');
  });

  it('multi-chat: unchecking a common tag removes it from every chat', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    store.upsertTag(PK, { id: 't1', label: 'Bug' });
    store.addChatTag(PK, 'c1', 't1');
    store.addChatTag(PK, 'c2', 't1');
    await store.flush();

    // t1 is common (pre-checked); user clears the selection.
    const ui = makeUi([[]]);
    await tagChats(makeDeps(store, provider, ui, PK), ['c1', 'c2']);
    assert.deepStrictEqual(store.getProjectMeta(PK).chats.c1.tags, []);
    assert.deepStrictEqual(store.getProjectMeta(PK).chats.c2.tags, []);
    assert.strictEqual(refreshCount(), 1);
  });

  it('preserves a dangling stored tag id on confirm-without-change (does not stamp a removal)', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    store.upsertTag(PK, { id: 't1', label: 'Bug' });
    store.addChatTag(PK, 'c1', 't1');
    // tDangling references a tag created/deleted on another machine: stored on the
    // chat but absent from meta.tags (not yet reconciled locally).
    store.addChatTag(PK, 'c1', 'tDangling');
    await store.flush();

    // The picker only ever offers real tags, so t1 is the only pickable option and
    // it is the only one pre-checked; the user confirms without change.
    const ui = makeUi([['t1']]);
    await tagChats(makeDeps(store, provider, ui, PK), ['c1']);

    const offered = ui.pickCalls[0].options.map((o) => o.tagId);
    assert.deepStrictEqual(offered, ['t1'], 'dangling id never offered as an option');
    // The dangling id must survive untouched: confirm-without-change is a no-op.
    assert.deepStrictEqual(
      store.getProjectMeta(PK).chats.c1.tags,
      ['t1', 'tDangling'],
      'dangling id preserved, no removal stamped',
    );
    assert.strictEqual(refreshCount(), 0, 'no refresh when only real tags are unchanged');
  });

  it('preserves a dangling stored tag id while still applying a real-tag change', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    store.upsertTag(PK, { id: 't1', label: 'Bug' });
    store.upsertTag(PK, { id: 't2', label: 'Feature' });
    store.addChatTag(PK, 'c1', 't1');
    store.addChatTag(PK, 'c1', 'tDangling');
    await store.flush();

    // User adds t2 (and leaves t1 checked); tDangling is never offered.
    const ui = makeUi([['t1', 't2']]);
    await tagChats(makeDeps(store, provider, ui, PK), ['c1']);

    assert.deepStrictEqual(
      store.getProjectMeta(PK).chats.c1.tags,
      ['t1', 'tDangling', 't2'],
      'real add appended, dangling id preserved',
    );
    assert.strictEqual(refreshCount(), 1);
  });

  it('de-duplicates a chat listed twice in the selection', async () => {
    const store = makeStore();
    const { provider } = makeProvider();
    store.upsertTag(PK, { id: 't1', label: 'Bug' });
    await store.flush();
    const ui = makeUi([['t1']]);
    await tagChats(makeDeps(store, provider, ui, PK), ['c1', 'c1']);
    assert.deepStrictEqual(store.getProjectMeta(PK).chats.c1.tags, ['t1']);
  });
});
