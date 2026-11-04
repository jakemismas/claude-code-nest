// Per-device lastSeenAt map behind the org panel's unread badge and dot. The host backs
// the injected store with workspaceState, which Settings Sync never carries, so this
// state stays local. One key holds { [sessionId]: epochMs } to keep writes coalesced.

import { isSafeRecordId } from '../store/schema';

export const READ_STATE_KEY = 'claudeNest.orgPanel.lastSeenAt';

// Set after the first scan marks existing chats seen, so only later assistant activity
// reads as unread.
export const READ_STATE_SEEDED_KEY = 'claudeNest.orgPanel.readStateSeeded';

// The Memento surface this store needs, injected so tests run without vscode.
export interface ReadStateMemento {
  get(key: string): string | undefined;
  update(key: string, value: string): void;
}

// A missing or corrupt persisted value reads as an empty map, so a bad memento never throws.
export class ReadStateStore {
  constructor(private readonly memento: ReadStateMemento) {}

  getMap(): Map<string, number> {
    return parseMap(this.memento.get(READ_STATE_KEY));
  }

  // Never regresses: a stale focus event cannot un-see a chat opened more recently.
  // The id is gated here as well as upstream because every write re-serializes the whole
  // map, so a garbage id would grow the memento without bound.
  markSeen(sessionId: string, at: number = Date.now()): void {
    if (!isSafeRecordId(sessionId)) {
      return;
    }
    const map = this.getMap();
    const prev = map.get(sessionId);
    if (prev !== undefined && prev >= at) {
      return;
    }
    map.set(sessionId, at);
    this.memento.update(READ_STATE_KEY, serializeMap(map));
  }

  // One-time seed: stamp each existing chat seen at its own last activity (or now when
  // null) so older chats do not all show unread. Returns true when the seed ran.
  seedIfFirstRun(
    records: ReadonlyArray<{ sessionId: string; timestamp: number | null }>,
    now: number = Date.now(),
  ): boolean {
    if (this.memento.get(READ_STATE_SEEDED_KEY) === 'true') {
      return false;
    }
    const map = this.getMap();
    for (const record of records) {
      if (typeof record.sessionId !== 'string' || record.sessionId.length === 0) {
        continue;
      }
      const at =
        typeof record.timestamp === 'number' && Number.isFinite(record.timestamp) && record.timestamp > 0
          ? record.timestamp
          : now;
      const prev = map.get(record.sessionId);
      if (prev === undefined || prev < at) {
        map.set(record.sessionId, at);
      }
    }
    this.memento.update(READ_STATE_KEY, serializeMap(map));
    this.memento.update(READ_STATE_SEEDED_KEY, 'true');
    return true;
  }
}

// Drops invalid entries so a tampered value cannot seed a bogus lastSeenAt.
function parseMap(raw: string | undefined): Map<string, number> {
  const map = new Map<string, number>();
  if (raw === undefined) {
    return map;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return map;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return map;
  }
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof key === 'string' && key.length > 0 && typeof value === 'number' && Number.isFinite(value) && value > 0) {
      map.set(key, value);
    }
  }
  return map;
}

function serializeMap(map: Map<string, number>): string {
  const obj: Record<string, number> = {};
  for (const [key, value] of map) {
    obj[key] = value;
  }
  return JSON.stringify(obj);
}
