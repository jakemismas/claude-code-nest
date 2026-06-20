// vscodeStub MUST be imported first so require('vscode') resolves before
// archiveBodyStore's transitive import of exportIO (which imports 'vscode') runs.
import './vscodeStub';
import { vscodeHarness } from './vscodeStub';

import * as assert from 'assert';
import * as path from 'path';
import {
  writeArchivedBody,
  readArchivedBody,
  deleteArchivedBody,
  updateStarFlag,
  pruneArchivedBodies,
  archivedBodyPath,
} from '../../store/archiveBodyStore';
import { ChatMessageBody } from '../../claude/bodyReader';
import {
  ExportPathError,
  assertNotUnderClaudeProjects,
  claudeProjectsRoot,
} from '../../store/exportPathGuard';
import { MS_PER_DAY } from '../../store/archiveRetention';

// Headless tests for the vscode-THIN Nest-owned archived-body store
// (src/store/archiveBodyStore.ts). It persists/reads/prunes ONLY through exportIO
// (vscode.workspace.fs, stubbed here) against a globalStorage Uri, never under
// ~/.claude/projects, and never as a synced globalState key. The guard test reuses
// exportPathGuard (the same guard every exportIO write runtime-asserts) to prove
// the target resolves under globalStorage and that a projects-path target is
// rejected. The prune test exercises the pure retention policy over each stored
// copy's recorded {archivedAt, starred}.

function uri(fsPath: string): { fsPath: string; scheme: 'file' } {
  return { fsPath, scheme: 'file' };
}

const STORAGE = '/storage/global';
const NOW = 1_700_000_000_000;

function bodies(): ChatMessageBody[] {
  return [
    { role: 'user', text: 'hello', uuid: 'u1' },
    { role: 'assistant', text: 'hi there', uuid: 'u2' },
  ];
}

describe('archiveBodyStore.writeArchivedBody + readArchivedBody', () => {
  beforeEach(() => vscodeHarness.reset());

  it('writes one copy under <globalStorage>/archive/<sessionId>.json through exportIO', async () => {
    const ok = await writeArchivedBody(uri(STORAGE) as never, {
      sessionId: 'sess-1',
      title: 'A chat',
      archivedAt: NOW,
      starred: false,
      bodies: bodies(),
    });
    assert.strictEqual(ok, true);
    assert.strictEqual(vscodeHarness.writes.length, 1, 'exactly one body file written');
    assert.strictEqual(
      vscodeHarness.writes[0].path,
      STORAGE + '/archive/sess-1.json',
      'copy written under <globalStorage>/archive/, keyed by sessionId',
    );
    // The archive dir is created before the write (ensureDirectory).
    assert.ok(
      vscodeHarness.createdDirs.includes(STORAGE + '/archive'),
      'the archive dir is created first',
    );
  });

  it('round-trips: a written copy reads back with its bodies, title, and retention inputs', async () => {
    await writeArchivedBody(uri(STORAGE) as never, {
      sessionId: 'sess-1',
      title: 'A chat',
      archivedAt: NOW,
      starred: true,
      bodies: bodies(),
    });
    const env = await readArchivedBody(uri(STORAGE) as never, 'sess-1');
    assert.ok(env !== null);
    assert.strictEqual(env.sessionId, 'sess-1');
    assert.strictEqual(env.title, 'A chat');
    assert.strictEqual(env.archivedAt, NOW);
    assert.strictEqual(env.starred, true);
    assert.deepStrictEqual(env.bodies, bodies());
  });

  it('readArchivedBody returns null (never throws) on an absent copy', async () => {
    const env = await readArchivedBody(uri(STORAGE) as never, 'missing');
    assert.strictEqual(env, null);
  });

  it('readArchivedBody returns null on malformed JSON', async () => {
    vscodeHarness.files.set(STORAGE + '/archive/sess-1.json', 'not json {{{');
    const env = await readArchivedBody(uri(STORAGE) as never, 'sess-1');
    assert.strictEqual(env, null);
  });

  it('writeArchivedBody swallows a write failure (best-effort) and returns false', async () => {
    vscodeHarness.writeErrors.add(STORAGE + '/archive/sess-1.json');
    const ok = await writeArchivedBody(uri(STORAGE) as never, {
      sessionId: 'sess-1',
      title: 'A chat',
      archivedAt: NOW,
      starred: false,
      bodies: bodies(),
    });
    assert.strictEqual(ok, false, 'a failed write returns false, never throws');
    assert.strictEqual(vscodeHarness.writes.length, 0);
  });
});

