import * as assert from 'assert';
import { ReadStateStore, ReadStateMemento, READ_STATE_KEY } from '../../views/readState';

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
