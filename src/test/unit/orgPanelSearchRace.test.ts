// Import vscodeStub first so require('vscode') resolves before orgPanelWebview loads.
import './vscodeStub';

import * as assert from 'assert';
import { ChatRecord, TokenTotals } from '../../model/types';

// Regression test for a refresh landing during the async content index build in
// src/views/orgPanelWebview.ts. Each build carries a generation, and a stale build
// must not write the index back after invalidation or flip bodyIndexReady.
// The test replaces chatScanner.scanChats and bodyReader.readTranscriptBodies on the cached
// modules (the provider calls them through the namespace) and gates the body read to fire a refresh mid-build.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const chatScanner = require('../../claude/chatScanner') as {
  scanChats: (workspacePath: string) => ChatRecord[];
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bodyReader = require('../../claude/bodyReader') as {
  readTranscriptBodies: (filePath: string) => { role: string; text: string | null; uuid: string | null }[];
};

// Load the provider after the stubbed modules are cached.
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

// Inert deps: search never touches the store, actions or dropDeps, and an undefined project key still scans.
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
// Inert read-state seam: an empty map is enough because these tests assert nothing on read state.
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

// A provider with a real project key and a store returning the given meta, so search can exclude userArchived chats.
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
    view: { webview, visible: true, onDidChangeVisibility: (): { dispose(): void } => ({ dispose: (): void => undefined }), onDidDispose: (): { dispose(): void } => ({ dispose: (): void => undefined }) },
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
      refresh(): void;
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
        provider.refresh();
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

    const provider = makeProvider('/ws') as { resolveWebviewView(view: unknown): void; refresh(): void };
    const { view, posted, send } = makeView();
    provider.resolveWebviewView(view);

    let refreshFired = false;
    bodyReader.readTranscriptBodies = (): { role: 'user'; text: string; uuid: null }[] => {
      if (!refreshFired) {
        refreshFired = true;
        currentCorpus = fresh;
        provider.refresh();
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
    // postSearch must re-check the build generation after awaiting the index. Otherwise a refresh
    // mid-build leaves a stale index that ranks to zero rows and blanks a real match.
    const corpus: ChatRecord[] = [
      record({ sessionId: 'a', title: 'alpha chat', lastMessageText: 'alpha body' }),
      record({ sessionId: 'a2', title: 'alpha two', lastMessageText: 'alpha body two', filePath: '/a2.jsonl' }),
    ];

    chatScanner.scanChats = (): ChatRecord[] => corpus.map((r) => ({ ...r }));

    const provider = makeProvider('/ws') as { resolveWebviewView(view: unknown): void; refresh(): void };
    const { view, posted, send } = makeView();
    provider.resolveWebviewView(view);

    let refreshFired = false;
    bodyReader.readTranscriptBodies = (): { role: 'user'; text: string; uuid: null }[] => {
      if (!refreshFired) {
        refreshFired = true;
        provider.refresh();
      }
      return [{ role: 'user', text: 'alpha body', uuid: null }];
    };

    send({ type: 'search', query: 'alpha' });
    await until(() => refreshFired);
    await until(() => false, 40);

    const alphaPosts = posted.filter((m) => m.type === 'searchResults' && m.query === 'alpha');
    assert.ok(alphaPosts.length > 0, 'a searchResults post for "alpha" was made');
    // No empty post for "alpha" may reach the client after invalidation.
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

  // The index must skip archived chats, as buildSections does. Otherwise they consume slots in the
  // 50-hit cap and crowd out live matches, even when their title and body match.
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

    const provider = makeProviderWithMeta('/ws', meta) as { resolveWebviewView(view: unknown): void; refresh(): void };
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
