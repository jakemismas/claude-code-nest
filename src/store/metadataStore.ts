// MetadataStore: per-project ProjectMeta documents over a structural Memento seam, so the
// store stays vscode-free. Writes are debounced, serialized and stamped with updatedAt and
// deviceId for cross-machine last-writer-wins. Orphan state lives in a local document that is never synced.

import {
  ChatMeta,
  Folder,
  Link,
  LocalChatState,
  LocalProjectMeta,
  ProjectMeta,
  Tag,
  emptyLocalProjectMeta,
  normalizeOrganizeLedger,
  OrganizeLedger,
  clampName,
  emptyProjectMeta,
  isMetaKey,
  isSafeProjectKey,
  isSafeRecordId,
  metaKeyFor,
  migrateProjectMeta,
  nullProtoMaps,
} from './schema';
import {
  SyncShadow,
  coerceShadow,
  reconcileProjectSync,
  shadowKeyFor,
} from './reconcileSync';
import { mergeProjectMeta } from './exportImport';

// Structural subset of the vscode global Memento; declared here so the store stays headless.
export interface SyncMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
  keys(): readonly string[];
  setKeysForSync(keys: readonly string[]): void;
}

export type Clock = () => number;

export interface MetadataStoreOptions {
  deviceId: string;
  // Debounce window in ms for coalescing writes (default 150). Tests pass 0.
  debounceMs?: number;
  // Clock for deterministic stamps in tests.
  now?: Clock;
}

// Does not start with the meta key prefix, so isMetaKey is false and the key is never synced.
const LOCAL_KEY_PREFIX = 'nest.local.v1';
const LOCAL_KEY_SEPARATOR = '::';

// Sentinel for "no stored value"; a JSON encoding never starts with a space, so it cannot collide.
const NO_STORED_VALUE = ' absent';

function localKeyFor(projectKey: string): string {
  return LOCAL_KEY_PREFIX + LOCAL_KEY_SEPARATOR + projectKey;
}

export class MetadataStore {
  private readonly memento: SyncMemento;
  private readonly deviceId: string;
  private readonly debounceMs: number;
  private readonly now: Clock;

  // Keys already registered for sync, so setKeysForSync refreshes only when the union changes.
  private readonly syncedProjectKeys = new Set<string>();

  // Staged documents awaiting the debounced flush; reads check here first (read-your-writes).
  private readonly pending = new Map<string, ProjectMeta>();

  // Documents being persisted on the write chain. Read after pending so a mutation during a write
  // builds on this value, not the stale Memento.
  private readonly inFlight = new Map<string, ProjectMeta>();

  // JSON of the Memento value last read or written per key. drainPending diffs the live value
  // against it; a mismatch means a Settings Sync write landed unseen, so it merges instead of overwriting.
  private readonly mementoBelief = new Map<string, string>();

  // JSON of the Memento value this device last wrote or classified as its own, per key. New
  // chains root through reconciledBase against it, so a foreign value that landed before the
  // first read is merged, not adopted. Plain reads never update it.
  private readonly lastAdopted = new Map<string, string>();

  // Serialized write chain: drains never interleave and the last queued state wins.
  private writeChain: Promise<void> = Promise.resolve();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Separate chain for the local document, so each read-modify-write sees the previous write.
  // Kept resolved so one failed update cannot wedge later ones.
  private localWriteChain: Promise<void> = Promise.resolve();

  constructor(memento: SyncMemento, options: MetadataStoreOptions) {
    this.memento = memento;
    this.deviceId = options.deviceId;
    this.debounceMs = options.debounceMs ?? 150;
    this.now = options.now ?? Date.now;
    this.primeSyncKeysFromMemento();
  }

