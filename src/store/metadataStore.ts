// MetadataStore: CRUD over the per-project ProjectMeta documents, backed by a
// structural Memento-plus-sync seam.
//
// This module is vscode-free (ARCHITECTURE.md build contract). It depends on the
// locally-declared SyncMemento structural interface below, NOT on the vscode
// module. extension.ts adapts the real context.globalState (which structurally
// satisfies get/update/setKeysForSync) to SyncMemento at the call site, and the
// headless unit suite supplies a fake implementing the same interface.
//
// Binding rules honored (ARCHITECTURE.md "Sync architecture"):
// - One synced globalState key per project, `nest.meta.v1::<projectKey>`.
// - All project keys registered with setKeysForSync, REFRESHED when a new project
//   key first appears (the union of every known nest.meta.v1::<projectKey> is
//   recomputed and re-registered).
// - Per-project and per-record updatedAt + deviceId stamps written on every
//   mutation, for cross-machine last-writer-wins reconcile.
// - Writes are DEBOUNCED and SERIALIZED: rapid mutations coalesce into one
//   persisted write, and writes never interleave (last-writer-wins within this
//   process is enforced by serializing through a single in-flight promise chain).
// - Orphan-reconcile state is LOCAL ONLY and lives on a separate, non-synced
//   document; this store never registers the local key for sync.

import {
  ChatMeta,
  Folder,
  Link,
  LocalChatState,
  LocalProjectMeta,
  ProjectMeta,
  Tag,
  emptyLocalProjectMeta,
  emptyProjectMeta,
  isMetaKey,
  metaKeyFor,
  migrateProjectMeta,
} from './schema';
import { shadowKeyFor } from './reconcileSync';

// The structural store seam. A real context.globalState satisfies this: get and
// update are the Memento contract, and setKeysForSync is the extra method VSCode
// adds on the global Memento. keys() lets the store rebuild the setKeysForSync
// union from every persisted meta key. Declared here, NOT imported from vscode,
// so the store and its tests stay headless.
export interface SyncMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
  keys(): readonly string[];
  setKeysForSync(keys: readonly string[]): void;
}

// A clock seam so tests get deterministic stamps. Defaults to Date.now.
export type Clock = () => number;

export interface MetadataStoreOptions {
  // The per-install device id stamped onto every write.
  deviceId: string;
  // Debounce window in ms for coalescing writes. Defaults to 150ms. Tests pass 0
  // for synchronous flush behavior under a fake timer-free run.
  debounceMs?: number;
  // Injected clock for deterministic stamps in tests.
  now?: Clock;
}

// The non-synced key prefix for the LOCAL companion document (orphan state). It
// deliberately does NOT start with the META_KEY_PREFIX, so isMetaKey is false for
// it and it is never swept into setKeysForSync.
const LOCAL_KEY_PREFIX = 'nest.local.v1';
const LOCAL_KEY_SEPARATOR = '::';

function localKeyFor(projectKey: string): string {
  return LOCAL_KEY_PREFIX + LOCAL_KEY_SEPARATOR + projectKey;
}

export class MetadataStore {
  private readonly memento: SyncMemento;
  private readonly deviceId: string;
  private readonly debounceMs: number;
  private readonly now: Clock;

  // The set of project keys this store has already registered for sync. Used to
  // detect a NEW project key so setKeysForSync is refreshed only when the union
  // actually changes.
  private readonly syncedProjectKeys = new Set<string>();

  // Pending in-memory documents per project key, awaiting a debounced flush. The
  // store always serves reads from this map first so a caller sees its own
  // not-yet-flushed writes immediately (read-your-writes within the process).
  private readonly pending = new Map<string, ProjectMeta>();

  // Documents drained out of `pending` and currently being persisted on the
  // write chain (the in-flight batch). Reads and mutations consult this AFTER
  // pending but BEFORE the Memento, so a mutation that lands while a write is
  // in flight builds on the drained-but-not-yet-persisted value instead of the
  // stale Memento. An entry is removed only once its memento.update resolves.
  private readonly inFlight = new Map<string, ProjectMeta>();

