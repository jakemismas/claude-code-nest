import * as assert from 'assert';
import { MetadataStore } from '../../store/metadataStore';
import { FakeMemento } from './fakeMemento';
import {
  LinkCommandDeps,
  LinkCommandUi,
  ChatPickItem,
  linkToChat,
  linkToChatFromPalette,
  unlinkChat,
  unlinkChatFromPalette,
} from '../../commands/linkCommands';
import { LinkedChild, linkedChildId } from '../../model/links';
import type { Link } from '../../store/schema';
import type { FoldersProvider } from '../../views/foldersProvider';

// Headless unit tests for the Links command orchestration. The commands depend only
// on the injectable LinkCommandUi/LinkCommandDeps seams, a real MetadataStore over
// the FakeMemento double, and a refresh-counting FoldersProvider stub. No vscode
// host. Mirrors tagCommands.test.ts.

const DEVICE = 'dev-link';
const PK = 'c--proj-link';

function makeStore(): MetadataStore {
  return new MetadataStore(new FakeMemento(), { deviceId: DEVICE, debounceMs: 0 });
}

function makeProvider(): { provider: FoldersProvider; refreshCount: () => number } {
  let refreshes = 0;
  const stub = {
    refresh(): void {
      refreshes++;
    },
  };
  return {
    provider: stub as unknown as FoldersProvider,
    refreshCount: () => refreshes,
  };
}

interface ScriptedUi extends LinkCommandUi {
  pickKindCalls: number;
  pickChatCalls: { items: ChatPickItem[]; placeholder: string }[];
  errors: string[];
  infos: string[];
}

function makeUi(responses: {
  kinds?: (Link['kind'] | undefined)[];
  chats?: ({ chatId: string } | undefined)[];
}): ScriptedUi {
  const kinds = [...(responses.kinds ?? [])];
  const chats = [...(responses.chats ?? [])];
  const ui: ScriptedUi = {
    pickKindCalls: 0,
    pickChatCalls: [],
    errors: [],
    infos: [],
    pickKind(): Thenable<Link['kind'] | undefined> {
      ui.pickKindCalls++;
      return Promise.resolve(kinds.shift());
    },
    pickChat(items, placeholder): Thenable<{ chatId: string } | undefined> {
      ui.pickChatCalls.push({ items, placeholder });
      return Promise.resolve(chats.shift());
    },
    showError(message): void {
      ui.errors.push(message);
    },
    showInfo(message): void {
      ui.infos.push(message);
    },
  };
  return ui;
}

function makeRecords(
  ids: string[],
): () => Map<string, { title: string; timestamp: number | null }> {
  return () => {
    const m = new Map<string, { title: string; timestamp: number | null }>();
    for (const id of ids) {
      m.set(id, { title: 'Chat ' + id, timestamp: 1 });
    }
    return m;
  };
}

function makeDeps(
  store: MetadataStore,
  provider: FoldersProvider,
  ui: LinkCommandUi,
  projectKey: string | undefined,
  recordIds: string[],
): LinkCommandDeps {
  return {
    store,
    provider,
    getProjectKey: () => projectKey,
    getChatRecords: makeRecords(recordIds),
    ui,
  };
}

function childArg(parentChatId: string, chatId: string, broken = false): LinkedChild {
  return {
    chatId,
    parentChatId,
    id: linkedChildId(parentChatId, chatId),
    depth: 1,
    broken,
  };
}