  // Re-registers keys persisted in a prior session. A legacy key failing isSafeProjectKey is
  // quarantined (not registered, enumerated or writable) and left untouched in the Memento.
  private primeSyncKeysFromMemento(): void {
    let changed = false;
    for (const key of this.memento.keys()) {
      if (isMetaKey(key)) {
        const projectKey = key.slice(metaKeyFor('').length);
        if (!isSafeProjectKey(projectKey)) {
          continue;
        }
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

  private refreshSyncKeys(): void {
    const keys: string[] = [];
    for (const projectKey of this.syncedProjectKeys) {
      keys.push(metaKeyFor(projectKey));
    }
    this.memento.setKeysForSync(keys);
  }

  // Never called for the local companion key.
  private ensureSyncRegistered(projectKey: string): void {
    if (this.syncedProjectKeys.has(projectKey)) {
      return;
    }
    this.syncedProjectKeys.add(projectKey);
    this.refreshSyncKeys();
  }

  // Reading does not register the key for sync; only a write does, so a never-written project
  // does not widen the sync surface.
  getProjectMeta(projectKey: string): ProjectMeta {
    // Plain clone so id-keyed maps compare as ordinary JSON; cloneForMutation builds the null-prototype copy.
    return JSON.parse(JSON.stringify(this.readBase(projectKey))) as ProjectMeta;
  }

  // Resolves pending, then in-flight, then the Memento. No copy: callers must not mutate it.
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
    // Records the Memento value this read rooted on, for the drain's foreign-write diff.
    this.mementoBelief.set(
      projectKey,
      raw === undefined ? NO_STORED_VALUE : JSON.stringify(raw),
    );
    return migrateProjectMeta(raw, this.deviceId, this.now());
  }

  // Root for every new pending chain and for the import plan. A staged key is served as-is.
  // Otherwise the raw Memento value is diffed against lastAdopted (the shadow on first touch):
  // a self-write or unchanged value is adopted verbatim, so a deletion from another window of
  // this profile is honored; a foreign value is served as an additive merge, so records it
  // dropped are restored. lastAdopted advances only when the drain persists, so a crash
  // before then leaves detection intact.
  private reconciledBase(projectKey: string): ProjectMeta {
    if (this.pending.has(projectKey) || this.inFlight.has(projectKey)) {
      return this.readBase(projectKey);
    }
    const raw = this.memento.get<unknown>(metaKeyFor(projectKey));
    const rawJson = raw === undefined ? NO_STORED_VALUE : JSON.stringify(raw);
    // Same root bookkeeping as readBase.
    this.mementoBelief.set(projectKey, rawJson);
    const live = migrateProjectMeta(raw, this.deviceId, this.now());
    const adopted = this.lastAdopted.get(projectKey);
    if (adopted === rawJson) {
      return live;
    }
    let shadow: SyncShadow | null;
    if (adopted !== undefined && adopted !== NO_STORED_VALUE) {
      // Fresher than the persistent shadow, which only advances on a poll.
      shadow = {
        meta: migrateProjectMeta(JSON.parse(adopted), this.deviceId, this.now()),
        deviceId: this.deviceId,
      };
    } else {
      // First touch this session: fall back to the shadow the reconcile poll maintains.
      shadow = coerceShadow(this.memento.get<unknown>(shadowKeyFor(projectKey)));
    }
    const outcome = reconcileProjectSync(projectKey, live, shadow, this.deviceId);
    if (outcome.kind !== 'foreign-merge') {
      this.lastAdopted.set(projectKey, rawJson);
      return live;
    }
    return outcome.result.merged;
  }

  // Defensive clone for callers that write a derived document back wholesale (the import plan).
  // The poll must use getProjectMeta: it needs the raw live value to classify a foreign write.
  getReconciledProjectMeta(projectKey: string): ProjectMeta {
    return JSON.parse(JSON.stringify(this.reconciledBase(projectKey))) as ProjectMeta;
  }

  getLocalProjectMeta(projectKey: string): LocalProjectMeta {
    const raw = this.memento.get<LocalProjectMeta>(localKeyFor(projectKey));
    if (raw && typeof raw === 'object' && raw.chats) {
      // Copy so a caller cannot corrupt the staged or persisted value.
      return JSON.parse(JSON.stringify(raw)) as LocalProjectMeta;
    }
    return emptyLocalProjectMeta();
  }

  // Synced mutators stamp the record and project, then schedule a debounced flush. Each returns
  // false when a sink gate rejects an unsafe project key or record id, so callers that finalize
  // the sync shadow can skip it. True means staged, not changed.

  upsertFolder(projectKey: string, folder: Folder): boolean {
    // Reject unsafe ids (prototype names, path tokens, over-long values) before they index the map.
    if (!isSafeRecordId(folder.id)) {
      return false;
    }
    return this.mutate(projectKey, (meta) => {
      // Clamp at the write sink so no caller can store a name that breaks the Settings Sync item.
      meta.folders[folder.id] = { ...folder, name: clampName(folder.name) };
    });
  }

  deleteFolder(projectKey: string, folderId: string): boolean {
    if (!isSafeRecordId(folderId)) {
      return false;
    }
    return this.mutate(projectKey, (meta) => {
      delete meta.folders[folderId];
      // Re-stamp each detached chat so the change wins on reconcile.
      for (const chat of Object.values(meta.chats)) {
        if (chat.folderId === folderId) {
          chat.folderId = null;
          this.stampRecord(chat);
        }
      }
    });
  }

  upsertTag(projectKey: string, tag: Tag): boolean {
    if (!isSafeRecordId(tag.id)) {
      return false;
    }
    return this.mutate(projectKey, (meta) => {
      // Clamp at the write sink, as in upsertFolder.
      meta.tags[tag.id] = { ...tag, label: clampName(tag.label) };
    });
  }

  deleteTag(projectKey: string, tagId: string): boolean {
    if (!isSafeRecordId(tagId)) {
      return false;
    }
    return this.mutate(projectKey, (meta) => {
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

  // A non-null folderId must be a safe id because it references the folders map. Null (unfile) is always allowed.
  setChatFolder(projectKey: string, chatId: string, folderId: string | null): boolean {
    if (folderId !== null && !isSafeRecordId(folderId)) {
      return false;
    }
    return this.mutate(projectKey, (meta) => {
      const chat = this.ensureChat(meta, chatId);
      if (chat === null) {
        return;
      }
      chat.folderId = folderId;
      this.stampRecord(chat);
    });
  }

  addChatTag(projectKey: string, chatId: string, tagId: string): boolean {
    if (!isSafeRecordId(tagId)) {
      return false;
    }
    return this.mutate(projectKey, (meta) => {
      const chat = this.ensureChat(meta, chatId);
      if (chat === null) {
        return;
      }
      if (!chat.tags.includes(tagId)) {
        chat.tags.push(tagId);
        this.stampRecord(chat);
      }
    });
  }

  removeChatTag(projectKey: string, chatId: string, tagId: string): boolean {
    return this.mutate(projectKey, (meta) => {
      const chat = this.ensureChat(meta, chatId);
      if (chat === null) {
        return;
      }
      const next = chat.tags.filter((t) => t !== tagId);
      if (next.length !== chat.tags.length) {
        chat.tags = next;
        this.stampRecord(chat);
      }
    });
  }

  addLink(projectKey: string, chatId: string, link: Link): boolean {
    // Reject an unsafe target, as with chatId.
    if (!isSafeRecordId(link.targetChatId)) {
      return false;
    }
    return this.mutate(projectKey, (meta) => {
      const chat = this.ensureChat(meta, chatId);
      if (chat === null) {
        return;
      }
      const exists = chat.links.some(
        (l) => l.targetChatId === link.targetChatId && l.kind === link.kind,
      );
      if (!exists) {
        chat.links.push({ ...link });
        this.stampRecord(chat);
      }
    });
  }

  removeLink(projectKey: string, chatId: string, targetChatId: string, kind: Link['kind']): boolean {
    return this.mutate(projectKey, (meta) => {
      const chat = this.ensureChat(meta, chatId);
      if (chat === null) {
        return;
      }
      const next = chat.links.filter(
        (l) => !(l.targetChatId === targetChatId && l.kind === kind),
      );
      if (next.length !== chat.links.length) {
        chat.links = next;
        this.stampRecord(chat);
      }
    });
  }

  setChatStarred(projectKey: string, chatId: string, starred: boolean): boolean {
    return this.mutate(projectKey, (meta) => {
      const chat = this.ensureChat(meta, chatId);
      if (chat === null) {
        return;
      }
      chat.starred = starred;
      this.stampRecord(chat);
    });
  }

  // archivedAt and restoredAt travel with the flag; restoredAt marks deliberate restore, which
  // auto-archive treats as activity. An automated flip must not refresh the per-record stamp:
  // a background pass would otherwise beat an unsynced user edit in LWW. The archive group
  // still propagates through the merge's loser fallback.
  setChatArchived(
    projectKey: string,
    chatId: string,
    archived: boolean,
    options?: { automated?: boolean },
  ): boolean {
    const automated = options?.automated === true;
    return this.mutate(projectKey, (meta) => {
      const existed = meta.chats[chatId] !== undefined;
      const chat = this.ensureChat(meta, chatId);
      if (chat === null) {
        return;
      }
      chat.userArchived = archived;
      if (archived) {
        chat.archivedAt = this.now();
        delete chat.restoredAt;
      } else {
        delete chat.archivedAt;
        chat.restoredAt = this.now();
      }
      if (!automated) {
        this.stampRecord(chat);
      } else if (!existed) {
        // Stamp 0 so a user-created record for the same chat on another device wins LWW.
        chat.updatedAt = 0;
      }
    });
  }

  // An unknown folder is a no-op; folders are created via upsertFolder.
  setFolderColor(projectKey: string, folderId: string, color: string | null): boolean {
    if (!isSafeRecordId(folderId)) {
      return false;
    }
    return this.mutate(projectKey, (meta) => {
      const folder = meta.folders[folderId];
      if (!folder) {
        return;
      }
      if (color === null || color === undefined) {
        delete folder.color;
      } else {
        folder.color = color;
      }
    });
  }

  // Replaces the whole document in one stamped write (sync reconcile and import). Returns false
  // when rejected; callers must check it before finalizing the sync shadow, or a lossy foreign
  // value becomes last-known-good.
  putProjectMeta(projectKey: string, meta: ProjectMeta): boolean {
    // Deep copy so the staged document never aliases the caller's objects.
    const copy = nullProtoMaps(JSON.parse(JSON.stringify(meta)) as ProjectMeta);
    return this.mutate(projectKey, (current) => {
      current.schemaVersion = copy.schemaVersion;
      current.folders = copy.folders;
      current.tags = copy.tags;
      current.chats = copy.chats;
      // Keep unrecognized fields from a newer schema so a replace does not strip them.
      if (copy.__unknown !== undefined) {
        current.__unknown = copy.__unknown;
      }
    });
  }

  // Local mutations use a dedicated serialized chain, not the debounced one. The Memento is the
  // only source for the local document, so overlapping read-modify-writes would drop each
  // other's changes.

  // Queued on the local chain; deep-copied at enqueue so later caller mutation cannot leak in.
  putLocalProjectMeta(projectKey: string, local: LocalProjectMeta): Promise<void> {
    const copy = JSON.parse(JSON.stringify(local)) as LocalProjectMeta;
    return this.enqueueLocalWrite(() => {
      // A replacement that carries no organize ledger keeps the one already stored:
      // the orphan reconcile builds its document without it.
      if (copy.organize === undefined) {
        const kept = this.getOrganizeLedger(projectKey);
        if (kept !== null) {
          copy.organize = kept;
        }
      }
      return this.memento.update(localKeyFor(projectKey), copy);
    });
  }

  getOrganizeLedger(projectKey: string): OrganizeLedger | null {
    return normalizeOrganizeLedger(this.getLocalProjectMeta(projectKey).organize);
  }

  // Runs on the local chain, so it never interleaves with an orphan state write.
  setOrganizeLedger(projectKey: string, ledger: OrganizeLedger | null): Promise<void> {
    if (!isSafeProjectKey(projectKey)) {
      return Promise.resolve();
    }
    const copy = ledger === null ? null : (JSON.parse(JSON.stringify(ledger)) as OrganizeLedger);
    return this.enqueueLocalWrite(() => {
      const local = this.getLocalProjectMeta(projectKey);
      if (copy === null) {
        delete local.organize;
      } else {
        local.organize = copy;
      }
      return this.memento.update(localKeyFor(projectKey), local);
    });
  }

  // Read and write happen in one chained step, so overlapping calls fold on top of each other.
  setLocalChatState(projectKey: string, chatId: string, state: LocalChatState): Promise<void> {
    // Snapshot at call time so a later caller mutation cannot change what is staged.
    const snapshot = JSON.parse(JSON.stringify(state)) as LocalChatState;
    return this.enqueueLocalWrite(() => {
      const local = this.getLocalProjectMeta(projectKey);
      local.chats[chatId] = snapshot;
      return this.memento.update(localKeyFor(projectKey), local);
    });
  }

  // The shared tail stays resolved so one failed write cannot wedge later ones; this caller
  // still receives its own outcome.
  private enqueueLocalWrite(op: () => Thenable<void>): Promise<void> {
    const run = this.localWriteChain.then(() => op());
    // Swallow the rejection on the tail only; `run` still surfaces it.
    this.localWriteChain = run.then(
      () => undefined,
      () => undefined,
    );
    return Promise.resolve(run);
  }

  // Resolves once all queued local writes settle; never rejects.
  flushLocal(): Promise<void> {
    return this.localWriteChain.then(
      () => undefined,
      () => undefined,
    );
  }


  // Chat-id chokepoint: null for an unsafe id, since a chat key also reaches the archive body-file path.
  private ensureChat(meta: ProjectMeta, chatId: string): ChatMeta | null {
    if (!isSafeRecordId(chatId)) {
      return null;
    }
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

  // Applies fn to the current document, stamps the project, stages the result and schedules a
  // flush. Returns false when the project key is rejected.
  private mutate(projectKey: string, fn: (meta: ProjectMeta) => void): boolean {
    // Every write mints a globalState key and registers it for sync with no removal path, so
    // reject illegal keys here for all callers.
    if (!isSafeProjectKey(projectKey)) {
      return false;
    }
    this.ensureSyncRegistered(projectKey);
    // Root on the reconciled base so a foreign value is merged before the local edit instead of
    // being laundered into a self-write.
    const current = this.cloneForMutation(this.reconciledBase(projectKey));
    fn(current);
    current.updatedAt = this.now();
    current.deviceId = this.deviceId;
    this.pending.set(projectKey, current);
    this.scheduleFlush();
    return true;
  }

  private cloneForMutation(meta: ProjectMeta): ProjectMeta {
    // Clone, then rebuild the maps with a null prototype: the JSON round-trip restores Object.prototype.
    return nullProtoMaps(JSON.parse(JSON.stringify(meta)) as ProjectMeta);
  }

  private scheduleFlush(): void {
    // Always defer the drain (setTimeout 0 when debounceMs <= 0) so a burst coalesces and a
    // same-tick read still sees pending.
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    const delay = this.debounceMs <= 0 ? 0 : this.debounceMs;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.drainPending();
    }, delay);
  }

  // Moves pending onto the serialized chain in one step; later mutations stay in pending for
  // the next drain. The tail always resolves: a rejected update must not poison the chain, so
  // a failed key is re-staged for retry on the next debounce tick.
  private drainPending(): Promise<void> {
    if (this.pending.size === 0) {
      return this.writeChain;
    }
    const batch = new Map(this.pending);
    this.pending.clear();
    // Move to in-flight before clearing pending, so a mutation during the write builds on this
    // value, not the stale Memento.
    for (const [projectKey, meta] of batch) {
      this.inFlight.set(projectKey, meta);
    }
    // Start from a resolved continuation so a rejected tail cannot block later drains.
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      let anyRequeued = false;
      for (const [projectKey, meta] of batch) {
        // A mismatch with the recorded belief means a foreign write landed since staging. Merge
        // additively (ours as base) instead of overwriting it; no await sits between this read
        // and the update.
        let toWrite = meta;
        const believed = this.mementoBelief.get(projectKey);
        if (believed !== undefined) {
          const currentRaw = this.memento.get<unknown>(metaKeyFor(projectKey));
          const currentJson =
            currentRaw === undefined ? NO_STORED_VALUE : JSON.stringify(currentRaw);
          if (currentJson !== believed) {
            const foreign = migrateProjectMeta(currentRaw, this.deviceId, this.now());
            toWrite = mergeProjectMeta(projectKey, meta, foreign).merged;
            // Keep reads serving the merged value while the write is in flight.
            if (this.inFlight.get(projectKey) === meta) {
              this.inFlight.set(projectKey, toWrite);
            }
          }
        }
        try {
          await this.memento.update(metaKeyFor(projectKey), toWrite);
          const writtenJson = JSON.stringify(toWrite);
          this.mementoBelief.set(projectKey, writtenJson);
          // Record as adopted so the next chain root does not reclassify our own write.
          this.lastAdopted.set(projectKey, writtenJson);
        } catch {
          // Re-stage for retry unless a newer mutation already superseded this value.
          if (!this.pending.has(projectKey)) {
            this.pending.set(projectKey, toWrite);
          }
          anyRequeued = true;
        }
        // Clear only if a later drain has not replaced the entry (identity check).
        const inFlightNow = this.inFlight.get(projectKey);
        if (inFlightNow === meta || inFlightNow === toWrite) {
          this.inFlight.delete(projectKey);
        }
      }
      if (anyRequeued) {
        // Reschedule so the retry fires.
        this.scheduleFlush();
      }
    });
    return this.writeChain;
  }

  // Persists pending writes now and resolves when the chain is drained. Retry rounds are capped
  // so a persistently failing Memento cannot hang shutdown; it never rejects.
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
      // Non-empty pending means a mid-await mutation or a re-staged failure; retry, capped.
      if (++rounds >= MAX_RETRY_ROUNDS) {
        return;
      }
    }
  }