  // The single serialized write chain. Every drain awaits the previous one, so
  // persisted writes never interleave and the last queued state wins. quiescent
  // always resolves once both the debounce timer has fired (or been forced) and
  // the chain has drained the pending map.
  private writeChain: Promise<void> = Promise.resolve();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // The serialized write chain for the LOCAL (non-synced) companion document.
  // SEPARATE from the synced writeChain so a local orphan-state write never
  // shares a chain step (or a coalescing window) with synced data. Every local
  // mutation queues its whole read-modify-write here, so two overlapping
  // setLocalChatState calls cannot each read the live document before the
  // other's update lands and then clobber it; the second op reads the value the
  // first already persisted. Like writeChain it is kept resolved (never
  // rejecting) so one failed local update cannot wedge later local writes.
  private localWriteChain: Promise<void> = Promise.resolve();

  constructor(memento: SyncMemento, options: MetadataStoreOptions) {
    this.memento = memento;
    this.deviceId = options.deviceId;
    this.debounceMs = options.debounceMs ?? 150;
    this.now = options.now ?? Date.now;
    this.primeSyncKeysFromMemento();
  }

  // On construction, register every project key already persisted in the Memento.
  // This re-establishes the full setKeysForSync union after a window reload so a
  // project that was synced last session stays synced this session.
  private primeSyncKeysFromMemento(): void {
    let changed = false;
    for (const key of this.memento.keys()) {
      if (isMetaKey(key)) {
        const projectKey = key.slice(metaKeyFor('').length);
        if (!this.syncedProjectKeys.has(projectKey)) {
          this.syncedProjectKeys.add(projectKey);
          changed = true;
        }
      }
    }
    if (changed) {
      this.refreshSyncKeys();
    }
  }

  // Recompute and re-register the full union of synced meta keys. Called whenever
  // a new project key first appears (refresh-on-new-key per ARCHITECTURE.md).
  private refreshSyncKeys(): void {
    const keys: string[] = [];
    for (const projectKey of this.syncedProjectKeys) {
      keys.push(metaKeyFor(projectKey));
    }
    this.memento.setKeysForSync(keys);
  }

  // Register a project key for sync if it is new, refreshing the union. The local
  // companion key is NEVER registered (orphan state stays local).
  private ensureSyncRegistered(projectKey: string): void {
    if (this.syncedProjectKeys.has(projectKey)) {
      return;
    }
    this.syncedProjectKeys.add(projectKey);
    this.refreshSyncKeys();
  }

  // Read the current synced document for a project, migrating a stored value to
  // the current schema and serving any pending in-memory state first. Always
  // returns a well-formed ProjectMeta (empty when nothing is stored). Reading
  // does NOT register the key for sync; only a write does, because reading a
  // never-written project should not expand the sync surface.
  getProjectMeta(projectKey: string): ProjectMeta {
    return this.cloneForMutation(this.readBase(projectKey));
  }

  // The current authoritative document for a project, without a defensive copy.
  // Resolution order: a staged pending write (read-your-writes), then a
  // drained-but-not-yet-persisted in-flight write (so a mutation during an
  // in-flight write never reverts to the stale Memento), then the persisted
  // Memento value. INTERNAL: callers must not mutate the result; getProjectMeta
  // wraps this in a structural clone for outside consumers.
  private readBase(projectKey: string): ProjectMeta {
    const pending = this.pending.get(projectKey);
    if (pending) {
      return pending;
    }
    const inFlight = this.inFlight.get(projectKey);
    if (inFlight) {
      return inFlight;
    }
    const raw = this.memento.get<unknown>(metaKeyFor(projectKey));
    return migrateProjectMeta(raw, this.deviceId, this.now());
  }

  // Read the LOCAL companion document (orphan state). Never synced.
  getLocalProjectMeta(projectKey: string): LocalProjectMeta {
    const raw = this.memento.get<LocalProjectMeta>(localKeyFor(projectKey));
    if (raw && typeof raw === 'object' && raw.chats) {
      // Defensive copy: never hand back the live stored reference, so a caller
      // that mutates the result cannot corrupt the staged or persisted value.
      return JSON.parse(JSON.stringify(raw)) as LocalProjectMeta;
    }
    return emptyLocalProjectMeta();
  }

  // ---- Synced mutations. Each stamps the touched record and the project, then
  // ---- schedules a debounced serialized flush.

