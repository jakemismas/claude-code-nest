import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CONFIG_RELOAD_DEBOUNCE_MS, ConfigReloader, ConfigTimers, loadNestConfig, nestConfigPath } from '../../fleet/configSource';
import { MAX_CONFIG_BYTES } from '../../fleet/nestConfig';
import { OPEN_LAYOUT_FILE_COMMAND, starterLayout, openLayoutFile } from '../../commands/openLayoutFile';
import { parseNestConfig } from '../../fleet/nestConfig';

let root: string;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-cfgsrc-'));
});
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeConfig(name: string, text: string): string {
  const dir = path.join(root, name, '.nest');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

class FakeClock implements ConfigTimers {
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

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

describe('loadNestConfig', () => {
  it('derives the path under the workspace folder', () => {
    assert.strictEqual(nestConfigPath('/w'), path.join('/w', '.nest', 'config.json'));
  });

  it('returns defaults for a missing file or no path', async () => {
    assert.strictEqual((await loadNestConfig(path.join(root, 'none', '.nest', 'config.json'))).config.groupBy, 'auto');
    assert.strictEqual((await loadNestConfig(undefined)).config.groupBy, 'auto');
  });

  it('reads a valid file', async () => {
    const file = writeConfig('valid', '{"groupBy":"date"}');
    assert.strictEqual((await loadNestConfig(file)).config.groupBy, 'date');
  });

  it('skips an oversized file with a warning', async () => {
    const file = writeConfig('big', ' '.repeat(MAX_CONFIG_BYTES + 1));
    const warnings: string[] = [];
    const r = await loadNestConfig(file, (m) => warnings.push(m));
    assert.strictEqual(r.config.groupBy, 'auto');
    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(r.problems.length, 1);
  });

  it('never modifies the file it reads', async () => {
    const file = writeConfig('ro', '{"groupBy":"tickets"}');
    const before = fs.statSync(file).mtimeMs;
    await loadNestConfig(file);
    assert.strictEqual(fs.statSync(file).mtimeMs, before);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"groupBy":"tickets"}');
  });
});

describe('ConfigReloader', () => {
  it('debounces a burst of events into one reload within 500 ms', async () => {
    assert.ok(CONFIG_RELOAD_DEBOUNCE_MS < 500);
    const file = writeConfig('rl', '{"groupBy":"auto"}');
    const clock = new FakeClock();
    const seen: string[] = [];
    const reloader = new ConfigReloader({ getPath: () => file, onChange: (p) => seen.push(p.config.groupBy), timers: clock });
    await reloader.reload();
    assert.deepStrictEqual(seen, ['auto']);

    fs.writeFileSync(file, '{"groupBy":"date"}');
    reloader.notifyFileEvent();
    reloader.notifyFileEvent();
    reloader.notifyFileEvent();
    assert.strictEqual(clock.pending.size, 1);
    assert.strictEqual([...clock.pending.values()][0].ms, CONFIG_RELOAD_DEBOUNCE_MS);
    clock.fireAll();
    await settle();
    assert.deepStrictEqual(seen, ['auto', 'date']);
    assert.strictEqual(reloader.getParsed().config.groupBy, 'date');
  });

  it('ignores events after dispose', async () => {
    const clock = new FakeClock();
    const reloader = new ConfigReloader({ getPath: () => undefined, onChange: () => assert.fail('no call'), timers: clock });
    reloader.dispose();
    reloader.notifyFileEvent();
    assert.strictEqual(clock.pending.size, 0);
    await reloader.reload();
  });

  it('keeps one load in flight and runs exactly one more for changes that arrive meanwhile', async () => {
    const file = writeConfig('sup', '{"groupBy":"date"}');
    const seen: string[] = [];
    let loads = 0;
    const reloader = new ConfigReloader({
      getPath: () => {
        loads++;
        return file;
      },
      onChange: (p) => seen.push(p.config.groupBy),
    });
    await Promise.all([reloader.reload(), reloader.reload(), reloader.reload()]);
    assert.strictEqual(loads, 2);
    assert.strictEqual(seen.length, 2);
  });
});

describe('openLayoutFile', () => {
  function deps(over: Partial<Parameters<typeof openLayoutFile>[0]> = {}) {
    const calls: string[] = [];
    const d = {
      workspaceFolder: () => '/w' as string | undefined,
      fileExists: async () => false,
      openExisting: async (p: string) => {
        calls.push('existing:' + p);
      },
      schemaRef: () => 'file:///ext/schemas/nest-config.schema.json',
      openUntitled: async (p: string, c: string) => {
        calls.push('untitled:' + p + ':' + c.includes('file:///ext/schemas/nest-config.schema.json'));
      },
      notify: (m: string) => {
        calls.push('notify:' + m.length);
      },
      ...over,
    };
    return { d, calls };
  }

  it('uses the stable command id', () => {
    assert.strictEqual(OPEN_LAYOUT_FILE_COMMAND, 'claudeNest.openLayoutFile');
  });

  it('opens the existing file', async () => {
    const { d, calls } = deps({ fileExists: async () => true });
    await openLayoutFile(d);
    assert.deepStrictEqual(calls, ['existing:' + path.join('/w', '.nest', 'config.json')]);
  });

  it('opens an untitled starter when the file is missing', async () => {
    const { d, calls } = deps();
    await openLayoutFile(d);
    assert.deepStrictEqual(calls, ['untitled:' + path.join('/w', '.nest', 'config.json') + ':true']);
  });

  it('tells the user when there is no workspace folder', async () => {
    const { d, calls } = deps({ workspaceFolder: () => undefined });
    await openLayoutFile(d);
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].startsWith('notify:'));
  });

  it('ships a starter that points $schema at the given reference and parses cleanly', () => {
    const starter = starterLayout('file:///ext/schemas/nest-config.schema.json');
    assert.strictEqual(parseNestConfig(starter).config.groupBy, 'auto');
    assert.ok(starter.includes('"$schema": "file:///ext/schemas/nest-config.schema.json"'));
    assert.deepStrictEqual(parseNestConfig(starter).problems, []);
  });
});
