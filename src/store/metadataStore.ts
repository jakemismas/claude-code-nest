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
  clampName,
  emptyProjectMeta,
  isMetaKey,
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

// Sentinel recorded in mementoBelief for "the Memento holds no value for this
// key". Distinct from every JSON.stringify result (a JSON encoding never starts
// with a space character), so an absent value can never be confused with a
// stored one.
const NO_STORED_VALUE = ' absent';

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

  // FOREIGN-WRITE DETECTION AT THE DRAIN (security fix pass round 2): the JSON
  // encoding of the raw Memento value this store last READ (readBase) or WROTE
  // (drainPending) per project key, i.e. the value the staged pending chain is
  // rooted on. A Settings Sync write can land in the Memento at ANY time with no
  // change event; the reconcile barrier (extension.ts) closes the window for
  // automated writers BEFORE they stage, but the classification and the drain
  // are separated by awaits (the mutate debounce, per-chat fs reads), so a
  // foreign value can still land BETWEEN staging and the drain's
  // memento.update. Without this map the drain would overwrite that foreign
  // value wholesale before any reconcile ever read it, and the next poll would
  // launder the clobber into a self-write (the drained doc carries this
  // device's stamps). drainPending diffs the live Memento value against this
  // belief just before writing; on a mismatch it diverts to an additive merge
  // (mergeProjectMeta, ours as base so ties keep the local edit) instead of a
  // blind write, so the foreign document's records survive to be classified by
  // the NEXT reconcile poll (their foreign per-record stamps mark the merged
  // value as a foreign write, so the LWW warning still surfaces).
  private readonly mementoBelief = new Map<string, string>();

  // FOREIGN-WRITE DETECTION AT THE CHAIN ROOT (security fix pass round 3): the
  // JSON encoding of the last Memento value this device WROTE (drainPending) or
  // POSITIVELY CLASSIFIED as its own / already reconciled (reconciledBase), per
  // project key. Distinct from mementoBelief, which records what the current
  // pending chain was ROOTED ON regardless of provenance: a plain read of a
  // just-landed foreign value updates mementoBelief (so the drain's
  // check-then-act diff stays quiet about it), which is exactly how the round-2
  // guard could still launder a foreign value that landed BEFORE the root read.
  // In that gap a user curation action roots its chain on the foreign value F,
  // mutate() re-stamps the project with THIS device's id, the drain sees
  // belief==current and blind-writes F+edit, and the next reconcile poll has no
  // project-level foreign signal left; when F was produced solely by another
  // device's no-stamp automated archive flips it has no chat-level signal
  // either, so the poll adopts the lossy value as a self-write and local-only
  // records are gone for good. lastAdopted closes that root gap: every new
  // pending chain roots through reconciledBase, which diffs the raw Memento
  // value against lastAdopted (falling back to the persistent sync shadow on
  // first touch) and classifies a mismatch with the SAME reconcile the poll
  // uses, so a foreign root is additively merged (records the foreign value
  // dropped are restored, LWW arbitrates scalars) BEFORE the local edit is
  // applied on top. Plain reads never update this map, so they can never bless
  // a foreign value as adopted.
  private readonly lastAdopted = new Map<string, string>();

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
    // Hand readers a plain structural clone, preserving the historical public
    // contract that the id-keyed maps serialize/compare as ordinary JSON objects.
    // The null-prototype backstop is applied to the INTERNAL staging copy that
    // mutations index into (cloneForMutation, via mutate), not to this read copy,
    // so a reader's deepStrictEqual against a bare {} still holds.
    return JSON.parse(JSON.stringify(this.readBase(projectKey))) as ProjectMeta;
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
    // Record what the Memento held at the moment this read rooted a new pending
    // chain (or served a plain read): the drain's foreign-write diff compares the
    // live Memento against THIS belief, so a Settings Sync value that lands after
    // this read and before the drain is detected and merged, never clobbered.
    this.mementoBelief.set(
      projectKey,
      raw === undefined ? NO_STORED_VALUE : JSON.stringify(raw),
    );
    return migrateProjectMeta(raw, this.deviceId, this.now());
  }

  // The current document RECONCILED AGAINST THE FOREIGN-WRITE SIGNAL, without a
  // defensive copy. This is the ROOT every new pending chain builds on (mutate),
  // and the read the import plan builds from (getReconciledProjectMeta). When
  // the key is already staged (pending/in-flight) the chain was reconciled when
  // it rooted, so the staged value is served as-is. Otherwise the raw Memento
  // value is diffed against lastAdopted (the last value this device wrote or
  // classified; the persistent sync shadow backs the first touch of a session),
  // and a mismatch is classified with reconcileProjectSync, the SAME
  // classification the focus/activation poll uses:
  //   - self-write / adopt / unchanged: the value is ours or there is nothing
  //     local to protect; adopt it (record lastAdopted) and serve it verbatim.
  //     A same-device write from ANOTHER WINDOW of this profile lands here, so
  //     a deletion made in that window is honored, never resurrected by merge.
  //   - foreign-merge: another install produced the value; serve the ADDITIVE
  //     merge (base = last-known-good, incoming = foreign live) so records the
  //     foreign wholesale-replace dropped are restored and per-record LWW
  //     arbitrates scalars, exactly as the poll would have reconciled had it
  //     run first. lastAdopted is deliberately NOT advanced: the merged result
  //     only becomes adopted when the drain persists it, so a crash before the
  //     drain leaves detection intact for the next session (via the shadow).
  // The sync shadow itself is never touched here; the next poll still
  // classifies the persisted merge (the foreign records keep their stamps) and
  // surfaces the LWW warning where one applies.
  private reconciledBase(projectKey: string): ProjectMeta {
    if (this.pending.has(projectKey) || this.inFlight.has(projectKey)) {
      return this.readBase(projectKey);
    }
    const raw = this.memento.get<unknown>(metaKeyFor(projectKey));
    const rawJson = raw === undefined ? NO_STORED_VALUE : JSON.stringify(raw);
    // Root marker for the drain's round-2 check-then-act diff (same bookkeeping
    // readBase performs when it serves the Memento).
    this.mementoBelief.set(projectKey, rawJson);
    const live = migrateProjectMeta(raw, this.deviceId, this.now());
    const adopted = this.lastAdopted.get(projectKey);
    if (adopted === rawJson) {
      return live;
    }
    let shadow: SyncShadow | null;
    if (adopted !== undefined && adopted !== NO_STORED_VALUE) {
      // In-session last-known-good: fresher than the persistent shadow (which
      // only advances on a poll), so windows between polls are covered.
      shadow = {
        meta: migrateProjectMeta(JSON.parse(adopted), this.deviceId, this.now()),
        deviceId: this.deviceId,
      };
    } else {
      // First touch this session (or the key was absent when last seen): fall
      // back to the persistent shadow the reconcile poll maintains.
      shadow = coerceShadow(this.memento.get<unknown>(shadowKeyFor(projectKey)));
    }
    const outcome = reconcileProjectSync(projectKey, live, shadow, this.deviceId);
    if (outcome.kind !== 'foreign-merge') {
      this.lastAdopted.set(projectKey, rawJson);
      return live;
    }
    return outcome.result.merged;
  }

  // The reconciled document as a defensive structural clone, for callers that
  // build a DERIVED document they will write back wholesale (the import plan:
  // its per-project merge result is persisted via putProjectMeta, which replaces
  // the collections outright, so a plan built from an UNRECONCILED read of a
  // just-landed lossy foreign value would launder the loss straight through the
  // apply loop). Plain consumers keep using getProjectMeta: the poll in
  // particular must see the RAW live value, or it could never classify a
  // foreign write itself.
  getReconciledProjectMeta(projectKey: string): ProjectMeta {
    return JSON.parse(JSON.stringify(this.reconciledBase(projectKey))) as ProjectMeta;
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
    // Gate the caller-supplied record id at the sink: an id failing isSafeRecordId
    // (a prototype name like '__proto__'/'constructor', a path-traversal token, or
    // an over-long/illegal value) is a safe no-op before it can index or re-key the
    // folders map. The normalize/merge boundaries already drop such ids; this is the
    // store-level chokepoint so a clone that reattached Object.prototype to the map
    // cannot turn a bad id into a global prototype write.
    if (!isSafeRecordId(folder.id)) {
      return;
    }
    this.mutate(projectKey, (meta) => {
      // Clamp the free-text name to the shared cap (schema.MAX_NAME_LENGTH) at
      // the write sink, so EVERY caller (webview handler, native input box,
      // promote) is covered and an unbounded string can never enter the synced
      // document and break the project's Settings Sync item.
      meta.folders[folder.id] = { ...folder, name: clampName(folder.name) };
    });
  }

  deleteFolder(projectKey: string, folderId: string): void {
    if (!isSafeRecordId(folderId)) {
      return;
    }
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
    if (!isSafeRecordId(tag.id)) {
      return;
    }
    this.mutate(projectKey, (meta) => {
      // Clamp the free-text label at the write sink (see upsertFolder).
      meta.tags[tag.id] = { ...tag, label: clampName(tag.label) };
    });
  }

  deleteTag(projectKey: string, tagId: string): void {
    if (!isSafeRecordId(tagId)) {
      return;
    }
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
  // absent. An unsafe chatId is a no-op (ensureChat returns null). A non-null
  // folderId that is itself unsafe is a no-op too: it is a reference into the
  // folders map that downstream resolve sites index, so storing a prototype name
  // here would re-create the exact phantom-record/prototype hazard the normalize
  // boundary drops; null (unfile) is always allowed.
  setChatFolder(projectKey: string, chatId: string, folderId: string | null): void {
    if (folderId !== null && !isSafeRecordId(folderId)) {
      return;
    }
    this.mutate(projectKey, (meta) => {
      const chat = this.ensureChat(meta, chatId);
      if (chat === null) {
        return;
      }
      chat.folderId = folderId;
      this.stampRecord(chat);
    });
  }

  addChatTag(projectKey: string, chatId: string, tagId: string): void {
    if (!isSafeRecordId(tagId)) {
      return;
    }
    this.mutate(projectKey, (meta) => {
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

  removeChatTag(projectKey: string, chatId: string, tagId: string): void {
    this.mutate(projectKey, (meta) => {
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

  addLink(projectKey: string, chatId: string, link: Link): void {
    // targetChatId is a reference into the chats map (a downstream resolve site
    // indexes it); reject an unsafe target the same way the chatId index is gated.
    if (!isSafeRecordId(link.targetChatId)) {
      return;
    }
    this.mutate(projectKey, (meta) => {
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

  removeLink(projectKey: string, chatId: string, targetChatId: string, kind: Link['kind']): void {
    this.mutate(projectKey, (meta) => {
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

  // Set a chat's starred flag. Creates the chat record if absent. Stamps the
  // record so the change wins on reconcile, and coalesces into the pending write
  // like every other granular mutation.
  setChatStarred(projectKey: string, chatId: string, starred: boolean): void {
    this.mutate(projectKey, (meta) => {
      const chat = this.ensureChat(meta, chatId);
      if (chat === null) {
        return;
      }
      chat.starred = starred;
      this.stampRecord(chat);
    });
  }

  // Set a chat's user-archive flag. archivedAt and restoredAt travel COUPLED to
  // the flag as one archive group: archiving sets archivedAt and clears
  // restoredAt; unarchiving clears archivedAt and stamps restoredAt (the
  // deliberate-restore intent marker the auto-archive policy treats as activity,
  // so a restored chat is not silently re-archived on the next automated pass).
  //
  // options.automated marks a write staged by AUTOMATION (the auto-archive
  // engine), not by a user action. An automated flip must NOT refresh the
  // per-record updatedAt/deviceId stamp: that single stamp arbitrates folderId,
  // starred, and the merge's winner side, so letting a background pass mint a
  // fresh stamp would let an automated archive silently beat an unsynced
  // DELIBERATE user edit (e.g. revert a folder move made on another device) in
  // the per-record LWW. The archive group itself still propagates without the
  // stamp: when the automated side loses the record arbitration, the winner did
  // not set the group and the merge's loser-fallback carries it. A record the
  // automated pass has to CREATE (a previously untracked chat) is stamped
  // updatedAt=0 so a user-created record for the same chat on another device
  // always wins the record arbitration. User-initiated calls (the default) keep
  // the full stamp, unchanged.
  setChatArchived(
    projectKey: string,
    chatId: string,
    archived: boolean,
    options?: { automated?: boolean },
  ): void {
    const automated = options?.automated === true;
    this.mutate(projectKey, (meta) => {
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
        // A brand-new automation-minted record must never carry a fresh stamp
        // that could win LWW over a user's record minted in the sync gap.
        chat.updatedAt = 0;
      }
    });
  }

  // Set (or clear) a folder's color. Pass null/undefined to clear. The folder
  // must exist; a call for an unknown folder is a no-op (folders are created via
  // upsertFolder). Coalesces into the pending write.
  setFolderColor(projectKey: string, folderId: string, color: string | null): void {
    if (!isSafeRecordId(folderId)) {
      return;
    }
    this.mutate(projectKey, (meta) => {
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

  // Replace the whole synced document for a project in one stamped write. Used by
  // the sync-reconcile slice; here it is the primitive the granular mutations and
  // the reconcile scaffolding build on. The supplied document is re-stamped at
  // the project level.
  putProjectMeta(projectKey: string, meta: ProjectMeta): void {
    // Deep-copy the supplied collections so the staged pending document never
    // aliases the caller's live objects (a later caller mutation must not leak
    // into the store before the next flush). mutate then re-stamps the project.
    const copy = nullProtoMaps(JSON.parse(JSON.stringify(meta)) as ProjectMeta);
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

  // The universal chat-id chokepoint. Returns null for an unsafe chatId so every
  // caller becomes a safe no-op before the id can index or re-key the chats map
  // (a chat key also flows verbatim to the archive body-file path sink). A safe id
  // resolves or creates the record as before, so legitimate UUID/minted ids work
  // unchanged.
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

  // Apply a mutation against the current (pending-or-stored) document, stamp the
  // project, register the key for sync if new, stage the result in the pending
  // map, and schedule a debounced flush. Read-your-writes is immediate; the
  // persisted write is coalesced.
  private mutate(projectKey: string, fn: (meta: ProjectMeta) => void): void {
    this.ensureSyncRegistered(projectKey);
    // Root the new pending chain on the RECONCILED base (round 3): if a foreign
    // Settings Sync value landed since this device last wrote or classified the
    // key, the root is the additive merge of last-known-good and the foreign
    // value, so the local edit below is applied ON TOP of the restoration
    // instead of on the lossy foreign document (which this stamp rewrite would
    // otherwise launder into a self-write).
    const current = this.cloneForMutation(this.reconciledBase(projectKey));
    fn(current);
    current.updatedAt = this.now();
    current.deviceId = this.deviceId;
    this.pending.set(projectKey, current);
    this.scheduleFlush();
  }

  private cloneForMutation(meta: ProjectMeta): ProjectMeta {
    // A structural clone so a staged pending document is never aliased to the
    // value previously returned to a reader. The shapes are plain JSON.
    //
    // The JSON round-trip re-attaches Object.prototype to the folders/tags/chats
    // maps, which would void the null-prototype backstop normalize builds. Rebuild
    // those maps with a null prototype so the documented defense in depth actually
    // holds on every mutation's working copy (the id gates above are the primary
    // protection; this is the secondary one).
    return nullProtoMaps(JSON.parse(JSON.stringify(meta)) as ProjectMeta);
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
        // CHECK-THEN-ACT GUARD (foreign Settings Sync write landing between the
        // read this document was staged from and this drain): diff the live
        // Memento value against the recorded belief. On a mismatch a foreign
        // value landed unseen; a blind update would destroy it before any
        // reconcile classified it, and the next poll would launder the clobber
        // into a self-write (this drained doc carries our stamps). Divert to the
        // ADDITIVE merge instead (ours as base, so a tie keeps the local edit;
        // foreign-only records are restored; newer foreign per-record stamps win
        // LWW exactly as a reconcile would arbitrate). The merged value keeps
        // the foreign records' stamps, so the NEXT reconcile poll still
        // classifies the result as a foreign write and surfaces the LWW warning.
        // No await sits between this read and the update call, so no further
        // foreign write can interleave on the extension-host thread.
        let toWrite = meta;
        const believed = this.mementoBelief.get(projectKey);
        if (believed !== undefined) {
          const currentRaw = this.memento.get<unknown>(metaKeyFor(projectKey));
          const currentJson =
            currentRaw === undefined ? NO_STORED_VALUE : JSON.stringify(currentRaw);
          if (currentJson !== believed) {
            const foreign = migrateProjectMeta(currentRaw, this.deviceId, this.now());
            toWrite = mergeProjectMeta(projectKey, meta, foreign).merged;
            // Keep the read path serving the merged value while the write is in
            // flight (identity-swap the in-flight entry we own).
            if (this.inFlight.get(projectKey) === meta) {
              this.inFlight.set(projectKey, toWrite);
            }
          }
        }
        try {
          await this.memento.update(metaKeyFor(projectKey), toWrite);
          const writtenJson = JSON.stringify(toWrite);
          this.mementoBelief.set(projectKey, writtenJson);
          // The persisted value is now OURS: record it as adopted so the next
          // chain root (reconciledBase) treats it as last-known-good rather
          // than re-classifying our own write.
          this.lastAdopted.set(projectKey, writtenJson);
        } catch {
          // The persisted write failed. If no later mutation has superseded this
          // key in pending, re-stage this drained value so the next flush retries
          // it; if pending already holds a newer value, that newer value wins and
          // we drop this stale one. Either way the write is not silently lost.
          if (!this.pending.has(projectKey)) {
            this.pending.set(projectKey, toWrite);
          }
          anyRequeued = true;
        }
        // Clear the in-flight entry only if a LATER drain has not already
        // replaced it with a newer value for this key (identity guard; the entry
        // may be `meta` or the diverted merge `toWrite`, both owned by this
        // drain); the newer entry must stay readable until its own update
        // resolves. On a failure the re-staged pending entry now backstops the
        // read path.
        const inFlightNow = this.inFlight.get(projectKey);
        if (inFlightNow === meta || inFlightNow === toWrite) {
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

export { emptyProjectMeta };
