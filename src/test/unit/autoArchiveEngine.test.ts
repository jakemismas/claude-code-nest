import * as assert from 'assert';
import { ChatMessageBody } from '../../claude/bodyReader';
import { MS_PER_DAY } from '../../store/autoArchivePolicy';
import {
  AutoArchiveChat,
  AutoArchiveEngineDeps,
  runAutoArchivePass,
} from '../../store/autoArchiveEngine';

// Headless unit tests for the auto-archive ENGINE (slice s3b-settings-overlay). The
// engine sequences injected seams the pure decision selects; all seams are stubbed
// in memory here, so this exercises the batching, the archive/copy branching, and the
// read-your-writes archivedAt round-trip without vscode or a filesystem. No stub
// needed: the engine imports no vscode.

const NOW = 1_700_000_000_000;

interface Harness {
  deps: AutoArchiveEngineDeps;
  archivedFlag: Set<string>;
  archivedAt: Map<string, number>;
  copies: Map<string, { starred: boolean; archivedAt: number; bodies: ChatMessageBody[] }>;
  flushes: () => number;
  bodyReads: () => number;
}

function harness(existingCopies: string[] = [], now = NOW): Harness {
  const archivedFlag = new Set<string>();
  const archivedAt = new Map<string, number>();
  const copies = new Map<string, { starred: boolean; archivedAt: number; bodies: ChatMessageBody[] }>();
  for (const id of existingCopies) {
    copies.set(id, { starred: true, archivedAt: now - 200 * MS_PER_DAY, bodies: [] });
  }
  let flushCount = 0;
  let bodyReadCount = 0;
  const body: ChatMessageBody[] = [{ role: 'user', text: 'hi', uuid: 'u1' }];
  const deps: AutoArchiveEngineDeps = {
    setArchived: (sessionId) => {
      archivedFlag.add(sessionId);
      // Mirror store.setChatArchived stamping archivedAt on the flip.
      archivedAt.set(sessionId, now);
    },
    flush: () => {
      flushCount++;
      return Promise.resolve();
    },
    readBody: () => {
      bodyReadCount++;
      return body;
    },
    writeBody: (envelope) => {
      copies.set(envelope.sessionId, {
        starred: envelope.starred,
        archivedAt: envelope.archivedAt,
        bodies: envelope.bodies,
      });
      return Promise.resolve(true);
    },
    hasBody: (sessionId) => Promise.resolve(copies.has(sessionId)),
    getArchivedAt: (sessionId) => archivedAt.get(sessionId) ?? null,
    now: () => now,
  };
  return {
    deps,
    archivedFlag,
    archivedAt,
    copies,
    flushes: () => flushCount,
    bodyReads: () => bodyReadCount,
  };
}

function chat(overrides: Partial<AutoArchiveChat>): AutoArchiveChat {
  return {
    sessionId: 's',
    filePath: '/tmp/s.jsonl',
    title: 'A chat',
    lastActivity: NOW - 100 * MS_PER_DAY,
    starred: false,
    archived: false,
    ...overrides,
  };
}