describe('linkToChat', () => {
  it('guards when no project is resolved and shows an error', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    const ui = makeUi({ kinds: ['parent'], chats: [{ chatId: 'B' }] });
    await linkToChat(makeDeps(store, provider, ui, undefined, ['A', 'B']), 'A');
    assert.strictEqual(ui.errors.length, 1);
    assert.strictEqual(refreshCount(), 0);
  });

  it('adds a parent link from the source to the chosen target and refreshes once', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    const ui = makeUi({ kinds: ['parent'], chats: [{ chatId: 'B' }] });
    await linkToChat(makeDeps(store, provider, ui, PK, ['A', 'B']), 'A');
    const meta = store.getProjectMeta(PK);
    assert.deepStrictEqual(meta.chats.A.links, [{ targetChatId: 'B', kind: 'parent' }]);
    assert.strictEqual(refreshCount(), 1);
  });

  it('never offers the source chat itself as a target', async () => {
    const store = makeStore();
    const { provider } = makeProvider();
    const ui = makeUi({ kinds: ['parent'], chats: [{ chatId: 'B' }] });
    await linkToChat(makeDeps(store, provider, ui, PK, ['A', 'B', 'C']), 'A');
    const offered = ui.pickChatCalls[0].items.map((i) => i.chatId).sort();
    assert.deepStrictEqual(offered, ['B', 'C'], 'A (the source) is excluded');
  });

  it('errors when there is no other chat to link to', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    const ui = makeUi({ kinds: ['parent'] });
    await linkToChat(makeDeps(store, provider, ui, PK, ['A']), 'A');
    assert.strictEqual(ui.errors.length, 1);
    assert.strictEqual(ui.pickKindCalls, 0, 'no kind prompt when there is nothing to link');
    assert.strictEqual(refreshCount(), 0);
  });

  it('does nothing when the kind pick is cancelled', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    const ui = makeUi({ kinds: [undefined], chats: [{ chatId: 'B' }] });
    await linkToChat(makeDeps(store, provider, ui, PK, ['A', 'B']), 'A');
    assert.deepStrictEqual(store.getProjectMeta(PK).chats, {});
    assert.strictEqual(refreshCount(), 0);
  });

  it('does nothing when the target pick is cancelled', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    const ui = makeUi({ kinds: ['parent'], chats: [undefined] });
    await linkToChat(makeDeps(store, provider, ui, PK, ['A', 'B']), 'A');
    assert.deepStrictEqual(store.getProjectMeta(PK).chats, {});
    assert.strictEqual(refreshCount(), 0);
  });

  it('stores a related link with kind related (no nesting)', async () => {
    const store = makeStore();
    const { provider } = makeProvider();
    const ui = makeUi({ kinds: ['related'], chats: [{ chatId: 'B' }] });
    await linkToChat(makeDeps(store, provider, ui, PK, ['A', 'B']), 'A');
    assert.deepStrictEqual(store.getProjectMeta(PK).chats.A.links, [
      { targetChatId: 'B', kind: 'related' },
    ]);
  });

  it('re-linking the same target/kind is idempotent (store dedupes)', async () => {
    const store = makeStore();
    const { provider } = makeProvider();
    store.addLink(PK, 'A', { targetChatId: 'B', kind: 'parent' });
    await store.flush();
    const ui = makeUi({ kinds: ['parent'], chats: [{ chatId: 'B' }] });
    await linkToChat(makeDeps(store, provider, ui, PK, ['A', 'B']), 'A');
    assert.deepStrictEqual(store.getProjectMeta(PK).chats.A.links, [
      { targetChatId: 'B', kind: 'parent' },
    ]);
  });
});

describe('unlinkChat', () => {
  it('removes the parent link from the designated parent to the child and refreshes once', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    store.addLink(PK, 'A', { targetChatId: 'B', kind: 'parent' });
    await store.flush();

    await unlinkChat(makeDeps(store, provider, makeUi({}), PK, ['A', 'B']), childArg('A', 'B'));
    assert.deepStrictEqual(store.getProjectMeta(PK).chats.A.links, [], 'parent link removed');
    assert.strictEqual(refreshCount(), 1);
  });

  it('removes the link from the CURRENT designated parent (smallest source) even if the node carries a stale parent', async () => {
    const store = makeStore();
    const { provider } = makeProvider();
    // Both A and Z list B as a parent target; the designated parent is A (smallest).
    store.addLink(PK, 'Z', { targetChatId: 'B', kind: 'parent' });
    store.addLink(PK, 'A', { targetChatId: 'B', kind: 'parent' });
    await store.flush();

    // The node was rendered carrying Z as parent (stale); unlink recomputes A.
    await unlinkChat(makeDeps(store, provider, makeUi({}), PK, ['A', 'B', 'Z']), childArg('Z', 'B'));
    const meta = store.getProjectMeta(PK);
    assert.deepStrictEqual(meta.chats.A.links, [], 'designated parent A had its link removed');
    assert.deepStrictEqual(
      meta.chats.Z.links,
      [{ targetChatId: 'B', kind: 'parent' }],
      'the other source Z keeps its link (B now nests under Z next render)',
    );
  });

  it('unlinks a BROKEN child so a dangling link can be cleaned up', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    store.addLink(PK, 'A', { targetChatId: 'GONE', kind: 'parent' });
    await store.flush();
    // GONE is not in the records, so the child is broken; unlink still works.
    await unlinkChat(makeDeps(store, provider, makeUi({}), PK, ['A']), childArg('A', 'GONE', true));
    assert.deepStrictEqual(store.getProjectMeta(PK).chats.A.links, []);
    assert.strictEqual(refreshCount(), 1);
  });

  it('guards when no project is resolved', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    await unlinkChat(makeDeps(store, provider, makeUi({}), undefined, ['A', 'B']), childArg('A', 'B'));
    assert.strictEqual(refreshCount(), 0);
  });
});

// The no-arg palette paths (slice s3a-view-consolidation): with the trees retired,
// the palette supplies no source row, so linkToChat first picks the source and
// unlink picks among the project's current designated-parent links.

