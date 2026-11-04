// Unit tests for the agents poller: visible, hidden and retry polling intervals.

import * as assert from 'assert';
import type { AgentSession, AgentsResult } from '../../claude/agentsCli';
import { AgentsPoller, POLL_HIDDEN_MS, POLL_RETRY_MS, POLL_VISIBLE_MS, PollerTimers } from '../../fleet/agentsPoller';

class FakeClock implements PollerTimers {
  private next = 1;
  readonly pending = new Map<number, { fn: () => void; ms: number }>();
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.pending.set(id, { fn, ms });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  get delays(): number[] {
    return [...this.pending.values()].map((p) => p.ms);
  }
  fire(): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    all.forEach((p) => p.fn());
  }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const ok: AgentsResult = { ok: true, sessions: [] };
const bad: AgentsResult = { ok: false, reason: 'The claude command was not found.', unavailable: true };
const transient: AgentsResult = { ok: false, reason: 'The claude agents command failed.' };

function make(results: AgentsResult[] | (() => Promise<AgentsResult>), watchdogClock?: FakeClock) {
  const clock = new FakeClock();
  const logs: string[] = [];
  const seen: (readonly AgentSession[])[] = [];
  let calls = 0;
  const poller = new AgentsPoller({
    poll: typeof results === 'function' ? () => { calls++; return results(); } : async () => results[Math.min(calls++, results.length - 1)],
    onSessions: (s) => seen.push(s),
    log: (m) => logs.push(m),
    timers: clock,
    ...(watchdogClock === undefined ? {} : { watchdogTimers: watchdogClock }),
  });
  return { clock, logs, seen, poller, calls: () => calls };
}

