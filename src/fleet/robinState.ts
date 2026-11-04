// Pure state machine for the header robin. No vscode, no filesystem, no timers: the
// caller passes the inputs, the clock and a random source, and gets one state back.
import type { AgentSession } from '../claude/agentsCli';
import type { ChatStatus } from './status';
import type { QueueRow } from './queueTable';
import type { FleetState } from './types';

export const ROBIN_STATES = [
  'hatch',
  'rotate',
  'error',
  'needs',
  'worm',
  'done',
  'milestone',
  'working',
  'sleep',
  'night',
  'idle',
] as const;
export type RobinState = (typeof ROBIN_STATES)[number];

// How long each transient state plays before the robin falls back. The one-shot scenes in
// media/mascot.js run exactly this long, so a scene is never cut off mid-flight.
export const TRANSIENT_MS: Readonly<Partial<Record<RobinState, number>>> = {
  hatch: 5300,
  rotate: 4400,
  error: 6000,
  worm: 4000,
  done: 3500,
  milestone: 4500,
};

// Nothing running for this long puts the robin to sleep.
export const SLEEP_AFTER_MS = 10 * 60 * 1000;
// Sleep between these local hours becomes night.
export const NIGHT_START_HOUR = 22;
export const NIGHT_END_HOUR = 6;

// A working chat pops out at most one note per this gap, plus a random spread.
export const NOTE_MIN_GAP_MS = 2500;
export const NOTE_SPREAD_MS = 3500;
export const MAX_NOTES = 6;
// Working chats at or above these counts step up the peck speed.
export const FAST_AT = 3;
export const FASTER_AT = 6;

export const MAX_SEEN = 2000;

export interface RobinSignals {
  // Chats whose status is working right now.
  readonly workingCount: number;
  // Any chat needs the user right now.
  readonly needs: boolean;
  // Session ids of new, non-backfill launches that carry a ticket.
  readonly launchIds: readonly string[];
  // Session ids whose fleet record ended with outcome done.
  readonly doneIds: readonly string[];
  // Session ids that failed: a fleet end with outcome failed or a CLI state failed or error.
  readonly failedIds: readonly string[];
  // Identifies the head of the rotate chain, or null when no rotate was recorded.
  readonly rotateKey: string | null;
  // Tickets currently in a finished stage.
  readonly doneTickets: readonly string[];
  // Every queue row's ticket is in a finished stage (false for an empty queue).
  readonly queueAllDone: boolean;
  // The queue has no rows right now (a momentary gap must not re-arm the milestone).
  readonly queueEmpty: boolean;
  // The egg has not hatched on this device yet.
  readonly hatchEligible: boolean;
}

export interface RobinTransient {
  readonly state: RobinState;
  readonly until: number;
}

export interface RobinMemory {
  readonly seeded: boolean;
  readonly seenLaunches: readonly string[];
  readonly seenDone: readonly string[];
  readonly seenFailed: readonly string[];
  readonly seenRotate: string | null;
  readonly seenDoneTickets: readonly string[];
  readonly milestoneHeld: boolean;
  readonly transients: readonly RobinTransient[];
  readonly lastBusyAt: number;
  readonly noteDelaysMs: readonly number[];
}

export const INITIAL_ROBIN_MEMORY: RobinMemory = {
  seeded: false,
  seenLaunches: [],
  seenDone: [],
  seenFailed: [],
  seenRotate: null,
  seenDoneTickets: [],
  milestoneHeld: false,
  transients: [],
  lastBusyAt: 0,
  noteDelaysMs: [],
};

export interface RobinOutput {
  readonly state: RobinState;
  // 0 normal peck, 1 fast, 2 fastest. Only meaningful while working.
  readonly speed: 0 | 1 | 2;
  readonly workingCount: number;
  // One initial delay per note slot, in milliseconds.
  readonly noteDelaysMs: readonly number[];
  // True when this step began the hatch, so the caller can remember it per device.
  readonly hatchStarted: boolean;
  // The next time the caller should step again with no new input, or null.
  readonly nextCheckAt: number | null;
}

// Remembers ids. Past the cap it drops only ids the current signals no longer carry, so an
// id that is still present never leaves the set and replays as new.
function addSeen(list: readonly string[], ids: readonly string[]): string[] {
  const set = new Set(list);
  for (const id of ids) {
    set.add(id);
  }
  const out = [...set];
  if (out.length <= MAX_SEEN) {
    return out;
  }
  const current = new Set(ids);
  let excess = out.length - MAX_SEEN;
  return out.filter((id) => {
    if (excess > 0 && !current.has(id)) {
      excess -= 1;
      return false;
    }
    return true;
  });
}

