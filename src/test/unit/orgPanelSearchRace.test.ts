// vscodeStub MUST be imported first so require('vscode') resolves before
// orgPanelWebview (and its transitive searchStore -> exportIO) imports it.
import './vscodeStub';

import * as assert from 'assert';
import { ChatRecord, TokenTotals } from '../../model/types';

// Regression test for the refresh-during-async-build race in
// src/views/orgPanelWebview.ts (the content-search machinery the PRIMARY org panel
// carried over from the retired chatsPreview POC). The content index builds in two
// detached phases (tier-A, then a yielding body-read upgrade). A 'refresh' message
// lands invalidateContentIndex() in the middle of the body-read window. WITHOUT the
// generation guard, the in-flight build would write back AFTER invalidation:
// contentIndex resurrected to a stale index and bodyIndexReady flipped back to true,
// so a subsequent content query short-circuits on the stale index while the fresh
// build's cleared indexedRecords makes rankRows drop every row -> zero rows for a
// query that should match. The fix stamps each build with a generation captured at
// ensureContentIndexBuilding time; the phases only write shared state while their
// captured generation still matches.
//
// We exercise the real provider by intercepting its two module-level data
// dependencies (chatScanner.scanChats, bodyReader.readTranscriptBodies) on the
// cached CommonJS module objects. The compiled provider calls these as
// chatScanner_1.scanChats(...) / bodyReader_1.readTranscriptBodies(...), i.e.
// through the module namespace at call time, so overriding the exports redirects
// them. readTranscriptBodies is gated so we can pause the body-read loop precisely
// inside the phase-2 window and fire the refresh.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const chatScanner = require('../../claude/chatScanner') as {
  scanChats: (workspacePath: string) => ChatRecord[];
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bodyReader = require('../../claude/bodyReader') as {
  readTranscriptBodies: (filePath: string) => { role: string; text: string | null; uuid: string | null }[];
};

// Load the provider AFTER the stubbed modules are in the cache.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { OrgPanelProvider } = require('../../views/orgPanelWebview') as {
  OrgPanelProvider: new (
    extensionUri: unknown,
    workspacePath: string | undefined,
    store: unknown,
    getProjectKey: () => string | undefined,
    actions: unknown,
    dropDeps: unknown,
    stateStore: unknown,
    readState: unknown,
    globalStorageUri?: unknown,
  ) => {
    resolveWebviewView(view: unknown): void;
  };
};

const realScanChats = chatScanner.scanChats;
const realReadBodies = bodyReader.readTranscriptBodies;

const extUri = { fsPath: '/ext', scheme: 'file' } as const;

// Inert deps the search path never touches: the store/actions/dropDeps are only
// used on a mutation, not during a search. getProjectKey returns undefined so the
// section build is empty but the content search still scans (search does not gate on
// the project key). The state store returns defaults.
const inertStore = {
  getProjectMeta: (): unknown => ({ folders: {}, tags: {}, chats: {} }),
  flush: (): Promise<void> => Promise.resolve(),
  setChatFolder: (): void => undefined,
  addChatTag: (): void => undefined,
  upsertFolder: (): void => undefined,
  setFolderColor: (): void => undefined,
};
const inertActions = {
  renameFolder: (): void => undefined,
  setFolderColor: (): void => undefined,
};
const inertDropDeps = {
  store: inertStore,
  getProjectKey: (): string | undefined => undefined,
  refresh: (): void => undefined,
};
const inertStateStore = {
  get: (): string | undefined => undefined,
  set: (): void => undefined,
};
// Inert read-state seam (OrgPanelReadState). getMap feeds the pure buildSections
// during postSections; markSeen is a no-op. The search-race path never asserts on
// read state, so an empty map is enough.
const inertReadState = {
  getMap: (): Map<string, number> => new Map(),
  markSeen: (): void => undefined,
  seedIfFirstRun: (): boolean => false,
};

function makeProvider(workspacePath: string): unknown {
  return new OrgPanelProvider(
    extUri,
    workspacePath,
    inertStore,
    () => undefined,
    inertActions,
    inertDropDeps,
    inertStateStore,
    inertReadState,
    undefined,
  );
}

