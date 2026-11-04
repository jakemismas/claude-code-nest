import * as assert from 'assert';
import { foldFleet, parseFleetLine, coerceString } from '../../fleet/fleetRecord';
import { FleetRecord } from '../../fleet/types';

const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const C = 'cccccccc-0000-0000-0000-000000000003';

function line(o: Record<string, unknown>): string {
  return JSON.stringify({ v: 1, ...o });
}

function rec(o: Record<string, unknown>): FleetRecord {
  const r = parseFleetLine(line(o));
  assert.ok(r, 'record should parse');
  return r;
}

describe('parseFleetLine', () => {
  it('accepts a valid v1 line', () => {
    const r = parseFleetLine(
      line({
        at: '2026-01-01T00:00:00Z',
        event: 'launch',
        agent: 'main',
        sessionId: A,
        name: 'Orchestrator',
        client: 'acme',
        ticket: 'T-101',
        role: 'orchestrator',
        launchedBy: 'user',
        cwd: '/work/scratch',
      }),
    );
    assert.ok(r);
    assert.strictEqual(r.sessionId, A);
    assert.strictEqual(r.ticket, 'T-101');
    assert.strictEqual(r.role, 'orchestrator');
    assert.strictEqual(r.at, '2026-01-01T00:00:00.000Z');
  });

  it('returns null without throwing for invalid input', () => {
    const bad = [
      '',
      'not json',
      '[]',
      '"x"',
      'null',
      '42',
      JSON.stringify({ v: 2, event: 'launch', sessionId: A }),
      JSON.stringify({ event: 'launch', sessionId: A }),
      line({ event: 'launch' }),
      line({ event: 'launch', sessionId: 'short' }),
      line({ event: 'launch', sessionId: 'zzzzzzzz-zzzz' }),
      line({ event: 'launch', sessionId: A + '\n' }),
      line({ event: 'launch', sessionId: 'a'.repeat(65) }),
      line({ event: 'launch', sessionId: 42 }),
      line({ event: 'teleport', sessionId: A }),
      line({ sessionId: A }),
    ];
    for (const b of bad) {
      assert.strictEqual(parseFleetLine(b), null, b);
    }
  });

  it('ignores unknown fields and drops unknown roles', () => {
    const r = rec({ event: 'launch', sessionId: A, role: 'wizard', extra: { x: 1 } });
    assert.strictEqual(r.role, undefined);
  });

  it('strips control characters and caps lengths', () => {
    const r = rec({
      event: 'launch',
      sessionId: A,
      name: 'a\u0000b\u001b[31mc\u0085d' + 'x'.repeat(500),
      cwd: 'p'.repeat(5000),
    });
    assert.ok(r.name && r.name.length === 200);
    // eslint-disable-next-line no-control-regex
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(r.name));
    assert.ok(r.name.startsWith('ab[31mcd'));
    assert.strictEqual(r.cwd?.length, 1024);
  });

  it('caps folder, tags and tag count on organize', () => {
    const tags = Array.from({ length: 30 }, (_, i) => `t${i}-` + 'y'.repeat(100));
    const r = rec({ event: 'organize', sessionId: A, folder: 'f'.repeat(300), tags, stage: 'Doing' });
    assert.strictEqual(r.folder?.length, 200);
    assert.strictEqual(r.tags?.length, 20);
    assert.ok(r.tags?.every((t) => t.length === 40));
    assert.strictEqual(r.stage, 'Doing');
  });

  it('checks ids on rotate and drops malformed ones', () => {
    const r = rec({ event: 'rotate', sessionId: B, previous: A, next: 'bad id' });
    assert.strictEqual(r.previous, A);
    assert.strictEqual(r.next, undefined);
  });

  it('coerceString rejects non-strings and empties', () => {
    assert.strictEqual(coerceString(5, 10), undefined);
    assert.strictEqual(coerceString('  \u0000 ', 10), undefined);
  });
});

