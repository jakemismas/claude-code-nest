// Unit tests for fleet status mapping, rollup and attachable session selection.
import * as assert from 'assert';
import { ChatStatus, StatusInput, attachableSessionIds, computeStatuses, isAttachable, mapStatus, rollupStatus } from '../../fleet/status';
import { FleetEntry } from '../../fleet/types';

const base: StatusInput = { hasTranscript: true, questionPending: false, fleet: null, agent: null };
const agent = (kind: string, state: string | null, status: string | null = null) => ({ kind, state, status });

function entry(id: string, extra: Partial<FleetEntry> = {}): FleetEntry {
  return {
    sessionId: id, name: 'n', ticket: null, role: null, agent: '', launchedBy: '', cwd: '', client: '', folder: null,
    tags: [], stage: null, ended: false, outcome: null, firstAt: null, lastAt: null, isBackfill: false, ...extra,
  };
}

describe('mapStatus', () => {
  it('maps an interactive busy session to working', () => {
    assert.strictEqual(mapStatus({ ...base, agent: agent('interactive', null, 'busy') }), 'working');
  });
  it('leaves an interactive session that is not busy as idle', () => {
    assert.strictEqual(mapStatus({ ...base, agent: agent('interactive', null, 'idle') }), 'idle');
  });
  for (const state of ['running', 'working', 'busy', 'RUNNING']) {
    it(`maps a background ${state} session to working`, () => {
      assert.strictEqual(mapStatus({ ...base, agent: agent('background', state) }), 'working');
    });
  }
  for (const state of ['blocked', 'waiting', 'needs-input', 'needs_input']) {
    it(`maps a background ${state} session to needs`, () => {
      assert.strictEqual(mapStatus({ ...base, agent: agent('background', state) }), 'needs');
    });
  }
  it('maps an unread assistant question to needs', () => {
    assert.strictEqual(mapStatus({ ...base, questionPending: true }), 'needs');
  });
  it('maps a launch with no live session and no transcript to queued', () => {
    assert.strictEqual(mapStatus({ ...base, hasTranscript: false, fleet: { ended: false, outcome: null } }), 'queued');
  });
  it('does not call a launch with a transcript queued', () => {
    assert.strictEqual(mapStatus({ ...base, fleet: { ended: false, outcome: null } }), 'idle');
  });
  for (const state of ['done', 'stopped']) {
    it(`maps a background ${state} session to done`, () => {
      assert.strictEqual(mapStatus({ ...base, agent: agent('background', state) }), 'done');
    });
  }
  it('maps a fleet end to done', () => {
    assert.strictEqual(mapStatus({ ...base, fleet: { ended: true, outcome: 'done' } }), 'done');
  });
  it('maps anything else to idle', () => {
    assert.strictEqual(mapStatus(base), 'idle');
    assert.strictEqual(mapStatus({ ...base, agent: agent('background', 'mystery') }), 'idle');
  });
  it('lets a working session outrank a pending question', () => {
    assert.strictEqual(mapStatus({ ...base, questionPending: true, agent: agent('background', 'running') }), 'working');
  });
});

describe('rollupStatus', () => {
  const rollup = (...s: ChatStatus[]) => rollupStatus(s);
  it('returns null for an empty group', () => {
    assert.strictEqual(rollup(), null);
  });
  it('orders needs, working, queued, done, idle', () => {
    assert.strictEqual(rollup('idle', 'done', 'queued', 'working', 'needs'), 'needs');
    assert.strictEqual(rollup('idle', 'done', 'queued', 'working'), 'working');
    assert.strictEqual(rollup('idle', 'done', 'queued'), 'queued');
    assert.strictEqual(rollup('idle', 'done'), 'done');
    assert.strictEqual(rollup('idle'), 'idle');
  });
});

describe('computeStatuses', () => {
  const A = 'aaaaaaaa-0000-0000-0000-000000000001';
  const B = 'bbbbbbbb-0000-0000-0000-000000000002';
  const C = 'cccccccc-0000-0000-0000-000000000003';
  const session = (sessionId: string, state: string) => ({
    sessionId, kind: 'background', state, status: null, cwd: null, name: null, startedAt: null, pid: null,
  });

  it('ignores sessions that match no chat in the panel', () => {
    const map = computeStatuses([{ sessionId: A, questionPending: false }], [], [session(C, 'running')]);
    assert.deepStrictEqual([...map.keys()], [A]);
    assert.strictEqual(map.get(A), 'idle');
  });
  it('applies a matching live session to its chat', () => {
    const map = computeStatuses([{ sessionId: A, questionPending: false }], [], [session(A, 'running')]);
    assert.strictEqual(map.get(A), 'working');
  });
  it('marks a fleet entry with no transcript as queued', () => {
    const map = computeStatuses([{ sessionId: A, questionPending: false }], [entry(B)], []);
    assert.strictEqual(map.get(B), 'queued');
  });
  it('lets a live session lift a fleet entry that has no transcript yet', () => {
    const map = computeStatuses([], [entry(B)], [session(B, 'running')]);
    assert.strictEqual(map.get(B), 'working');
  });
});

describe('isAttachable', () => {
  for (const state of ['running', 'working', 'busy', 'blocked', 'waiting', 'needs-input', 'needs_input', 'RUNNING']) {
    it(`accepts a background ${state} session`, () => {
      assert.strictEqual(isAttachable(agent('background', state)), true);
    });
  }
  for (const state of ['done', 'stopped', 'idle', null]) {
    it(`rejects a background ${String(state)} session`, () => {
      assert.strictEqual(isAttachable(agent('background', state)), false);
    });
  }
  it('rejects an interactive session even when busy', () => {
    assert.strictEqual(isAttachable({ kind: 'interactive', state: 'running' }), false);
  });
  it('rejects a missing session', () => {
    assert.strictEqual(isAttachable(null), false);
  });
  it('collects the ids of attachable sessions only', () => {
    const session = (sessionId: string, kind: string, state: string) => ({
      sessionId, kind, state, status: null, cwd: null, name: null, startedAt: null, pid: null,
    });
    const ids = attachableSessionIds([
      session('aaaa0001', 'background', 'running'),
      session('aaaa0002', 'background', 'done'),
      session('aaaa0003', 'interactive', 'running'),
    ]);
    assert.deepStrictEqual([...ids], ['aaaa0001']);
  });
});
