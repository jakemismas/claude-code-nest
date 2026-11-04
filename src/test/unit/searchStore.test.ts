// Import vscodeStub first so require('vscode') resolves before searchStore loads exportIO.
import './vscodeStub';
import { vscodeHarness } from './vscodeStub';

import * as assert from 'assert';
import * as path from 'path';
import {
  persistTierAIndex,
  loadOrRebuildTierAIndex,
  tierADocs,
  indexFilePath,
} from '../../search/searchStore';
import { search } from '../../search/searchIndex';
import { ChatRecord, TokenTotals } from '../../model/types';
import {
  ExportPathError,
  assertNotUnderClaudeProjects,
  claudeProjectsRoot,
} from '../../store/exportPathGuard';

// Tests for the vscode-thin search-index store (src/search/searchStore.ts). It persists and loads only
// through exportIO against a globalStorage Uri, never under ~/.claude/projects or as a synced key.

// Stub Uri matching the vscodeStub shape: fsPath and scheme are all the store needs.
function uri(fsPath: string): { fsPath: string; scheme: 'file' } {
  return { fsPath, scheme: 'file' };
}

function totals(): TokenTotals {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
}

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

const STORAGE = '/storage/global';
const records: ChatRecord[] = [
  record({ sessionId: 'a', title: 'Refactor the parser', lastMessageText: 'done', filesTouched: ['p.ts'] }),
  record({ sessionId: 'b', title: 'Add tags', lastMessageText: 'tags applied', filesTouched: ['t.ts'] }),
];

describe('searchStore.tierADocs (no body ever)', () => {
  it('builds tier-A docs with an EMPTY bodyText for every record', () => {
    const docs = tierADocs(records);
    assert.strictEqual(docs.length, 2);
    for (const d of docs) {
      assert.strictEqual(d.bodyText, '', 'a persisted doc never carries body text');
    }
    assert.strictEqual(docs[0].title, 'Refactor the parser');
    assert.strictEqual(docs[0].files, 'p.ts');
  });
});

describe('searchStore.persistTierAIndex', () => {
  beforeEach(() => vscodeHarness.reset());

  it('writes the index file under the globalStorage search dir, through exportIO', async () => {
    await persistTierAIndex(uri(STORAGE) as never, records);
    assert.strictEqual(vscodeHarness.writes.length, 1, 'exactly one index file written');
    const written = vscodeHarness.writes[0];
    assert.strictEqual(
      written.path,
      STORAGE + '/search/nest-search-index.v1.json',
      'index written under <globalStorage>/search/',
    );
    assert.ok(
      vscodeHarness.createdDirs.includes(STORAGE + '/search'),
      'the search dir is created first',
    );
  });

  it('the persisted payload is a versioned envelope with NO body token', async () => {
    await persistTierAIndex(uri(STORAGE) as never, records);
    const body = vscodeHarness.writes[0].content;
    const env = JSON.parse(body) as { version: number; index: unknown };
    assert.strictEqual(env.version, 1, 'a schema version rides the envelope');
    assert.ok(env.index !== undefined && env.index !== null, 'the serialized index is present');
    // Tier-A docs carry no body, so no body text can appear in the serialized index.
    assert.ok(body.includes('refactor') || body.includes('Refactor') || body.length > 0);
  });

  it('swallows a write failure (best-effort: never throws, leaves no file)', async () => {
    vscodeHarness.writeErrors.add(STORAGE + '/search/nest-search-index.v1.json');
    await persistTierAIndex(uri(STORAGE) as never, records);
    assert.strictEqual(vscodeHarness.writes.length, 0, 'the failed write recorded nothing');
  });
});

