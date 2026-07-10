import * as assert from 'assert';
import { ReadStateStore, ReadStateMemento, READ_STATE_KEY, READ_STATE_SEEDED_KEY } from '../../views/readState';

// Headless unit tests for the per-device lastSeenAt read-state store. It takes an
// injected Memento (get/update over a JSON string), so no vscode import is needed
// (unit-gate rule). Covers round-trip, the monotonic no-regress rule, corrupt/absent
// tolerance, and the single-key storage shape.

class FakeMemento implements ReadStateMemento {
  private store = new Map<string, string>();
  get(key: string): string | undefined {
    return this.store.get(key);
  }
  update(key: string, value: string): void {
    this.store.set(key, value);
  }
  raw(key: string): string | undefined {
    return this.store.get(key);
  }
}

describe('ReadStateStore round-trip', () => {
  it('an empty store yields an empty map', () => {
    const store = new ReadStateStore(new FakeMemento());
    assert.strictEqual(store.getMap().size, 0);
  });

  it('markSeen persists and getMap returns it', () => {
    const mem = new FakeMemento();
    const store = new ReadStateStore(mem);
    store.markSeen('c1', 1000);
    assert.strictEqual(store.getMap().get('c1'), 1000);
    // Persisted under the single documented key, as a JSON object.
    const raw = mem.raw(READ_STATE_KEY);
    assert.ok(raw && raw.indexOf('c1') !== -1, 'persisted under READ_STATE_KEY');
  });

  it('stores multiple chats under ONE key (single-key shape)', () => {
    const mem = new FakeMemento();
    const store = new ReadStateStore(mem);
    store.markSeen('c1', 1000);
    store.markSeen('c2', 2000);
    const map = store.getMap();
    assert.strictEqual(map.get('c1'), 1000);
    assert.strictEqual(map.get('c2'), 2000);
    const parsed = JSON.parse(mem.raw(READ_STATE_KEY) as string);
    assert.deepStrictEqual(Object.keys(parsed).sort(), ['c1', 'c2']);
  });
});

describe('ReadStateStore monotonic no-regress', () => {
  it('advances lastSeenAt to a newer value', () => {
    const store = new ReadStateStore(new FakeMemento());
    store.markSeen('c1', 1000);
    store.markSeen('c1', 2000);
    assert.strictEqual(store.getMap().get('c1'), 2000);
  });

  it('does NOT regress to an older value (a stale focus event cannot un-see)', () => {
    const store = new ReadStateStore(new FakeMemento());
    store.markSeen('c1', 2000);
    store.markSeen('c1', 1000);
    assert.strictEqual(store.getMap().get('c1'), 2000, 'kept the newer stamp');
  });

  it('keeps the value on an equal re-stamp', () => {
    const store = new ReadStateStore(new FakeMemento());
    store.markSeen('c1', 2000);
    store.markSeen('c1', 2000);
    assert.strictEqual(store.getMap().get('c1'), 2000);
  });
});

describe('ReadStateStore tolerance', () => {
  it('ignores an empty sessionId', () => {
    const mem = new FakeMemento();
    const store = new ReadStateStore(mem);
    store.markSeen('', 1000);
    assert.strictEqual(store.getMap().size, 0);
    assert.strictEqual(mem.raw(READ_STATE_KEY), undefined, 'no write for an empty id');
  });

  it('treats a corrupt JSON value as an empty map', () => {
    const mem = new FakeMemento();
    mem.update(READ_STATE_KEY, '{not json');
    const store = new ReadStateStore(mem);
    assert.strictEqual(store.getMap().size, 0);
  });

  it('drops non-numeric, non-finite, or non-positive values', () => {
    const mem = new FakeMemento();
    mem.update(
      READ_STATE_KEY,
      JSON.stringify({ good: 5, str: 'x', zero: 0, neg: -3, nan: null }),
    );
    const store = new ReadStateStore(mem);
    const map = store.getMap();
    assert.strictEqual(map.get('good'), 5);
    assert.strictEqual(map.has('str'), false);
    assert.strictEqual(map.has('zero'), false);
    assert.strictEqual(map.has('neg'), false);
    assert.strictEqual(map.has('nan'), false);
  });

  it('treats a JSON array (wrong shape) as an empty map', () => {
    const mem = new FakeMemento();
    mem.update(READ_STATE_KEY, JSON.stringify([1, 2, 3]));
    const store = new ReadStateStore(mem);
    assert.strictEqual(store.getMap().size, 0);
  });
});