function fresh(seen: readonly string[], ids: readonly string[]): string[] {
  const set = new Set(seen);
  return ids.filter((id) => !set.has(id));
}

export function isNightHour(hour: number): boolean {
  return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
}

// The next local time at which the night window opens or closes.
export function nextNightBoundary(now: number): number {
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  for (let i = 0; i < 25; i++) {
    d.setHours(d.getHours() + 1);
    if (d.getHours() === NIGHT_START_HOUR || d.getHours() === NIGHT_END_HOUR) {
      return d.getTime();
    }
  }
  return now + 60 * 60 * 1000;
}

export function noteDelayMs(random: () => number): number {
  const r = Math.min(Math.max(random(), 0), 0.999999);
  return NOTE_MIN_GAP_MS + Math.floor(r * NOTE_SPREAD_MS);
}

export function speedFor(workingCount: number): 0 | 1 | 2 {
  if (workingCount >= FASTER_AT) {
    return 2;
  }
  return workingCount >= FAST_AT ? 1 : 0;
}

// One step of the machine. The first call seeds the seen sets from the current inputs so
// existing history never replays as a transient.
export function stepRobin(
  memory: RobinMemory,
  signals: RobinSignals,
  now: number,
  random: () => number,
): { memory: RobinMemory; output: RobinOutput } {
  const started: RobinTransient[] = [];
  const begin = (state: RobinState): void => {
    started.push({ state, until: now + (TRANSIENT_MS[state] ?? 0) });
  };
  let hatchStarted = false;

  if (memory.seeded) {
    if (fresh(memory.seenFailed, signals.failedIds).length > 0) {
      begin('error');
    }
    if (signals.rotateKey !== null && signals.rotateKey !== memory.seenRotate) {
      begin('rotate');
    }
    if (fresh(memory.seenLaunches, signals.launchIds).length > 0) {
      begin('worm');
    }
    const newDone = fresh(memory.seenDone, signals.doneIds).length > 0;
    const newStage = fresh(memory.seenDoneTickets, signals.doneTickets).length > 0;
    if (newDone || newStage) {
      begin('done');
    }
    if (signals.queueAllDone && !memory.milestoneHeld) {
      begin('milestone');
    }
  } else if (signals.hatchEligible) {
    begin('hatch');
    hatchStarted = true;
  }

  const busy = signals.workingCount > 0 || signals.needs;
  const lastBusyAt = !memory.seeded || busy ? now : memory.lastBusyAt;

  let noteDelays = memory.noteDelaysMs;
  const noteBudget = Math.min(signals.workingCount, MAX_NOTES);
  if (noteDelays.length !== noteBudget) {
    noteDelays = Array.from({ length: noteBudget }, () => noteDelayMs(random));
  }

  const transients = [...memory.transients, ...started].filter((t) => t.until > now);
  const next: RobinMemory = {
    seeded: true,
    seenLaunches: addSeen(memory.seenLaunches, signals.launchIds),
    seenDone: addSeen(memory.seenDone, signals.doneIds),
    seenFailed: addSeen(memory.seenFailed, signals.failedIds),
    seenRotate: signals.rotateKey ?? memory.seenRotate,
    seenDoneTickets: addSeen(memory.seenDoneTickets, signals.doneTickets),
    milestoneHeld: signals.queueEmpty ? memory.milestoneHeld : signals.queueAllDone,
    transients,
    lastBusyAt,
    noteDelaysMs: noteDelays,
  };

  const asleep = !busy && now - lastBusyAt >= SLEEP_AFTER_MS;
  const night = asleep && isNightHour(new Date(now).getHours());
  const active = (state: RobinState): boolean => transients.some((t) => t.state === state);

  const holds: Readonly<Record<RobinState, boolean>> = {
    hatch: active('hatch'),
    rotate: active('rotate'),
    error: active('error'),
    needs: signals.needs,
    worm: active('worm'),
    done: active('done'),
    milestone: active('milestone'),
    working: signals.workingCount > 0,
    sleep: asleep && !night,
    night,
    idle: true,
  };
  const state = ROBIN_STATES.find((candidate) => holds[candidate]) ?? 'idle';

  const checks: number[] = transients.map((t) => t.until);
  if (!busy) {
    checks.push(asleep ? nextNightBoundary(now) : lastBusyAt + SLEEP_AFTER_MS);
  }
  const nextCheckAt = checks.length > 0 ? Math.min(...checks) : null;

  return {
    memory: next,
    output: {
      state,
      speed: speedFor(signals.workingCount),
      workingCount: signals.workingCount,
      noteDelaysMs: noteDelays,
      hatchStarted,
      nextCheckAt,
    },
  };
}

