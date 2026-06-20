import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as path from 'path';
import {
  SearchDoc,
  buildIndex,
  search,
  docFromRecord,
  buildSnippet,
  SNIPPET_LENGTH,
} from '../../search/searchIndex';
import { ChatRecord, TokenTotals } from '../../model/types';

// Headless unit tests for the PURE, vscode-free full-text search index
// (src/search/searchIndex.ts). This file and the module it imports must NOT
// require the vscode module (unit-gate rule); searchIndex imports only the
// vendored MiniSearch (by relative path) and the model types, so there is no
// vscode in this graph. The guard against a vscode import is asserted explicitly
// at the bottom.

function totals(): TokenTotals {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
}

// A minimal ChatRecord factory for docFromRecord tests. Only the fields
// docFromRecord reads (sessionId, title, lastMessageText, filesTouched) carry
// values; the rest are defaulted so the record type-checks.
function record(over: Partial<ChatRecord>): ChatRecord {
  return {
    sessionId: 's',
    title: '',
    timestamp: null,
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

function doc(over: Partial<SearchDoc>): SearchDoc {
  return {
    sessionId: 's',
    title: '',
    lastMessage: '',
    files: '',
    bodyText: '',
    ...over,
  };
}

describe('searchIndex.search ranked results', () => {
  const docs: SearchDoc[] = [
    doc({
      sessionId: 'a',
      title: 'Refactor the JSONL parser',
      lastMessage: 'done refactoring the tolerant parser',
      files: 'src/claude/jsonlReader.ts',
      bodyText: 'we discussed how the tolerant parser skips unknown line types',
    }),
    doc({
      sessionId: 'b',
      title: 'Add tags to chats',
      lastMessage: 'tags now apply to a chat in any view',
      files: 'src/views/tagsProvider.ts',
      bodyText: 'tagging applies a tag id to a chat metadata record',
    }),
    doc({
      sessionId: 'c',
      title: 'Smart groups by pull request',
      lastMessage: 'PR grouping is the solid signal',
      files: 'src/smart/signals/pr.ts',
      bodyText: 'a chat carries a pr-link line with prNumber and prUrl',
    }),
  ];

  it('returns sessionIds ranked, matching a body-only term', () => {
    const index = buildIndex(docs);
    const hits = search(index, 'tolerant');
    assert.ok(hits.length >= 1, 'a body term matches');
    assert.strictEqual(hits[0].sessionId, 'a', 'the chat whose body has the term ranks first');
    assert.ok(hits[0].score > 0, 'score is positive');
  });

  it('boosts a title match above a body-only match', () => {
    const index = buildIndex(docs);
    // "tags" is in chat b's title; it should rank b first even though other docs
    // may mention tagging in the body.
    const hits = search(index, 'tags');
    assert.ok(hits.length >= 1);
    assert.strictEqual(hits[0].sessionId, 'b', 'the title match ranks first via the title boost');
  });

  it('matches on the files field', () => {
    const index = buildIndex(docs);
    const hits = search(index, 'tagsProvider');
    assert.ok(
      hits.some((h) => h.sessionId === 'b'),
      'a filename token is searchable',
    );
  });

  it('every hit carries a non-empty snippet', () => {
    const index = buildIndex(docs);
    const hits = search(index, 'parser');
    assert.ok(hits.length >= 1);
    for (const h of hits) {
      assert.ok(typeof h.snippet === 'string' && h.snippet.length > 0, 'snippet present');
    }
  });

  it('returns [] for an empty or whitespace query', () => {
    const index = buildIndex(docs);
    assert.deepStrictEqual(search(index, ''), []);
    assert.deepStrictEqual(search(index, '   '), []);
  });

  it('returns [] for a no-match query', () => {
    const index = buildIndex(docs);
    assert.deepStrictEqual(search(index, 'zzzznotpresentanywhere'), []);
  });

  it('returns [] from an index built over no documents', () => {
    const index = buildIndex([]);
    assert.deepStrictEqual(search(index, 'anything'), []);
  });

  it('tolerates a duplicate sessionId (first-seen wins, no throw)', () => {
    // MiniSearch THROWS on a duplicate id; buildIndex must dedupe so a
    // pathological scan does not crash a content search.
    const dup: SearchDoc[] = [
      doc({ sessionId: 'd', title: 'first widget', bodyText: 'first' }),
      doc({ sessionId: 'd', title: 'second widget', bodyText: 'second' }),
    ];
    let index: ReturnType<typeof buildIndex>;
    assert.doesNotThrow(() => {
      index = buildIndex(dup);
    });
    const hits = search(index!, 'widget');
    assert.strictEqual(hits.length, 1, 'the duplicate id is indexed exactly once');
    assert.strictEqual(hits[0].sessionId, 'd');
  });

  it('drops a document with a blank sessionId', () => {
    const docs2: SearchDoc[] = [
      doc({ sessionId: '', title: 'no id widget' }),
      doc({ sessionId: 'real', title: 'real widget' }),
    ];
    const index = buildIndex(docs2);
    const hits = search(index, 'widget');
    assert.ok(
      hits.every((h) => h.sessionId === 'real'),
      'only the document with a usable id is searchable',
    );
  });

  it('honors the result limit', () => {
    const many: SearchDoc[] = [];
    for (let i = 0; i < 20; i++) {
      many.push(doc({ sessionId: 'id' + i, title: 'widget number ' + i, bodyText: 'widget widget' }));
    }
    const index = buildIndex(many);
    const hits = search(index, 'widget', 5);
    assert.strictEqual(hits.length, 5, 'no more than the limit is returned');
  });
});

describe('searchIndex.docFromRecord', () => {
  it('builds a tier-A doc from a ChatRecord without body when none is supplied', () => {
    const r = record({
      sessionId: 'r1',
      title: 'My title',
      lastMessageText: 'the last thing said',
      filesTouched: ['a.ts', 'b.ts'],
    });
    const d = docFromRecord(r);
    assert.strictEqual(d.sessionId, 'r1');
    assert.strictEqual(d.title, 'My title');
    assert.strictEqual(d.lastMessage, 'the last thing said');
    assert.strictEqual(d.files, 'a.ts b.ts');
    assert.strictEqual(d.bodyText, '', 'no body text when none is supplied');
  });

  it('includes the supplied body text when given', () => {
    const r = record({ sessionId: 'r2', title: 'T' });
    const d = docFromRecord(r, 'the full conversation body');
    assert.strictEqual(d.bodyText, 'the full conversation body');
  });

  it('defaults a null tier-A field to an empty string', () => {
    const r = record({ sessionId: 'r3', title: '', lastMessageText: null, filesTouched: [] });
    const d = docFromRecord(r);
    assert.strictEqual(d.lastMessage, '');
    assert.strictEqual(d.files, '');
  });
});

describe('searchIndex.buildSnippet centering and truncation', () => {
  it('returns a short source whole, with no ellipsis', () => {
    const s = buildSnippet('a short line of text', 'short');
    assert.strictEqual(s, 'a short line of text');
  });

  it('returns "" for an empty source', () => {
    assert.strictEqual(buildSnippet('', 'term'), '');
    assert.strictEqual(buildSnippet('   ', 'term'), '');
  });

  it('centers the window on the matched term and bounds the length', () => {
    const head = Array.from({ length: 60 }, (_, i) => 'h' + i).join(' ');
    const tail = Array.from({ length: 60 }, (_, i) => 't' + i).join(' ');
    const source = head + ' TARGETWORD ' + tail;
    const s = buildSnippet(source, 'TARGETWORD');
    assert.ok(s.includes('TARGETWORD'), 'the matched term is inside the window');
    assert.ok(s.startsWith('...'), 'a leading ellipsis when the window does not start at 0');
    assert.ok(s.endsWith('...'), 'a trailing ellipsis when the window does not reach the end');
    // Allow the two 3-char ellipses on top of the window length.
    assert.ok(s.length <= SNIPPET_LENGTH + 6, 'snippet bounded to the window plus ellipses');
  });

  it('truncates the head with a trailing ellipsis when the term is not found', () => {
    const long = Array.from({ length: 100 }, (_, i) => 'word' + i).join(' ');
    const s = buildSnippet(long, 'absentterm');
    assert.ok(s.endsWith('...'), 'a trailing ellipsis on a head truncation');
    assert.ok(!s.startsWith('...'), 'no leading ellipsis on a head truncation');
    assert.ok(s.length <= SNIPPET_LENGTH + 3);
  });

  it('truncates the head when the query is empty (no term to center on)', () => {
    const long = Array.from({ length: 100 }, (_, i) => 'word' + i).join(' ');
    const s = buildSnippet(long, '');
    assert.ok(s.endsWith('...'));
    assert.ok(s.startsWith('word0'), 'the head begins at the start of the text');
  });

  it('collapses internal whitespace in the source', () => {
    const s = buildSnippet('alpha    beta\n\tgamma', 'beta');
    assert.strictEqual(s, 'alpha beta gamma');
  });

  it('does not cut into the matched term at the right edge', () => {
    // A match near the end: the trailing snap-to-space must not slice the term.
    const head = Array.from({ length: 80 }, (_, i) => 'x' + i).join(' ');
    const source = head + ' FINALMATCH';
    const s = buildSnippet(source, 'FINALMATCH');
    assert.ok(s.includes('FINALMATCH'), 'the trailing match survives the boundary snap');
  });
});

// The unit-gate invariant: importing searchIndex must not transitively pull in
// the vscode module. The whole mocha suite shares one process where other test
// files install a vscode stub, so an in-process require.cache check is unreliable.
// Instead, require searchIndex in an ISOLATED child node process (no stub, no
// vscode host) and assert it loads and that no vscode module entered THAT
// process's require cache. If searchIndex (or the vendored MiniSearch) imported
// vscode, the child require would throw "Cannot find module 'vscode'".
describe('searchIndex is vscode-free', () => {
  it('loads in an isolated process with no vscode module', () => {
    // Resolve out/search/searchIndex.js relative to this compiled test file
    // (out/test/unit/searchIndex.test.js -> out/search/searchIndex.js).
    const indexJs = path.join(__dirname, '..', '..', 'search', 'searchIndex.js');
    const script =
      'const m = require(' +
      JSON.stringify(indexJs) +
      '); ' +
      'if (typeof m.buildIndex !== "function") { console.error("no buildIndex"); process.exit(2); } ' +
      'const hasVscode = Object.keys(require.cache).some((k) => /[\\\\/]vscode[\\\\/]/.test(k)); ' +
      'if (hasVscode) { console.error("vscode was loaded"); process.exit(3); } ' +
      'process.exit(0);';
    // execFileSync throws on a non-zero exit, which fails the test with the child
    // stderr attached, so a vscode import or a missing export is a clear failure.
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    assert.strictEqual(out, '', 'the isolated load produced no error output');
  });
});