  upsertFolder(projectKey: string, folder: Folder): void {
    this.mutate(projectKey, (meta) => {
      meta.folders[folder.id] = { ...folder };
    });
  }

  deleteFolder(projectKey: string, folderId: string): void {
    this.mutate(projectKey, (meta) => {
      delete meta.folders[folderId];
      // Detach any chat whose home was this folder. Each detached chat is
      // re-stamped so the change wins on reconcile.
      for (const chat of Object.values(meta.chats)) {
        if (chat.folderId === folderId) {
          chat.folderId = null;
          this.stampRecord(chat);
        }
      }
    });
  }

  upsertTag(projectKey: string, tag: Tag): void {
    this.mutate(projectKey, (meta) => {
      meta.tags[tag.id] = { ...tag };
    });
  }

  deleteTag(projectKey: string, tagId: string): void {
    this.mutate(projectKey, (meta) => {
      delete meta.tags[tagId];
      for (const chat of Object.values(meta.chats)) {
        const next = chat.tags.filter((t) => t !== tagId);
        if (next.length !== chat.tags.length) {
          chat.tags = next;
          this.stampRecord(chat);
        }
      }
    });
  }

  // Set a chat's single home folder (null to unfile). Creates the chat record if
  // absent.
  setChatFolder(projectKey: string, chatId: string, folderId: string | null): void {
    this.mutate(projectKey, (meta) => {
      const chat = this.ensureChat(meta, chatId);
      chat.folderId = folderId;
      this.stampRecord(chat);
    });
  }

  addChatTag(projectKey: string, chatId: string, tagId: string): void {
    this.mutate(projectKey, (meta) => {
      const chat = this.ensureChat(meta, chatId);
      if (!chat.tags.includes(tagId)) {
        chat.tags.push(tagId);
        this.stampRecord(chat);
      }
    });
  }

  removeChatTag(projectKey: string, chatId: string, tagId: string): void {
    this.mutate(projectKey, (meta) => {
      const chat = this.ensureChat(meta, chatId);
      const next = chat.tags.filter((t) => t !== tagId);
      if (next.length !== chat.tags.length) {
        chat.tags = next;
        this.stampRecord(chat);
      }
    });
  }

  addLink(projectKey: string, chatId: string, link: Link): void {
    this.mutate(projectKey, (meta) => {
      const chat = this.ensureChat(meta, chatId);
      const exists = chat.links.some(
        (l) => l.targetChatId === link.targetChatId && l.kind === link.kind,
      );
      if (!exists) {
        chat.links.push({ ...link });
        this.stampRecord(chat);
      }
    });
  }

  removeLink(projectKey: string, chatId: string, targetChatId: string, kind: Link['kind']): void {
    this.mutate(projectKey, (meta) => {
      const chat = this.ensureChat(meta, chatId);
      const next = chat.links.filter(
        (l) => !(l.targetChatId === targetChatId && l.kind === kind),
      );
      if (next.length !== chat.links.length) {
        chat.links = next;
        this.stampRecord(chat);
      }
    });
  }

  // Replace the whole synced document for a project in one stamped write. Used by
  // the sync-reconcile slice; here it is the primitive the granular mutations and
  // the reconcile scaffolding build on. The supplied document is re-stamped at
  // the project level.
  putProjectMeta(projectKey: string, meta: ProjectMeta): void {
    // Deep-copy the supplied collections so the staged pending document never
    // aliases the caller's live objects (a later caller mutation must not leak
    // into the store before the next flush). mutate then re-stamps the project.
    const copy = JSON.parse(JSON.stringify(meta)) as ProjectMeta;
    this.mutate(projectKey, (current) => {
      current.schemaVersion = copy.schemaVersion;
      current.folders = copy.folders;
      current.tags = copy.tags;
      current.chats = copy.chats;
      // Carry the forward-compat escrow: prefer the supplied document's
      // __unknown, else keep whatever the current document already escrowed, so
      // a whole-document replace on a newer-schema project does not strip the
      // foreign machine's unrecognized fields.
      if (copy.__unknown !== undefined) {
        current.__unknown = copy.__unknown;
      }
    });
  }

