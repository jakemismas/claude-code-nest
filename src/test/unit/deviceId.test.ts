import * as assert from 'assert';
import {
  DEVICE_ID_KEY,
  DeviceIdStore,
  generateDeviceId,
  getOrCreateDeviceId,
} from '../../store/deviceId';

// Pure-logic unit tests for the per-install device id. The persistence is an
// injected getter/setter seam (no vscode import), exactly as in production where
// extension.ts supplies the globalState binding.

class FakeStore implements DeviceIdStore {
  private readonly map = new Map<string, string>();
  setCalls = 0;
  get(key: string): string | undefined {
    return this.map.get(key);
  }
  set(key: string, value: string): void {
    this.setCalls++;
    this.map.set(key, value);
  }
}

describe('deviceId.generateDeviceId', () => {
  it('generates a non-empty id', () => {
    assert.ok(generateDeviceId().length > 0);
  });
  it('generates distinct ids across calls', () => {
    assert.notStrictEqual(generateDeviceId(), generateDeviceId());
  });
});

describe('deviceId.getOrCreateDeviceId', () => {
  it('generates and persists a new id on first call', () => {
    const store = new FakeStore();
    const id = getOrCreateDeviceId(store);
    assert.ok(id.length > 0);
    assert.strictEqual(store.get(DEVICE_ID_KEY), id);
    assert.strictEqual(store.setCalls, 1);
  });

  it('returns the persisted id on subsequent calls without re-persisting', () => {
    const store = new FakeStore();
    const first = getOrCreateDeviceId(store);
    const second = getOrCreateDeviceId(store);
    assert.strictEqual(first, second);
    assert.strictEqual(store.setCalls, 1);
  });

  it('uses a supplied seed for the first generation', () => {
    const store = new FakeStore();
    const id = getOrCreateDeviceId(store, 'machine-abc');
    assert.strictEqual(id, 'machine-abc');
    assert.strictEqual(store.get(DEVICE_ID_KEY), 'machine-abc');
  });

  it('never overwrites an already-persisted id with a seed', () => {
    const store = new FakeStore();
    getOrCreateDeviceId(store, 'first-seed');
    const second = getOrCreateDeviceId(store, 'different-seed');
    assert.strictEqual(second, 'first-seed');
    assert.strictEqual(store.setCalls, 1);
  });

  it('ignores an empty seed and generates instead', () => {
    const store = new FakeStore();
    const id = getOrCreateDeviceId(store, '');
    assert.ok(id.length > 0);
    assert.notStrictEqual(id, '');
  });
});
