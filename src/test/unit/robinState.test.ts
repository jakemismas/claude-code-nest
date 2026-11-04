import * as assert from 'assert';
import {
  INITIAL_ROBIN_MEMORY,
  NOTE_MIN_GAP_MS,
  NOTE_SPREAD_MS,
  RobinMemory,
  RobinSignals,
  SLEEP_AFTER_MS,
  TRANSIENT_MS,
  buildRobinMessage,
  buildRobinSignals,
  isNightHour,
  noteDelayMs,
  speedFor,
  stepRobin,
} from '../../fleet/robinState';
import { EMPTY_FLEET_STATE, FleetEntry, FleetState } from '../../fleet/types';

const quiet: RobinSignals = {
  workingCount: 0,
  needs: false,
  launchIds: [],
  doneIds: [],
  failedIds: [],
  rotateKey: null,
  doneTickets: [],
  queueAllDone: false,
  hatchEligible: false,
};
const rnd = () => 0;
// Noon local time on a fixed day, so the night window never applies by accident.
const NOON = new Date(2026, 5, 10, 12, 0, 0).getTime();
const MIDNIGHT = new Date(2026, 5, 10, 1, 0, 0).getTime();

function seed(signals: Partial<RobinSignals> = {}, now = NOON): RobinMemory {
  return stepRobin(INITIAL_ROBIN_MEMORY, { ...quiet, ...signals }, now, rnd).memory;
}

function step(memory: RobinMemory, signals: Partial<RobinSignals>, now: number) {
  return stepRobin(memory, { ...quiet, ...signals }, now, rnd);
}

