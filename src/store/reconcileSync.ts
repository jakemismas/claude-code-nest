// Cross-machine ADDITIVE reconcile against an on-disk shadow. PURE and
// vscode-free (unit-gate rule): no filesystem, no vscode. The command module
// owns the activation hook, the window-focus polling
// (vscode.window.onDidChangeWindowState), the shadow read/write, and the LWW
// warning toast; this module takes plain data (the live synced ProjectMeta, the
// last-seen shadow snapshot) and returns a plain reconcile result/intent.
//
// Why a shadow (slice patch + ARCHITECTURE.md lines 234-236): there is NO Memento
// remote-change event for a Settings Sync write, so foreign-device overwrites are
// detected by best-effort POLLING on activation and on window focus. To tell a
// foreign wholesale-replace apart from this device's own last write, each device
// keeps a LOCAL-ONLY shadow: the last synced ProjectMeta value THIS device wrote
// or saw for each project. On a poll we diff the live globalState value against
// the shadow; a difference whose records carry a DIFFERENT deviceId or newer
// updatedAt is the foreign-write signal, and we reconcile additively rather than
// letting the foreign opaque value wholesale-replace local organization.
//
// The shadow is LOCAL-ONLY and MUST live under a NON-synced key (the command
// module uses the SHADOW_KEY_PREFIX below, which does not start with
// META_KEY_PREFIX, so isMetaKey is false and it is never swept into
// setKeysForSync). Storing it under a nest.meta.v1:: key would sync it and defeat
// the whole detection.
//
// The additive reconcile is the SAME shape as the import merge (union tags, union
// links, LWW per record-scalar by record updatedAt), reused so the two
// cross-machine paths agree. The record scalars mergeProjectMeta arbitrates are
// folderId, starred, userArchived, and archivedAt (archivedAt coupled to
// userArchived), plus Folder.color at the document level (Slice 3). A foreign
// write that flipped any of these is therefore reconciled additively, not
// wholesale-replaced. The irreducible floor is a concurrent same-scalar
// (folderId) edit, which loses one side and is surfaced.

import { ProjectMeta } from './schema';
import { mergeProjectMeta, ProjectMergeResult } from './exportImport';

// The LOCAL-ONLY shadow key prefix. Deliberately NOT META_KEY_PREFIX so isMetaKey
// is false and the store never registers it for sync (mirrors the orphan
// LocalProjectMeta convention's nest.local.* exclusion). The command module
// builds the full key as SHADOW_KEY_PREFIX + SHADOW_KEY_SEPARATOR + projectKey.
export const SHADOW_KEY_PREFIX = 'nest.shadow.v1';
export const SHADOW_KEY_SEPARATOR = '::';

export function shadowKeyFor(projectKey: string): string {
  return SHADOW_KEY_PREFIX + SHADOW_KEY_SEPARATOR + projectKey;
}

// The shadow snapshot stored locally per project: the last synced ProjectMeta
// this device wrote or saw. It is the SAME ProjectMeta shape (so a diff is a
// like-for-like comparison) plus the deviceId of THIS install at the time it was
// recorded, kept so a re-read can confirm the recorded snapshot was ours.
export interface SyncShadow {
  // The last-seen synced document for the project (a structural copy).
  meta: ProjectMeta;
  // This install's device id when the shadow was recorded.
  deviceId: string;
}

// Why a reconcile pass did or did not change anything, for diagnostics, the
// warning surface, and tests.
export type SyncReconcileResult =
  | {
      // No shadow yet (first sight of this project on this device): adopt the
      // live value as the shadow with no merge. Nothing foreign to reconcile.
      kind: 'adopt';
      shadow: SyncShadow;
    }
  | {
      // The live value equals the shadow (no foreign write since we last saw it):
      // nothing to do.
      kind: 'unchanged';
    }
  | {
      // The live value differs from the shadow but the change is attributable to
      // THIS device (same deviceId at the project level and no newer foreign
      // record): refresh the shadow to the new live value, no merge needed.
      kind: 'self-write';
      shadow: SyncShadow;
    }
  | {
      // A foreign device wrote the project's synced value. We reconcile additively
      // (the union/LWW merge) so the foreign wholesale-replace does not silently
      // drop local-only organization, then re-stamp the shadow. The command module
      // persists `merged` via store.putProjectMeta and the shadow via the local
      // key, and surfaces folderConflicts through the LWW warning.
      kind: 'foreign-merge';
      result: ProjectMergeResult;
      // Whether the merged document differs from the current LIVE STORE value (the
      // foreign value the store currently holds). This, NOT result.changed, is the
      // correct persist gate. result.changed reports whether the merge differs from
      // its BASE, which here is the SHADOW (mergeProjectMeta(shadow, live)); a
      // foreign value that DROPPED a local-only record this device never synced
      // produces merged == shadow (changed:false) yet merged != live, because the
      // store holds the lossy foreign value. Gating the write on result.changed
      // would skip restoring the dropped record and then advance the shadow to the
      // lossy live value, losing it permanently. storeChanged compares merged to
      // live directly, so the restore is always persisted.
      storeChanged: boolean;
      shadow: SyncShadow;
    };

