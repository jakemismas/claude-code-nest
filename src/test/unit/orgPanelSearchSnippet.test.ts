// vscodeStub MUST be imported first so require('vscode') resolves before
// orgPanelWebview (and its transitive searchStore -> exportIO) imports it.
import './vscodeStub';

import * as assert from 'assert';
import { ChatRecord, TokenTotals } from '../../model/types';
import { ROLE_LABEL_USER, ROLE_LABEL_ASSISTANT } from '../../search/searchIndex';

// Behavior tests for the host content-search reply the PRIMARY org panel posts
// (src/views/orgPanelWebview.ts rankRows / postSearchResults), driving the REAL
// provider through its message handler exactly as the search-race regression test
// does. Two things this slice added are pinned here (issue #83):
//
//   - AC #1 snippet gating: a TITLE match sends snippet:null (no snippet row); a
//     BODY-only match sends a role-prefixed snippet ("You: " / "Claude: ").
//   - The body feed threads role INTO the snippet source, so the emitted body-match
//     snippet begins with the matched line's role label.
//
// It intercepts the two module-level data deps (chatScanner.scanChats,
// bodyReader.readTranscriptBodies) on the cached CommonJS module objects, the same
// technique the race test uses (the compiled provider calls them through the module
// namespace at call time).

// eslint-disable-next-line @typescript-eslint/no-var-requires
const chatScanner = require('../../claude/chatScanner') as {
  scanChats: (workspacePath: string) => ChatRecord[];
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bodyReader = require('../../claude/bodyReader') as {
  readTranscriptBodies: (
    filePath: string,
  ) => { role: 'user' | 'assistant'; text: string | null; uuid: string | null }[];
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { OrgPanelProvider } = require('../../views/orgPanelWebview') as {
  OrgPanelProvider: new (...args: unknown[]) => { resolveWebviewView(view: unknown): void };
};

const realScanChats = chatScanner.scanChats;
const realReadBodies = bodyReader.readTranscriptBodies;

const extUri = { fsPath: '/ext', scheme: 'file' } as const;

const inertStore = {
  getProjectMeta: (): unknown => ({ folders: {}, tags: {}, chats: {} }),
  flush: (): Promise<void> => Promise.resolve(),
};
const inertActions = {};
const inertDropDeps = {
  store: inertStore,
  getProjectKey: (): string | undefined => undefined,
  refresh: (): void => undefined,
};
const inertStateStore = { get: (): string | undefined => undefined, set: (): void => undefined };
const inertReadState = {
  getMap: (): Map<string, number> => new Map(),
  markSeen: (): void => undefined,
  seedIfFirstRun: (): boolean => false,
};

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

interface Row {
  sessionId: string;
  title: string;
  snippet: string | null;
}
interface Posted {
  type: string;
  query?: string;
  rows?: Row[];
}

function makeView(): { view: unknown; posted: Posted[]; send: (msg: unknown) => void } {
  const posted: Posted[] = [];
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
      posted.push(msg as Posted);
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

function makeProvider(workspacePath: string): { resolveWebviewView(view: unknown): void } {
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

describe('orgPanelWebview content-search snippet gating (issue #83 AC #1)', () => {
  afterEach(() => {
    chatScanner.scanChats = realScanChats;
    bodyReader.readTranscriptBodies = realReadBodies;
  });

  async function runQuery(
    corpus: ChatRecord[],
    bodiesByPath: Record<string, { role: 'user' | 'assistant'; text: string; uuid: null }[]>,
    query: string,
  ): Promise<Row[]> {
    chatScanner.scanChats = (): ChatRecord[] => corpus.map((r) => ({ ...r }));
    bodyReader.readTranscriptBodies = (
      filePath: string,
    ): { role: 'user' | 'assistant'; text: string; uuid: null }[] => bodiesByPath[filePath] ?? [];

    const provider = makeProvider('/ws');
    const { view, posted, send } = makeView();
    provider.resolveWebviewView(view);
    send({ type: 'search', query });
    // Let the two-phase build settle so the body-indexed reply (the final post) lands.
    await until(
      () => posted.filter((m) => m.type === 'searchResults' && m.query === query).length > 0,
    );
    await until(() => false, 40);
    const replies = posted.filter((m) => m.type === 'searchResults' && m.query === query);
    return (replies[replies.length - 1].rows ?? []) as Row[];
  }

  it('a TITLE match sends snippet=null (no snippet row under a title hit)', async () => {
    const corpus = [
      record({ sessionId: 'a', title: 'Redis rate limiter', lastMessageText: 'done', filePath: '/a.jsonl' }),
    ];
    const bodies = {
      '/a.jsonl': [
        { role: 'user' as const, text: 'we discussed a rate limiter backed by redis', uuid: null },
      ],
    };
    const rows = await runQuery(corpus, bodies, 'redis');
    const a = rows.find((r) => r.sessionId === 'a');
    assert.ok(a, 'the chat is a hit (its title contains the query)');
    assert.strictEqual(a!.snippet, null, 'a title match carries no snippet');
  });

  it('a BODY-only match sends a role-prefixed snippet ("You: " / "Claude: ")', async () => {
    const corpus = [
      record({ sessionId: 'b', title: 'Rate limiter design', lastMessageText: 'done', filePath: '/b.jsonl' }),
    ];
    const bodies = {
      '/b.jsonl': [
        { role: 'user' as const, text: 'I want a token-bucket limiter backed by redis for the api', uuid: null },
        { role: 'assistant' as const, text: 'a sliding window is simpler here', uuid: null },
      ],
    };
    const rows = await runQuery(corpus, bodies, 'redis');
    const b = rows.find((r) => r.sessionId === 'b');
    assert.ok(b, 'the chat is a hit (its body contains the query, its title does not)');
    assert.ok(typeof b!.snippet === 'string' && b!.snippet!.length > 0, 'a body-only match has a snippet');
    assert.ok(
      b!.snippet!.startsWith(ROLE_LABEL_USER) || b!.snippet!.startsWith(ROLE_LABEL_ASSISTANT),
      'the body snippet is role-prefixed: ' + b!.snippet,
    );
    // The matched line is the USER line ("...redis..."), so the label is "You: ".
    assert.ok(b!.snippet!.startsWith(ROLE_LABEL_USER), 'the matched line role is You: ' + b!.snippet);
    assert.ok(b!.snippet!.toLowerCase().includes('redis'), 'the matched term rides the snippet');
  });
});
