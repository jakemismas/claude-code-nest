import * as assert from 'assert';
import { ChatRecord, TokenTotals } from '../../model/types';
import { ChatMessageBody } from '../../claude/bodyReader';
import {
  ChatExportJson,
  ExportOrgLayer,
  renderJson,
  renderMarkdown,
} from '../../export/chatExport';

// Pure-logic unit tests for the Slice 5 per-chat export formatters. No vscode, no
// filesystem: both renderMarkdown and renderJson take plain data (a ChatRecord, a
// resolved org layer, ordered bodies) and return a string. The highest-value cases
// (slice patch "FRONT-MATTER ESCAPING/INJECTION"): a title with a colon/quote/
// newline/leading '---' must not break the YAML front-matter or inject a second
// block, the JSON must round-trip, and a no-body export must still ship the org layer.

function tokens(partial: Partial<TokenTotals> = {}): TokenTotals {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, ...partial };
}

function makeRecord(partial: Partial<ChatRecord> = {}): ChatRecord {
  return {
    sessionId: 'sess-1',
    title: 'Plain Title',
    timestamp: 1_700_000_000_000,
    filePath: '/scratch/sess-1.jsonl',
    prNumber: null,
    prUrl: null,
    prRepository: null,
    gitBranch: null,
    leadingMessageUuids: [],
    messageCount: 2,
    firstMessageText: 'hello',
    firstMessageRole: 'user',
    lastMessageText: 'bye',
    lastMessageRole: 'assistant',
    tokenTotals: tokens({ input: 100, output: 50, cacheCreation: 10, cacheRead: 5 }),
    filesTouched: ['/a.ts', '/b.ts'],
    models: ['claude-opus-4'],
    ...partial,
  };
}

const ORG: ExportOrgLayer = {
  folder: 'Inbox',
  tags: ['bug', 'urgent'],
  starred: true,
  links: ['other-sess'],
};

const BODIES: ChatMessageBody[] = [
  { role: 'user', text: 'How do I fix this?', uuid: 'u1' },
  { role: 'assistant', text: 'Try this.', uuid: 'a1' },
];

// Find the front-matter block (everything between the first two '---' fences at
// column 0) and return its inner lines. Asserts there are EXACTLY two fences so a
// title that injected a third '---' is caught.
function frontMatterLines(markdown: string): string[] {
  const lines = markdown.split('\n');
  const fences: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '---') {
      fences.push(i);
    }
  }
  assert.strictEqual(
    fences.length,
    2,
    'expected exactly two front-matter fences (no injected block); got ' + fences.length,
  );
  return lines.slice(fences[0] + 1, fences[1]);
}