describe('archiveBodyStore.deleteArchivedBody + updateStarFlag', () => {
  beforeEach(() => vscodeHarness.reset());

  it('deletes one copy through exportIO and tolerates an absent copy', async () => {
    await writeArchivedBody(uri(STORAGE) as never, {
      sessionId: 'sess-1',
      title: 't',
      archivedAt: NOW,
      starred: false,
      bodies: [],
    });
    await deleteArchivedBody(uri(STORAGE) as never, 'sess-1');
    assert.ok(
      vscodeHarness.deletes.includes(STORAGE + '/archive/sess-1.json'),
      'the body copy was deleted',
    );
    // Deleting an absent copy is a no-op, never a throw.
    vscodeHarness.deleteErrors.add(STORAGE + '/archive/gone.json');
    await deleteArchivedBody(uri(STORAGE) as never, 'gone');
  });

  it('updateStarFlag flips the recorded starred without rewriting bodies; no-op when no copy', async () => {
    await writeArchivedBody(uri(STORAGE) as never, {
      sessionId: 'sess-1',
      title: 't',
      archivedAt: NOW,
      starred: false,
      bodies: bodies(),
    });
    await updateStarFlag(uri(STORAGE) as never, 'sess-1', true);
    const env = await readArchivedBody(uri(STORAGE) as never, 'sess-1');
    assert.ok(env !== null);
    assert.strictEqual(env.starred, true, 'the star flag was updated on the copy');
    assert.deepStrictEqual(env.bodies, bodies(), 'the bodies were preserved');

    // No copy => no-op (no throw, no write).
    vscodeHarness.reset();
    await updateStarFlag(uri(STORAGE) as never, 'absent', true);
    assert.strictEqual(vscodeHarness.writes.length, 0);
  });
});

describe('archiveBodyStore.pruneArchivedBodies (pure retention over recorded copies)', () => {
  beforeEach(() => vscodeHarness.reset());

  async function seedThree(): Promise<void> {
    // old + unstarred (should prune past a 7d window), old + starred (exempt),
    // fresh + unstarred (within the window).
    await writeArchivedBody(uri(STORAGE) as never, {
      sessionId: 'old-unstarred',
      title: 't',
      archivedAt: NOW - 30 * MS_PER_DAY,
      starred: false,
      bodies: [],
    });
    await writeArchivedBody(uri(STORAGE) as never, {
      sessionId: 'old-starred',
      title: 't',
      archivedAt: NOW - 30 * MS_PER_DAY,
      starred: true,
      bodies: [],
    });
    await writeArchivedBody(uri(STORAGE) as never, {
      sessionId: 'fresh',
      title: 't',
      archivedAt: NOW - 1 * MS_PER_DAY,
      starred: false,
      bodies: [],
    });
    // Make the seeded files listable by the stub's readDirectory (FileType.File=1).
    vscodeHarness.dirEntries.set(STORAGE + '/archive', [
      ['old-unstarred.json', 1],
      ['old-starred.json', 1],
      ['fresh.json', 1],
    ]);
  }

  it('prunes only the past-window UNSTARRED copy under a 7d window', async () => {
    await seedThree();
    const pruned = await pruneArchivedBodies(uri(STORAGE) as never, 7, NOW);
    assert.deepStrictEqual(pruned, ['old-unstarred'], 'only the old unstarred copy is pruned');
    assert.ok(vscodeHarness.deletes.includes(STORAGE + '/archive/old-unstarred.json'));
    assert.ok(!vscodeHarness.deletes.includes(STORAGE + '/archive/old-starred.json'), 'starred exempt');
    assert.ok(!vscodeHarness.deletes.includes(STORAGE + '/archive/fresh.json'), 'fresh kept');
  });

  it('never-window (0) prunes nothing', async () => {
    await seedThree();
    const pruned = await pruneArchivedBodies(uri(STORAGE) as never, 0, NOW);
    assert.deepStrictEqual(pruned, []);
    assert.strictEqual(vscodeHarness.deletes.length, 0);
  });

  it('an empty/absent archive dir prunes nothing and never throws', async () => {
    const pruned = await pruneArchivedBodies(uri(STORAGE) as never, 7, NOW);
    assert.deepStrictEqual(pruned, []);
  });
});

// The GUARD test: the body target resolves under globalStorage, and the same guard
// every exportIO write runs (assertNotUnderClaudeProjects) rejects a pathological
// globalStorage that points into ~/.claude/projects/.
describe('archiveBodyStore target is guarded under globalStorage, never under ~/.claude/projects', () => {
  it('the body file path resolves under the given globalStorage dir', () => {
    const fsPath = archivedBodyPath(uri(STORAGE) as never, 'sess-1');
    assert.strictEqual(fsPath, STORAGE + '/archive/sess-1.json');
    assert.doesNotThrow(() => assertNotUnderClaudeProjects(fsPath));
  });

  it('assertNotUnderClaudeProjects THROWS for a target under ~/.claude/projects (reused guard)', () => {
    const projectsStorage = uri(path.join(claudeProjectsRoot(), 'c--proj'));
    const fsPath = archivedBodyPath(projectsStorage as never, 'sess-1');
    assert.throws(
      () => assertNotUnderClaudeProjects(fsPath),
      (e: unknown) => e instanceof ExportPathError,
      'a projects-path body target is rejected by the guard',
    );
  });

  it('writeArchivedBody aimed under ~/.claude/projects writes NOTHING (the guard fires inside exportIO)', async () => {
    vscodeHarness.reset();
    const projectsStorage = uri(path.join(claudeProjectsRoot(), 'c--proj'));
    const ok = await writeArchivedBody(projectsStorage as never, {
      sessionId: 'sess-1',
      title: 't',
      archivedAt: NOW,
      starred: false,
      bodies: bodies(),
    });
    assert.strictEqual(ok, false, 'the guarded write is swallowed and returns false');
    assert.strictEqual(
      vscodeHarness.writes.length,
      0,
      'no body file is written under ~/.claude/projects',
    );
  });
});