  // Exposed for tests and diagnostics.
  registeredSyncProjectKeys(): string[] {
    return Array.from(this.syncedProjectKeys);
  }

  // Persisted keys plus staged keys not yet on disk, so export-all includes projects synced in a
  // prior session but untouched in this one.
  allProjectKeys(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (projectKey: string): void => {
      // Quarantine legacy-invalid keys (see primeSyncKeysFromMemento): they are unwritable, and
      // enumerating one would let the reconcile poll finalize a lossy value as last-known-good.
      if (!isSafeProjectKey(projectKey)) {
        return;
      }
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

  // The sync shadow records what this device last wrote or saw per project, so the poll can detect
  // a foreign wholesale replace. Its key does not start with the meta prefix, so it is never
  // synced, and it writes through the local chain.

  // Raw value; coerceShadow validates it. Returns a copy so callers cannot corrupt the stored value.
  getSyncShadow(projectKey: string): unknown {
    const raw = this.memento.get<unknown>(shadowKeyFor(projectKey));
    if (raw === undefined || raw === null) {
      return undefined;
    }
    return JSON.parse(JSON.stringify(raw));
  }

  // Queued on the local chain; deep-copied at enqueue so later caller mutation cannot leak in.
  putSyncShadow(projectKey: string, shadow: unknown): Promise<void> {
    const copy = JSON.parse(JSON.stringify(shadow)) as unknown;
    return this.enqueueLocalWrite(() =>
      this.memento.update(shadowKeyFor(projectKey), copy),
    );
  }

  // Returns the flush promise so a deactivate() that awaits it does not lose a write staged in the
  // debounce window. The timer is cleared first so flush() is the only persisting path.
  dispose(): Promise<void> {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    // Await both chains so neither synced nor local writes are lost at shutdown.
    return Promise.all([this.flush(), this.flushLocal()]).then(() => undefined);
  }
}

export { emptyProjectMeta };
