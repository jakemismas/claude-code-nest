import * as assert from 'assert';
import { MetadataStore } from '../../store/metadataStore';
import { FakeMemento } from './fakeMemento';
import { UNFILED_FOLDER_ID } from '../../model/folderTree';
import {
  FolderCommandDeps,
  FolderCommandUi,
  assignChatToFolder,
  createFolder,
  deleteFolder,
  folderPathFor,
  renameFolder,
} from '../../commands/folderCommands';
import type { FoldersProvider, FolderItem, ChatMemberItem } from '../../views/foldersProvider';

// Headless unit tests for the Folders-view command orchestration. The commands
// depend only on the injectable FolderCommandUi/FolderCommandDeps seams (designed
// to be exercised without the real vscode UI), a real MetadataStore over the
// FakeMemento double, and a refresh-counting FoldersProvider stub. No vscode host.
//
// This complements folderTree.test.ts (the pure model) by covering the command
// layer the model feeds: parent-chain path composition (with its cyclic guard),
// slash-path create + persistence + the mint-id write-boundary assertion, the
// delete cascade-count confirmation and single-flush cascade, the rename
// slash-rejection, and the assign null-pick-to-Unfiled mapping.

const DEVICE = 'dev-cmd';
const PK = 'c--proj-cmd';

function makeStore(): MetadataStore {
  return new MetadataStore(new FakeMemento(), { deviceId: DEVICE, debounceMs: 0 });
}

// A FoldersProvider stub that only counts refreshes. The commands call exactly
// provider.refresh() once after each store flush (refresh coalescing); nothing
// else on the provider is touched, so a structural stub cast to the type suffices
// without constructing the real vscode-bound provider.
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

// A scriptable FolderCommandUi. Each prompt/confirm/pick response is taken from a
// queue; calls and the messages they were shown are recorded so a test can assert
// the confirmation text and the validateInput behavior.
interface ScriptedUi extends FolderCommandUi {
  promptCalls: { title: string; validate?: (v: string) => string | null }[];
  confirmCalls: { message: string; confirmLabel: string }[];
  pickCalls: { items: { label: string; folderId: string | null }[]; placeholder: string }[];
  errors: string[];
}

function makeUi(responses: {
  prompts?: (string | undefined)[];
  confirms?: boolean[];
  picks?: ({ folderId: string | null } | undefined)[];
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
    pickFolder(items, placeholder): Thenable<{ folderId: string | null } | undefined> {
      ui.pickCalls.push({ items, placeholder });
      return Promise.resolve(picks.shift());
    },
    showError(message): void {
      ui.errors.push(message);
    },
  };
  return ui;
}

// projectKey is supplied as a getProjectKey closure (the commands now re-resolve it
// on demand, mirroring scanChats), so an explicit `undefined` return genuinely
// exercises the no-project guard. mutableProjectKey lets a test flip the value
// BETWEEN calls to prove the command picks up a dir created after activation.
function makeDeps(
  store: MetadataStore,
  provider: FoldersProvider,
  ui: FolderCommandUi,
  projectKey: string | undefined,
): FolderCommandDeps {
  return { store, provider, getProjectKey: () => projectKey, ui };
}

// A minimal FolderItem-shaped arg: the commands read only .folderId off it.
function folderArg(folderId: string): FolderItem {
  return { folderId } as unknown as FolderItem;
}

// A minimal ChatMemberItem-shaped arg: assignChatToFolder reads only .record.sessionId.
function chatArg(sessionId: string): ChatMemberItem {
  return { record: { sessionId } } as unknown as ChatMemberItem;
}

