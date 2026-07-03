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