// A provider variant with a real project key and a store whose getProjectMeta
// returns the given meta, so the content-search path can resolve the SYNCED
// ChatMeta.userArchived flag and exclude archived chats from the index (the
// archived-in-index regression test below). Everything else is the inert wiring.
function makeProviderWithMeta(workspacePath: string, meta: unknown): unknown {
  const store = { ...inertStore, getProjectMeta: (): unknown => meta };
  return new OrgPanelProvider(
    extUri,
    workspacePath,
    store,
    () => 'pk',
    inertActions,
    inertDropDeps,
    inertStateStore,
    inertReadState,
    undefined,
  );
}

function totals(): TokenTotals {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
}

function record(over: Partial<ChatRecord>): ChatRecord {
  return {
    sessionId: 's',
    title: '',
    timestamp: 1,
    filePath: '/x.jsonl',
    prNumber: null,
    prUrl: null,
    prRepository: null,
    gitBranch: null,
    leadingMessageUuids: [],
    messageCount: 0,
    firstMessageText: null,
    firstMessageRole: null,
    lastMessageText: null,
    lastMessageRole: null,
    tokenTotals: totals(),
    filesTouched: [],
    models: [],
    ...over,
  };
}

interface PostedMessage {
  type: string;
  query?: string;
  rows?: { sessionId: string }[];
}