describe('folderPathFor (parent-chain slash path)', () => {
  it('composes the full slash path by walking parentId to the root', () => {
    const folders = {
      W: { id: 'W', name: 'Work', parentId: null, order: 0 },
      C: { id: 'C', name: 'ClientA', parentId: 'W', order: 0 },
      G: { id: 'G', name: 'Q1', parentId: 'C', order: 0 },
    };
    assert.strictEqual(folderPathFor(folders, 'G'), 'Work/ClientA/Q1');
    assert.strictEqual(folderPathFor(folders, 'W'), 'Work');
  });

  it('returns empty for an unknown folder id', () => {
    assert.strictEqual(folderPathFor({}, 'missing'), '');
  });

  it('is bounded against a cyclic parent chain (corrupt store)', () => {
    const cyclic = {
      A: { id: 'A', name: 'A', parentId: 'B', order: 0 },
      B: { id: 'B', name: 'B', parentId: 'A', order: 0 },
    };
    // The visited guard stops the walk; it must terminate and not loop forever.
    const path = folderPathFor(cyclic, 'A');
    assert.ok(path.length > 0);
    assert.ok(path.split('/').length <= 2, 'cyclic walk visited a node twice');
  });
});

describe('createFolder', () => {
  it('guards when no project is resolved and shows an error', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    const ui = makeUi({});
    const leaf = await createFolder(makeDeps(store, provider, ui, undefined));
    assert.strictEqual(leaf, null);
    assert.strictEqual(ui.errors.length, 1);
    assert.strictEqual(refreshCount(), 0);
  });

  it('returns null on a cancelled prompt without persisting or refreshing', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    const ui = makeUi({ prompts: [undefined] });
    const leaf = await createFolder(makeDeps(store, provider, ui, PK));
    assert.strictEqual(leaf, null);
    assert.deepStrictEqual(store.getProjectMeta(PK).folders, {});
    assert.strictEqual(refreshCount(), 0);
  });

  it('expands a slash path into a persisted parent-child chain and refreshes once', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    const ui = makeUi({ prompts: ['Work/ClientA'] });
    const leaf = await createFolder(makeDeps(store, provider, ui, PK));

    const folders = Object.values(store.getProjectMeta(PK).folders);
    assert.strictEqual(folders.length, 2, 'both segments persisted');
    const work = folders.find((f) => f.name === 'Work');
    const clientA = folders.find((f) => f.name === 'ClientA');
    assert.ok(work && clientA);
    assert.strictEqual(work.parentId, null);
    assert.strictEqual(clientA.parentId, work.id);
    // No literal slash ever lands in a stored Folder.name.
    for (const f of folders) {
      assert.ok(!f.name.includes('/'));
    }
    // The returned leaf is the deepest segment.
    assert.strictEqual(leaf, clientA.id);
    assert.strictEqual(refreshCount(), 1, 'refresh coalesced to one call');
  });

  it('prefixes the parent folder path when created under an existing folder, reusing it', async () => {
    const store = makeStore();
    const { provider } = makeProvider();
    // First create the parent chain.
    await createFolder(makeDeps(store, provider, makeUi({ prompts: ['Work'] }), PK));
    const work = Object.values(store.getProjectMeta(PK).folders).find((f) => f.name === 'Work');
    assert.ok(work);

    // Now create 'ClientB' under Work via the right-click parent arg.
    const leaf = await createFolder(
      makeDeps(store, provider, makeUi({ prompts: ['ClientB'] }), PK),
      folderArg(work.id),
    );
    const folders = Object.values(store.getProjectMeta(PK).folders);
    assert.strictEqual(folders.length, 2, 'Work reused, only ClientB minted');
    const clientB = folders.find((f) => f.name === 'ClientB');
    assert.ok(clientB);
    assert.strictEqual(clientB.parentId, work.id, 'new child hangs under the parent');
    assert.strictEqual(leaf, clientB.id);
  });

  it('attaches a new child to the exact clicked parent when two root folders share a name', async () => {
    const store = makeStore();
    const { provider } = makeProvider();
    // Two distinct root folders both named 'Work' (the store permits this; the
    // rename guard prevents NEW collisions but a pre-existing/synced store can
    // still hold them). The user right-clicks the SECOND one to create a child.
    store.upsertFolder(PK, { id: 'work1', name: 'Work', parentId: null, order: 0 });
    store.upsertFolder(PK, { id: 'work2', name: 'Work', parentId: null, order: 1 });
    await store.flush();

    const leaf = await createFolder(
      makeDeps(store, provider, makeUi({ prompts: ['ClientX'] }), PK),
      folderArg('work2'),
    );
    const meta = store.getProjectMeta(PK);
    const clientX = Object.values(meta.folders).find((f) => f.name === 'ClientX');
    assert.ok(clientX);
    // The child hangs under the EXACT clicked folder (work2), not the first
    // same-named match (work1) a name-path round-trip would have resolved.
    assert.strictEqual(clientX.parentId, 'work2', 'child attached to the wrong same-named parent');
    assert.strictEqual(leaf, clientX.id);
    // Only one new folder was minted; the two Work roots are untouched.
    assert.strictEqual(Object.keys(meta.folders).length, 3);
  });

  it('does not persist a blank/slash-only name', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    const ui = makeUi({ prompts: ['   /  '] });
    const leaf = await createFolder(makeDeps(store, provider, ui, PK));
    assert.strictEqual(leaf, null);
    assert.deepStrictEqual(store.getProjectMeta(PK).folders, {});
    assert.strictEqual(refreshCount(), 0);
    // The validateInput surfaced on the prompt rejects the empty expansion.
    const validate = ui.promptCalls[0].validate;
    assert.ok(validate);
    assert.notStrictEqual(validate('   /  '), null);
    assert.strictEqual(validate('Work'), null);
  });
});