describe('foldFleet', () => {
  it('builds entries and later records override field by field', () => {
    const state = foldFleet([
      rec({ at: '2026-01-01T00:00:00Z', event: 'launch', sessionId: A, name: 'one', ticket: 'T-101', role: 'build', agent: 'g', launchedBy: 'user', cwd: '/w', client: 'c1' }),
      rec({ at: '2026-01-01T00:01:00Z', event: 'launch', sessionId: A, name: 'two' }),
    ]);
    assert.strictEqual(state.entries.length, 1);
    const e = state.entries[0];
    assert.strictEqual(e.name, 'two');
    assert.strictEqual(e.ticket, 'T-101');
    assert.strictEqual(e.role, 'build');
    assert.strictEqual(e.cwd, '/w');
    assert.strictEqual(e.firstAt, '2026-01-01T00:00:00.000Z');
    assert.strictEqual(e.lastAt, '2026-01-01T00:01:00.000Z');
  });

  it('rename changes only the name', () => {
    const e = foldFleet([
      rec({ at: '2026-01-01T00:00:00Z', event: 'launch', sessionId: A, name: 'one', ticket: 'T-101', role: 'qa' }),
      rec({ at: '2026-01-01T00:01:00Z', event: 'rename', sessionId: A, name: 'new', ticket: 'T-999', role: 'build' }),
    ]).entries[0];
    assert.strictEqual(e.name, 'new');
    assert.strictEqual(e.ticket, 'T-101');
    assert.strictEqual(e.role, 'qa');
  });

  it('organize changes only the fields it carries', () => {
    const e = foldFleet([
      rec({ at: '2026-01-01T00:00:00Z', event: 'launch', sessionId: A, name: 'one' }),
      rec({ at: '2026-01-01T00:01:00Z', event: 'organize', sessionId: A, folder: 'F', tags: ['x', 'y'], stage: 'Doing' }),
      rec({ at: '2026-01-01T00:02:00Z', event: 'organize', sessionId: A, stage: 'Done' }),
    ]).entries[0];
    assert.strictEqual(e.folder, 'F');
    assert.deepStrictEqual([...e.tags], ['x', 'y']);
    assert.strictEqual(e.stage, 'Done');
    assert.strictEqual(e.name, 'one');
  });

  it('end marks ended with an outcome', () => {
    const e = foldFleet([
      rec({ at: '2026-01-01T00:00:00Z', event: 'launch', sessionId: A }),
      rec({ at: '2026-01-01T00:01:00Z', event: 'end', sessionId: A, outcome: 'failed' }),
    ]).entries[0];
    assert.strictEqual(e.ended, true);
    assert.strictEqual(e.outcome, 'failed');
  });

  it('ignores events for sessions that never launched', () => {
    const state = foldFleet([rec({ event: 'rename', sessionId: A, name: 'x' }), rec({ event: 'end', sessionId: A })]);
    assert.strictEqual(state.entries.length, 0);
  });

  it('applies records in time order regardless of input order', () => {
    const e = foldFleet([
      rec({ at: '2026-01-01T00:02:00Z', event: 'rename', sessionId: A, name: 'later' }),
      rec({ at: '2026-01-01T00:00:00Z', event: 'launch', sessionId: A, name: 'first' }),
    ]).entries[0];
    assert.strictEqual(e.name, 'later');
  });

  it('resolves the rotate chain and lists past orchestrators newest first', () => {
    const state = foldFleet([
      rec({ at: '2026-01-01T00:00:00Z', event: 'launch', sessionId: A, role: 'orchestrator', name: 'o1' }),
      rec({ at: '2026-01-02T00:00:00Z', event: 'launch', sessionId: B, role: 'orchestrator', name: 'o2' }),
      rec({ at: '2026-01-02T00:00:01Z', event: 'rotate', sessionId: A, previous: A, next: B }),
      rec({ at: '2026-01-03T00:00:00Z', event: 'launch', sessionId: C, role: 'orchestrator', name: 'o3' }),
      rec({ at: '2026-01-03T00:00:01Z', event: 'rotate', sessionId: B, previous: B, next: C }),
    ]);
    assert.strictEqual(state.currentOrchestrator?.sessionId, C);
    assert.deepStrictEqual(state.pastOrchestrators.map((e) => e.sessionId), [B, A]);
  });

  it('has no current orchestrator when the newest has ended', () => {
    const state = foldFleet([
      rec({ at: '2026-01-01T00:00:00Z', event: 'launch', sessionId: A, role: 'orchestrator' }),
      rec({ at: '2026-01-02T00:00:00Z', event: 'end', sessionId: A }),
    ]);
    assert.strictEqual(state.currentOrchestrator, null);
    assert.strictEqual(state.pastOrchestrators.length, 1);
  });

  it('picks the newest unrotated orchestrator', () => {
    const state = foldFleet([
      rec({ at: '2026-01-01T00:00:00Z', event: 'launch', sessionId: A, role: 'orchestrator' }),
      rec({ at: '2026-01-02T00:00:00Z', event: 'launch', sessionId: B, role: 'orchestrator' }),
    ]);
    assert.strictEqual(state.currentOrchestrator?.sessionId, B);
    assert.deepStrictEqual(state.pastOrchestrators.map((e) => e.sessionId), [A]);
  });

  it('backfill creates an entry flagged isBackfill; a launch clears the flag', () => {
    const s1 = foldFleet([rec({ at: '2026-01-01T00:00:00Z', event: 'backfill', sessionId: A, name: 'old', role: 'build' })]);
    assert.strictEqual(s1.entries[0].isBackfill, true);
    assert.strictEqual(s1.entries[0].name, 'old');
    const s2 = foldFleet([
      rec({ at: '2026-01-01T00:00:00Z', event: 'backfill', sessionId: A }),
      rec({ at: '2026-01-01T00:01:00Z', event: 'launch', sessionId: A }),
    ]);
    assert.strictEqual(s2.entries[0].isBackfill, false);
    const s3 = foldFleet([rec({ at: '2026-01-01T00:00:00Z', event: 'launch', sessionId: A })]);
    assert.strictEqual(s3.entries[0].isBackfill, false);
  });
});
