// Read state: the per-device, per-chat lastSeenAt map that powers the org panel's
// unread affordances (the Questions '?' badge and the solid unread dot). It is a
// LOCAL, NEVER-SYNCED concern (UI-SPEC.md "Read state": "Per-device lastSeenAt per
// chat, stored in workspace/global Memento state, NEVER synced", like sort and the
// collapsed set).
//
// This module is VSCODE-THIN by design: it takes an injected Memento-shaped store
// (get/update over a JSON string), so the pure orgPanelModel.ts stays vscode-free
// and never imports or reads a store (ARCHITECTURE.md unit-gate rule; patch item 1).
// The extension host backs the injected store with context.workspaceState, which is
// structurally NEVER part of Settings Sync, so lastSeenAt can never widen the synced
// surface (which stays exactly nest.meta.v1::<projectKey>). This module also NEVER
// calls setKeysForSync.
//
// The persisted shape is a single Memento key holding a JSON object
// { [sessionId]: epochMs }. One key (not one per chat) keeps the write coalesced and
// the read a single parse, mirroring the collapsed-folder set's storage shape.

// The single workspaceState key the lastSeenAt map is persisted under. Local and
// never synced, exactly like claudeNest.orgPanel.sort / .collapsedFolders.
export const READ_STATE_KEY = 'claudeNest.orgPanel.lastSeenAt';

// The one-time-seed flag (issue #123). Before the seed, every chat predating the
// read-state store read as unread ("old af and already read"). The first scan after
// this flag is absent marks every scanned chat seen once; the flag then prevents
// re-seeding, so only genuinely new assistant activity shows unread afterward.
// Local and never synced, like the map itself.
export const READ_STATE_SEEDED_KEY = 'claudeNest.orgPanel.readStateSeeded';

// The minimal Memento surface this adapter needs, injected so the module stays
// unit-testable without the vscode module. In production the host passes an adapter
// over context.workspaceState.
export interface ReadStateMemento {
  get(key: string): string | undefined;
  update(key: string, value: string): void;
}

// A per-chat lastSeenAt store. Reads serve the parsed map; writes stamp one chat and
// persist the whole map back under the single key. Tolerant of a missing or corrupt
// persisted value (treated as an empty map) so a bad memento never throws.
export class ReadStateStore {
  constructor(private readonly memento: ReadStateMemento) {}

  // The current lastSeenAt map as a plain Map<sessionId, epochMs>, threaded into the
  // pure buildSections. A missing/corrupt/non-object persisted value yields an empty
  // map (nothing seen), so every assistant-last chat reads as unread until opened.
  getMap(): Map<string, number> {
    return parseMap(this.memento.get(READ_STATE_KEY));
  }

  // Stamp one chat as seen at `at` (default now). A later timestamp never regresses:
  // if the chat already has a >= value we keep it, so a stale focus event cannot
  // un-see a chat the user opened more recently. Persists the whole map back.
  markSeen(sessionId: string, at: number = Date.now()): void {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
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

  // One-time seed (issue #123): treat every chat that exists at first activation as
  // already read. Chats predating the read-state store have no lastSeenAt entry, so
  // they all showed the unread dot regardless of age. On the FIRST scan after this
  // store version lands, stamp each scanned chat seen at its own last-activity
  // timestamp (so an assistant message arriving later is still newer than seenAt and
  // reads unread per the existing heuristics); a null timestamp falls back to `now`.
  // The seeded flag makes this a no-op on every later call, and existing (higher)
  // stamps are preserved by markSeen's no-regress rule. Returns true when the seed
  // ran. Coalesces to ONE map write for the whole batch.
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

// Parse the persisted JSON object into a Map. Any non-string key or non-finite/<=0
// value is dropped so a tampered or partial value cannot seed a bogus lastSeenAt.
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