describe('renameFolder', () => {
  it('renames a single segment and refreshes', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    store.upsertFolder(PK, { id: 'f1', name: 'Old', parentId: null, order: 0 });
    await store.flush();

    const ui = makeUi({ prompts: ['New'] });
    await renameFolder(makeDeps(store, provider, ui, PK), folderArg('f1'));
    assert.strictEqual(store.getProjectMeta(PK).folders.f1.name, 'New');
    assert.strictEqual(refreshCount(), 1);
  });

  it('rejects a slash in the rename via validateInput and is a no-op on cancel', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    store.upsertFolder(PK, { id: 'f1', name: 'Old', parentId: null, order: 0 });
    await store.flush();

    const ui = makeUi({ prompts: [undefined] });
    await renameFolder(makeDeps(store, provider, ui, PK), folderArg('f1'));
    // The prompt offered a validateInput that rejects a slash (re-parenting is not
    // a rename) and accepts a plain name.
    const validate = ui.promptCalls[0].validate;
    assert.ok(validate);
    assert.notStrictEqual(validate('Work/Client'), null);
    assert.strictEqual(validate('Renamed'), null);
    assert.notStrictEqual(validate('   '), null);
    // Cancelled: name unchanged, no refresh.
    assert.strictEqual(store.getProjectMeta(PK).folders.f1.name, 'Old');
    assert.strictEqual(refreshCount(), 0);
  });

  it('errors and no-ops when the target folder no longer exists', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    const ui = makeUi({ prompts: ['Whatever'] });
    await renameFolder(makeDeps(store, provider, ui, PK), folderArg('gone'));
    assert.strictEqual(ui.errors.length, 1);
    assert.strictEqual(refreshCount(), 0);
  });

  it('rejects a rename that would collide with a sibling name, but allows a no-op self-rename', async () => {
    const store = makeStore();
    const { provider } = makeProvider();
    // Two root siblings; renaming f2 to 'Work' would collide with f1.
    store.upsertFolder(PK, { id: 'f1', name: 'Work', parentId: null, order: 0 });
    store.upsertFolder(PK, { id: 'f2', name: 'Personal', parentId: null, order: 1 });
    // A nested child also named 'Work' under f1 must NOT count as a sibling of f2.
    store.upsertFolder(PK, { id: 'f3', name: 'Work', parentId: 'f1', order: 0 });
    await store.flush();

    const ui = makeUi({ prompts: [undefined] });
    await renameFolder(makeDeps(store, provider, ui, PK), folderArg('f2'));
    const validate = ui.promptCalls[0].validate;
    assert.ok(validate);
    // Colliding with the same-parent sibling f1 is rejected.
    assert.notStrictEqual(validate('Work'), null, 'a sibling-name collision must be rejected');
    // A non-colliding name is accepted.
    assert.strictEqual(validate('Archive'), null);
    // The child 'Work' under a DIFFERENT parent does not collide with f2's siblings.
    // (f2 renaming to a name unique among its own siblings is fine.)
    assert.strictEqual(validate('Clients'), null);
  });

  it('allows renaming a folder to its OWN current name (self is not a collision)', async () => {
    const store = makeStore();
    const { provider } = makeProvider();
    store.upsertFolder(PK, { id: 'f1', name: 'Work', parentId: null, order: 0 });
    await store.flush();
    const ui = makeUi({ prompts: [undefined] });
    await renameFolder(makeDeps(store, provider, ui, PK), folderArg('f1'));
    const validate = ui.promptCalls[0].validate;
    assert.ok(validate);
    // The folder's own name is not a collision against itself.
    assert.strictEqual(validate('Work'), null);
  });
});