describe('stepRobin states', () => {
  it('starts idle', () => {
    assert.strictEqual(step(seed(), {}, NOON + 1000).output.state, 'idle');
  });

  it('shows working while chats work, with the peck speed stepping at 3 and 6', () => {
    const m = seed();
    assert.strictEqual(step(m, { workingCount: 1 }, NOON + 1).output.state, 'working');
    assert.strictEqual(speedFor(2), 0);
    assert.strictEqual(speedFor(3), 1);
    assert.strictEqual(speedFor(5), 1);
    assert.strictEqual(speedFor(6), 2);
  });

  it('shows needs while any chat needs the user', () => {
    assert.strictEqual(step(seed(), { needs: true }, NOON + 1).output.state, 'needs');
  });

  it('plays worm for a new launch, then falls back after 1.8 s', () => {
    const m = seed({ launchIds: ['a'] });
    const first = step(m, { launchIds: ['a', 'b'] }, NOON + 100);
    assert.strictEqual(first.output.state, 'worm');
    const during = step(first.memory, { launchIds: ['a', 'b'] }, NOON + 100 + (TRANSIENT_MS.worm ?? 0) - 1);
    assert.strictEqual(during.output.state, 'worm');
    const after = step(during.memory, { launchIds: ['a', 'b'] }, NOON + 100 + (TRANSIENT_MS.worm ?? 0));
    assert.strictEqual(after.output.state, 'idle');
  });

  it('plays done for a new done end and for a ticket entering a finished stage', () => {
    const m = seed({ doneIds: ['a'], doneTickets: ['T-1'] });
    assert.strictEqual(step(m, { doneIds: ['a', 'b'], doneTickets: ['T-1'] }, NOON + 1).output.state, 'done');
    assert.strictEqual(step(m, { doneIds: ['a'], doneTickets: ['T-1', 'T-2'] }, NOON + 1).output.state, 'done');
    const after = step(step(m, { doneIds: ['a', 'b'] }, NOON + 1).memory, { doneIds: ['a', 'b'] }, NOON + 1 + (TRANSIENT_MS.done ?? 0));
    assert.strictEqual(after.output.state, 'idle');
  });

  it('plays error for a new failure for 6 s', () => {
    const m = seed();
    const first = step(m, { failedIds: ['x'] }, NOON + 10);
    assert.strictEqual(first.output.state, 'error');
    assert.strictEqual(step(first.memory, { failedIds: ['x'] }, NOON + 10 + 5999).output.state, 'error');
    assert.strictEqual(step(first.memory, { failedIds: ['x'] }, NOON + 10 + 6000).output.state, 'idle');
  });

  it('plays rotate when the chain head changes, never on first load', () => {
    const first = stepRobin(INITIAL_ROBIN_MEMORY, { ...quiet, rotateKey: 'o1' }, NOON, rnd);
    assert.strictEqual(first.output.state, 'idle');
    assert.strictEqual(step(first.memory, { rotateKey: 'o1' }, NOON + 5).output.state, 'idle');
    const rotated = step(first.memory, { rotateKey: 'o2' }, NOON + 10);
    assert.strictEqual(rotated.output.state, 'rotate');
    assert.strictEqual(step(rotated.memory, { rotateKey: 'o2' }, NOON + 10 + (TRANSIENT_MS.rotate ?? 0)).output.state, 'idle');
  });

  it('plays milestone once when every queue row becomes finished', () => {
    const m = seed({ queueAllDone: false });
    const hit = step(m, { queueAllDone: true }, NOON + 1);
    assert.strictEqual(hit.output.state, 'milestone');
    const later = step(hit.memory, { queueAllDone: true }, NOON + 1 + (TRANSIENT_MS.milestone ?? 0));
    assert.strictEqual(later.output.state, 'idle');
  });

  it('does not play milestone when the queue is already finished on first load', () => {
    const m = seed({ queueAllDone: true });
    assert.strictEqual(step(m, { queueAllDone: true }, NOON + 1).output.state, 'idle');
  });

  it('plays hatch on the first step only when the egg has not hatched', () => {
    const first = stepRobin(INITIAL_ROBIN_MEMORY, { ...quiet, hatchEligible: true }, NOON, rnd);
    assert.strictEqual(first.output.state, 'hatch');
    assert.strictEqual(first.output.hatchStarted, true);
    assert.strictEqual(step(first.memory, { hatchEligible: true }, NOON + (TRANSIENT_MS.hatch ?? 0)).output.state, 'idle');
    assert.strictEqual(step(first.memory, { hatchEligible: true }, NOON + 1).output.hatchStarted, false);
    assert.strictEqual(stepRobin(INITIAL_ROBIN_MEMORY, quiet, NOON, rnd).output.hatchStarted, false);
  });

  it('seeds history on first load so nothing replays', () => {
    const loud: Partial<RobinSignals> = {
      launchIds: ['a'],
      doneIds: ['b'],
      failedIds: ['c'],
      doneTickets: ['T-1'],
      rotateKey: 'o1',
    };
    const first = stepRobin(INITIAL_ROBIN_MEMORY, { ...quiet, ...loud }, NOON, rnd);
    assert.strictEqual(first.output.state, 'idle');
    assert.strictEqual(step(first.memory, loud, NOON + 1).output.state, 'idle');
  });

  it('sleeps after ten minutes with nothing running', () => {
    const m = seed();
    assert.strictEqual(step(m, {}, NOON + SLEEP_AFTER_MS - 1).output.state, 'idle');
    assert.strictEqual(step(m, {}, NOON + SLEEP_AFTER_MS).output.state, 'sleep');
  });

  it('shows night when asleep inside the night window', () => {
    const m = seed({}, MIDNIGHT);
    assert.strictEqual(step(m, {}, MIDNIGHT + SLEEP_AFTER_MS).output.state, 'night');
    assert.strictEqual(isNightHour(22), true);
    assert.strictEqual(isNightHour(5), true);
    assert.strictEqual(isNightHour(6), false);
    assert.strictEqual(isNightHour(21), false);
  });

  it('wakes when a chat starts working', () => {
    const m = seed();
    const asleep = step(m, {}, NOON + SLEEP_AFTER_MS + 5);
    assert.strictEqual(asleep.output.state, 'sleep');
    assert.strictEqual(step(asleep.memory, { workingCount: 1 }, NOON + SLEEP_AFTER_MS + 10).output.state, 'working');
  });
});