// The pixel glyph a still pose shows for each state.
export const STILL_MARKERS: Readonly<Record<RobinState, string>> = {
  hatch: 'egg',
  rotate: 'plus',
  error: 'bang',
  needs: 'question',
  worm: 'worm',
  done: 'check',
  milestone: 'burst',
  working: 'note',
  sleep: 'z',
  night: 'moon',
  idle: '',
};

// The text a polite live region announces, only for needs and error.
export function liveTextFor(state: RobinState): string {
  if (state === 'needs') {
    return 'A chat needs you';
  }
  if (state === 'error') {
    return 'A chat failed';
  }
  return '';
}

export interface RobinMessage {
  readonly type: 'robin';
  readonly state: RobinState;
  readonly speed: 0 | 1 | 2;
  readonly workingCount: number;
  readonly noteBudget: number;
  readonly noteDelaysMs: readonly number[];
  readonly noteMinMs: number;
  readonly noteSpreadMs: number;
  readonly animations: boolean;
  // The glyph name a reduced-motion or animations-off pose shows.
  readonly reducedHint: string;
  readonly liveText: string;
}

export function buildRobinMessage(output: RobinOutput, animations: boolean): RobinMessage {
  const noteBudget = animations ? Math.min(output.noteDelaysMs.length, MAX_NOTES) : 0;
  return {
    type: 'robin',
    state: output.state,
    speed: output.speed,
    workingCount: output.workingCount,
    noteBudget,
    noteDelaysMs: output.noteDelaysMs.slice(0, noteBudget),
    noteMinMs: NOTE_MIN_GAP_MS,
    noteSpreadMs: NOTE_SPREAD_MS,
    animations,
    reducedHint: STILL_MARKERS[output.state],
    liveText: liveTextFor(output.state),
  };
}

export interface RobinInputs {
  readonly fleet: FleetState;
  readonly statuses: ReadonlyMap<string, ChatStatus>;
  readonly sessions: readonly AgentSession[];
  readonly queueRows: readonly QueueRow[];
  readonly doneStages: readonly string[];
  readonly hatchEligible: boolean;
}

const CLI_FAILED = new Set(['failed', 'error']);

function lower(value: string | null): string {
  return (value ?? '').trim().toLowerCase();
}

// Reduces the host's existing inputs to the signals the machine reads.
export function buildRobinSignals(input: RobinInputs): RobinSignals {
  const isDone = (stage: string | null): boolean => {
    const norm = lower(stage);
    return norm.length > 0 && input.doneStages.some((d) => lower(d) === norm);
  };
  let workingCount = 0;
  let needs = false;
  for (const status of input.statuses.values()) {
    if (status === 'working') {
      workingCount++;
    } else if (status === 'needs') {
      needs = true;
    }
  }
  const launchIds: string[] = [];
  const doneIds: string[] = [];
  const failedIds: string[] = [];
  const doneTickets = new Set<string>();
  for (const entry of input.fleet.entries) {
    if (!entry.isBackfill && entry.ticket !== null) {
      launchIds.push(entry.sessionId);
    }
    if (entry.ended && entry.outcome === 'done') {
      doneIds.push(entry.sessionId);
    } else if (entry.ended && entry.outcome === 'failed') {
      failedIds.push(entry.sessionId);
    }
    if (entry.ticket !== null && isDone(entry.stage)) {
      doneTickets.add(entry.ticket);
    }
  }
  for (const session of input.sessions) {
    if (lower(session.kind) === 'background' && CLI_FAILED.has(lower(session.state))) {
      failedIds.push(session.sessionId);
    }
  }
  for (const row of input.queueRows) {
    if (isDone(row.stage)) {
      doneTickets.add(row.key);
    }
  }
  const current = input.fleet.currentOrchestrator;
  return {
    workingCount,
    needs,
    launchIds,
    doneIds,
    failedIds,
    rotateKey: current !== null && input.fleet.pastOrchestrators.length > 0 ? current.sessionId : null,
    doneTickets: [...doneTickets],
    queueEmpty: input.queueRows.length === 0,
    queueAllDone: input.queueRows.length > 0 && input.queueRows.every((row) => isDone(row.stage)),
    hatchEligible: input.hatchEligible,
  };
}
