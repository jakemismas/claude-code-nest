// Unit tests for resolving the queue file path and reloading the queue on change.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ExpandDeps } from '../../fleet/nestConfig';
import { MAX_QUEUE_FILE_BYTES, QueueReloader, currentQueuePath, loadQueueRows, resolveQueuePath } from '../../fleet/queueSource';

let root: string;
let ws: string;
let deps: ExpandDeps;
const queue = { file: 'dev/queue.md', keyColumn: 'Ticket', stageColumn: 'Stage' };
const table = '| Ticket | Stage |\n|---|---|\n| T-1 | Build |\n';

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nest-queue-')));
  ws = path.join(root, 'ws');
  fs.mkdirSync(path.join(ws, 'dev'), { recursive: true });
  fs.mkdirSync(path.join(root, 'home', '.claude', 'projects'), { recursive: true });
  deps = {
    homedir: path.join(root, 'home'),
    projectsRoot: path.join(root, 'home', '.claude', 'projects'),
    isDirectory: (p) => fs.existsSync(p) && fs.statSync(p).isDirectory(),
    isFile: (p) => fs.existsSync(p) && fs.statSync(p).isFile(),
    listDir: (p) => fs.readdirSync(p),
    realpath: (p) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return null;
      }
    },
  };
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

describe('queue source', () => {
  it('resolves a relative path against the workspace folder', () => {
    assert.strictEqual(resolveQueuePath('dev/queue.md', ws, deps), path.join(ws, 'dev', 'queue.md'));
  });

  it('expands ~ against the home folder', () => {
    assert.strictEqual(resolveQueuePath('~/q.md', ws, deps), path.join(deps.homedir, 'q.md'));
  });

  it('drops a path inside the transcript directory', () => {
    assert.strictEqual(resolveQueuePath('~/.claude/projects/x/q.md', ws, deps), null);
  });

  it('drops a symlink that resolves into the transcript directory', () => {
    fs.symlinkSync(deps.projectsRoot, path.join(ws, 'link'));
    assert.strictEqual(resolveQueuePath('link/q.md', ws, deps), null);
  });

  it('reads and parses the table', async () => {
    fs.writeFileSync(path.join(ws, 'dev', 'queue.md'), table);
    const rows = await loadQueueRows(queue, ws, { trusted: true, deps });
    assert.deepStrictEqual(rows, [{ key: 'T-1', stage: 'Build', title: null }]);
  });

  it('returns nothing for a missing file, no setting or no workspace', async () => {
    assert.deepStrictEqual(await loadQueueRows({ ...queue, file: 'nope.md' }, ws, { trusted: true, deps }), []);
    assert.deepStrictEqual(await loadQueueRows(null, ws, { trusted: true, deps }), []);
    assert.deepStrictEqual(await loadQueueRows(queue, undefined, { trusted: true, deps }), []);
  });

  it('ignores the queue in an untrusted workspace', async () => {
    assert.deepStrictEqual(await loadQueueRows(queue, ws, { trusted: false, deps }), []);
  });

  it('skips a file over 256 KB with one warning', async () => {
    fs.writeFileSync(path.join(ws, 'dev', 'big.md'), table + 'x'.repeat(MAX_QUEUE_FILE_BYTES));
    const warnings: string[] = [];
    const rows = await loadQueueRows({ ...queue, file: 'dev/big.md' }, ws, { trusted: true, deps, warn: (m) => warnings.push(m) });
    assert.deepStrictEqual(rows, []);
    assert.strictEqual(warnings.length, 1);
  });
});

describe('queue reloader', () => {
  class Clock {
    private next = 1;
    readonly pending = new Map<number, () => void>();
    setTimeout(fn: () => void): unknown {
      const id = this.next++;
      this.pending.set(id, fn);
      return id;
    }
    clearTimeout(h: unknown): void {
      this.pending.delete(h as number);
    }
    fireAll(): void {
      const all = [...this.pending.values()];
      this.pending.clear();
      all.forEach((f) => f());
    }
  }

  it('reloads the rows when the queue file changes', async () => {
    const dir = path.join(ws, 'dev');
    const file = path.join(dir, 'reload-queue.md');
    fs.writeFileSync(file, table);
    const clock = new Clock();
    const seen: number[] = [];
    const reloader = new QueueReloader({
      getQueue: () => ({ ...queue, file: 'dev/reload-queue.md' }),
      getWorkspaceFolder: () => ws,
      isTrusted: () => true,
      onRows: (rows) => seen.push(rows.length),
      expandDeps: deps,
      timers: clock,
    });
    await reloader.reload();
    fs.writeFileSync(file, table + '| T-2 | Build |\n');
    reloader.notifyFileEvent();
    reloader.notifyFileEvent();
    assert.strictEqual(clock.pending.size, 1);
    clock.fireAll();
    await new Promise((r) => setTimeout(r, 30));
    assert.deepStrictEqual(seen, [1, 2]);
    reloader.dispose();
  });

  it('runs one load at a time and one follow-up', async () => {
    let loads = 0;
    const reloader = new QueueReloader({
      getQueue: () => {
        loads++;
        return null;
      },
      getWorkspaceFolder: () => ws,
      isTrusted: () => true,
      onRows: () => undefined,
    });
    await Promise.all([reloader.reload(), reloader.reload(), reloader.reload()]);
    assert.strictEqual(loads, 2);
  });

  it('reports the path to watch only when a queue is readable', () => {
    const base = { getWorkspaceFolder: () => ws, isTrusted: () => true, expandDeps: deps };
    assert.strictEqual(currentQueuePath({ ...base, getQueue: () => queue }), path.join(ws, 'dev', 'queue.md'));
    assert.strictEqual(currentQueuePath({ ...base, getQueue: () => null }), undefined);
    assert.strictEqual(currentQueuePath({ ...base, getQueue: () => queue, isTrusted: () => false }), undefined);
  });
});
