import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { FleetReloader } from '../../fleet/fleetReloader';
import { watchFleetFiles } from '../../fleet/fleetWatcher';
import { FleetState } from '../../fleet/types';

// Runs only in the Extension Development Host (npm run test:integration). A line appended to a watched
// fleet file must reach the fleet state through the real file watcher and the debounced reloader.

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

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  // The watcher reloads once more a second after each new watch; waiting past that makes
  // the next write reach the state only through a live watcher event.
  const PAST_LATE_RELOAD_MS = 1600;
  async function waitForEntries(get: () => FleetState | undefined, count: number): Promise<void> {
    const deadline = Date.now() + 8000;
    while ((get()?.entries.length ?? 0) !== count && Date.now() < deadline) {
      await sleep(50);
    }
    assert.strictEqual(get()?.entries.length ?? 0, count);
  }

  // An orchestrator often writes its first record after Nest has started watching the folder.
  const cases = [
    { title: 'its folder exists', parts: ['dev'], existing: 1 },
    { title: 'its folder is created with it', parts: ['dev'], existing: 0 },
    { title: 'two folders are created with it', parts: ['linked', 'dev'], existing: 0 },
  ];
  for (const c of cases) {
    it('follows a fleet file created after the watch starts when ' + c.title, async function () {
      this.timeout(25000);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-fleet-it-'));
      if (c.existing > 0) {
        fs.mkdirSync(path.join(dir, ...c.parts.slice(0, c.existing)), { recursive: true });
      }
      const file = path.join(dir, ...c.parts, 'fleet.jsonl');

      let latest: FleetState | undefined;
      const reloader = new FleetReloader({ getPaths: () => [file], onChange: (s) => (latest = s) });
      const watch = watchFleetFiles([file], reloader);
      try {
        await reloader.reload();
        await waitForEntries(() => latest, 0);
        await sleep(PAST_LATE_RELOAD_MS);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, line(A, 'first'), 'utf8');
        await waitForEntries(() => latest, 1);
        await sleep(PAST_LATE_RELOAD_MS);
        fs.appendFileSync(file, line(B, 'second'));
        await waitForEntries(() => latest, 2);
      } finally {
        watch.dispose();
        reloader.dispose();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('follows a fleet file again after its folder is deleted and made again', async function () {
    this.timeout(25000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-fleet-it-'));
    const dev = path.join(dir, 'dev');
    const file = path.join(dev, 'fleet.jsonl');
    fs.mkdirSync(dev);
    fs.writeFileSync(file, line(A, 'first'), 'utf8');

    let latest: FleetState | undefined;
    const reloader = new FleetReloader({ getPaths: () => [file], onChange: (s) => (latest = s) });
    const watch = watchFleetFiles([file], reloader);
    try {
      await reloader.reload();
      await waitForEntries(() => latest, 1);
      await sleep(PAST_LATE_RELOAD_MS);
      fs.rmSync(dev, { recursive: true, force: true });
      await waitForEntries(() => latest, 0);
      await sleep(PAST_LATE_RELOAD_MS * 2);
      fs.mkdirSync(dev);
      fs.writeFileSync(file, line(A, 'first') + line(B, 'second'), 'utf8');
      await waitForEntries(() => latest, 2);
      await sleep(PAST_LATE_RELOAD_MS);
      fs.appendFileSync(file, line('cccccccc-0000-0000-0000-000000000003', 'third'));
      await waitForEntries(() => latest, 3);
    } finally {
      watch.dispose();
      reloader.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
