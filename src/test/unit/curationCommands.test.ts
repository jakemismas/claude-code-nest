// vscodeStub MUST be imported first so require('vscode') resolves before
// archiveProvider's transitive import of vscode (TreeItem/EventEmitter/ThemeIcon)
// runs under the headless runner.
import './vscodeStub';

import * as assert from 'assert';
import { MetadataStore } from '../../store/metadataStore';
import { FakeMemento } from './fakeMemento';
import { ChatMessageBody } from '../../claude/bodyReader';
import {
  CurationCommandDeps,
  CurationTarget,
  starChat,
  unstarChat,
  archiveChat,
  restoreChat,
} from '../../commands/curationCommands';
import {
  previewArchivedBody,
  PreviewArchivedChatDeps,
} from '../../commands/previewChatCommand';
import { writeArchivedBody, readArchivedBody } from '../../store/archiveBodyStore';

// Headless unit tests for the Slice 4 curation commands and the archived-copy read path.
// The commands run against a real MetadataStore over the FakeMemento double, with the
// archive-body IO seams stubbed in memory. The archived-row membership + sort + fallback-
// title logic that once lived on the Archive tree provider moved to the pure
// buildArchivedRows (issue #87), tested in orgPanelModel.test.ts; the SYNCED-userArchived-
// only membership rule (never the local orphan flag) is asserted there. What remains here
// is the cleanup-survival read path: the Nest-owned body copy is still readable after the
// transcript is gone. No vscode host beyond the stub.

const DEVICE = 'dev-curation';
const PK = 'c--Users-Tester-curation';
const NOW = 1_700_000_000_000;

function makeStore(): MetadataStore {
  return new MetadataStore(new FakeMemento(), { deviceId: DEVICE, debounceMs: 0, now: () => NOW });
}

function makeProvider(): { provider: { refresh(): void }; refreshCount: () => number } {
  let refreshes = 0;
  return {
    provider: { refresh: () => { refreshes++; } },
    refreshCount: () => refreshes,
  };
}

// An in-memory archive-body IO double recording what the commands wrote/deleted.
// transcriptPresent controls the read-only transcript-existence seam restore gates
// its body-copy delete on; it defaults to true (the live transcript is present, the
// historical behavior) and a test flips it false to model the copy-only row.
interface BodyIoSpy {
  written: { sessionId: string; archivedAt: number; starred: boolean; bodies: ChatMessageBody[]; title: string }[];
  deleted: string[];
  starFlags: { sessionId: string; starred: boolean }[];
  writeResult: boolean;
  transcriptPresent: boolean;
  existenceChecks: string[];
}

function makeDeps(
  store: MetadataStore,
  provider: { refresh(): void },
  projectKey: string | undefined,
  bodyToRead: ChatMessageBody[] = [],
): { deps: CurationCommandDeps; io: BodyIoSpy } {
  const io: BodyIoSpy = {
    written: [],
    deleted: [],
    starFlags: [],
    writeResult: true,
    transcriptPresent: true,
    existenceChecks: [],
  };
  const deps: CurationCommandDeps = {
    store,
    provider,
    getProjectKey: () => projectKey,
    readBody: () => bodyToRead,
    writeBody: (env) => {
      io.written.push(env);
      return Promise.resolve(io.writeResult);
    },
    deleteBody: (sessionId) => {
      io.deleted.push(sessionId);
      return Promise.resolve();
    },
    transcriptExists: (filePath) => {
      io.existenceChecks.push(filePath);
      return io.transcriptPresent;
    },
    updateBodyStarFlag: (sessionId, starred) => {
      io.starFlags.push({ sessionId, starred });
      return Promise.resolve();
    },
    now: () => NOW,
  };
  return { deps, io };
}

const target = (sessionId: string): CurationTarget => ({
  sessionId,
  filePath: '/x/' + sessionId + '.jsonl',
  title: 'Title ' + sessionId,
});