  // ---- Local (non-synced) orphan-state mutation. Written through a dedicated
  // ---- serialized chain (localWriteChain), NOT debounced through the synced
  // ---- chain, because orphan state is local and small and must never share a
  // ---- write with synced data. Serializing matters because the live Memento is
  // ---- the only source of truth for the local document (there is no pending /
  // ---- inFlight read cache for it): without serialization two overlapping
  // ---- async calls each read the document before the other's update resolves
  // ---- and the second whole-document put silently drops the first's change.

  // Replace the whole local companion document. Queued on the local write chain
  // so it never interleaves with a concurrent setLocalChatState read-modify-write
  // for the same project. The document is deep-copied at enqueue time so a later
  // caller mutation cannot leak into the staged value before it persists.
  putLocalProjectMeta(projectKey: string, local: LocalProjectMeta): Promise<void> {
    const copy = JSON.parse(JSON.stringify(local)) as LocalProjectMeta;
    return this.enqueueLocalWrite(() =>
      this.memento.update(localKeyFor(projectKey), copy),
    );
  }

  // Set one chat's orphan state. The read of the current document and the write
  // back happen INSIDE one chained step, so when two of these overlap the second
  // reads the document the first already persisted (rather than the stale value
  // captured before the first's update resolved) and folds its change on top
  // instead of overwriting it.
  setLocalChatState(projectKey: string, chatId: string, state: LocalChatState): Promise<void> {
    // Snapshot the requested state at call time so a later caller mutation of the
    // passed object cannot change what is staged.
    const snapshot = JSON.parse(JSON.stringify(state)) as LocalChatState;
    return this.enqueueLocalWrite(() => {
      const local = this.getLocalProjectMeta(projectKey);
      local.chats[chatId] = snapshot;
      return this.memento.update(localKeyFor(projectKey), local);
    });
  }

  // Append an operation to the serialized local write chain and return a promise
  // that resolves (or rejects) with THIS operation's outcome, while keeping the
  // shared chain tail resolved so one failed local write cannot wedge later ones
  // (mirrors the synced chain's poison-resistance). The op runs only after every
  // previously-queued local op has settled, giving each read-modify-write a
  // consistent view of the just-persisted document.
  private enqueueLocalWrite(op: () => Thenable<void>): Promise<void> {
    const run = this.localWriteChain.then(() => op());
    // Advance the shared tail off a swallowed copy so a rejection here does not
    // poison the chain for the next caller; the rejection still surfaces to THIS
    // caller through `run`.
    this.localWriteChain = run.then(
      () => undefined,
      () => undefined,
    );
    return Promise.resolve(run);
  }

  // Resolve once every queued LOCAL write has settled. Tests and shutdown await
  // this to reach a quiescent local document. Never rejects (the chain tail is
  // kept resolved).
  flushLocal(): Promise<void> {
    return this.localWriteChain.then(
      () => undefined,
      () => undefined,
    );
  }

  // ---- Internals.

  private ensureChat(meta: ProjectMeta, chatId: string): ChatMeta {
    let chat = meta.chats[chatId];
    if (!chat) {
      chat = {
        folderId: null,
        tags: [],
        links: [],
        updatedAt: this.now(),
        deviceId: this.deviceId,
      };
      meta.chats[chatId] = chat;
    }
    return chat;
  }

  private stampRecord(chat: ChatMeta): void {
    chat.updatedAt = this.now();
    chat.deviceId = this.deviceId;
  }

  // Apply a mutation against the current (pending-or-stored) document, stamp the
  // project, register the key for sync if new, stage the result in the pending
  // map, and schedule a debounced flush. Read-your-writes is immediate; the
  // persisted write is coalesced.
  private mutate(projectKey: string, fn: (meta: ProjectMeta) => void): void {
    this.ensureSyncRegistered(projectKey);
    const current = this.cloneForMutation(this.readBase(projectKey));
    fn(current);
    current.updatedAt = this.now();
    current.deviceId = this.deviceId;
    this.pending.set(projectKey, current);
    this.scheduleFlush();
  }

  private cloneForMutation(meta: ProjectMeta): ProjectMeta {
    // A structural clone so a staged pending document is never aliased to the
    // value previously returned to a reader. The shapes are plain JSON.
    return JSON.parse(JSON.stringify(meta)) as ProjectMeta;
  }