describe('autoArchiveEngine.runAutoArchivePass', () => {
  it('archives every unstarred past-window chat with ONE flush, then writes each copy', async () => {
    const h = harness();
    const chats = [
      chat({ sessionId: 'a', filePath: '/a.jsonl', lastActivity: NOW - 40 * MS_PER_DAY }),
      chat({ sessionId: 'b', filePath: '/b.jsonl', lastActivity: NOW - 60 * MS_PER_DAY }),
      chat({ sessionId: 'c', filePath: '/c.jsonl', lastActivity: NOW - 5 * MS_PER_DAY }), // within window
    ];
    const result = await runAutoArchivePass(h.deps, chats, 30, 30);
    assert.strictEqual(result.archived, 2);
    assert.strictEqual(result.protectiveCopies, 0);
    assert.strictEqual(result.changed, true);
    assert.deepStrictEqual([...h.archivedFlag].sort(), ['a', 'b']);
    // ONE flush for the whole batch (refresh coalescing).
    assert.strictEqual(h.flushes(), 1);
    // A copy was written for each archived chat, carrying the store-stamped archivedAt.
    assert.strictEqual(h.copies.get('a')?.archivedAt, NOW);
    assert.strictEqual(h.copies.get('b')?.archivedAt, NOW);
    assert.strictEqual(h.copies.has('c'), false);
  });

  it('writes a protective copy for a starred past-window chat WITHOUT archiving it', async () => {
    const h = harness();
    const chats = [chat({ sessionId: 's1', starred: true, lastActivity: NOW - 90 * MS_PER_DAY })];
    const result = await runAutoArchivePass(h.deps, chats, 30, 30);
    assert.strictEqual(result.archived, 0);
    assert.strictEqual(result.protectiveCopies, 1);
    assert.strictEqual(result.changed, true);
    assert.strictEqual(h.archivedFlag.has('s1'), false); // never archived
    assert.strictEqual(h.copies.get('s1')?.starred, true);
    // No flag flip -> no flush of the store batch.
    assert.strictEqual(h.flushes(), 0);
  });

  it('is idempotent for a starred chat that already has a copy (no re-copy)', async () => {
    const h = harness(['s1']);
    const chats = [chat({ sessionId: 's1', starred: true, lastActivity: NOW - 90 * MS_PER_DAY })];
    const result = await runAutoArchivePass(h.deps, chats, 30, 30);
    assert.strictEqual(result.protectiveCopies, 0);
    assert.strictEqual(result.changed, false);
    assert.strictEqual(h.bodyReads(), 0); // no body read for the existing copy
  });

  it('does nothing when BOTH windows are disabled (archive=0, protective=0)', async () => {
    const h = harness();
    const chats = [
      chat({ sessionId: 'a', lastActivity: NOW - 999 * MS_PER_DAY }),
      chat({ sessionId: 's', starred: true, lastActivity: NOW - 999 * MS_PER_DAY }),
    ];
    const result = await runAutoArchivePass(h.deps, chats, 0, 0);
    assert.deepStrictEqual(result, { archived: 0, protectiveCopies: 0, changed: false });
    assert.strictEqual(h.archivedFlag.size, 0);
    assert.strictEqual(h.flushes(), 0);
  });

  it('does not archive an unstarred chat when auto-archive is Never (archive=0), even with a protective window', async () => {
    const h = harness();
    const chats = [chat({ sessionId: 'a', lastActivity: NOW - 999 * MS_PER_DAY })];
    const result = await runAutoArchivePass(h.deps, chats, 0, 30);
    assert.strictEqual(result.archived, 0);
    assert.strictEqual(result.protectiveCopies, 0); // protective is starred-only
    assert.strictEqual(h.archivedFlag.size, 0);
    assert.strictEqual(h.copies.has('a'), false);
  });

  it('AC #5: writes a starred protective copy when auto-archive is Never but the protective window is past', async () => {
    const h = harness();
    const chats = [chat({ sessionId: 's1', starred: true, lastActivity: NOW - 90 * MS_PER_DAY })];
    const result = await runAutoArchivePass(h.deps, chats, 0, 30);
    assert.strictEqual(result.archived, 0);
    assert.strictEqual(result.protectiveCopies, 1);
    assert.strictEqual(result.changed, true);
    assert.strictEqual(h.archivedFlag.has('s1'), false); // never archived
    assert.strictEqual(h.copies.get('s1')?.starred, true);
  });

  it('skips an already-archived chat (never re-archives, never re-flushes)', async () => {
    const h = harness();
    const chats = [chat({ sessionId: 'a', archived: true, lastActivity: NOW - 999 * MS_PER_DAY })];
    const result = await runAutoArchivePass(h.deps, chats, 30, 30);
    assert.strictEqual(result.changed, false);
    assert.strictEqual(h.archivedFlag.has('a'), false);
    assert.strictEqual(h.flushes(), 0);
  });

  it('does not let one unreadable transcript abort the pass', async () => {
    const h = harness();
    // Make readBody throw for the first chat only.
    let call = 0;
    h.deps.readBody = () => {
      call++;
      if (call === 1) {
        throw new Error('unreadable');
      }
      return [{ role: 'user', text: 'ok', uuid: 'u2' }];
    };
    const chats = [
      chat({ sessionId: 'a', lastActivity: NOW - 40 * MS_PER_DAY }),
      chat({ sessionId: 'b', lastActivity: NOW - 40 * MS_PER_DAY }),
    ];
    const result = await runAutoArchivePass(h.deps, chats, 30, 30);
    // Both flags flipped (the flag is authoritative and staged before the copy read).
    assert.strictEqual(result.archived, 2);
    assert.deepStrictEqual([...h.archivedFlag].sort(), ['a', 'b']);
    // The second copy still landed even though the first read threw.
    assert.strictEqual(h.copies.has('b'), true);
  });
});

// Security fix pass round 1: the engine threads restoredAt (the deliberate-restore
// intent marker) into the pure policy, so a chat the user restored is not swept by
// the very next pass even though its transcript age is past the window.
describe('runAutoArchivePass: restored chats are not re-archived', () => {
  it('skips a past-window chat with a recent restoredAt and archives its sibling without one', async () => {
    const h = harness();
    const result = await runAutoArchivePass(
      h.deps,
      [
        chat({ sessionId: 'restored', restoredAt: NOW - 1 * MS_PER_DAY }),
        chat({ sessionId: 'stale' }),
      ],
      30,
      30,
    );
    assert.strictEqual(h.archivedFlag.has('restored'), false, 'restored chat must stay live');
    assert.strictEqual(h.archivedFlag.has('stale'), true);
    assert.strictEqual(result.archived, 1);
  });

  it('archives a restored chat once the restore itself is past the window', async () => {
    const h = harness();
    await runAutoArchivePass(
      h.deps,
      [chat({ sessionId: 'old-restore', restoredAt: NOW - 31 * MS_PER_DAY })],
      30,
      30,
    );
    assert.strictEqual(h.archivedFlag.has('old-restore'), true);
  });
});