describe('stepRobin priority', () => {
  const now = NOON + 100;
  const base = seed({ launchIds: [] });

  it('rotate beats error', () => {
    const m = seed({ rotateKey: 'o1' });
    assert.strictEqual(step(m, { rotateKey: 'o2', failedIds: ['x'] }, now).output.state, 'rotate');
  });
  it('error beats needs', () => {
    assert.strictEqual(step(base, { failedIds: ['x'], needs: true }, now).output.state, 'error');
  });
  it('needs beats worm', () => {
    assert.strictEqual(step(base, { launchIds: ['n'], needs: true }, now).output.state, 'needs');
  });
  it('worm beats done', () => {
    assert.strictEqual(step(base, { launchIds: ['n'], doneIds: ['d'] }, now).output.state, 'worm');
  });
  it('done beats milestone', () => {
    assert.strictEqual(step(base, { doneIds: ['d'], queueAllDone: true }, now).output.state, 'done');
  });
  it('milestone beats working', () => {
    assert.strictEqual(step(base, { queueAllDone: true, workingCount: 2 }, now).output.state, 'milestone');
  });
  it('working beats sleep', () => {
    assert.strictEqual(step(base, { workingCount: 1 }, NOON + SLEEP_AFTER_MS * 2).output.state, 'working');
  });
  it('a lower transient resumes after a higher one ends', () => {
    const first = step(base, { failedIds: ['x'], doneIds: ['d'] }, now);
    assert.strictEqual(first.output.state, 'error');
    const later = step(first.memory, { failedIds: ['x'], doneIds: ['d'] }, now + (TRANSIENT_MS.done ?? 0));
    assert.strictEqual(later.output.state, 'error');
    const end = step(later.memory, { failedIds: ['x'], doneIds: ['d'] }, now + (TRANSIENT_MS.error ?? 0));
    assert.strictEqual(end.output.state, 'idle');
  });
});

describe('robin notes', () => {
  it('schedules zero notes with zero working chats', () => {
    const out = step(seed(), {}, NOON + 1).output;
    assert.deepStrictEqual(out.noteDelaysMs, []);
    assert.strictEqual(buildRobinMessage(out, true).noteBudget, 0);
  });

  it('schedules one note slot per working chat from the injected random source', () => {
    const calls: number[] = [];
    const random = () => {
      calls.push(1);
      return 0.5;
    };
    const out = stepRobin(seed(), { ...quiet, workingCount: 3 }, NOON + 1, random).output;
    assert.strictEqual(out.noteDelaysMs.length, 3);
    assert.strictEqual(calls.length, 3);
    for (const d of out.noteDelaysMs) {
      assert.strictEqual(d, NOTE_MIN_GAP_MS + Math.floor(0.5 * NOTE_SPREAD_MS));
    }
  });

  it('keeps every delay at or above the per-chat minimum gap', () => {
    assert.strictEqual(noteDelayMs(() => 0), NOTE_MIN_GAP_MS);
    assert.ok(noteDelayMs(() => 0.999999) < NOTE_MIN_GAP_MS + NOTE_SPREAD_MS);
    assert.strictEqual(noteDelayMs(() => -5), NOTE_MIN_GAP_MS);
    assert.ok(noteDelayMs(() => 7) < NOTE_MIN_GAP_MS + NOTE_SPREAD_MS);
  });

  it('caps slots at six and keeps the same delays while the count holds', () => {
    let n = 0;
    const random = () => (n++ % 10) / 10;
    const first = stepRobin(seed(), { ...quiet, workingCount: 9 }, NOON + 1, random);
    assert.strictEqual(buildRobinMessage(first.output, true).noteBudget, 6);
    const again = stepRobin(first.memory, { ...quiet, workingCount: 9 }, NOON + 2, random);
    assert.deepStrictEqual(again.output.noteDelaysMs, first.output.noteDelaysMs);
  });

  it('sends no notes when animations are off', () => {
    const out = stepRobin(seed(), { ...quiet, workingCount: 2 }, NOON + 1, rnd).output;
    const msg = buildRobinMessage(out, false);
    assert.strictEqual(msg.noteBudget, 0);
    assert.deepStrictEqual(msg.noteDelaysMs, []);
    assert.strictEqual(msg.animations, false);
  });
});

describe('robin message', () => {
  it('carries the still marker and the live text only for needs and error', () => {
    const m = seed();
    const needs = buildRobinMessage(step(m, { needs: true }, NOON + 1).output, true);
    assert.strictEqual(needs.reducedHint, '?');
    assert.strictEqual(needs.liveText, 'A chat needs you');
    const error = buildRobinMessage(step(m, { failedIds: ['x'] }, NOON + 1).output, true);
    assert.strictEqual(error.reducedHint, '!');
    assert.strictEqual(error.liveText, 'A chat failed');
    const idle = buildRobinMessage(step(m, {}, NOON + 1).output, true);
    assert.strictEqual(idle.liveText, '');
    assert.strictEqual(idle.type, 'robin');
  });

  it('asks the caller to step again at the next transient end or the sleep point', () => {
    const m = seed();
    assert.strictEqual(step(m, {}, NOON + 1).output.nextCheckAt, NOON + SLEEP_AFTER_MS);
    const worm = step(seed({ launchIds: ['a'] }), { launchIds: ['a', 'b'] }, NOON + 50);
    assert.strictEqual(worm.output.nextCheckAt, NOON + 50 + (TRANSIENT_MS.worm ?? 0));
    assert.strictEqual(step(m, { workingCount: 1 }, NOON + 1).output.nextCheckAt, null);
  });
});

