import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AgentsResult, execFileRunner, listAgentSessions } from '../../claude/agentsCli';
import { AgentsPoller } from '../../fleet/agentsPoller';

// Runs only in the Extension Development Host (npm run test:integration). It proves the
// real execFile runner against an absent `claude` binary degrades quietly: a failed
// result, one log line, no throw.

describe('agents CLI missing (host)', () => {
  let dir: string;
  let savedPath: string | undefined;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-agents-it-'));
    savedPath = process.env.PATH;
    process.env.PATH = dir;
  });

  after(() => {
    if (savedPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = savedPath;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects the real runner with ENOENT and maps it to a failed result', async () => {
    await assert.rejects(execFileRunner(dir), (e: NodeJS.ErrnoException) => e.code === 'ENOENT');
    const result = await listAgentSessions(execFileRunner, dir);
    assert.deepStrictEqual(result, { ok: false, reason: 'The claude command was not found.', unavailable: true });
  });

  it('logs once and delivers only empty lists when the poller runs against the real runner', async () => {
    const logs: string[] = [];
    let delivered = 0;
    let nonEmpty = 0;
    const poller = new AgentsPoller({
      poll: (): Promise<AgentsResult> => listAgentSessions(execFileRunner, dir),
      onSessions: (sessions) => {
        delivered++;
        nonEmpty += sessions.length;
      },
      log: (m) => logs.push(m),
    });
    try {
      poller.start();
      const deadline = Date.now() + 5000;
      while (logs.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      poller.retryNow();
      await new Promise((r) => setTimeout(r, 300));
      assert.strictEqual(logs.length, 1, 'expected exactly one log line');
      assert.ok(delivered >= 1);
      assert.strictEqual(nonEmpty, 0);
    } finally {
      poller.dispose();
    }
  });
});
