import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { FleetReloader } from '../../fleet/fleetReloader';
import { watchFleetFiles } from '../../fleet/fleetWatcher';
import { FleetState } from '../../fleet/types';

// Runs only in the Extension Development Host (npm run test:integration). It proves
// a line appended to a watched fleet file reaches the fleet state through the real
// vscode file watcher and the debounced reloader.

const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';

function line(id: string, name: string): string {
  return JSON.stringify({ v: 1, at: '2026-01-01T00:00:00Z', event: 'launch', sessionId: id, name, role: 'build' }) + '\n';
}

describe('fleet watcher (host)', () => {
  it('reloads the fleet state after a line is appended', async function () {
    this.timeout(15000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-fleet-it-'));
    fs.mkdirSync(path.join(dir, 'dev'));
    const file = path.join(dir, 'dev', 'fleet.jsonl');
    fs.writeFileSync(file, line(A, 'first'), 'utf8');

    let latest: FleetState | undefined;
    const reloader = new FleetReloader({ getPaths: () => [file], onChange: (s) => (latest = s) });
    const watch = watchFleetFiles([file], reloader);
    try {
      await reloader.reload();
      assert.strictEqual(latest?.entries.length, 1);
      // Give the watcher time to register before the write.
      await new Promise((r) => setTimeout(r, 500));
      fs.appendFileSync(file, line(B, 'second'));
      const deadline = Date.now() + 10000;
      while ((latest?.entries.length ?? 0) < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.strictEqual(latest?.entries.length, 2);
    } finally {
      watch.dispose();
      reloader.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