function entry(id: string, extra: Partial<FleetEntry> = {}): FleetEntry {
  return {
    sessionId: id, name: 'n', ticket: null, role: null, agent: '', launchedBy: '', cwd: '', client: '', folder: null,
    tags: [], stage: null, ended: false, outcome: null, firstAt: null, lastAt: null, isBackfill: false, ...extra,
  };
}

describe('buildRobinSignals', () => {
  const inputs = (fleet: FleetState, extra: Partial<Parameters<typeof buildRobinSignals>[0]> = {}) => ({
    fleet,
    statuses: new Map(),
    sessions: [],
    queueRows: [],
    doneStages: ['Done'],
    hatchEligible: false,
    ...extra,
  });

  it('counts working chats and flags needs from the statuses', () => {
    const statuses = new Map<string, 'working' | 'needs' | 'idle'>([['a', 'working'], ['b', 'working'], ['c', 'needs'], ['d', 'idle']]);
    const s = buildRobinSignals(inputs(EMPTY_FLEET_STATE, { statuses }));
    assert.strictEqual(s.workingCount, 2);
    assert.strictEqual(s.needs, true);
  });

  it('counts a launch only when it is not a backfill and carries a ticket', () => {
    const fleet: FleetState = {
      ...EMPTY_FLEET_STATE,
      entries: [entry('a', { ticket: 'T-1' }), entry('b', { ticket: 'T-2', isBackfill: true }), entry('c')],
    };
    assert.deepStrictEqual(buildRobinSignals(inputs(fleet)).launchIds, ['a']);
  });

  it('reads done and failed ends, CLI failures, and finished stages', () => {
    const fleet: FleetState = {
      ...EMPTY_FLEET_STATE,
      entries: [
        entry('a', { ended: true, outcome: 'done' }),
        entry('b', { ended: true, outcome: 'failed' }),
        entry('c', { ticket: 'T-9', stage: ' done ' }),
      ],
    };
    const sessions = [
      { sessionId: 'd', kind: 'background', state: 'Failed', status: null, cwd: null, name: null, startedAt: null, pid: null },
      { sessionId: 'e', kind: 'background', state: 'error', status: null, cwd: null, name: null, startedAt: null, pid: null },
      { sessionId: 'f', kind: 'interactive', state: 'error', status: null, cwd: null, name: null, startedAt: null, pid: null },
    ];
    const s = buildRobinSignals(inputs(fleet, { sessions }));
    assert.deepStrictEqual(s.doneIds, ['a']);
    assert.deepStrictEqual(s.failedIds, ['b', 'd', 'e']);
    assert.deepStrictEqual(s.doneTickets, ['T-9']);
  });

  it('flags the milestone only for a non-empty queue that is entirely finished', () => {
    const row = (key: string, stage: string) => ({ key, stage, title: null });
    assert.strictEqual(buildRobinSignals(inputs(EMPTY_FLEET_STATE)).queueAllDone, false);
    assert.strictEqual(buildRobinSignals(inputs(EMPTY_FLEET_STATE, { queueRows: [row('A', 'Done'), row('B', 'Build')] })).queueAllDone, false);
    const all = buildRobinSignals(inputs(EMPTY_FLEET_STATE, { queueRows: [row('A', 'Done'), row('B', 'DONE')] }));
    assert.strictEqual(all.queueAllDone, true);
    assert.deepStrictEqual(all.doneTickets, ['A', 'B']);
  });

  it('keys a rotate only when there is a chain behind the current orchestrator', () => {
    const cur = entry('o2');
    assert.strictEqual(buildRobinSignals(inputs({ ...EMPTY_FLEET_STATE, currentOrchestrator: cur })).rotateKey, null);
    const fleet: FleetState = { entries: [], currentOrchestrator: cur, pastOrchestrators: [entry('o1')] };
    assert.strictEqual(buildRobinSignals(inputs(fleet)).rotateKey, 'o2');
  });
});
