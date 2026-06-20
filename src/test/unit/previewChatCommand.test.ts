import * as assert from 'assert';
import { ChatRecord, TokenTotals } from '../../model/types';
import { ChatMessageBody } from '../../claude/bodyReader';
import {
  formatBodyPreview,
  formatArchivedPreview,
  previewChatBody,
  previewArchivedBody,
  PreviewChatDeps,
  PreviewArchivedChatDeps,
} from '../../commands/previewChatCommand';
import type { ArchivedBodyEnvelope } from '../../store/archiveBodyStore';

// Headless unit tests for the "Preview Full Chat" command (slice 1): the on-demand
// single-chat body reader's production caller. No vscode import and no filesystem:
// the body read and the document open are injected seams, so the orchestrator and
// the pure formatter are exercised against in-memory doubles.

function tokens(partial: Partial<TokenTotals> = {}): TokenTotals {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, ...partial };
}

function record(partial: Partial<ChatRecord> = {}): ChatRecord {
  return {
    sessionId: 'sess-1',
    title: 'A chat title',
    timestamp: Date.now(),
    filePath: '/x/sess-1.jsonl',
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
    tokenTotals: tokens(),
    filesTouched: [],
    models: [],
    ...partial,
  };
}

function body(role: 'user' | 'assistant', text: string | null): ChatMessageBody {
  return { role, text, uuid: null };
}

describe('previewChatCommand: formatBodyPreview', () => {
  it('renders a header plus each labelled turn in order', () => {
    const rec = record({ title: 'My Chat', sessionId: 'abc' });
    const out = formatBodyPreview(rec, [
      body('user', 'hello there'),
      body('assistant', 'hi, how can I help'),
    ]);
    assert.ok(out.includes('My Chat'), 'title in header');
    assert.ok(out.includes('Session: abc'), 'session id in header');
    assert.ok(out.includes('2 messages'), 'message count in header');
    assert.ok(out.includes('You:'), 'user role label');
    assert.ok(out.includes('hello there'), 'user text');
    assert.ok(out.includes('Claude:'), 'assistant role label');
    assert.ok(out.includes('hi, how can I help'), 'assistant text');
    // Order: the user turn precedes the assistant turn.
    assert.ok(out.indexOf('hello there') < out.indexOf('hi, how can I help'), 'transcript order preserved');
  });

  it('renders a placeholder for a textless turn rather than dropping it', () => {
    const out = formatBodyPreview(record(), [
      body('assistant', null),
      body('user', 'a real prompt'),
    ]);
    assert.ok(out.includes('(no text in this turn)'), 'textless turn shown as a placeholder');
    assert.ok(out.includes('a real prompt'), 'prose turn shown');
  });

  it('singularizes the message count for a one-message chat', () => {
    const out = formatBodyPreview(record(), [body('user', 'only')]);
    assert.ok(out.includes('1 message'), 'singular count');
    assert.ok(!out.includes('1 messages'), 'not pluralized');
  });
});

describe('previewChatCommand: previewChatBody orchestration', () => {
  it('reads the chat body on demand via the injected reader and opens the preview', async () => {
    const reads: string[] = [];
    let opened: string | null = null;
    const deps: PreviewChatDeps = {
      readBodies: (filePath: string) => {
        reads.push(filePath);
        return [body('user', 'first'), body('assistant', 'second')];
      },
      openPreview: (content: string) => {
        opened = content;
      },
      showInfo: () => assert.fail('should not show the empty notice when bodies exist'),
    };
    await previewChatBody(deps, record({ filePath: '/path/to/chat.jsonl', title: 'T' }));
    assert.deepStrictEqual(reads, ['/path/to/chat.jsonl'], 'read exactly the one chat file on demand');
    assert.ok(opened !== null, 'a preview was opened');
    assert.ok((opened as unknown as string).includes('first'), 'opened content carries the body');
  });

  it('shows an info notice and opens nothing when the chat has no readable body', async () => {
    let opened = false;
    let info: string | null = null;
    const deps: PreviewChatDeps = {
      readBodies: () => [],
      openPreview: () => {
        opened = true;
      },
      showInfo: (message: string) => {
        info = message;
      },
    };
    await previewChatBody(deps, record({ title: 'Empty Chat' }));
    assert.strictEqual(opened, false, 'no empty document opened');
    assert.ok(info !== null, 'an info notice was shown');
    assert.ok((info as unknown as string).includes('Empty Chat'), 'notice names the chat');
  });
});

function envelope(partial: Partial<ArchivedBodyEnvelope> = {}): ArchivedBodyEnvelope {
  return {
    version: 1,
    sessionId: 'arch-1',
    title: 'Archived Chat',
    archivedAt: Date.now(),
    starred: false,
    bodies: [body('user', 'saved question'), body('assistant', 'saved answer')],
    ...partial,
  };
}

describe('previewChatCommand: formatArchivedPreview', () => {
  it('renders the archived envelope identically to the live formatter', () => {
    const env = envelope({ title: 'My Chat', sessionId: 'abc' });
    const out = formatArchivedPreview(env);
    const live = formatBodyPreview(
      record({ title: 'My Chat', sessionId: 'abc' }),
      env.bodies,
    );
    assert.strictEqual(out, live, 'archived and live previews use the same rendering');
  });
});

describe('previewChatCommand: previewArchivedBody orchestration', () => {
  it('reads the Nest-owned copy by sessionId and opens its saved bodies', async () => {
    const reads: string[] = [];
    let opened: string | null = null;
    const deps: PreviewArchivedChatDeps = {
      readArchivedBody: async (sessionId: string) => {
        reads.push(sessionId);
        return envelope({ sessionId, title: 'Survived Cleanup' });
      },
      openPreview: (content: string) => {
        opened = content;
      },
      showInfo: () => assert.fail('should not show the empty notice when a copy exists'),
    };
    await previewArchivedBody(deps, 'arch-1');
    assert.deepStrictEqual(reads, ['arch-1'], 'read exactly the one copy by sessionId');
    assert.ok(opened !== null, 'a preview was opened from the saved copy');
    assert.ok(
      (opened as unknown as string).includes('saved question'),
      'opened content carries the saved bodies, NOT the live transcript',
    );
    assert.ok(
      (opened as unknown as string).includes('Survived Cleanup'),
      'opened content carries the stored title',
    );
  });

  it('shows an info notice and opens nothing when no copy exists (pruned/never written)', async () => {
    let opened = false;
    let info: string | null = null;
    const deps: PreviewArchivedChatDeps = {
      readArchivedBody: async () => null,
      openPreview: () => {
        opened = true;
      },
      showInfo: (message: string) => {
        info = message;
      },
    };
    await previewArchivedBody(deps, 'gone');
    assert.strictEqual(opened, false, 'no empty document opened');
    assert.ok(info !== null, 'an info notice was shown');
  });

  it('shows an info notice when the copy exists but has no bodies', async () => {
    let opened = false;
    let info: string | null = null;
    const deps: PreviewArchivedChatDeps = {
      readArchivedBody: async () => envelope({ bodies: [] }),
      openPreview: () => {
        opened = true;
      },
      showInfo: (message: string) => {
        info = message;
      },
    };
    await previewArchivedBody(deps, 'empty-copy');
    assert.strictEqual(opened, false, 'no empty document opened for a bodiless copy');
    assert.ok(info !== null, 'an info notice was shown');
  });
});
