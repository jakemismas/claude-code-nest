// vscodeStub MUST be imported first so require('vscode') resolves before
// chatsPreviewWebview (and its transitive searchStore -> exportIO) imports it.
import './vscodeStub';

import * as assert from 'assert';
import { ChatRecord, TokenTotals } from '../../model/types';

// Regression test for the refresh-during-async-build race in
// src/views/chatsPreviewWebview.ts (round-2 fix-pass finding). The content index
// builds in two detached phases (tier-A, then a yielding body-read upgrade). A
// 'refresh' message lands invalidateContentIndex() in the middle of the body-read
// window. BEFORE the fix, the in-flight build wrote back AFTER invalidation:
// contentIndex was resurrected to a stale index and bodyIndexReady flipped back to
// true, so a subsequent content query short-circuited on the stale index while the
// fresh build's cleared indexedRecords made rankRows drop every row -> zero rows
// for a query that should match. The fix stamps each build with a generation
// captured at ensureContentIndexBuilding time; the phases only write shared state
// while their captured generation still matches.
//
// We exercise the real provider by intercepting its two module-level data
// dependencies (chatScanner.scanChats, bodyReader.readTranscriptBodies) on the
// cached CommonJS module objects. The compiled provider calls these as
// chatScanner_1.scanChats(...) / bodyReader_1.readTranscriptBodies(...), i.e.
// through the module namespace at call time, so overriding the exports redirects
// them. readTranscriptBodies is gated on a controllable promise so we can pause
// the body-read loop precisely inside the phase-2 window and fire the refresh.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const chatScanner = require('../../claude/chatScanner') as {
  scanChats: (workspacePath: string) => ChatRecord[];
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bodyReader = require('../../claude/bodyReader') as {
  readTranscriptBodies: (filePath: string) => { role: string; text: string | null; uuid: string | null }[];
};

// Load the provider AFTER the stubbed modules are in the cache. Import path matches
// the searchStore tests' style (require from compiled-equivalent source path).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ChatsPreviewProvider } = require('../../views/chatsPreviewWebview') as {
  ChatsPreviewProvider: new (
    extensionUri: unknown,
    workspacePath: string | undefined,
    globalStorageUri?: unknown,
  ) => {
    resolveWebviewView(view: unknown): void;
  };
};

const realScanChats = chatScanner.scanChats;
const realReadBodies = bodyReader.readTranscriptBodies;

// A fake extension Uri for the provider's media-root joins. Matches the shape the
// vscodeStub's Uri.joinPath consumes (fsPath + scheme). The HTML it feeds is
// dropped by the fake webview, so only the join must not throw.
const extUri = { fsPath: '/ext', scheme: 'file' } as const;

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

// A minimal WebviewView double that captures posted messages and the message
// handler the provider registers, so the test can drive 'search' / 'refresh'
// inbound messages and read back the 'searchResults' posts.
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

// Wait until predicate is true or a bounded number of macrotask turns elapse, so a
// test asserts on a settled state without a fixed sleep.
async function until(predicate: () => boolean, turns = 200): Promise<void> {
  for (let i = 0; i < turns; i++) {
    if (predicate()) {
      return;
    }
    await flush();
  }
}

describe('chatsPreviewWebview content-search refresh-during-build race', () => {
  afterEach(() => {
    chatScanner.scanChats = realScanChats;
    bodyReader.readTranscriptBodies = realReadBodies;
  });

  it('a refresh DURING the body-read window leaves the index invalidated (no resurrection, bodyIndexReady stays false)', async () => {
    // Direct-state variant: fire the refresh from INSIDE the stale build's
    // body-read loop, so the stale build's post-loop writeback runs AFTER
    // invalidateContentIndex. The fix must leave the invalidated state intact:
    // contentIndex null and bodyIndexReady false. BEFORE the fix the stale build
    // resurrects contentIndex and flips bodyIndexReady back to true.
    const stale: ChatRecord[] = [
      record({ sessionId: 'a', title: 'alpha chat', lastMessageText: 'alpha body' }),
      record({ sessionId: 'a2', title: 'alpha two', lastMessageText: 'alpha body two', filePath: '/a2.jsonl' }),
    ];

    chatScanner.scanChats = (): ChatRecord[] => stale.map((r) => ({ ...r }));

    const provider = new ChatsPreviewProvider(extUri, '/ws', undefined) as unknown as {
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
        // Refresh lands mid body-read window: invalidate the in-flight build.
        send({ type: 'refresh' });
      }
      return [{ role: 'user', text: 'alpha body', uuid: null }];
    };

    send({ type: 'search', query: 'alpha' });
    await until(() => refreshFired);
    // Let the stale build run all the way to its (now-stale) writebacks.
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
    // Tighter variant: interleave the refresh between the stale build's body reads.
    // The body reader fires the refresh on the FIRST stale-build read, so the stale
    // build finishes and tries to write back AFTER invalidation.
    const stale: ChatRecord[] = [
      record({ sessionId: 'a', title: 'gamma chat', lastMessageText: 'gamma body' }),
      record({ sessionId: 'c', title: 'gamma two', lastMessageText: 'gamma body two', filePath: '/c.jsonl' }),
    ];
    const fresh: ChatRecord[] = [
      record({ sessionId: 'd', title: 'delta chat', lastMessageText: 'delta body', filePath: '/d.jsonl' }),
    ];

    let currentCorpus = stale;
    chatScanner.scanChats = (): ChatRecord[] => currentCorpus.map((r) => ({ ...r }));

    const provider = new ChatsPreviewProvider(extUri, '/ws', undefined);
    const { view, posted, send } = makeView();
    provider.resolveWebviewView(view);

    let refreshFired = false;
    bodyReader.readTranscriptBodies = (): { role: 'user'; text: string; uuid: null }[] => {
      if (!refreshFired) {
        refreshFired = true;
        // Fire the refresh mid body-read window of the stale build.
        currentCorpus = fresh;
        send({ type: 'refresh' });
      }
      return [{ role: 'user', text: 'gamma body', uuid: null }];
    };

    send({ type: 'search', query: 'gamma' });
    await until(() => refreshFired);
    // Let the stale build settle fully (its writebacks would land here if buggy).
    await until(() => false, 20);

    // Now query for "delta": only in the FRESH corpus. If the stale build flipped
    // bodyIndexReady back on and resurrected the stale (gamma-only) index, this
    // returns zero rows.
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