describe('linkToChatFromPalette', () => {
  it('guards when no project is resolved and shows an error', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    const ui = makeUi({ kinds: ['parent'], chats: [{ chatId: 'A' }, { chatId: 'B' }] });
    await linkToChatFromPalette(makeDeps(store, provider, ui, undefined, ['A', 'B']));
    assert.strictEqual(ui.errors.length, 1);
    assert.strictEqual(refreshCount(), 0);
  });

  it('errors when fewer than two chats exist (nothing linkable)', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    const ui = makeUi({});
    await linkToChatFromPalette(makeDeps(store, provider, ui, PK, ['A']));
    assert.strictEqual(ui.errors.length, 1);
    assert.strictEqual(ui.pickChatCalls.length, 0, 'no source pick with one chat');
    assert.strictEqual(refreshCount(), 0);
  });

  it('picks the source, then delegates to linkToChat (source excluded from targets)', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    // Pick 1: the source (A). Pick 2 (inside linkToChat): the target (B).
    const ui = makeUi({ kinds: ['parent'], chats: [{ chatId: 'A' }, { chatId: 'B' }] });
    await linkToChatFromPalette(makeDeps(store, provider, ui, PK, ['A', 'B', 'C']));
    assert.strictEqual(ui.pickChatCalls.length, 2);
    const sourceOffer = ui.pickChatCalls[0].items.map((i) => i.chatId).sort();
    assert.deepStrictEqual(sourceOffer, ['A', 'B', 'C'], 'every chat is a candidate source');
    const targetOffer = ui.pickChatCalls[1].items.map((i) => i.chatId).sort();
    assert.deepStrictEqual(targetOffer, ['B', 'C'], 'the chosen source is excluded');
    assert.deepStrictEqual(store.getProjectMeta(PK).chats.A.links, [
      { targetChatId: 'B', kind: 'parent' },
    ]);
    assert.strictEqual(refreshCount(), 1);
  });

  it('does nothing when the source pick is cancelled', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    const ui = makeUi({ kinds: ['parent'], chats: [undefined] });
    await linkToChatFromPalette(makeDeps(store, provider, ui, PK, ['A', 'B']));
    assert.deepStrictEqual(store.getProjectMeta(PK).chats, {});
    assert.strictEqual(refreshCount(), 0);
  });
});

describe('unlinkChatFromPalette', () => {
  it('guards when no project is resolved and shows an error', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    const ui = makeUi({});
    await unlinkChatFromPalette(makeDeps(store, provider, ui, undefined, ['A', 'B']));
    assert.strictEqual(ui.errors.length, 1);
    assert.strictEqual(refreshCount(), 0);
  });

  it('shows an info notice when there is no parent link to unlink', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    // A related link produces no nesting, so it is not offered.
    store.addLink(PK, 'A', { targetChatId: 'B', kind: 'related' });
    await store.flush();
    const ui = makeUi({});
    await unlinkChatFromPalette(makeDeps(store, provider, ui, PK, ['A', 'B']));
    assert.strictEqual(ui.infos.length, 1);
    assert.strictEqual(ui.pickChatCalls.length, 0);
    assert.strictEqual(refreshCount(), 0);
  });

  it('offers one entry per linked child labeled with its designated parent and unlinks the chosen one', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    // Both A and Z list B as a parent target; the designated parent is A
    // (smallest), so the single entry for B names A and the unlink removes A's
    // link, leaving Z's intact (B nests under Z on the next render).
    store.addLink(PK, 'Z', { targetChatId: 'B', kind: 'parent' });
    store.addLink(PK, 'A', { targetChatId: 'B', kind: 'parent' });
    await store.flush();
    const ui = makeUi({ chats: [{ chatId: 'B' }] });
    await unlinkChatFromPalette(makeDeps(store, provider, ui, PK, ['A', 'B', 'Z']));
    assert.strictEqual(ui.pickChatCalls.length, 1);
    const items = ui.pickChatCalls[0].items;
    assert.strictEqual(items.length, 1, 'one entry per linked child');
    assert.strictEqual(items[0].chatId, 'B');
    assert.strictEqual(items[0].label, 'Chat B');
    assert.strictEqual(items[0].description, 'nested under Chat A');
    const meta = store.getProjectMeta(PK);
    assert.deepStrictEqual(meta.chats.A.links, [], 'designated parent A had its link removed');
    assert.deepStrictEqual(meta.chats.Z.links, [{ targetChatId: 'B', kind: 'parent' }]);
    assert.strictEqual(refreshCount(), 1);
  });

  it('offers a BROKEN child (missing record) so a dangling link stays cleanable', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    store.addLink(PK, 'A', { targetChatId: 'GONE', kind: 'parent' });
    await store.flush();
    const ui = makeUi({ chats: [{ chatId: 'GONE' }] });
    await unlinkChatFromPalette(makeDeps(store, provider, ui, PK, ['A']));
    const items = ui.pickChatCalls[0].items;
    assert.strictEqual(items[0].label, 'GONE (missing)');
    assert.deepStrictEqual(store.getProjectMeta(PK).chats.A.links, []);
    assert.strictEqual(refreshCount(), 1);
  });

  it('does nothing when the pick is cancelled', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    store.addLink(PK, 'A', { targetChatId: 'B', kind: 'parent' });
    await store.flush();
    const ui = makeUi({ chats: [undefined] });
    await unlinkChatFromPalette(makeDeps(store, provider, ui, PK, ['A', 'B']));
    assert.deepStrictEqual(store.getProjectMeta(PK).chats.A.links, [
      { targetChatId: 'B', kind: 'parent' },
    ]);
    assert.strictEqual(refreshCount(), 0);
  });
});
