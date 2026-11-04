// Pure parsing, coercion and folding of fleet records. No fs, no vscode.
import {
  EMPTY_FLEET_STATE,
  FLEET_EVENTS,
  FLEET_RECORD_VERSION,
  FLEET_ROLES,
  FleetEntry,
  FleetEvent,
  FleetOutcome,
  FleetRecord,
  FleetRole,
  FleetState,
  MAX_FIELD_LEN,
  MAX_FOLDER_LEN,
  MAX_NAME_LEN,
  MAX_PATH_LEN,
  MAX_TAGS,
  MAX_TAG_LEN,
  SESSION_ID_RE,
} from './types';

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g');

// Strips control characters, trims, and caps the length. Returns undefined for a
// non-string or an empty result.
export function coerceString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const cleaned = value.replace(CONTROL_CHARS, '').trim();
  if (cleaned.length === 0) {
    return undefined;
  }
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

function coerceTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: string[] = [];
  for (const item of value) {
    const tag = coerceString(item, MAX_TAG_LEN);
    if (tag !== undefined && !out.includes(tag)) {
      out.push(tag);
      if (out.length >= MAX_TAGS) {
        break;
      }
    }
  }
  return out;
}

function coerceAt(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// Returns null for anything that is not a valid v1 line. Never throws.
export function parseFleetLine(line: string): FleetRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const o = raw as Record<string, unknown>;
  if (o.v !== FLEET_RECORD_VERSION) {
    return null;
  }
  if (typeof o.event !== 'string' || !(FLEET_EVENTS as readonly string[]).includes(o.event)) {
    return null;
  }
  if (!isSessionId(o.sessionId)) {
    return null;
  }
  const rec: { -readonly [K in keyof FleetRecord]: FleetRecord[K] } = {
    event: o.event as FleetEvent,
    at: coerceAt(o.at),
    sessionId: o.sessionId,
  };
  const agent = coerceString(o.agent, MAX_FIELD_LEN);
  if (agent !== undefined) rec.agent = agent;
  const name = coerceString(o.name, MAX_NAME_LEN);
  if (name !== undefined) rec.name = name;
  const client = coerceString(o.client, MAX_FIELD_LEN);
  if (client !== undefined) rec.client = client;
  if (o.ticket === null) {
    rec.ticket = null;
  } else {
    const ticket = coerceString(o.ticket, MAX_FIELD_LEN);
    if (ticket !== undefined) rec.ticket = ticket;
  }
  if (typeof o.role === 'string' && (FLEET_ROLES as readonly string[]).includes(o.role)) {
    rec.role = o.role as FleetRole;
  }
  // launchedBy is a session id or a user marker; both are coerced strings.
  const launchedBy = coerceString(o.launchedBy, MAX_FIELD_LEN);
  if (launchedBy !== undefined) rec.launchedBy = launchedBy;
  const cwd = coerceString(o.cwd, MAX_PATH_LEN);
  if (cwd !== undefined) rec.cwd = cwd;
  if (o.event === 'rotate') {
    if (isSessionId(o.previous)) rec.previous = o.previous;
    if (isSessionId(o.next)) rec.next = o.next;
  }
  if (o.event === 'organize') {
    const folder = coerceString(o.folder, MAX_FOLDER_LEN);
    if (folder !== undefined) rec.folder = folder;
    const tags = coerceTags(o.tags);
    if (tags !== undefined) rec.tags = tags;
    const stage = coerceString(o.stage, MAX_FIELD_LEN);
    if (stage !== undefined) rec.stage = stage;
  }
  if (o.event === 'end' && (o.outcome === 'done' || o.outcome === 'failed')) {
    rec.outcome = o.outcome as FleetOutcome;
  }
  return rec;
}

interface MutableEntry {
  sessionId: string;
  name: string;
  ticket: string | null;
  role: FleetRole | null;
  agent: string;
  launchedBy: string;
  cwd: string;
  client: string;
  folder: string | null;
  tags: readonly string[];
  stage: string | null;
  ended: boolean;
  outcome: FleetOutcome | null;
  firstAt: string | null;
  lastAt: string | null;
  isBackfill: boolean;
  order: number;
}

