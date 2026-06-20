import * as assert from 'assert';
import { ChatRecord, TokenTotals } from '../../model/types';
import { ChatMessageBody } from '../../claude/bodyReader';
import { ExportOrgLayer } from '../../export/chatExport';
import {
  ExportChatDeps,
  ExportFormat,
  exportChat,
  suggestFileName,
} from '../../commands/exportChatCommands';

// Headless unit tests for the Slice 5 Export Chat orchestrator. The module is
// vscode-free (it takes injected seams for the format pick, the save dialog, the body
// read, the org-layer resolution, and the GUARDED write), so the test exercises the
// flow with in-memory doubles: no vscode host, no real filesystem, no real transcript.
// The highest-value assertions: the body is read ON DEMAND from the record's file
// path (read-only), the org layer is carried into the rendered output, the write goes
// through the injected (guarded) seam exactly once, and every cancel point aborts
// without writing.

function tokens(partial: Partial<TokenTotals> = {}): TokenTotals {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, ...partial };
}

function makeRecord(partial: Partial<ChatRecord> = {}): ChatRecord {
  return {
    sessionId: 'sess-1',
    title: 'My Chat',
    timestamp: 1_700_000_000_000,
    filePath: '/scratch/sess-1.jsonl',
    prNumber: null,
    prUrl: null,
    prRepository: null,
    gitBranch: null,
    leadingMessageUuids: [],
    messageCount: 1,
    firstMessageText: 'hi',
    firstMessageRole: 'user',
    lastMessageText: 'hi',
    lastMessageRole: 'user',
    tokenTotals: tokens({ input: 10 }),
    filesTouched: [],
    models: [],
    ...partial,
  };
}

const ORG: ExportOrgLayer = { folder: 'Inbox', tags: ['bug'], starred: true, links: [] };

interface Spy {
  readFor: string[];
  written: { target: unknown; content: string }[];
  infos: string[];
  errors: string[];
}

function makeDeps(
  overrides: Partial<ExportChatDeps>,
  bodies: ChatMessageBody[] = [{ role: 'user', text: 'hi', uuid: 'u1' }],
): { deps: ExportChatDeps; spy: Spy } {
  const spy: Spy = { readFor: [], written: [], infos: [], errors: [] };
  const deps: ExportChatDeps = {
    pickFormat: async () => 'markdown' as ExportFormat,
    showSaveDialog: async () => '/out/file.md',
    readBodies: (filePath: string) => {
      spy.readFor.push(filePath);
      return bodies;
    },
    resolveOrgLayer: () => ORG,
    writeExport: async (target: unknown, content: string) => {
      spy.written.push({ target, content });
    },
    showInfo: (m: string) => spy.infos.push(m),
    showError: (m: string) => spy.errors.push(m),
    ...overrides,
  };
  return { deps, spy };
}

describe('exportChatCommands.exportChat', () => {
  it('reads the body on demand from the record path and writes the rendered Markdown once', async () => {
    const { deps, spy } = makeDeps({});
    await exportChat(deps, makeRecord());
    assert.deepStrictEqual(spy.readFor, ['/scratch/sess-1.jsonl'], 'body read on demand from the record file');
    assert.strictEqual(spy.written.length, 1, 'wrote exactly once');
    assert.strictEqual(spy.written[0].target, '/out/file.md', 'wrote to the chosen target');
    const content = spy.written[0].content;
    assert.ok(content.startsWith('---\n'), 'Markdown front-matter');
    assert.ok(content.includes('folder: "Inbox"'), 'org layer folder carried');
    assert.ok(content.includes('tags: ["bug"]'), 'org layer tags carried');
    assert.ok(content.includes('hi'), 'body carried');
    assert.strictEqual(spy.infos.length, 1, 'one success info');
    assert.strictEqual(spy.errors.length, 0);
  });

  it('writes JSON when JSON is picked', async () => {
    const { deps, spy } = makeDeps({
      pickFormat: async () => 'json' as ExportFormat,
      showSaveDialog: async () => '/out/file.json',
    });
    await exportChat(deps, makeRecord());
    const parsed = JSON.parse(spy.written[0].content) as { org: { folder: string } };
    assert.strictEqual(parsed.org.folder, 'Inbox', 'JSON org layer carried');
  });

  it('no-body: still writes a document carrying the org layer', async () => {
    const { deps, spy } = makeDeps({}, []); // empty bodies
    await exportChat(deps, makeRecord());
    assert.strictEqual(spy.written.length, 1, 'wrote even with no body');
    assert.ok(spy.written[0].content.includes('folder: "Inbox"'), 'org layer present');
    assert.ok(spy.written[0].content.includes('No readable messages'), 'empty-body note');
  });

  it('aborts without writing when the format pick is cancelled', async () => {
    const { deps, spy } = makeDeps({ pickFormat: async () => null });
    await exportChat(deps, makeRecord());
    assert.strictEqual(spy.written.length, 0, 'no write on format cancel');
    assert.strictEqual(spy.readFor.length, 0, 'no body read on format cancel');
  });

  it('aborts without writing when the save dialog is cancelled', async () => {
    const { deps, spy } = makeDeps({ showSaveDialog: async () => null });
    await exportChat(deps, makeRecord());
    assert.strictEqual(spy.written.length, 0, 'no write on save cancel');
  });

  it('surfaces an error and does not throw when the guarded write rejects', async () => {
    const { deps, spy } = makeDeps({
      writeExport: async () => {
        // Mimic the exportIO guard rejecting a transcript-path target.
        throw new Error('refusing to write under ~/.claude/projects');
      },
    });
    await exportChat(deps, makeRecord());
    assert.strictEqual(spy.errors.length, 1, 'one error surfaced');
    assert.ok(spy.errors[0].includes('export failed'), 'error wording');
    assert.strictEqual(spy.infos.length, 0, 'no success info on failure');
  });
});

describe('exportChatCommands.suggestFileName', () => {
  it('slugs the title and applies the format extension', () => {
    assert.strictEqual(suggestFileName(makeRecord({ title: 'Fix the Bug!' }), 'markdown'), 'fix-the-bug.md');
    assert.strictEqual(suggestFileName(makeRecord({ title: 'Fix the Bug!' }), 'json'), 'fix-the-bug.json');
  });

  it('falls back to the sessionId when the title slugs to empty', () => {
    assert.strictEqual(
      suggestFileName(makeRecord({ title: '!!!', sessionId: 'abc-123' }), 'markdown'),
      'abc-123.md',
    );
  });
});