describe('curationCommands.starChat / unstarChat', () => {
  it('writes the SYNCED starred flag, independent of archive, and refreshes once', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    const { deps, io } = makeDeps(store, provider, PK);

    await starChat(deps, target('c1'));
    assert.strictEqual(store.getProjectMeta(PK).chats.c1.starred, true);
    // Archive untouched.
    assert.strictEqual('userArchived' in store.getProjectMeta(PK).chats.c1, false);
    assert.strictEqual(refreshCount(), 1);
    // Body-copy star flag kept current (no-op when no copy, but the seam fires).
    assert.deepStrictEqual(io.starFlags, [{ sessionId: 'c1', starred: true }]);

    await unstarChat(deps, target('c1'));
    assert.strictEqual(store.getProjectMeta(PK).chats.c1.starred, false);
    assert.strictEqual(refreshCount(), 2);
  });

  it('guards with no project resolved (no write, no refresh)', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    const { deps } = makeDeps(store, provider, undefined);
    await starChat(deps, target('c1'));
    assert.deepStrictEqual(store.getProjectMeta(PK).chats, {});
    assert.strictEqual(refreshCount(), 0);
  });
});

describe('curationCommands.archiveChat', () => {
  it('flips userArchived (with archivedAt) and writes a Nest-owned body copy with matching archivedAt', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    const fixtureBody: ChatMessageBody[] = [{ role: 'user', text: 'hi', uuid: 'u1' }];
    const { deps, io } = makeDeps(store, provider, PK, fixtureBody);

    await archiveChat(deps, target('c1'));
    const chat = store.getProjectMeta(PK).chats.c1;
    assert.strictEqual(chat.userArchived, true);
    assert.strictEqual(chat.archivedAt, NOW, 'store stamps archivedAt coupled to the flag');
    // Exactly one body copy written, with the SAME archivedAt the store stamped.
    assert.strictEqual(io.written.length, 1);
    assert.strictEqual(io.written[0].sessionId, 'c1');
    assert.strictEqual(io.written[0].archivedAt, NOW, 'copy archivedAt matches the synced flag');
    assert.deepStrictEqual(io.written[0].bodies, fixtureBody);
    assert.strictEqual(refreshCount(), 1);
  });

  it('still archives (flag set) when the body copy write fails (best-effort durability)', async () => {
    const store = makeStore();
    const { provider } = makeProvider();
    const { deps, io } = makeDeps(store, provider, PK);
    io.writeResult = false;
    await archiveChat(deps, target('c1'));
    // The flag flip is authoritative and survives a failed copy.
    assert.strictEqual(store.getProjectMeta(PK).chats.c1.userArchived, true);
  });

  it('carries the starred exemption onto the body copy when the chat is already starred', async () => {
    const store = makeStore();
    const { provider } = makeProvider();
    store.setChatStarred(PK, 'c1', true);
    await store.flush();
    const { deps, io } = makeDeps(store, provider, PK);
    await archiveChat(deps, target('c1'));
    assert.strictEqual(io.written[0].starred, true, 'copy records the star so prune exempts it');
  });
});