describe('deleteFolder', () => {
  // A small Work/ClientA/Q1 tree plus a sibling Personal, with chats homed at
  // various depths, for the cascade-count message and the single-flush cascade.
  async function seedTree(store: MetadataStore): Promise<void> {
    store.upsertFolder(PK, { id: 'W', name: 'Work', parentId: null, order: 0 });
    store.upsertFolder(PK, { id: 'C', name: 'ClientA', parentId: 'W', order: 0 });
    store.upsertFolder(PK, { id: 'Q', name: 'Q1', parentId: 'C', order: 0 });
    store.upsertFolder(PK, { id: 'P', name: 'Personal', parentId: null, order: 1 });
    store.setChatFolder(PK, 'chatW', 'W');
    store.setChatFolder(PK, 'chatQ', 'Q');
    await store.flush();
  }

  it('shows a cascade count in the confirmation and unfiles every subtree chat on confirm', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    await seedTree(store);

    const ui = makeUi({ confirms: [true] });
    await deleteFolder(makeDeps(store, provider, ui, PK), folderArg('W'));

    // Confirmation names the folder and the nested-folder count (ClientA + Q1 = 2).
    assert.strictEqual(ui.confirmCalls.length, 1);
    const msg = ui.confirmCalls[0].message;
    assert.ok(/Work/.test(msg), 'message names the folder');
    assert.ok(/2 nested folders/.test(msg), `expected nested count in: ${msg}`);
    assert.ok(/Unfiled/.test(msg), 'message states chats move to Unfiled');
    assert.strictEqual(ui.confirmCalls[0].confirmLabel, 'Delete');

    const meta = store.getProjectMeta(PK);
    // The whole subtree is gone; Personal survives.
    assert.ok(!('W' in meta.folders) && !('C' in meta.folders) && !('Q' in meta.folders));
    assert.ok('P' in meta.folders);
    // Chats homed anywhere in the subtree are unfiled (folderId null), not deleted.
    assert.strictEqual(meta.chats.chatW.folderId, null);
    assert.strictEqual(meta.chats.chatQ.folderId, null);
    // One coalesced refresh for the whole cascade.
    assert.strictEqual(refreshCount(), 1);
  });

  it('uses singular "nested folder" for a single child and omits the clause for a leaf', async () => {
    const store = makeStore();
    const { provider } = makeProvider();
    store.upsertFolder(PK, { id: 'A', name: 'A', parentId: null, order: 0 });
    store.upsertFolder(PK, { id: 'B', name: 'B', parentId: 'A', order: 0 });
    store.upsertFolder(PK, { id: 'L', name: 'Leaf', parentId: null, order: 1 });
    await store.flush();

    const oneChildUi = makeUi({ confirms: [false] });
    await deleteFolder(makeDeps(store, provider, oneChildUi, PK), folderArg('A'));
    assert.ok(/1 nested folder\b/.test(oneChildUi.confirmCalls[0].message), oneChildUi.confirmCalls[0].message);
    assert.ok(!/nested folders/.test(oneChildUi.confirmCalls[0].message));

    const leafUi = makeUi({ confirms: [false] });
    await deleteFolder(makeDeps(store, provider, leafUi, PK), folderArg('L'));
    assert.ok(!/nested folder/.test(leafUi.confirmCalls[0].message), leafUi.confirmCalls[0].message);
  });

  it('does nothing when the deletion is not confirmed', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    await seedTree(store);

    const ui = makeUi({ confirms: [false] });
    await deleteFolder(makeDeps(store, provider, ui, PK), folderArg('W'));
    const meta = store.getProjectMeta(PK);
    assert.ok('W' in meta.folders, 'folder survives a declined delete');
    assert.strictEqual(meta.chats.chatW.folderId, 'W', 'chat home untouched');
    assert.strictEqual(refreshCount(), 0);
  });

  it('no-ops on an unknown target without prompting', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    const ui = makeUi({ confirms: [true] });
    await deleteFolder(makeDeps(store, provider, ui, PK), folderArg('gone'));
    assert.strictEqual(ui.confirmCalls.length, 0);
    assert.strictEqual(refreshCount(), 0);
  });
});