// The persistence-sink id gate (security fix pass round 3): markSeen writes the
// whole lastSeenAt map back to the memento, so an id that is not in the safe
// record-id shape (the shape every real transcript-filename sessionId has) must
// be rejected AT THE SINK. A tampered webview 'open' message or a foreign
// extension invoking the open command with a multi-megabyte or garbage id would
// otherwise grow workspaceState without bound.
describe('ReadStateStore markSeen id gate (safe record-id shape at the sink)', () => {
  it('rejects an oversized id (no write, no map growth)', () => {
    const mem = new FakeMemento();
    const store = new ReadStateStore(mem);
    store.markSeen('a'.repeat(65), 1000);
    assert.strictEqual(store.getMap().size, 0);
    assert.strictEqual(mem.raw(READ_STATE_KEY), undefined, 'no write for an oversized id');
  });

  it('rejects a multi-megabyte id without persisting it', () => {
    const mem = new FakeMemento();
    const store = new ReadStateStore(mem);
    store.markSeen('x'.repeat(2 * 1024 * 1024), 1000);
    assert.strictEqual(mem.raw(READ_STATE_KEY), undefined);
  });

  it('rejects prototype-name and traversal-shaped ids', () => {
    const mem = new FakeMemento();
    const store = new ReadStateStore(mem);
    for (const bad of ['constructor', '__proto__', '../../../evil', 'a b', 'a.b']) {
      store.markSeen(bad, 1000);
    }
    assert.strictEqual(store.getMap().size, 0);
    assert.strictEqual(mem.raw(READ_STATE_KEY), undefined);
  });

  it('accepts a real UUID-shaped sessionId unchanged', () => {
    const mem = new FakeMemento();
    const store = new ReadStateStore(mem);
    store.markSeen('01890c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', 1000);
    assert.strictEqual(store.getMap().get('01890c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e'), 1000);
  });
});

// The one-time first-run seed (issue #123): every chat present at the first scan is
// marked read at its own last-activity timestamp, exactly once, so pre-existing
// chats never light the unread dot while later assistant activity still does.
describe('ReadStateStore first-run seed (issue #123)', () => {
  const records = [
    { sessionId: 'old-1', timestamp: 1000 },
    { sessionId: 'old-2', timestamp: 2000 },
    { sessionId: 'no-ts', timestamp: null },
  ];

  it('seeds every scanned chat once and sets the flag', () => {
    const mem = new FakeMemento();
    const store = new ReadStateStore(mem);
    const ran = store.seedIfFirstRun(records, 9999);
    assert.strictEqual(ran, true);
    const map = store.getMap();
    assert.strictEqual(map.get('old-1'), 1000, 'seeded at its own timestamp');
    assert.strictEqual(map.get('old-2'), 2000, 'seeded at its own timestamp');
    assert.strictEqual(map.get('no-ts'), 9999, 'null timestamp falls back to now');
    assert.strictEqual(mem.raw(READ_STATE_SEEDED_KEY), 'true');
  });

  it('is a no-op once the flag is set (a later scan cannot re-seed)', () => {
    const mem = new FakeMemento();
    const store = new ReadStateStore(mem);
    assert.strictEqual(store.seedIfFirstRun(records, 9999), true);
    const ranAgain = store.seedIfFirstRun(
      [{ sessionId: 'new-chat', timestamp: 5000 }],
      10000,
    );
    assert.strictEqual(ranAgain, false);
    assert.strictEqual(
      store.getMap().get('new-chat'),
      undefined,
      'a chat scanned after the seed stays unseen until a real clear trigger',
    );
  });

  it('a newer assistant message still reads unread after the seed', () => {
    const store = new ReadStateStore(new FakeMemento());
    store.seedIfFirstRun([{ sessionId: 'c1', timestamp: 1000 }], 9999);
    // The rowStatus predicate shows unread when record.timestamp > seenAt; a
    // message at 1500 is newer than the seeded 1000.
    const seenAt = store.getMap().get('c1');
    assert.ok(seenAt !== undefined && 1500 > seenAt);
  });

  it('never regresses a lastSeenAt the user already advanced past the scan', () => {
    const mem = new FakeMemento();
    const store = new ReadStateStore(mem);
    store.markSeen('c1', 5000);
    store.seedIfFirstRun([{ sessionId: 'c1', timestamp: 1000 }], 9999);
    assert.strictEqual(store.getMap().get('c1'), 5000);
  });

  it('skips empty or invalid session ids without throwing', () => {
    const store = new ReadStateStore(new FakeMemento());
    const ran = store.seedIfFirstRun(
      [{ sessionId: '', timestamp: 1000 }, { sessionId: 'ok', timestamp: 2000 }],
      9999,
    );
    assert.strictEqual(ran, true);
    const map = store.getMap();
    assert.strictEqual(map.size, 1);
    assert.strictEqual(map.get('ok'), 2000);
  });
});
