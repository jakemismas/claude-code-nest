// Tests for the archived-body store: writes, reads and prunes copies under globalStorage,
// never under the Claude projects dir.

// vscodeStub MUST be imported first so require('vscode') resolves before
// archiveBodyStore's transitive import of exportIO (which imports 'vscode') runs.
import './vscodeStub';
import { vscodeHarness } from './vscodeStub';

import * as assert from 'assert';
import * as path from 'path';
import {
  writeArchivedBody,
  readArchivedBody,
  hasArchivedBody,
  deleteArchivedBody,
  updateStarFlag,
  pruneArchivedBodies,
  archivedBodyPath,
  ArchivePathError,
} from '../../store/archiveBodyStore';
import { ChatMessageBody } from '../../claude/bodyReader';
import {
  ExportPathError,
  assertNotUnderClaudeProjects,
  claudeProjectsRoot,
} from '../../store/exportPathGuard';
import { MS_PER_DAY } from '../../store/archiveRetention';
import { MetadataStore } from '../../store/metadataStore';
import { FakeMemento } from './fakeMemento';

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

  it('REFUSES an empty-bodies envelope (returns false, writes nothing): a transiently unreadable transcript must not mint a permanent empty copy', async () => {
    const ok = await writeArchivedBody(uri(STORAGE) as never, {
      sessionId: 'sess-1',
      title: 'A chat',
      archivedAt: NOW,
      starred: true,
      bodies: [],
    });
    assert.strictEqual(ok, false, 'an empty-bodies write is refused like a storage failure');
    assert.strictEqual(vscodeHarness.writes.length, 0, 'no poisoned envelope lands on disk');
  });

  it('never DOWNGRADES an existing good copy with an empty-bodies rewrite', async () => {
    await writeArchivedBody(uri(STORAGE) as never, {
      sessionId: 'sess-1',
      title: 'A chat',
      archivedAt: NOW,
      starred: false,
      bodies: bodies(),
    });
    const ok = await writeArchivedBody(uri(STORAGE) as never, {
      sessionId: 'sess-1',
      title: 'A chat',
      archivedAt: NOW + 1,
      starred: false,
      bodies: [],
    });
    assert.strictEqual(ok, false);
    const env = await readArchivedBody(uri(STORAGE) as never, 'sess-1');
    assert.ok(env !== null);
    assert.deepStrictEqual(env.bodies, bodies(), 'the good copy survives untouched');
  });
});