  private scheduleFlush(): void {
    // Always DEFER the drain (never drain inline in mutate), so a burst of
    // synchronous mutations coalesces into one write and a read between them
    // still sees pending. With debounceMs <= 0 the drain is deferred to a macro
    // task (setTimeout 0) rather than fired inline, which keeps the pending map
    // populated for any same-tick read and still coalesces the burst.
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    const delay = this.debounceMs <= 0 ? 0 : this.debounceMs;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.drainPending();
    }, delay);
  }

  // Drain the pending map onto the serialized write chain in ONE chained step.
  // The snapshot is taken at drain time so any mutation that lands after this
  // call is left in pending for the next drain (and is captured by a subsequent
  // flush). The chain guarantees no two drains interleave and the last queued
  // state for a key persists. Returns the chain tail so flush() can await it.
  //
  // Failure handling: the chain tail ALWAYS resolves, never rejects. A rejected
  // memento.update (a transient Settings Sync write failure, disk full, locked
  // storage, quota) must not poison the chain: if it did, every later
  // `this.writeChain.then(...)` would chain off a rejected promise, its callback
  // would never run, and the entire metadata store would silently stop
  // persisting for the rest of the session. Instead each key is written under
  // try/catch; a failed key is RE-STAGED into pending (unless a newer mutation
  // for that key already superseded it) and a flush is rescheduled, so the write
  // is retried on the next debounce tick rather than lost. The in-flight entry
  // is always cleared so it cannot leak.
  private drainPending(): Promise<void> {
    if (this.pending.size === 0) {
      return this.writeChain;
    }
    const batch = new Map(this.pending);
    this.pending.clear();
    // Move the batch into the in-flight map BEFORE clearing it from the read
    // path, so a mutation that lands between now and the update resolving still
    // reads this drained value (not the stale Memento) and folds its change on
    // top. Without this, the new mutation would build from the old persisted
    // value and silently overwrite the drained-but-unpersisted change.
    for (const [projectKey, meta] of batch) {
      this.inFlight.set(projectKey, meta);
    }
    // Tolerate a previously-rejected tail (defensive; this method already keeps
    // the tail resolved): start from a resolved continuation so a poisoned chain
    // can never block a future drain's callback from running.
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      let anyRequeued = false;
      for (const [projectKey, meta] of batch) {
        try {
          await this.memento.update(metaKeyFor(projectKey), meta);
        } catch {
          // The persisted write failed. If no later mutation has superseded this
          // key in pending, re-stage this drained value so the next flush retries
          // it; if pending already holds a newer value, that newer value wins and
          // we drop this stale one. Either way the write is not silently lost.
          if (!this.pending.has(projectKey)) {
            this.pending.set(projectKey, meta);
          }
          anyRequeued = true;
        }
        // Clear the in-flight entry only if a LATER drain has not already
        // replaced it with a newer value for this key (identity guard); the
        // newer entry must stay readable until its own update resolves. On a
        // failure the re-staged pending entry now backstops the read path.
        if (this.inFlight.get(projectKey) === meta) {
          this.inFlight.delete(projectKey);
        }
      }
      if (anyRequeued) {
        // Reschedule so a retry actually fires. flush() also loops on a
        // non-empty pending map, so an awaiting flush still completes once the
        // retry drains (or keeps retrying on a persistent failure).
        this.scheduleFlush();
      }
    });
    return this.writeChain;
  }

  // Force any pending debounced write to persist now and resolve once the
  // serialized chain is fully drained. Tests and shutdown call this to await a
  // quiescent store. Robust to a mutation that lands during the await: it loops
  // until both the debounce timer is clear and nothing is pending.
  //
  // Bounded against a persistently-failing memento: drainPending re-stages a key
  // whose update rejected, so a memento that always rejects would keep pending
  // non-empty forever. flush() therefore caps the number of retry rounds; once
  // the cap is hit it returns rather than spinning, leaving the still-pending
  // entries staged for a later debounce tick or the next flush. flush() never
  // rejects (the chain tail never rejects), so a caller awaiting shutdown is not
  // blocked by a storage fault.
  async flush(): Promise<void> {
    const MAX_RETRY_ROUNDS = 5;
    let rounds = 0;
    for (;;) {
      if (this.debounceTimer !== null) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
      const tail = this.drainPending();
      await tail;
      if (this.pending.size === 0 && this.debounceTimer === null) {
        return;
      }
      // A non-empty pending map after a drain means either a normal mutation
      // landed mid-await (drain it) or a write failed and was re-staged (retry
      // it). Cap the retries so a persistent storage fault cannot hang flush().
      if (++rounds >= MAX_RETRY_ROUNDS) {
        return;
      }
    }
  }

  // The set of project keys currently registered for sync. Exposed for the
  // refresh-on-new-key unit test and for diagnostics.
  registeredSyncProjectKeys(): string[] {
    return Array.from(this.syncedProjectKeys);
  }

  // Every project key with a PERSISTED synced document, plus any staged
  // pending/in-flight key not yet on disk. The union is what export-all
  // enumerates: it reflects the on-disk Memento (every nest.meta.v1::* key) so a
  // project synced in a prior session but not yet touched this session is still
  // exported. De-duplicated. Used by exportImportCommands; not a sync mutation.
  allProjectKeys(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (projectKey: string): void => {
      if (!seen.has(projectKey)) {
        seen.add(projectKey);
        out.push(projectKey);
      }
    };
    for (const key of this.memento.keys()) {
      if (isMetaKey(key)) {
        add(key.slice(metaKeyFor('').length));
      }
    }
    for (const projectKey of this.pending.keys()) {
      add(projectKey);
    }
    for (const projectKey of this.inFlight.keys()) {
      add(projectKey);
    }
    return out;
  }

  // ---- The cross-machine reconcile SHADOW (local-only, non-synced). The shadow
  // ---- records what THIS device last wrote or saw for a project's synced value,
  // ---- so a focus/activation poll can diff the live synced value against it and
  // ---- detect a foreign-device wholesale-replace (reconcileSync.ts). It is read
  // ---- and written under SHADOW_KEY_PREFIX, which does NOT start with
  // ---- META_KEY_PREFIX, so isMetaKey is false and it is never registered for
  // ---- sync. Written through the dedicated local write chain (same serialization
  // ---- discipline as orphan state), NOT the synced debounced chain.

  // Read the stored shadow for a project. Returns the raw stored value (or
  // undefined when absent); reconcileSync.coerceShadow validates it. A defensive
  // copy is returned so a caller cannot corrupt the staged or persisted value.
  getSyncShadow(projectKey: string): unknown {
    const raw = this.memento.get<unknown>(shadowKeyFor(projectKey));
    if (raw === undefined || raw === null) {
      return undefined;
    }
    return JSON.parse(JSON.stringify(raw));
  }

  // Persist the shadow for a project under the non-synced shadow key. Queued on
  // the local write chain so it never interleaves with a concurrent local write
  // and never shares the synced debounced window. The value is deep-copied at
  // enqueue time so a later caller mutation cannot leak into the staged value.
  putSyncShadow(projectKey: string, shadow: unknown): Promise<void> {
    const copy = JSON.parse(JSON.stringify(shadow)) as unknown;
    return this.enqueueLocalWrite(() =>
      this.memento.update(shadowKeyFor(projectKey), copy),
    );
  }

  // Dispose: cancel the debounce timer and force any staged writes to persist.
  // Returns the flush promise so a caller that can await teardown (a
  // deactivate() that returns a Thenable) does not lose a write staged within
  // the debounce window at shutdown. The timer is cleared first so flush()'s own
  // drain loop is the only path that persists. Best-effort: if the host tears
  // the process down before the chain settles the platform may still drop the
  // tail, but a window close that awaits deactivate() will persist.
  dispose(): Promise<void> {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    // Await BOTH chains: the synced debounced writes and any in-flight local
    // orphan-state writes, so neither is lost in the shutdown window.
    return Promise.all([this.flush(), this.flushLocal()]).then(() => undefined);
  }
}

// Default factory: a store with the production 150ms debounce.
export function createMetadataStore(
  memento: SyncMemento,
  deviceId: string,
): MetadataStore {
  return new MetadataStore(memento, { deviceId });
}

export { emptyProjectMeta };
