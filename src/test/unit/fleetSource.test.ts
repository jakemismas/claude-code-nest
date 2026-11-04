import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadFleetState, splitFleetLines, fleetFilePaths, MAX_FLEET_FILE_BYTES } from '../../fleet/fleetSource';
import { FleetReloader, FleetTimers } from '../../fleet/fleetReloader';

const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';

let root: string;

function launch(id: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ v: 1, at: '2026-01-01T00:00:00Z', event: 'launch', sessionId: id, name: 'n', ...extra });
}

function fleetFile(name: string, content: string): string {
  const dir = path.join(root, name, 'dev');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'fleet.jsonl');
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-fleet-'));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('fleetSource', () => {
  it('derives one path per workspace folder', () => {
    assert.deepStrictEqual(fleetFilePaths(['/a', '/b']), [path.join('/a', 'dev', 'fleet.jsonl'), path.join('/b', 'dev', 'fleet.jsonl')]);
  });

  it('reads and folds every listed file, skipping bad lines and missing files', async () => {
    const f1 = fleetFile('w1', [launch(A, { role: 'orchestrator' }), 'garbage', ''].join('\n'));
    const f2 = fleetFile('w2', launch(B, { role: 'build', ticket: 'T-101' }) + '\r\n');
    const state = await loadFleetState([f1, f2, path.join(root, 'none', 'dev', 'fleet.jsonl')]);
    assert.strictEqual(state.entries.length, 2);
    assert.strictEqual(state.currentOrchestrator?.sessionId, A);
  });

  it('skips a file over 8 MB with one warning', async () => {
    const big = fleetFile('big', launch(A) + '\n' + ' '.repeat(MAX_FLEET_FILE_BYTES));
    const warnings: string[] = [];
    const state = await loadFleetState([big], { warn: (m) => warnings.push(m) });
    assert.strictEqual(state.entries.length, 0);
    assert.strictEqual(warnings.length, 1);
  });

  it('warns once per oversized file across reloads and again after it shrinks and regrows', async () => {
    const big = fleetFile('bigonce', launch(A) + '\n' + ' '.repeat(MAX_FLEET_FILE_BYTES));
    const warnings: string[] = [];
    const warned = new Set<string>();
    const opts = { warn: (m: string) => warnings.push(m), warnedOversized: warned };
    await loadFleetState([big], opts);
    await loadFleetState([big], opts);
    assert.strictEqual(warnings.length, 1);
    fs.writeFileSync(big, launch(A) + '\n');
    await loadFleetState([big], opts);
    fs.writeFileSync(big, launch(A) + '\n' + ' '.repeat(MAX_FLEET_FILE_BYTES));
    await loadFleetState([big], opts);
    assert.strictEqual(warnings.length, 2);
  });

  it('drops lines over 16 KB and keeps shorter ones', () => {
    const long = launch(A, { name: 'x'.repeat(20000) });
    const lines = splitFleetLines([long, launch(B)].join('\n'));
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].includes(B));
    const edge = 'y'.repeat(16 * 1024);
    assert.strictEqual(splitFleetLines(edge).length, 1);
    assert.strictEqual(splitFleetLines(edge + 'y').length, 0);
  });

  it('a directory in place of the file contributes nothing', async () => {
    const dir = path.join(root, 'dirasfile', 'dev', 'fleet.jsonl');
    fs.mkdirSync(dir, { recursive: true });
    const state = await loadFleetState([dir]);
    assert.strictEqual(state.entries.length, 0);
  });
});

describe('FleetReloader', () => {
  class FakeClock implements FleetTimers {
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
    fireAll(): void {
      const all = [...this.pending.values()];
      this.pending.clear();
      all.forEach((p) => p.fn());
    }
  }

  async function settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 30));
  }

  it('debounces a burst of file events into one reload at 250 ms', async () => {
    const file = fleetFile('rl1', launch(A) + '\n');
    const clock = new FakeClock();
    const states: number[] = [];
    const reloader = new FleetReloader({ getPaths: () => [file], onChange: (s) => states.push(s.entries.length), timers: clock });
    await reloader.reload();
    assert.deepStrictEqual(states, [1]);

    fs.appendFileSync(file, launch(B) + '\n');
    reloader.notifyFileEvent();
    reloader.notifyFileEvent();
    reloader.notifyFileEvent();
    assert.strictEqual(clock.pending.size, 1);
    assert.strictEqual([...clock.pending.values()][0].ms, 250);
    assert.deepStrictEqual(states, [1]);
    clock.fireAll();
    await settle();
    assert.deepStrictEqual(states, [1, 2]);
    assert.strictEqual(reloader.getState().entries.length, 2);
    reloader.dispose();
  });

  it('does not fire after dispose', async () => {
    const file = fleetFile('rl2', launch(A) + '\n');
    const clock = new FakeClock();
    let calls = 0;
    const reloader = new FleetReloader({ getPaths: () => [file], onChange: () => calls++, timers: clock });
    reloader.notifyFileEvent();
    reloader.dispose();
    assert.strictEqual(clock.pending.size, 0);
    reloader.notifyFileEvent();
    assert.strictEqual(clock.pending.size, 0);
    await reloader.reload();
    assert.strictEqual(calls, 0);
  });

  it('runs one load at a time and one follow-up for changes that arrive meanwhile', async () => {
    const file = fleetFile('flight', launch(A) + '\n');
    let loads = 0;
    const reloader = new FleetReloader({
      getPaths: () => {
        loads++;
        return [file];
      },
      onChange: () => undefined,
    });
    await Promise.all([reloader.reload(), reloader.reload(), reloader.reload()]);
    assert.strictEqual(loads, 2);
    reloader.dispose();
  });
});