function newEntry(sessionId: string, order: number, backfill: boolean): MutableEntry {
  return {
    sessionId,
    name: '',
    ticket: null,
    role: null,
    agent: '',
    launchedBy: '',
    cwd: '',
    client: '',
    folder: null,
    tags: [],
    stage: null,
    ended: false,
    outcome: null,
    firstAt: null,
    lastAt: null,
    isBackfill: backfill,
    order,
  };
}

function timeOf(at: string | null): number | null {
  if (at === null) {
    return null;
  }
  const t = Date.parse(at);
  return Number.isFinite(t) ? t : null;
}

function applyLaunch(e: MutableEntry, r: FleetRecord): void {
  if (r.agent !== undefined) e.agent = r.agent;
  if (r.name !== undefined) e.name = r.name;
  if (r.client !== undefined) e.client = r.client;
  if (r.ticket !== undefined) e.ticket = r.ticket;
  if (r.role !== undefined) e.role = r.role;
  if (r.launchedBy !== undefined) e.launchedBy = r.launchedBy;
  if (r.cwd !== undefined) e.cwd = r.cwd;
}

// Folds records into per-session entries. Records apply in time order (a record
// without a usable time keeps the time of the one before it); ties keep input order.
export function foldFleet(records: readonly FleetRecord[]): FleetState {
  let carry = 0;
  const timed = records.map((record, index) => {
    const t = timeOf(record.at);
    if (t !== null) carry = t;
    return { record, index, t: carry };
  });
  timed.sort((a, b) => a.t - b.t || a.index - b.index);

  const entries = new Map<string, MutableEntry>();
  const rotatedAway = new Set<string>();
  let order = 0;

  for (const { record: r } of timed) {
    if (r.event === 'rotate') {
      if (r.previous !== undefined) rotatedAway.add(r.previous);
      continue;
    }
    let e = entries.get(r.sessionId);
    if (e === undefined) {
      if (r.event !== 'launch' && r.event !== 'backfill') {
        // rename, organize and end for an unknown session carry no launch data.
        continue;
      }
      e = newEntry(r.sessionId, order++, r.event === 'backfill');
      e.firstAt = r.at;
      entries.set(r.sessionId, e);
    } else if (r.event === 'launch' || r.event === 'backfill') {
      // A repeated launch overrides field by field but keeps the first-seen time.
      if (r.event === 'launch') e.isBackfill = false;
    }
    if (r.at !== null) {
      if (e.firstAt === null) e.firstAt = r.at;
      e.lastAt = r.at;
    }
    switch (r.event) {
      case 'launch':
      case 'backfill':
        // Records apply in time order, so a launch seen after an end is a restart.
        if (r.event === 'launch' && e.ended) {
          e.ended = false;
          e.outcome = null;
        }
        applyLaunch(e, r);
        break;
      case 'rename':
        if (r.name !== undefined) e.name = r.name;
        break;
      case 'organize':
        if (r.folder !== undefined) e.folder = r.folder;
        if (r.tags !== undefined) e.tags = r.tags;
        if (r.stage !== undefined) e.stage = r.stage;
        break;
      case 'end':
        e.ended = true;
        if (r.outcome !== undefined) e.outcome = r.outcome;
        break;
    }
  }

  const sorted = [...entries.values()].sort((a, b) => {
    const ta = timeOf(a.firstAt);
    const tb = timeOf(b.firstAt);
    if (ta !== null && tb !== null && ta !== tb) return tb - ta;
    return b.order - a.order;
  });
  const out: FleetEntry[] = sorted.map(({ order: _order, ...rest }) => rest);

  const orchestrators = out.filter((e) => e.role === 'orchestrator');
  const current =
    orchestrators.find((e) => !rotatedAway.has(e.sessionId) && !e.ended) ?? null;
  const past = orchestrators.filter((e) => e !== current);
  return { entries: out, currentOrchestrator: current, pastOrchestrators: past };
}

// Convenience for callers that hold raw lines.
export function foldFleetLines(lines: readonly string[]): FleetState {
  if (lines.length === 0) {
    return EMPTY_FLEET_STATE;
  }
  const records: FleetRecord[] = [];
  for (const line of lines) {
    const rec = parseFleetLine(line);
    if (rec !== null) records.push(rec);
  }
  return foldFleet(records);
}
