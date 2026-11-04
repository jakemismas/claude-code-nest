// Cross-machine additive reconcile of a project's synced metadata against a local-only shadow.
// Pure and vscode-free: the command module does the polling and storage, this module decides.
// Settings Sync raises no change event, so a foreign overwrite is detected by diffing against the shadow.

import { ProjectMeta } from './schema';
import { mergeProjectMeta, ProjectMergeResult } from './exportImport';

// Local-only key prefix. It must not start with META_KEY_PREFIX, or the shadow would sync.
export const SHADOW_KEY_PREFIX = 'nest.shadow.v1';
export const SHADOW_KEY_SEPARATOR = '::';

export function shadowKeyFor(projectKey: string): string {
  return SHADOW_KEY_PREFIX + SHADOW_KEY_SEPARATOR + projectKey;
}

// Last synced ProjectMeta this device wrote or saw, plus this install's deviceId.
export interface SyncShadow {
  meta: ProjectMeta;
  deviceId: string;
}

export type SyncReconcileResult =
  | {
      kind: 'adopt';
      shadow: SyncShadow;
    }
  | {
      kind: 'unchanged';
    }
  | {
      // The change came from this device: refresh the shadow without a merge.
      kind: 'self-write';
      shadow: SyncShadow;
    }
  | {
      // A foreign device wrote the value: merge additively so local-only organization survives.
      kind: 'foreign-merge';
      result: ProjectMergeResult;
      // Persist gate: merged versus the live store value, not result.changed. result.changed compares
      // against the shadow, so a foreign value that dropped a local-only record would skip the restore.
      storeChanged: boolean;
      shadow: SyncShadow;
    };

// Decides one project's reconcile from the live value, the prior shadow (null on first sight) and this
// device's id. The caller persists the returned shadow under the non-synced key.
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

  // The project deviceId stamp separates own writes from foreign ones: a value still stamped with this
  // device is our own later write.
  if (!isForeignWrite(live, shadow, deviceId)) {
    return { kind: 'self-write', shadow: snapshot(live, deviceId) };
  }

  // Merge the foreign value onto the shadow so records it dropped are restored. The shadow is the base
  // and the foreign value the incoming side, so the result matches the import path.
  const result = mergeProjectMeta(projectKey, shadow.meta, live);
  return {
    kind: 'foreign-merge',
    result,
    // Persist only when the merged document differs from the live store value; a pure superset needs no write.
    storeChanged: !metaEqual(result.merged, live),
    shadow: snapshot(result.merged, deviceId),
  };
}

// A value is foreign when its project deviceId differs from this device, or a chat stamped by
// another device is newer than the shadow's record.
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
  // A plain clone: the merge gates keys and rebuilds its maps with a null prototype, so no backstop is needed here.
  return {
    meta: JSON.parse(JSON.stringify(meta)) as ProjectMeta,
    deviceId,
  };
}

// Byte-for-byte JSON compare. It is order-sensitive: a same-content value with a different key order
// causes one redundant restore write, which converges on the next poll.
function metaEqual(a: ProjectMeta, b: ProjectMeta): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Returns a well-formed SyncShadow, or null for a corrupt value so the caller treats it as first sight.
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
  return { meta: obj.meta as ProjectMeta, deviceId: obj.deviceId };
}
