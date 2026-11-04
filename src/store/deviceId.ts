// Per-install device id that stamps metadata writes for last-writer-wins reconcile
// across machines. Persistence goes through DeviceIdStore so the module stays vscode-free.
// The binding must keep the id in a non-synced key: two machines must not share it.

// Minimal string-keyed store that extension.ts adapts from globalState; tests use a fake.
export interface DeviceIdStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

export const DEVICE_ID_KEY = 'nest.deviceId.v1';

// Falls back to a timestamp-plus-random id when crypto.randomUUID is missing, so it never throws.
export function generateDeviceId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  return fallbackId();
}

function fallbackId(): string {
  const time = Date.now().toString(16);
  let rand = '';
  for (let i = 0; i < 24; i++) {
    rand += Math.floor(Math.random() * 16).toString(16);
  }
  return 'dev-' + time + '-' + rand;
}

// Return the persisted id, creating it on first call. The seed applies only at creation
// and never overwrites a persisted id.
export function getOrCreateDeviceId(store: DeviceIdStore, seed?: string): string {
  const existing = store.get(DEVICE_ID_KEY);
  if (typeof existing === 'string' && existing.length > 0) {
    return existing;
  }
  const created = seed && seed.length > 0 ? seed : generateDeviceId();
  store.set(DEVICE_ID_KEY, created);
  return created;
}
