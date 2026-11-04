import * as assert from 'assert';
import {
  AGENTS_ARGS,
  AGENTS_BINARY,
  AGENTS_MAX_BUFFER,
  AGENTS_TIMEOUT_MS,
  listAgentSessions,
  parseAgentsOutput,
} from '../../claude/agentsCli';

const A = 'aaaaaaaa-0000-0000-0000-000000000001';

describe('parseAgentsOutput', () => {
  it('keeps only the known fields after coercion', () => {
    const out = parseAgentsOutput(
      JSON.stringify([
        { sessionId: A, kind: 'background', state: 'running', status: 'busy', cwd: '/w', name: 'n', startedAt: 1700000000, pid: 42, extra: 'x' },
      ]),
    );
    assert.deepStrictEqual(out, [
      { sessionId: A, kind: 'background', state: 'running', status: 'busy', cwd: '/w', name: 'n', startedAt: '1700000000', pid: 42 },
    ]);
  });

  it('returns an empty list for anything but an array of objects', () => {
    for (const text of ['', 'not json', '{}', '"x"', 'null', '42']) {
      assert.deepStrictEqual(parseAgentsOutput(text), []);
    }
    assert.deepStrictEqual(parseAgentsOutput('[1, "a", null, []]'), []);
  });

  it('drops a session whose id fails the id grammar', () => {
    const out = parseAgentsOutput(JSON.stringify([{ sessionId: 'abc; rm -rf' }, { sessionId: 'short' }, { sessionId: 5 }, { sessionId: A }]));
    assert.deepStrictEqual(out.map((s) => s.sessionId), [A]);
  });

  it('strips control characters, caps length and nulls bad types', () => {
    const [s] = parseAgentsOutput(JSON.stringify([{ sessionId: A, name: 'a\u001b[31mb' + 'x'.repeat(500), state: 7, pid: -3 }]));
    assert.ok(![...(s.name ?? '')].some((ch) => ch.charCodeAt(0) < 32));
    assert.strictEqual((s.name ?? '').length, 200);
    assert.strictEqual(s.state, null);
    assert.strictEqual(s.pid, null);
  });
});

describe('listAgentSessions', () => {
  it('passes the workspace folder to the runner and parses stdout', async () => {
    let seen = '';
    const result = await listAgentSessions(async (cwd) => {
      seen = cwd;
      return JSON.stringify([{ sessionId: A }]);
    }, '/work/sample-app');
    assert.strictEqual(seen, '/work/sample-app');
    assert.ok(result.ok && result.sessions.length === 1);
  });

  it('turns a missing command into a failed result', async () => {
    const result = await listAgentSessions(async () => {
      throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    }, '/w');
    assert.ok(!result.ok && /not found/.test(result.reason));
  });

  it('turns any other failure into a failed result without throwing', async () => {
    const result = await listAgentSessions(async () => {
      throw new Error('boom');
    }, '/w');
    assert.ok(!result.ok);
  });

  it('uses a fixed binary, fixed arguments, a timeout and an output cap', () => {
    assert.strictEqual(AGENTS_BINARY, 'claude');
    assert.deepStrictEqual([...AGENTS_ARGS], ['agents', '--json']);
    assert.strictEqual(AGENTS_TIMEOUT_MS, 5000);
    assert.strictEqual(AGENTS_MAX_BUFFER, 4 * 1024 * 1024);
  });
});