describe('chatExport.renderMarkdown', () => {
  it('emits a YAML front-matter block carrying the full org layer plus the body', () => {
    const md = renderMarkdown(makeRecord(), ORG, BODIES);
    const fm = frontMatterLines(md);
    assert.ok(fm.some((l) => l === 'title: "Plain Title"'), 'title line');
    assert.ok(fm.some((l) => l === 'folder: "Inbox"'), 'folder line');
    assert.ok(fm.some((l) => l === 'tags: ["bug", "urgent"]'), 'tags flow array');
    assert.ok(fm.some((l) => l === 'starred: true'), 'starred line');
    assert.ok(fm.some((l) => l === 'links: ["other-sess"]'), 'links flow array');
    assert.ok(fm.some((l) => l === 'tokenTotal: 165'), 'summed token total (100+50+10+5)');
    // The body carries both turns, labelled.
    assert.ok(md.includes('## You'), 'user turn heading');
    assert.ok(md.includes('How do I fix this?'), 'user turn text');
    assert.ok(md.includes('## Claude'), 'assistant turn heading');
    assert.ok(md.includes('Try this.'), 'assistant turn text');
  });

  it('renders an unfiled chat folder as the YAML null, not a quoted string', () => {
    const md = renderMarkdown(makeRecord(), { folder: null, tags: [], starred: false, links: [] }, BODIES);
    const fm = frontMatterLines(md);
    assert.ok(fm.some((l) => l === 'folder: null'), 'null folder');
    assert.ok(fm.some((l) => l === 'tags: []'), 'empty tags array');
    assert.ok(fm.some((l) => l === 'starred: false'), 'unstarred');
  });

  it('no-body: still ships the full front-matter org layer and a clear empty-body note', () => {
    const md = renderMarkdown(makeRecord(), ORG, []);
    const fm = frontMatterLines(md);
    // The org layer is intact even with no body.
    assert.ok(fm.some((l) => l === 'title: "Plain Title"'), 'title still present');
    assert.ok(fm.some((l) => l === 'tags: ["bug", "urgent"]'), 'tags still present');
    assert.ok(fm.some((l) => l === 'messageCount: 2'), 'messageCount from the record');
    // The body section states the transcript had no readable messages, not blank.
    assert.ok(md.includes('No readable messages'), 'empty-body note');
    assert.ok(!md.includes('## You'), 'no turn headings');
  });

  it('markdown-injection / front-matter-injection: a hostile title cannot break or inject a block', () => {
    // A title with a colon, a double quote, a newline, AND a leading '---' line: a
    // naive renderer would either break the YAML (the colon/quote) or inject a second
    // front-matter block (the embedded '---' on its own line).
    const hostile = 'Evil: "title"\n---\ninjected: true';
    const md = renderMarkdown(makeRecord({ title: hostile }), ORG, BODIES);
    // frontMatterLines asserts EXACTLY two fences, so an injected '---' fails here.
    const fm = frontMatterLines(md);
    // The whole hostile title is contained on ONE escaped, quoted line.
    const titleLine = fm.find((l) => l.startsWith('title: '));
    assert.ok(titleLine !== undefined, 'a single title line exists');
    assert.strictEqual(
      titleLine,
      'title: "Evil: \\"title\\"\\n---\\ninjected: true"',
      'colon, quote, newline, and embedded --- are all escaped on one quoted line',
    );
    // The escaped content is NOT a parseable injected key.
    assert.ok(!fm.some((l) => l === 'injected: true'), 'no injected key in the block');
  });

  it('escapes a tag label that would otherwise break the flow array', () => {
    const md = renderMarkdown(
      makeRecord(),
      { folder: 'F', tags: ['a"b', 'c,d'], starred: false, links: [] },
      BODIES,
    );
    const fm = frontMatterLines(md);
    assert.ok(
      fm.some((l) => l === 'tags: ["a\\"b", "c,d"]'),
      'tag quote escaped; comma stays inside the quoted scalar',
    );
  });

  it('renders a textless turn as a placeholder, not a blank paragraph', () => {
    const md = renderMarkdown(makeRecord(), ORG, [
      { role: 'assistant', text: null, uuid: 'a1' },
    ]);
    assert.ok(md.includes('(no text in this turn)'), 'textless-turn placeholder');
  });
});

describe('chatExport.renderJson', () => {
  it('produces a round-trippable JSON document with the org layer and messages', () => {
    const record = makeRecord();
    const json = renderJson(record, ORG, BODIES);
    const parsed = JSON.parse(json) as ChatExportJson;
    assert.strictEqual(parsed.exportVersion, 1);
    assert.strictEqual(parsed.sessionId, 'sess-1');
    assert.strictEqual(parsed.title, 'Plain Title');
    assert.deepStrictEqual(parsed.org, {
      folder: 'Inbox',
      tags: ['bug', 'urgent'],
      starred: true,
      links: ['other-sess'],
    });
    assert.deepStrictEqual(parsed.tokenTotals, {
      total: 165,
      input: 100,
      output: 50,
      cacheCreation: 10,
      cacheRead: 5,
    });
    assert.deepStrictEqual(parsed.messages, [
      { role: 'user', text: 'How do I fix this?' },
      { role: 'assistant', text: 'Try this.' },
    ]);
  });

  it('round-trips a hostile title safely (JSON.stringify handles all escaping)', () => {
    const hostile = 'Evil: "title"\n---\ninjected: true';
    const json = renderJson(makeRecord({ title: hostile }), ORG, BODIES);
    const parsed = JSON.parse(json) as ChatExportJson;
    assert.strictEqual(parsed.title, hostile, 'title survives the round-trip verbatim');
  });

  it('no-body: emits an empty messages array, org layer intact', () => {
    const parsed = JSON.parse(renderJson(makeRecord(), ORG, [])) as ChatExportJson;
    assert.deepStrictEqual(parsed.messages, []);
    assert.strictEqual(parsed.org.folder, 'Inbox');
    assert.strictEqual(parsed.messageCount, 2);
  });

  it('carries a textless turn as text:null', () => {
    const parsed = JSON.parse(
      renderJson(makeRecord(), ORG, [{ role: 'assistant', text: null, uuid: 'a1' }]),
    ) as ChatExportJson;
    assert.deepStrictEqual(parsed.messages, [{ role: 'assistant', text: null }]);
  });
});