describe('assignChatToFolder', () => {
  it('maps a null pick to Unfiled (folderId null)', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    store.upsertFolder(PK, { id: 'f1', name: 'Inbox', parentId: null, order: 0 });
    store.setChatFolder(PK, 'chatX', 'f1');
    await store.flush();

    const ui = makeUi({ picks: [{ folderId: null }] });
    await assignChatToFolder(makeDeps(store, provider, ui, PK), chatArg('chatX'));
    assert.strictEqual(store.getProjectMeta(PK).chats.chatX.folderId, null);
    assert.strictEqual(refreshCount(), 1);
    // The picker offered the Unfiled choice first.
    assert.strictEqual(ui.pickCalls[0].items[0].folderId, null);
  });

  it('assigns to a chosen folder and accepts a bare sessionId target', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    store.upsertFolder(PK, { id: 'f1', name: 'Inbox', parentId: null, order: 0 });
    await store.flush();

    const ui = makeUi({ picks: [{ folderId: 'f1' }] });
    await assignChatToFolder(makeDeps(store, provider, ui, PK), 'chatString');
    assert.strictEqual(store.getProjectMeta(PK).chats.chatString.folderId, 'f1');
    assert.strictEqual(refreshCount(), 1);
  });

  it('does nothing when the pick is cancelled', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    store.upsertFolder(PK, { id: 'f1', name: 'Inbox', parentId: null, order: 0 });
    store.setChatFolder(PK, 'chatX', 'f1');
    await store.flush();

    const ui = makeUi({ picks: [undefined] });
    await assignChatToFolder(makeDeps(store, provider, ui, PK), chatArg('chatX'));
    assert.strictEqual(store.getProjectMeta(PK).chats.chatX.folderId, 'f1', 'unchanged on cancel');
    assert.strictEqual(refreshCount(), 0);
  });

  it('uses the Unfiled sentinel id constant for the synthetic bucket label', () => {
    // Guard that the model constant the picker keys on stays stable; a drift here
    // would silently break reveal of unfiled chats.
    assert.strictEqual(UNFILED_FOLDER_ID, '__unfiled__');
  });
});

describe('FolderCommandDeps.getProjectKey lazy re-resolution', () => {
  // Regression for the frozen-projectKey bug: a command run when the project dir
  // did NOT exist at activation must pick up the key once getProjectKey starts
  // returning it (the dir appeared and the user clicked Refresh), with no reload.
  it('createFolder recovers once getProjectKey starts returning a key', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();

    // The key is undefined at first (no project dir yet), then resolves.
    let resolved: string | undefined = undefined;
    const deps: FolderCommandDeps = {
      store,
      provider,
      getProjectKey: () => resolved,
      ui: makeUi({ prompts: ['Work'] }),
    };

    // First attempt while unresolved: guarded, no persistence, no refresh.
    const first = await createFolder(deps);
    assert.strictEqual(first, null);
    assert.deepStrictEqual(store.getProjectMeta(PK).folders, {});
    assert.strictEqual(refreshCount(), 0);

    // The project dir appears; getProjectKey now returns it. Re-run with a fresh
    // prompt queue and the SAME deps object (only the closure's captured value
    // changed, exactly as the live provider re-resolves on demand).
    resolved = PK;
    deps.ui = makeUi({ prompts: ['Work'] });
    const second = await createFolder(deps);
    assert.notStrictEqual(second, null, 'create now resolves the project and persists');
    const folders = Object.values(store.getProjectMeta(PK).folders);
    assert.strictEqual(folders.length, 1);
    assert.strictEqual(folders[0].name, 'Work');
    assert.strictEqual(refreshCount(), 1, 'refresh fires only on the successful run');
  });
});
