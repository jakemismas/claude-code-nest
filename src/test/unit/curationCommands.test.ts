// vscodeStub MUST be imported first so require('vscode') resolves before
// archiveProvider's transitive import of vscode (TreeItem/EventEmitter/ThemeIcon)
// runs under the headless runner.
import './vscodeStub';

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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
import { ArchiveProvider, ArchivedChatItem } from '../../views/archiveProvider';

// Headless unit tests for the Slice 4 curation commands and the Archive provider.
// The commands run against a real MetadataStore over the FakeMemento double, with
// the archive-body IO seams stubbed in memory; the provider runs against a scratch
// transcript fixture (NEVER the real ~/.claude files) plus the same store. No
// vscode host beyond the stub.
//
// The highest-value assertion (slice patch "NAMING-COLLISION GUARD"): the provider
// lists chats by the SYNCED ChatMeta.userArchived flag from store.getProjectMeta,
// NOT the local-only LocalChatState.archived (the orphan-reconcile flag). The test
// sets BOTH flags on DIFFERENT chats and proves only the userArchived one surfaces.

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
interface BodyIoSpy {
  written: { sessionId: string; archivedAt: number; starred: boolean; bodies: ChatMessageBody[]; title: string }[];
  deleted: string[];
  starFlags: { sessionId: string; starred: boolean }[];
  writeResult: boolean;
}

function makeDeps(
  store: MetadataStore,
  provider: { refresh(): void },
  projectKey: string | undefined,
  bodyToRead: ChatMessageBody[] = [],
): { deps: CurationCommandDeps; io: BodyIoSpy } {
  const io: BodyIoSpy = { written: [], deleted: [], starFlags: [], writeResult: true };
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
    await restoreChat(deps, target('c1'));
    const chat = store.getProjectMeta(PK).chats.c1;
    assert.strictEqual(chat.userArchived, false, 'archive flag cleared');
    assert.strictEqual('archivedAt' in chat, false, 'archivedAt cleared (coupled to the flag)');
    assert.strictEqual(chat.starred, true, 'star survives a restore (independent)');
    assert.deepStrictEqual(io.deleted, ['c1'], 'the now-redundant body copy is deleted');
    assert.strictEqual(refreshCount(), 1);
  });
});

// ---- The Archive provider, against a scratch transcript fixture. ----

describe('ArchiveProvider lists by SYNCED userArchived, NOT the orphan flag', () => {
  let root: string;
  let workspacePath: string;

  function writeJsonl(dir: string, name: string, objs: unknown[]): void {
    fs.writeFileSync(path.join(dir, name), objs.map((o) => JSON.stringify(o)).join('\n'), 'utf8');
  }

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-archive-'));
    workspacePath = 'c:\\Users\\Tester\\curation';
    const proj = path.join(root, PK);
    fs.mkdirSync(proj, { recursive: true });
    // Three present transcripts.
    for (const id of ['11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000003']) {
      writeJsonl(proj, id + '.jsonl', [
        { type: 'custom-title', customTitle: 'Chat ' + id.slice(0, 8) },
        { type: 'user', timestamp: '2026-06-15T10:00:00.000Z', cwd: 'c:\\Users\\Tester\\curation', message: { content: 'hi' } },
      ]);
    }
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function provider(store: MetadataStore): ArchiveProvider {
    return new ArchiveProvider(workspacePath, store, { projectsRoot: root });
  }

  const C1 = '11111111-0000-0000-0000-000000000001';
  const C2 = '22222222-0000-0000-0000-000000000002';
  const C3 = '33333333-0000-0000-0000-000000000003';

  it('surfaces ONLY chats whose synced userArchived === true', async () => {
    const store = makeStore();
    // C1 is user-archived (synced). C2 has the LOCAL orphan flag set (missing-on-disk
    // machinery), which MUST NOT surface here. C3 is untouched.
    store.setChatArchived(PK, C1, true);
    await store.flush();
    await store.setLocalChatState(PK, C2, { missingSince: NOW, archived: true, tombstone: false });
    await store.flushLocal();

    const rows = provider(store).getChildren();
    const ids = rows.map((r) => r.sessionId);
    assert.deepStrictEqual(ids, [C1], 'only the userArchived chat is listed; the orphan flag is ignored');
    // Sanity: the local orphan flag genuinely IS set on C2 (so the test is honest).
    assert.strictEqual(store.getLocalProjectMeta(PK).chats[C2].archived, true);
  });

  it('an unarchived (userArchived false) chat does not surface', async () => {
    const store = makeStore();
    store.setChatArchived(PK, C1, true);
    store.setChatArchived(PK, C1, false);
    await store.flush();
    const rows = provider(store).getChildren();
    assert.deepStrictEqual(rows.map((r) => r.sessionId), []);
  });

  it('marks a starred archived chat and renders an archived row item shape', async () => {
    const store = makeStore();
    store.setChatStarred(PK, C1, true);
    store.setChatArchived(PK, C1, true);
    store.setChatArchived(PK, C3, true);
    await store.flush();
    const rows = provider(store).getChildren();
    const byId = new Map(rows.map((r) => [r.sessionId, r]));
    assert.ok(byId.has(C1) && byId.has(C3));
    const c1 = byId.get(C1) as ArchivedChatItem;
    // The starred archived chat carries the star icon (exempt-from-prune badge).
    assert.strictEqual((c1.iconPath as { id: string }).id, 'star-full');
    // contextValue gates the archive-row menu (restore/star/unstar).
    assert.strictEqual(c1.contextValue, 'claudeNest.archivedChat');
  });

  it('getChildren(undefined) returns [] and never throws when there is no project', () => {
    const store = makeStore();
    const noProj = new ArchiveProvider(undefined, store, { projectsRoot: root });
    assert.deepStrictEqual(noProj.getChildren(), []);
    // getParent is always undefined (flat view).
    assert.strictEqual(noProj.getParent(), undefined);
  });

  it('a child element yields [] (flat, no nesting)', async () => {
    const store = makeStore();
    store.setChatArchived(PK, C1, true);
    await store.flush();
    const p = provider(store);
    const rows = p.getChildren();
    assert.strictEqual(rows.length, 1);
    assert.deepStrictEqual(p.getChildren(rows[0]), []);
  });
});