function makeView(): {
  view: unknown;
  posted: PostedMessage[];
  send: (msg: unknown) => void;
} {
  const posted: PostedMessage[] = [];
  let handler: ((raw: unknown) => void) | undefined;
  const webview = {
    options: {},
    cspSource: 'vscode-resource:',
    asWebviewUri: (u: unknown): unknown => u,
    html: '',
    onDidReceiveMessage: (cb: (raw: unknown) => void): { dispose(): void } => {
      handler = cb;
      return { dispose: (): void => undefined };
    },
    postMessage: (msg: unknown): Thenable<boolean> => {
      posted.push(msg as PostedMessage);
      return Promise.resolve(true);
    },
  };
  return {
    view: { webview },
    posted,
    send: (msg: unknown): void => {
      if (handler === undefined) {
        throw new Error('message handler not registered');
      }
      handler(msg);
    },
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function until(predicate: () => boolean, turns = 200): Promise<void> {
  for (let i = 0; i < turns; i++) {
    if (predicate()) {
      return;
    }
    await flush();
  }
}

describe('orgPanelWebview content-search refresh-during-build race', () => {
  afterEach(() => {
    chatScanner.scanChats = realScanChats;
    bodyReader.readTranscriptBodies = realReadBodies;
  });

  it('a refresh DURING the body-read window leaves the index invalidated (no resurrection, bodyIndexReady stays false)', async () => {
    const stale: ChatRecord[] = [
      record({ sessionId: 'a', title: 'alpha chat', lastMessageText: 'alpha body' }),
      record({ sessionId: 'a2', title: 'alpha two', lastMessageText: 'alpha body two', filePath: '/a2.jsonl' }),
    ];

    chatScanner.scanChats = (): ChatRecord[] => stale.map((r) => ({ ...r }));

    const provider = makeProvider('/ws') as {
      resolveWebviewView(view: unknown): void;
      contentIndex: unknown;
      bodyIndexReady: boolean;
      indexedRecords: Map<string, unknown>;
    };
    const { view, send } = makeView();
    provider.resolveWebviewView(view);

    let refreshFired = false;
    bodyReader.readTranscriptBodies = (): { role: 'user'; text: string; uuid: null }[] => {
      if (!refreshFired) {
        refreshFired = true;
        send({ type: 'refresh' });
      }
      return [{ role: 'user', text: 'alpha body', uuid: null }];
    };

    send({ type: 'search', query: 'alpha' });
    await until(() => refreshFired);
    await until(() => false, 40);

    assert.strictEqual(
      provider.bodyIndexReady,
      false,
      'a stale build must NOT flip bodyIndexReady back to true after a refresh invalidated it',
    );
    assert.strictEqual(
      provider.contentIndex,
      null,
      'a stale build must NOT resurrect contentIndex after a refresh cleared it',
    );
    assert.strictEqual(
      provider.indexedRecords.size,
      0,
      'a stale scan must NOT repopulate indexedRecords after a refresh cleared it',
    );
  });

  it('a stale tier-A writeback after refresh does not flip bodyIndexReady or blank a fresh query', async () => {
    const stale: ChatRecord[] = [
      record({ sessionId: 'a', title: 'gamma chat', lastMessageText: 'gamma body' }),
      record({ sessionId: 'c', title: 'gamma two', lastMessageText: 'gamma body two', filePath: '/c.jsonl' }),
    ];
    const fresh: ChatRecord[] = [
      record({ sessionId: 'd', title: 'delta chat', lastMessageText: 'delta body', filePath: '/d.jsonl' }),
    ];

    let currentCorpus = stale;
    chatScanner.scanChats = (): ChatRecord[] => currentCorpus.map((r) => ({ ...r }));

    const provider = makeProvider('/ws') as { resolveWebviewView(view: unknown): void };
    const { view, posted, send } = makeView();
    provider.resolveWebviewView(view);

    let refreshFired = false;
    bodyReader.readTranscriptBodies = (): { role: 'user'; text: string; uuid: null }[] => {
      if (!refreshFired) {
        refreshFired = true;
        currentCorpus = fresh;
        send({ type: 'refresh' });
      }
      return [{ role: 'user', text: 'gamma body', uuid: null }];
    };

    send({ type: 'search', query: 'gamma' });
    await until(() => refreshFired);
    await until(() => false, 20);

    posted.length = 0;
    send({ type: 'search', query: 'delta' });
    await until(
      () => posted.filter((m) => m.type === 'searchResults' && m.query === 'delta').length > 0,
    );
    await until(() => false, 30);

    const deltaPosts = posted.filter((m) => m.type === 'searchResults' && m.query === 'delta');
    assert.ok(deltaPosts.length > 0, 'a searchResults post for "delta" was made');
    const last = deltaPosts[deltaPosts.length - 1];
    assert.ok(
      (last.rows ?? []).some((r) => r.sessionId === 'd'),
      'the fresh build returns the "delta" chat (d) after a refresh interrupted the stale build',
    );
  });

  it('a refresh during the body-read window does NOT post an empty result for the query still in the box', async () => {
    // The finding: postSearch awaits tierAReady/bodyReady but, unlike the build
    // phases, did not re-check the build generation after the await. When a refresh
    // fires inside the body-read window it invalidates the index (clears
    // indexedRecords, nulls contentIndex, bumps buildGeneration); the awaited stale
    // index then ranks to zero rows and postSearch posted { rows: [] } for the SAME
    // query still in the search box, blanking a genuine match with no recovery. The
    // generation guard must SKIP that stale empty post: the last searchResults post
    // for the query must still carry the real hit (the pre-refresh tier-A reply),
    // never a later empty one.
    const corpus: ChatRecord[] = [
      record({ sessionId: 'a', title: 'alpha chat', lastMessageText: 'alpha body' }),
      record({ sessionId: 'a2', title: 'alpha two', lastMessageText: 'alpha body two', filePath: '/a2.jsonl' }),
    ];

    chatScanner.scanChats = (): ChatRecord[] => corpus.map((r) => ({ ...r }));

    const provider = makeProvider('/ws') as { resolveWebviewView(view: unknown): void };
    const { view, posted, send } = makeView();
    provider.resolveWebviewView(view);

    let refreshFired = false;
    bodyReader.readTranscriptBodies = (): { role: 'user'; text: string; uuid: null }[] => {
      if (!refreshFired) {
        refreshFired = true;
        send({ type: 'refresh' });
      }
      return [{ role: 'user', text: 'alpha body', uuid: null }];
    };

    send({ type: 'search', query: 'alpha' });
    await until(() => refreshFired);
    await until(() => false, 40);

    const alphaPosts = posted.filter((m) => m.type === 'searchResults' && m.query === 'alpha');
    assert.ok(alphaPosts.length > 0, 'a searchResults post for "alpha" was made');
    // Every post for the in-box query must be non-empty. The stale body-phase reply
    // that would post [] after invalidation must be suppressed by the generation
    // guard, so no empty post for "alpha" ever reaches the client.
    for (const p of alphaPosts) {
      assert.ok(
        (p.rows ?? []).some((r) => r.sessionId === 'a'),
        'no searchResults post for the in-box query "alpha" may be blanked by a stale post-refresh reply',
      );
    }
  });
});

describe('orgPanelWebview content-search excludes user-archived chats from the index', () => {
  afterEach(() => {
    chatScanner.scanChats = realScanChats;
    bodyReader.readTranscriptBodies = realReadBodies;
  });

  // The finding: the host search index had NO archived filter, while buildSections
  // excludes archived chats. archived chats got indexed (title + full body) and
  // ranked, then the client dropped their hits when it joined to the
  // archived-excluded rows, so archived chats consumed rank slots inside search()'s
  // 50-hit cap and could crowd genuine live matches out. The fix filters archived
  // chats out of scanForIndex (the sole index feeder) by the SAME synced
  // ChatMeta.userArchived predicate buildSections uses. An archived chat must never
  // enter indexedRecords and must never appear in a searchResults post, even when its
  // title AND body match the query.
  function archivedCorpusMeta(): { corpus: ChatRecord[]; meta: unknown } {
    const corpus: ChatRecord[] = [
      record({ sessionId: 'live', title: 'zebra live chat', lastMessageText: 'zebra body live', filePath: '/live.jsonl' }),
      record({ sessionId: 'arc', title: 'zebra archived chat', lastMessageText: 'zebra body archived', filePath: '/arc.jsonl' }),
    ];
    const meta = {
      schemaVersion: 3,
      folders: {},
      tags: {},
      chats: {
        live: { folderId: null, tags: [], links: [], updatedAt: 0, deviceId: 'd' },
        arc: { folderId: null, tags: [], links: [], updatedAt: 0, deviceId: 'd', userArchived: true },
      },
      updatedAt: 0,
      deviceId: 'd',
    };
    return { corpus, meta };
  }

  it('an archived chat never enters indexedRecords', async () => {
    const { corpus, meta } = archivedCorpusMeta();
    chatScanner.scanChats = (): ChatRecord[] => corpus.map((r) => ({ ...r }));
    bodyReader.readTranscriptBodies = (): { role: 'user'; text: string; uuid: null }[] => [
      { role: 'user', text: 'zebra body', uuid: null },
    ];

    const provider = makeProviderWithMeta('/ws', meta) as {
      resolveWebviewView(view: unknown): void;
      indexedRecords: Map<string, unknown>;
    };
    const { view, send } = makeView();
    provider.resolveWebviewView(view);

    send({ type: 'search', query: 'zebra' });
    await until(() => provider.indexedRecords.size > 0);
    await until(() => false, 30);

    assert.strictEqual(provider.indexedRecords.has('live'), true, 'the live chat is indexed');
    assert.strictEqual(
      provider.indexedRecords.has('arc'),
      false,
      'the archived chat must NOT be indexed (excluded by the synced userArchived flag)',
    );
  });

  it('a matching archived chat never appears in any searchResults post', async () => {
    const { corpus, meta } = archivedCorpusMeta();
    chatScanner.scanChats = (): ChatRecord[] => corpus.map((r) => ({ ...r }));
    bodyReader.readTranscriptBodies = (): { role: 'user'; text: string; uuid: null }[] => [
      { role: 'user', text: 'zebra body', uuid: null },
    ];

    const provider = makeProviderWithMeta('/ws', meta) as { resolveWebviewView(view: unknown): void };
    const { view, posted, send } = makeView();
    provider.resolveWebviewView(view);

    send({ type: 'search', query: 'zebra' });
    await until(
      () => posted.filter((m) => m.type === 'searchResults' && m.query === 'zebra').length > 0,
    );
    await until(() => false, 30);

    const zebraPosts = posted.filter((m) => m.type === 'searchResults' && m.query === 'zebra');
    assert.ok(zebraPosts.length > 0, 'a searchResults post for "zebra" was made');
    for (const p of zebraPosts) {
      const ids = (p.rows ?? []).map((r) => r.sessionId);
      assert.ok(ids.includes('live'), 'the live match is present');
      assert.ok(
        !ids.includes('arc'),
        'the archived chat must NEVER appear in a searchResults post, even though its title and body match',
      );
    }
  });
});
