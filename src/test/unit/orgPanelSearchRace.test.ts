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

function makeProvider(workspacePath: string): unknown {
  return new OrgPanelProvider(
    extUri,
    workspacePath,
    inertStore,
    () => undefined,
    inertActions,
    inertDropDeps,
    inertStateStore,
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
});