describe('curationCommands.restoreChat', () => {
  it('clears userArchived AND archivedAt (coupled), keeps starred, deletes the copy', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    // Seed an archived, starred chat.
    store.setChatStarred(PK, 'c1', true);
    store.setChatArchived(PK, 'c1', true);
    await store.flush();
    assert.strictEqual(store.getProjectMeta(PK).chats.c1.archivedAt, NOW);

    const { deps, io } = makeDeps(store, provider, PK);
    // The live transcript is present (default), so the redundant copy may be deleted.
    await restoreChat(deps, target('c1'));
    const chat = store.getProjectMeta(PK).chats.c1;
    assert.strictEqual(chat.userArchived, false, 'archive flag cleared');
    assert.strictEqual('archivedAt' in chat, false, 'archivedAt cleared (coupled to the flag)');
    assert.strictEqual(chat.starred, true, 'star survives a restore (independent)');
    assert.deepStrictEqual(io.deleted, ['c1'], 'the now-redundant body copy is deleted');
    assert.strictEqual(refreshCount(), 1);
  });

  // DATA-LOSS GUARD: restore is reachable on a copy-only archived row (a userArchived
  // chat whose transcript Claude cleaned up out of band; curationTargetFrom yields an
  // EMPTY filePath for it). The body copy is then the sole surviving form, so restore
  // must NOT delete it. An empty filePath is treated as absent with NO filesystem
  // touch.
  it('a COPY-ONLY restore (empty filePath, transcript gone) KEEPS the body copy', async () => {
    const store = makeStore();
    const { provider, refreshCount } = makeProvider();
    store.setChatArchived(PK, 'gone', true);
    await store.flush();

    const { deps, io } = makeDeps(store, provider, PK);
    io.transcriptPresent = false; // immaterial: empty filePath short-circuits the check
    const copyOnlyTarget: CurationTarget = { sessionId: 'gone', filePath: '', title: 'gone' };
    await restoreChat(deps, copyOnlyTarget);

    const chat = store.getProjectMeta(PK).chats.gone;
    assert.strictEqual(chat.userArchived, false, 'archive flag still cleared');
    assert.deepStrictEqual(io.deleted, [], 'the SOLE surviving copy is NOT deleted');
    assert.deepStrictEqual(io.existenceChecks, [], 'an empty filePath short-circuits with no fs touch');
    assert.strictEqual(refreshCount(), 1);
  });

  // The transcript can vanish out of band between the scan and the restore click, so a
  // present-looking row (non-empty filePath) must still re-check existence and KEEP
  // the copy when the file is actually gone.
  it('a row with a filePath whose transcript is GONE keeps the copy (existence re-checked)', async () => {
    const store = makeStore();
    const { provider } = makeProvider();
    store.setChatArchived(PK, 'c1', true);
    await store.flush();

    const { deps, io } = makeDeps(store, provider, PK);
    io.transcriptPresent = false;
    await restoreChat(deps, target('c1'));

    assert.deepStrictEqual(io.existenceChecks, ['/x/c1.jsonl'], 'existence was re-checked for a non-empty filePath');
    assert.deepStrictEqual(io.deleted, [], 'copy kept because the transcript is actually gone');
    assert.strictEqual(store.getProjectMeta(PK).chats.c1.userArchived, false);
  });
});

// ---- The archived-copy READ path (survives the Archive-tree retirement, issue #87).
// The Archive tree provider is retired; its membership + sort + fallback-title logic moved
// to the pure buildArchivedRows (covered in orgPanelModel.test.ts). What still lives here is
// the cleanup-survival read: once Claude deletes the live transcript, the Nest-owned body
// copy must still be readable via previewArchivedBody, the command the Archive overlay row
// and the palette both call.

describe('archived-copy read path survives transcript cleanup', () => {
  it('end to end: a saved copy is readable AFTER the transcript is gone', async () => {
    const STORAGE = '/storage/global-e2e';
    const GONE = '99999999-0000-0000-0000-000000000099';
    const savedBodies: ChatMessageBody[] = [
      { role: 'user', text: 'this is the only surviving copy', uuid: 'u1' },
      { role: 'assistant', text: 'and it must still read', uuid: 'u2' },
    ];
    const storageUri = { fsPath: STORAGE, scheme: 'file' } as never;
    // The archive command wrote a Nest-owned copy while the transcript existed.
    const wrote = await writeArchivedBody(storageUri, {
      sessionId: GONE,
      title: 'Cleaned Up Chat',
      archivedAt: NOW,
      starred: false,
      bodies: savedBodies,
    });
    assert.strictEqual(wrote, true);

    // The transcript is now gone (we never seed it). The preview-archived command
    // reads ONLY the copy by sessionId, wired exactly as extension.ts wires it.
    let opened: string | null = null;
    const deps: PreviewArchivedChatDeps = {
      readArchivedBody: (sessionId: string) => readArchivedBody(storageUri, sessionId),
      openPreview: (content: string) => {
        opened = content;
      },
      showInfo: () => assert.fail('a saved copy exists; the empty notice must not fire'),
    };
    await previewArchivedBody(deps, GONE);
    assert.ok(opened !== null, 'the archived copy opened with no live transcript present');
    const text = opened as unknown as string;
    assert.ok(text.includes('Cleaned Up Chat'), 'the stored title renders');
    assert.ok(text.includes('this is the only surviving copy'), 'the saved bodies render');
    assert.ok(text.includes('and it must still read'), 'every saved turn renders');
  });
});