describe('archiveBodyStore.hasArchivedBody (envelope-exists is not content-exists)', () => {
  beforeEach(() => vscodeHarness.reset());

  it('reports true for a copy with content and false when absent', async () => {
    await writeArchivedBody(uri(STORAGE) as never, {
      sessionId: 'sess-1',
      title: 't',
      archivedAt: NOW,
      starred: true,
      bodies: bodies(),
    });
    assert.strictEqual(await hasArchivedBody(uri(STORAGE) as never, 'sess-1'), true);
    assert.strictEqual(await hasArchivedBody(uri(STORAGE) as never, 'absent'), false);
  });

  it('treats a LEGACY empty-bodies envelope as ABSENT so the protective-copy pass retries', async () => {
    // Seed the poisoned shape directly (pre-guard installs could have written it).
    vscodeHarness.files.set(
      STORAGE + '/archive/sess-1.json',
      JSON.stringify({
        version: 1,
        sessionId: 'sess-1',
        title: 't',
        archivedAt: NOW,
        starred: true,
        bodies: [],
      }),
    );
    assert.strictEqual(
      await hasArchivedBody(uri(STORAGE) as never, 'sess-1'),
      false,
      'an empty envelope must not satisfy the copy-exists check',
    );
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
      bodies: bodies(),
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
      bodies: bodies(),
    });
    await writeArchivedBody(uri(STORAGE) as never, {
      sessionId: 'old-starred',
      title: 't',
      archivedAt: NOW - 30 * MS_PER_DAY,
      starred: true,
      bodies: bodies(),
    });
    await writeArchivedBody(uri(STORAGE) as never, {
      sessionId: 'fresh',
      title: 't',
      archivedAt: NOW - 1 * MS_PER_DAY,
      starred: false,
      bodies: bodies(),
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

  // A copy can record starred as false while the live synced flag is true; the backstop reads the live flag and forces keep.
  it('does NOT prune a past-window unstarred-on-disk copy that the live backstop protects', async () => {
    await seedThree();
    // old-unstarred's copy snapshot says starred:false, but the live store says the
    // user starred it. The backstop must keep it.
    const liveStarred = new Set<string>(['old-unstarred']);
    const pruned = await pruneArchivedBodies(
      uri(STORAGE) as never,
      7,
      NOW,
      (sessionId) => liveStarred.has(sessionId),
    );
    assert.deepStrictEqual(pruned, [], 'the live-protected copy is kept despite a stale snapshot');
    assert.ok(
      !vscodeHarness.deletes.includes(STORAGE + '/archive/old-unstarred.json'),
      'the starred-live copy was not deleted',
    );
  });

  it('still prunes a past-window copy the live backstop does NOT protect', async () => {
    await seedThree();
    const pruned = await pruneArchivedBodies(uri(STORAGE) as never, 7, NOW, () => false);
    assert.deepStrictEqual(pruned, ['old-unstarred'], 'an unprotected past-window copy still prunes');
  });

  it('fails SAFE (keeps the copy) when the live backstop throws', async () => {
    await seedThree();
    const pruned = await pruneArchivedBodies(uri(STORAGE) as never, 7, NOW, () => {
      throw new Error('store read failed');
    });
    assert.deepStrictEqual(pruned, [], 'a throwing backstop keeps every otherwise-prunable copy');
  });

  // Archive means keep: the backstop force-keeps any chat still userArchived, even unstarred, so a foreign
  // device winning an older archivedAt cannot prune its only copy. This test builds the backstop from a real MetadataStore.
  describe('live backstop force-keeps any userArchived chat, regardless of starred', () => {
    const DEVICE = 'dev-prune-backstop';
    const PK = 'c--Users-Tester-prune-backstop';

    function makeStore(): MetadataStore {
      return new MetadataStore(new FakeMemento(), { deviceId: DEVICE, debounceMs: 0, now: () => NOW });
    }

    // Mirrors the production predicate: keep when the live ChatMeta is still userArchived.
    function liveProtectedFrom(store: MetadataStore): (sessionId: string) => boolean {
      return (sessionId) => store.getProjectMeta(PK).chats[sessionId]?.userArchived === true;
    }

    it('does NOT prune a past-window UNSTARRED copy when the live chat is still userArchived', async () => {
      await seedThree();
      const store = makeStore();
      // The snapshot is unstarred and past the window, but the live store has it archived, so the archive flag alone protects it.
      store.setChatArchived(PK, 'old-unstarred', true);
      await store.flush();
      assert.strictEqual(store.getProjectMeta(PK).chats['old-unstarred'].starred, undefined);

      const pruned = await pruneArchivedBodies(uri(STORAGE) as never, 7, NOW, liveProtectedFrom(store));
      assert.deepStrictEqual(pruned, [], 'an unstarred-but-archived chat is force-kept');
      assert.ok(
        !vscodeHarness.deletes.includes(STORAGE + '/archive/old-unstarred.json'),
        'the only surviving copy of the unstarred archived chat was not deleted',
      );
    });

    it('also keeps a past-window STARRED archived chat (existing starred-kept behavior holds)', async () => {
      await seedThree();
      const store = makeStore();
      // old-starred is archived and starred in the live store; it must stay kept.
      store.setChatStarred(PK, 'old-starred', true);
      store.setChatArchived(PK, 'old-starred', true);
      await store.flush();

      const pruned = await pruneArchivedBodies(uri(STORAGE) as never, 7, NOW, liveProtectedFrom(store));
      assert.ok(!pruned.includes('old-starred'), 'the starred archived chat is still kept');
      assert.ok(!vscodeHarness.deletes.includes(STORAGE + '/archive/old-starred.json'));
    });

    it('still prunes a past-window copy whose live chat is no longer userArchived', async () => {
      await seedThree();
      const store = makeStore();
      // old-unstarred was restored in the live store (userArchived cleared), so the
      // backstop no longer protects it and the lapsed copy is reclaimable.
      store.setChatArchived(PK, 'old-unstarred', true);
      store.setChatArchived(PK, 'old-unstarred', false);
      await store.flush();

      const pruned = await pruneArchivedBodies(uri(STORAGE) as never, 7, NOW, liveProtectedFrom(store));
      assert.deepStrictEqual(pruned, ['old-unstarred'], 'a no-longer-archived lapsed copy still prunes');
    });
  });
});

// The body target resolves under globalStorage, and the exportIO guard rejects a globalStorage that points into ~/.claude/projects/.
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

// A sessionId from an untrusted import can be a path-traversal or prototype-name id. The store validates it and
// asserts the resolved path stays under the archive dir, so an unsafe id is a no-op (no write or delete, null read).
describe('archiveBodyStore refuses an unsafe or escaping sessionId (path-traversal confinement)', () => {
  beforeEach(() => vscodeHarness.reset());

  const VALID = '0a1b2c3d-4e5f-6789-abcd-ef0123456789';

  it('writeArchivedBody writes NOTHING for a path-traversal sessionId and returns false', async () => {
    const ok = await writeArchivedBody(uri(STORAGE) as never, {
      sessionId: '../../../../Users/victim/evil',
      title: 't',
      archivedAt: NOW,
      starred: false,
      bodies: bodies(),
    });
    assert.strictEqual(ok, false, 'an unsafe sessionId write is refused, never throws');
    assert.strictEqual(vscodeHarness.writes.length, 0, 'no file written outside the archive dir');
  });

  it('writeArchivedBody writes NOTHING for a prototype-name sessionId', async () => {
    const ok = await writeArchivedBody(uri(STORAGE) as never, {
      sessionId: 'constructor',
      title: 't',
      archivedAt: NOW,
      starred: false,
      bodies: bodies(),
    });
    assert.strictEqual(ok, false);
    assert.strictEqual(vscodeHarness.writes.length, 0);
  });

  it('readArchivedBody returns null (never throws) for an unsafe sessionId', async () => {
    const env = await readArchivedBody(uri(STORAGE) as never, '../../escape');
    assert.strictEqual(env, null);
  });

  it('deleteArchivedBody is a no-op (no delete, no throw) for an unsafe sessionId', async () => {
    await deleteArchivedBody(uri(STORAGE) as never, '../../escape');
    assert.strictEqual(vscodeHarness.deletes.length, 0, 'nothing deleted outside the archive dir');
  });

  it('a valid UUID sessionId still writes and reads normally (no real data lost)', async () => {
    const ok = await writeArchivedBody(uri(STORAGE) as never, {
      sessionId: VALID,
      title: 'A chat',
      archivedAt: NOW,
      starred: false,
      bodies: bodies(),
    });
    assert.strictEqual(ok, true);
    assert.strictEqual(vscodeHarness.writes[0].path, STORAGE + '/archive/' + VALID + '.json');
    const env = await readArchivedBody(uri(STORAGE) as never, VALID);
    assert.ok(env !== null);
    assert.strictEqual(env.sessionId, VALID);
  });

  it('archivedBodyPath THROWS ArchivePathError for an unsafe sessionId', () => {
    assert.throws(
      () => archivedBodyPath(uri(STORAGE) as never, '../../../etc/passwd'),
      (e: unknown) => e instanceof ArchivePathError,
      'an unsafe sessionId is rejected before a path is built',
    );
    assert.throws(
      () => archivedBodyPath(uri(STORAGE) as never, 'constructor'),
      (e: unknown) => e instanceof ArchivePathError,
    );
  });

  it('archivedBodyPath returns the confined path for a valid sessionId', () => {
    const fsPath = archivedBodyPath(uri(STORAGE) as never, VALID);
    assert.strictEqual(fsPath, STORAGE + '/archive/' + VALID + '.json');
  });
});