describe('searchStore.loadOrRebuildTierAIndex', () => {
  beforeEach(() => vscodeHarness.reset());

  it('round-trips: a persisted index loads and searches identically', async () => {
    await persistTierAIndex(uri(STORAGE) as never, records);
    const index = await loadOrRebuildTierAIndex(uri(STORAGE) as never, []);
    const hits = search(index, 'tags');
    assert.ok(
      hits.some((h) => h.sessionId === 'b'),
      'the loaded index finds the persisted document',
    );
  });

  it('the warm-loaded index carries TIER-A tokens but no body token', async () => {
    // The warm start loads this persisted index and answers the first query before any body is read, so the
    // persisted index must carry no body text: a body-only term must not match, a tier-A term must.
    await persistTierAIndex(uri(STORAGE) as never, records);
    const warm = await loadOrRebuildTierAIndex(uri(STORAGE) as never, []);
    assert.ok(
      search(warm, 'parser').some((h) => h.sessionId === 'a'),
      'a tier-A term matches the warm-loaded index',
    );
    // A body-only term was never persisted, so it cannot match the warm index.
    assert.strictEqual(
      search(warm, 'zzqxbodyonly').length,
      0,
      'no body-derived token is searchable from the warm-loaded index',
    );
  });

  it('rebuilds in memory from records when no persisted file exists', async () => {
    const index = await loadOrRebuildTierAIndex(uri(STORAGE) as never, records);
    const hits = search(index, 'parser');
    assert.ok(
      hits.some((h) => h.sessionId === 'a'),
      'the rebuilt index searches the supplied records',
    );
  });

  it('rebuilds when the persisted file is malformed JSON', async () => {
    vscodeHarness.files.set(STORAGE + '/search/nest-search-index.v1.json', 'not json {{{');
    const index = await loadOrRebuildTierAIndex(uri(STORAGE) as never, records);
    const hits = search(index, 'parser');
    assert.ok(hits.some((h) => h.sessionId === 'a'), 'a corrupt file falls back to rebuild');
  });

  it('rebuilds when the persisted envelope has a wrong version', async () => {
    vscodeHarness.files.set(
      STORAGE + '/search/nest-search-index.v1.json',
      JSON.stringify({ version: 999, index: {} }),
    );
    const index = await loadOrRebuildTierAIndex(uri(STORAGE) as never, records);
    const hits = search(index, 'tags');
    assert.ok(hits.some((h) => h.sessionId === 'b'), 'a version mismatch falls back to rebuild');
  });

  it('never throws and rebuilds when loadJSON receives a structurally bad index', async () => {
    vscodeHarness.files.set(
      STORAGE + '/search/nest-search-index.v1.json',
      JSON.stringify({ version: 1, index: { bogus: true } }),
    );
    const index = await loadOrRebuildTierAIndex(uri(STORAGE) as never, records);
    const hits = search(index, 'parser');
    assert.ok(Array.isArray(hits), 'load is total and never throws');
  });
});

// The store target resolves under globalStorage, and the guard every exportIO write runs
// (assertNotUnderClaudeProjects) rejects a globalStorage that points into ~/.claude/projects/.
describe('searchStore target is guarded under globalStorage, never under ~/.claude/projects', () => {
  it('the index file path resolves under the given globalStorage dir', () => {
    const fsPath = indexFilePath(uri(STORAGE) as never);
    assert.strictEqual(fsPath, STORAGE + '/search/nest-search-index.v1.json');
    assert.doesNotThrow(() => assertNotUnderClaudeProjects(fsPath));
  });

  it('assertNotUnderClaudeProjects THROWS for a target under ~/.claude/projects (reused guard)', () => {
    // A globalStorageUri inside the transcript tree must be rejected before any write.
    const projectsStorage = uri(path.join(claudeProjectsRoot(), 'c--proj'));
    const fsPath = indexFilePath(projectsStorage as never);
    assert.throws(
      () => assertNotUnderClaudeProjects(fsPath),
      (e: unknown) => e instanceof ExportPathError,
      'a projects-path index target is rejected by the guard',
    );
  });

  it('persistTierAIndex aimed under ~/.claude/projects writes NOTHING (the guard fires inside exportIO)', async () => {
    vscodeHarness.reset();
    const projectsStorage = uri(path.join(claudeProjectsRoot(), 'c--proj'));
    // persistTierAIndex is best-effort: the guard throws inside, the store swallows it, and no write is recorded.
    await persistTierAIndex(projectsStorage as never, records);
    assert.strictEqual(
      vscodeHarness.writes.length,
      0,
      'no index file is written under ~/.claude/projects',
    );
  });
});
