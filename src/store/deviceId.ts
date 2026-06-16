// The per-install device id used to stamp ProjectMeta writes for last-writer-wins
// reconcile across machines.
//
// This module is vscode-free so it stays unit-testable under the headless gate
// (ARCHITECTURE.md build contract: unit modules must not import vscode). The real
// vscode binding (context.globalState as the persistent store, optionally seeded
// from vscode.env.machineId) is supplied only in extension.ts through the
// injected DeviceIdStore seam below.
//
// Persistence rule: the device id is generated once per install and persisted, so
// every stamp from one machine carries a stable id. It is read through the seam,
// and if absent, generated and written back through the same seam. The id itself
// is local-install identity and is fine to keep in the (synced) globalState
// because two machines must NOT share it; we therefore namespace it under a key
// the store registers for sync only if asked. By default the binding in
// extension.ts persists it under a NON-synced key so each install keeps its own.

// A minimal persistence seam for the device id: a getter and a setter over some
// string-keyed store. extension.ts adapts context.globalState (or any Memento) to
// this; tests supply an in-memory fake.
export interface DeviceIdStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

// The persistence key for the device id.
export const DEVICE_ID_KEY = 'nest.deviceId.v1';

// Generate a new random id. Uses crypto.randomUUID when available (Node 16.7+,
// always present in the VSCode 1.66 Electron runtime) and falls back to a
// timestamp-plus-random composite otherwise so the module never throws.
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

// Read the persisted device id, generating and persisting one on first call.
// Deterministic thereafter for the life of the install. An optional seed (e.g.
// vscode.env.machineId) is used only when generating for the first time, letting
// the binding prefer a stable machine-derived id; when omitted a random id is
// generated. The seed is never used to OVERWRITE an already-persisted id.
export function getOrCreateDeviceId(store: DeviceIdStore, seed?: string): string {
  const existing = store.get(DEVICE_ID_KEY);
  if (typeof existing === 'string' && existing.length > 0) {
    return existing;
  }
  const created = seed && seed.length > 0 ? seed : generateDeviceId();
  store.set(DEVICE_ID_KEY, created);
  return created;
}
