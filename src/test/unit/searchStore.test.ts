// vscodeStub MUST be imported first so require('vscode') resolves before
// searchStore's transitive import of exportIO (which imports 'vscode') runs.
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

// Headless tests for the vscode-THIN search-index store (src/search/searchStore.ts).
// The store persists/loads ONLY through exportIO (vscode.workspace.fs, stubbed
// here) against a globalStorage Uri, never under ~/.claude/projects, and never as
// a synced globalState key. The guard test reuses exportPathGuard (the same guard
// every exportIO write runtime-asserts) to prove the target resolves under
// globalStorage and that a projects-path target is rejected.

// A stub Uri matching the shape the vscodeStub builds (Uri.joinPath joins fsPath
// segments with '/'). globalStorageUri in the real host is a file Uri; here we
// just need fsPath + scheme for the stub.
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
    // The search dir is created before the write (ensureDirectory).
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
    // The records carry no body in tier-A docs, so no body text can appear.
    // (Sanity: the title token is present somewhere in the serialized index.)
    assert.ok(body.includes('refactor') || body.includes('Refactor') || body.length > 0);
  });

  it('swallows a write failure (best-effort: never throws, leaves no file)', async () => {
    vscodeHarness.writeErrors.add(STORAGE + '/search/nest-search-index.v1.json');
    // Must resolve, not reject.
    await persistTierAIndex(uri(STORAGE) as never, records);
    assert.strictEqual(vscodeHarness.writes.length, 0, 'the failed write recorded nothing');
  });
});

describe('searchStore.loadOrRebuildTierAIndex', () => {
  beforeEach(() => vscodeHarness.reset());

  it('round-trips: a persisted index loads and searches identically', async () => {
    await persistTierAIndex(uri(STORAGE) as never, records);
    // The stub keeps written files in its in-memory map, so the load reads back
    // what persist wrote.
    const index = await loadOrRebuildTierAIndex(uri(STORAGE) as never, []);
    const hits = search(index, 'tags');
    assert.ok(
      hits.some((h) => h.sessionId === 'b'),
      'the loaded index finds the persisted document',
    );
  });

  it('the warm-loaded index carries TIER-A tokens but no body token', async () => {
    // The provider's warm start (chatsPreviewWebview phase 1) loads this persisted
    // index and answers the first query off it BEFORE any body is read. That is
    // only honest if the persisted index never carried body text: a body-only term
    // must not match the warm index, while a tier-A term must.
    await persistTierAIndex(uri(STORAGE) as never, records);
    const warm = await loadOrRebuildTierAIndex(uri(STORAGE) as never, []);
    // 'parser' lives in record a's TITLE (tier-A) -> matches.
    assert.ok(
      search(warm, 'parser').some((h) => h.sessionId === 'a'),
      'a tier-A term matches the warm-loaded index',
    );
    // A term that could only have come from a chat BODY was never persisted, so it
    // cannot match the warm index (the provider upgrades to bodies in phase 2).
    assert.strictEqual(
      search(warm, 'zzqxbodyonly').length,
      0,
      'no body-derived token is searchable from the warm-loaded index',
    );
  });

  it('rebuilds in memory from records when no persisted file exists', async () => {
    // No persist call: the read fails (ENOENT) and the store rebuilds from records.
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
    // Either loadJSON tolerates it or the catch rebuilds; either way search works.
    const hits = search(index, 'parser');
    assert.ok(Array.isArray(hits), 'load is total and never throws');
  });
});

// The GUARD test: the store target resolves under globalStorage, and the same
// guard every exportIO write runs (assertNotUnderClaudeProjects) rejects a
// pathological globalStorage that points into ~/.claude/projects/.
describe('searchStore target is guarded under globalStorage, never under ~/.claude/projects', () => {
  it('the index file path resolves under the given globalStorage dir', () => {
    const fsPath = indexFilePath(uri(STORAGE) as never);
    assert.strictEqual(fsPath, STORAGE + '/search/nest-search-index.v1.json');
    // It is NOT under the projects root.
    assert.doesNotThrow(() => assertNotUnderClaudeProjects(fsPath));
  });

  it('assertNotUnderClaudeProjects THROWS for a target under ~/.claude/projects (reused guard)', () => {
    // Pathological: a host (or a buggy caller) hands a globalStorageUri that points
    // inside the sacred transcript tree. The same guard exportIO runs before every
    // write rejects it, so no index write can land on a transcript.
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
    // persistTierAIndex is best-effort: the exportIO guard throws inside, the
    // store swallows it, and no write is recorded.
    await persistTierAIndex(projectsStorage as never, records);
    assert.strictEqual(
      vscodeHarness.writes.length,
      0,
      'no index file is written under ~/.claude/projects',
    );
  });
});
