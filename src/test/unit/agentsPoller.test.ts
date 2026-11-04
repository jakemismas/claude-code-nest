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
const bad: AgentsResult = { ok: false, reason: 'The claude command was not found.' };

function make(results: AgentsResult[] | (() => Promise<AgentsResult>)) {
  const clock = new FakeClock();
  const logs: string[] = [];
  const seen: (readonly AgentSession[])[] = [];
  let calls = 0;
  const poller = new AgentsPoller({
    poll: typeof results === 'function' ? () => { calls++; return results(); } : async () => results[Math.min(calls++, results.length - 1)],
    onSessions: (s) => seen.push(s),
    log: (m) => logs.push(m),
    timers: clock,
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

  it('logs once, clears sessions and retries every 5 minutes when the command fails', async () => {
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

  it('does not poll early on becoming visible while failing', async () => {
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

  it('treats a throwing runner as a failure', async () => {
    const t = make(() => Promise.reject(new Error('x')));
    t.poller.start();
    await flush();
    assert.strictEqual(t.logs.length, 1);
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
});
