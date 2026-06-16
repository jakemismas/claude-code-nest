// A headless fake of the store's SyncMemento structural seam, used by the store
// unit tests. It implements the same interface the real context.globalState
// satisfies (get/update/keys/setKeysForSync), with no vscode import, so the store
// is exercised exactly as in production but against an in-memory map. It also
// captures every setKeysForSync registration so a test can assert the refreshed
// union when a new project key first appears.

import { SyncMemento } from '../../store/metadataStore';

export class FakeMemento implements SyncMemento {
  private readonly data = new Map<string, unknown>();

  // The history of every setKeysForSync call, newest last. Each entry is the
  // exact key array the store registered on that call.
  readonly syncRegistrations: string[][] = [];

  // Count of update() calls, used to prove writes are coalesced (debounced).
  updateCount = 0;

  // Optional async gate. When set, update() applies the write to the in-memory
  // map only AFTER this hook's returned promise resolves, mimicking a real
  // globalState.update that does not land synchronously. Used to reproduce a
  // mutation arriving while a write is in flight.
  onUpdate: ((key: string, value: unknown) => Promise<void>) | null = null;

  get<T>(key: string): T | undefined {
    return this.data.has(key) ? (this.data.get(key) as T) : undefined;
  }

  update(key: string, value: unknown): Thenable<void> {
    this.updateCount++;
    const apply = (): void => {
      if (value === undefined) {
        this.data.delete(key);
      } else {
        // Deep-copy on write to mimic the platform's JSON round-trip and to
        // ensure a stored value is never aliased to a caller's live object.
        this.data.set(key, JSON.parse(JSON.stringify(value)));
      }
    };
    if (this.onUpdate) {
      return this.onUpdate(key, value).then(apply);
    }
    apply();
    return Promise.resolve();
  }

  keys(): readonly string[] {
    return Array.from(this.data.keys());
  }

  setKeysForSync(keys: readonly string[]): void {
    this.syncRegistrations.push([...keys]);
  }

  // The most recent registered sync-key set, or [] if none.
  lastSyncRegistration(): string[] {
    return this.syncRegistrations.length === 0
      ? []
      : this.syncRegistrations[this.syncRegistrations.length - 1];
  }

  // Directly seed a stored value (bypassing update()), for migration tests that
  // need to plant an older or malformed document.
  seed(key: string, value: unknown): void {
    this.data.set(key, value);
  }
}