// Decide one project's reconcile from the live synced value and the prior shadow.
// Pure. The caller supplies:
//   live      - the current synced ProjectMeta read from globalState (already
//               migrated by the store on read),
//   shadow    - the prior SyncShadow for this project, or null on first sight,
//   deviceId  - THIS install's device id.
//
// The returned shadow (when present) is what the caller persists under the
// non-synced shadow key after applying any merge.
export function reconcileProjectSync(
  projectKey: string,
  live: ProjectMeta,
  shadow: SyncShadow | null,
  deviceId: string,
): SyncReconcileResult {
  if (shadow === null) {
    return { kind: 'adopt', shadow: snapshot(live, deviceId) };
  }

  if (metaEqual(live, shadow.meta)) {
    return { kind: 'unchanged' };
  }

  // The live value changed since we last saw it. Decide whether the change is
  // OURS or FOREIGN. The project-level deviceId stamp is the primary signal: the
  // store stamps every write with this device's id, so a live document still
  // stamped with our id (and no record newer than the shadow stamped by another
  // device) is our own later write that the shadow simply has not caught up to.
  if (!isForeignWrite(live, shadow, deviceId)) {
    return { kind: 'self-write', shadow: snapshot(live, deviceId) };
  }

  // A foreign device wrote it. Reconcile additively: merge the FOREIGN live value
  // ONTO the shadow (our last-known-good local value) so local-only records the
  // foreign opaque value dropped are restored, and LWW arbitrates the scalars.
  // We treat the shadow as `live` (our base) and the foreign value as `file`
  // (incoming) so the union semantics and folderConflict detection match the
  // import path exactly.
  const result = mergeProjectMeta(projectKey, shadow.meta, live);
  return {
    kind: 'foreign-merge',
    result,
    // Persist iff the reconciled document differs from what the store holds now
    // (live). When the foreign value dropped a local-only record, merged restores
    // it and merged != live, so this is true and the restore is written. When the
    // foreign value was a pure superset already containing everything, merged ==
    // live and this is false, so we skip a redundant write and just advance the
    // shadow.
    storeChanged: !metaEqual(result.merged, live),
    shadow: snapshot(result.merged, deviceId),
  };
}

// A live value is a FOREIGN write (relative to the shadow) when its project-level
// deviceId differs from THIS device, OR any chat record carries a deviceId other
// than this device with an updatedAt newer than the shadow's same record. Either
// signal means another install produced the current synced value.
function isForeignWrite(
  live: ProjectMeta,
  shadow: SyncShadow,
  deviceId: string,
): boolean {
  if (live.deviceId !== deviceId) {
    return true;
  }
  for (const [chatId, liveChat] of Object.entries(live.chats)) {
    if (liveChat.deviceId !== deviceId) {
      const prior = shadow.meta.chats[chatId];
      if (!prior || liveChat.updatedAt > prior.updatedAt) {
        return true;
      }
    }
  }
  return false;
}

function snapshot(meta: ProjectMeta, deviceId: string): SyncShadow {
  return {
    meta: JSON.parse(JSON.stringify(meta)) as ProjectMeta,
    deviceId,
  };
}

// Structural equality over the logical document (ignores nothing: a byte-for-byte
// JSON compare of the two documents). Two documents that serialize identically
// are equal; this is the cheap diff signal the polling reconcile uses.
//
// Key-order note: this is order-sensitive (a record map keyed a,b serializes
// differently from b,a). A foreign value with the SAME content but a different
// record insertion order than the shadow therefore reads as storeChanged and
// triggers ONE redundant restore write + refresh. This is BENIGN and converges:
// the write re-stamps and both live and shadow are then re-read through the same
// store/migrate path, so they serialize identically and the next poll is silent.
// It is not an infinite loop and never loses data, so we keep the cheap compare
// rather than a normalized deep-equal; revisit only if redundant cross-machine
// re-sync churn ever becomes a measured concern.
function metaEqual(a: ProjectMeta, b: ProjectMeta): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Validate a value read back from the non-synced shadow key. The shadow is local
// and small, but a corrupt or older value must not throw the reconcile; this
// returns a well-formed SyncShadow or null (treated as first-sight -> adopt).
export function coerceShadow(raw: unknown): SyncShadow | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const obj = raw as { meta?: unknown; deviceId?: unknown };
  if (typeof obj.meta !== 'object' || obj.meta === null) {
    return null;
  }
  if (typeof obj.deviceId !== 'string') {
    return null;
  }
  // Trust the stored meta as-is for the shadow's purpose (it is this device's own
  // prior snapshot, not a foreign value); the reconcile compares it structurally.
  return { meta: obj.meta as ProjectMeta, deviceId: obj.deviceId };
}