describe('AgentsPoller', () => {
  it('polls at start and then every 60 seconds while hidden', async () => {
    const t = make([ok]);
    t.poller.start();
    await flush();
    assert.strictEqual(t.calls(), 1);
    assert.deepStrictEqual(t.clock.delays, [POLL_HIDDEN_MS]);
  });

  it('polls every 10 seconds while visible', async () => {
    const t = make([ok]);
    t.poller.start();
    await flush();
    t.poller.setVisible(true);
    await flush();
    assert.strictEqual(t.calls(), 2);
    assert.deepStrictEqual(t.clock.delays, [POLL_VISIBLE_MS]);
  });

  it('returns to the slow cadence when hidden again', async () => {
    const t = make([ok]);
    t.poller.start();
    t.poller.setVisible(true);
    await flush();
    t.poller.setVisible(false);
    assert.deepStrictEqual(t.clock.delays, [POLL_HIDDEN_MS]);
  });

  it('skips an overlapping poll', async () => {
    let release: (r: AgentsResult) => void = () => undefined;
    const t = make(() => new Promise<AgentsResult>((resolve) => { release = resolve; }));
    t.poller.start();
    t.poller.retryNow();
    t.poller.setVisible(true);
    assert.strictEqual(t.calls(), 1);
    release(ok);
    await flush();
    assert.strictEqual(t.calls(), 1);
    assert.deepStrictEqual(t.clock.delays, [POLL_VISIBLE_MS]);
  });

  it('logs once, clears sessions and retries every 5 minutes when the command is missing', async () => {
    const t = make([bad]);
    t.poller.start();
    await flush();
    assert.deepStrictEqual(t.clock.delays, [POLL_RETRY_MS]);
    t.clock.fire();
    await flush();
    t.clock.fire();
    await flush();
    assert.strictEqual(t.logs.length, 1);
    assert.deepStrictEqual(t.seen.every((s) => s.length === 0), true);
  });

  it('does not poll early on becoming visible while unavailable', async () => {
    const t = make([bad]);
    t.poller.start();
    await flush();
    t.poller.setVisible(true);
    await flush();
    assert.strictEqual(t.calls(), 1);
    assert.deepStrictEqual(t.clock.delays, [POLL_RETRY_MS]);
  });

  it('recovers to the normal cadence after a success and logs a later failure again', async () => {
    const t = make([bad, ok, bad]);
    t.poller.start();
    await flush();
    t.poller.retryNow();
    await flush();
    assert.deepStrictEqual(t.clock.delays, [POLL_HIDDEN_MS]);
    t.clock.fire();
    await flush();
    assert.strictEqual(t.logs.length, 2);
  });

  it('treats a throwing runner as a transient failure', async () => {
    const t = make(() => Promise.reject(new Error('x')));
    t.poller.start();
    await flush();
    assert.strictEqual(t.logs.length, 0);
    assert.strictEqual(t.seen.length, 0);
    assert.deepStrictEqual(t.clock.delays, [POLL_HIDDEN_MS]);
  });

  it('stops polling on dispose and ignores a result that arrives later', async () => {
    let release: (r: AgentsResult) => void = () => undefined;
    const t = make(() => new Promise<AgentsResult>((resolve) => { release = resolve; }));
    t.poller.start();
    t.poller.dispose();
    release(ok);
    await flush();
    assert.strictEqual(t.seen.length, 0);
    assert.strictEqual(t.clock.pending.size, 0);
    t.poller.retryNow();
    t.poller.setVisible(true);
    assert.strictEqual(t.calls(), 1);
  });

  it('keeps the last sessions and retries at the normal cadence after a transient failure', async () => {
    const good: AgentsResult = { ok: true, sessions: [{ sessionId: 'aaaaaaaa-0000', kind: null, state: null, status: null, cwd: null, name: null, startedAt: null, pid: null }] };
    const t = make([good, transient, transient]);
    t.poller.start();
    await flush();
    t.clock.fire();
    await flush();
    t.clock.fire();
    await flush();
    assert.strictEqual(t.seen.length, 1);
    assert.strictEqual(t.seen[0].length, 1);
    assert.strictEqual(t.logs.length, 0);
    assert.deepStrictEqual(t.clock.delays, [POLL_HIDDEN_MS]);
  });

  it('resets in-flight and reports a failure when the poll never settles', async () => {
    const wd = new FakeClock();
    const t = make(() => new Promise<AgentsResult>(() => undefined), wd);
    t.poller.start();
    await flush();
    assert.strictEqual(wd.pending.size, 1);
    wd.fire();
    await flush();
    assert.deepStrictEqual(t.clock.delays, [POLL_HIDDEN_MS]);
    t.poller.retryNow();
    await flush();
    assert.strictEqual(t.calls(), 2);
  });

  it('ignores a late result from a timed-out run', async () => {
    const wd = new FakeClock();
    const releases: ((r: AgentsResult) => void)[] = [];
    const t = make(() => new Promise<AgentsResult>((resolve) => { releases.push(resolve); }), wd);
    t.poller.start();
    await flush();
    wd.fire();
    await flush();
    const newer: AgentsResult = { ok: true, sessions: [{ sessionId: 'bbbbbbbb-0000', kind: null, state: null, status: null, cwd: null, name: null, startedAt: null, pid: null }] };
    t.poller.retryNow();
    await flush();
    releases[1](newer);
    await flush();
    releases[0]({ ok: true, sessions: [] });
    await flush();
    assert.strictEqual(t.seen.length, 1);
    assert.strictEqual(t.seen[0][0].sessionId, 'bbbbbbbb-0000');
  });

  it('clears the watchdog timer when a poll settles', async () => {
    const wd = new FakeClock();
    const t = make([ok], wd);
    t.poller.start();
    await flush();
    assert.strictEqual(wd.pending.size, 0);
  });

  it('does not start a new poll while two are unsettled', async () => {
    const wd = new FakeClock();
    const t = make(() => new Promise<AgentsResult>(() => undefined), wd);
    t.poller.start();
    await flush();
    wd.fire();
    await flush();
    t.poller.retryNow();
    await flush();
    wd.fire();
    await flush();
    assert.strictEqual(t.calls(), 2);
    t.poller.retryNow();
    t.clock.fire();
    await flush();
    assert.strictEqual(t.calls(), 2);
    assert.deepStrictEqual(t.clock.delays, [POLL_HIDDEN_MS]);
  });
});
