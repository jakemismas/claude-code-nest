import * as assert from 'assert';
import { ChatRecord, TokenTotals } from '../../model/types';
import { buildChatTooltip, tokenBadge } from '../../views/chatTooltip';

// Headless unit tests for the PURE hover-card builder and the row token badge
// (slice 1). No vscode import and no filesystem: buildChatTooltip takes a plain
// ChatRecord plus a plain folder name and tag-label list and returns markdown, so
// the provider's vscode.MarkdownString wrapping is the only vscode contact and
// stays out of this gate (mirrors occurrence.ts / dropReducer.ts vscode-free
// builders).

function tokens(partial: Partial<TokenTotals> = {}): TokenTotals {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, ...partial };
}

function record(partial: Partial<ChatRecord> = {}): ChatRecord {
  return {
    sessionId: 'sess-1',
    title: 'A chat title',
    timestamp: Date.now() - 2 * 60 * 60 * 1000,
    filePath: '/x/sess-1.jsonl',
    prNumber: null,
    prUrl: null,
    prRepository: null,
    gitBranch: null,
    leadingMessageUuids: [],
    messageCount: 4,
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

describe('chatTooltip: full record', () => {
  it('renders folder, age, tokens, full tag set, snippets, models, files', () => {
    const rec = record({
      title: 'Build the hover card',
      tokenTotals: tokens({ input: 10000, output: 2000, cacheCreation: 300, cacheRead: 0 }),
      firstMessageText: 'the first thing asked',
      firstMessageRole: 'user',
      lastMessageText: 'the last thing said',
      lastMessageRole: 'assistant',
      models: ['claude-opus-4-8', 'claude-sonnet-4-5'],
      filesTouched: ['/a.ts', '/b.ts', '/c.ts'],
    });
    const md = buildChatTooltip(rec, 'Work/ClientA', ['urgent', 'review']);
    assert.ok(md.includes('Build the hover card'), 'title present');
    assert.ok(md.includes('Folder: Work'), 'folder name present (escaped slash)');
    assert.ok(md.includes('Age: 2 hours ago'), 'relative age present');
    // 12300 tokens -> ~12.3k
    assert.ok(md.includes('Tokens: ~12.3k'), 'token total present: ' + md);
    assert.ok(md.includes('urgent') && md.includes('review'), 'full tag set present');
    // Model names contain hyphens, which escapeMarkdown backslash-escapes, so match
    // the escaped form. This confirms BOTH models render and that escaping applies.
    assert.ok(
      md.includes('claude\\-opus\\-4\\-8') && md.includes('claude\\-sonnet\\-4\\-5'),
      'both models present (escaped): ' + md,
    );
    assert.ok(md.includes('Files touched: 3'), 'files-touched count present');
    // BOTH the first and the last snippet render (binding UI-SPEC first/last).
    assert.ok(md.includes('the first thing asked'), 'first snippet present');
    assert.ok(md.includes('First (you):'), 'user first snippet label');
    assert.ok(md.includes('the last thing said'), 'last snippet present');
    assert.ok(md.includes('Last (Claude):'), 'assistant last snippet label');
  });

  it('separates the metadata fields with CommonMark hard breaks so they do not run together', () => {
    // Finding 1: a single-newline soft join collapses to one paragraph in the
    // hover renderer (markdown-it breaks:false), running every field onto one
    // line. The builder must emit a HARD break (two trailing spaces + newline)
    // between fields. Assert the rendered shape, not just substring presence: each
    // non-final field line ends with the two-space hard-break marker.
    const rec = record({
      tokenTotals: tokens({ input: 5000 }),
      models: ['claude-opus-4-8'],
      filesTouched: ['/a.ts'],
    });
    const md = buildChatTooltip(rec, 'MyFolder', ['tag1']);
    assert.ok(md.includes('  \n'), 'a CommonMark hard break is present between fields');
    assert.ok(md.includes('Folder: MyFolder  \n'), 'Folder field ends with a hard break');
    assert.ok(md.includes('Age:'), 'Age field present');
    assert.ok(/Tokens: ~5k {2}\n/.test(md), 'Tokens field ends with a hard break');
    // The six metadata fields are NOT all collapsed onto one soft-joined line.
    assert.ok(
      !/Folder: MyFolder\nAge:/.test(md),
      'fields must not be soft-joined onto adjacent lines',
    );
  });
});

describe('chatTooltip: token-less record', () => {
  it('shows Tokens: unknown and no models/files lines, no badge', () => {
    const rec = record({ tokenTotals: tokens(), models: [], filesTouched: [] });
    const md = buildChatTooltip(rec, null, []);
    assert.ok(md.includes('Tokens: unknown'), 'no usage -> unknown');
    assert.ok(!md.includes('Models:'), 'no models line when empty');
    assert.ok(!md.includes('Files touched:'), 'no files line when empty');
    assert.strictEqual(tokenBadge(rec), '', 'no badge for a usage-less chat');
  });
});

describe('chatTooltip: unfiled and untagged', () => {
  it('renders Unfiled and none when folder/tags absent', () => {
    const md = buildChatTooltip(record(), undefined, []);
    assert.ok(md.includes('Folder: Unfiled'), 'absent folder -> Unfiled');
    assert.ok(md.includes('Tags: none'), 'empty tag set -> none');
  });

  it('treats a blank folder name as Unfiled and dedups tags', () => {
    const md = buildChatTooltip(record(), '   ', ['dup', 'dup', '', 'keep']);
    assert.ok(md.includes('Folder: Unfiled'), 'blank folder -> Unfiled');
    // dup appears once, blank dropped, keep present.
    const tagsLine = md.split('\n').find((l) => l.startsWith('Tags: '));
    assert.strictEqual(tagsLine, 'Tags: dup, keep');
  });
});

describe('chatTooltip: snippet role labels and absence', () => {
  it('labels a user last snippet and omits the snippet block when none', () => {
    const userRec = record({ lastMessageText: 'a question', lastMessageRole: 'user' });
    assert.ok(buildChatTooltip(userRec, null, []).includes('Last (you):'));
    const noneRec = record({
      firstMessageText: null,
      firstMessageRole: null,
      lastMessageText: null,
      lastMessageRole: null,
    });
    const noneMd = buildChatTooltip(noneRec, null, []);
    assert.ok(!noneMd.includes('Last'), 'no last snippet when none');
    assert.ok(!noneMd.includes('First'), 'no first snippet when none');
  });

  it('renders the first snippet alone when only the first turn was captured', () => {
    const firstOnly = record({
      firstMessageText: 'the opening prompt',
      firstMessageRole: 'user',
      lastMessageText: null,
      lastMessageRole: null,
    });
    const md = buildChatTooltip(firstOnly, null, []);
    assert.ok(md.includes('First (you):'), 'first snippet label present');
    assert.ok(md.includes('the opening prompt'), 'first snippet text present');
    assert.ok(!md.includes('Last'), 'no last snippet when last is absent');
  });

  it('labels an assistant first snippet', () => {
    const assistantFirst = record({
      firstMessageText: 'I will start by reading the file',
      firstMessageRole: 'assistant',
    });
    assert.ok(buildChatTooltip(assistantFirst, null, []).includes('First (Claude):'));
  });
});

describe('chatTooltip: markdown escaping', () => {
  it('escapes control characters in title, snippet, and tags', () => {
    const rec = record({ title: 'a*b_c`d', lastMessageText: 'line1\nline2 with `code`', lastMessageRole: 'user' });
    const md = buildChatTooltip(rec, 'fold[er]', ['t*g']);
    assert.ok(md.includes('a\\*b\\_c\\`d'), 'title escaped');
    assert.ok(md.includes('fold\\[er\\]'), 'folder escaped');
    assert.ok(md.includes('t\\*g'), 'tag escaped');
    assert.ok(!md.includes('line1\nline2'), 'snippet newline collapsed');
  });
});

describe('tokenBadge: formatting', () => {
  it('formats sub-1k, thousands, and millions', () => {
    assert.strictEqual(tokenBadge(record({ tokenTotals: tokens({ input: 850 }) })), '~850 tokens');
    assert.strictEqual(tokenBadge(record({ tokenTotals: tokens({ input: 12345 }) })), '~12.3k tokens');
    assert.strictEqual(tokenBadge(record({ tokenTotals: tokens({ input: 2_000_000 }) })), '~2m tokens');
  });

  it('sums all four token fields', () => {
    const rec = record({ tokenTotals: tokens({ input: 100, output: 200, cacheCreation: 300, cacheRead: 400 }) });
    assert.strictEqual(tokenBadge(rec), '~1k tokens');
  });
});
