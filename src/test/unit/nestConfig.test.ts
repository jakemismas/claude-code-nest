// Unit tests for parsing .nest/config.json, linked folder and fleet file expansion, and glob segment matching.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DEFAULT_NEST_CONFIG,
  ExpandDeps,
  MAX_LINKED_EXPANSION,
  defaultExpandDeps,
  expandLinkedFolders,
  isUnderProjectsRoot,
  matchGlobSegment,
  parseNestConfig,
  resolveFleetFileEntries,
  stripJsonComments,
} from '../../fleet/nestConfig';

describe('parseNestConfig', () => {
  it('returns defaults for null, empty and unparsable text', () => {
    assert.deepStrictEqual(parseNestConfig(null).config, DEFAULT_NEST_CONFIG);
    assert.deepStrictEqual(parseNestConfig('   ').config, DEFAULT_NEST_CONFIG);
    const bad = parseNestConfig('{ nope');
    assert.deepStrictEqual(bad.config, DEFAULT_NEST_CONFIG);
    assert.strictEqual(bad.problems.length, 1);
    assert.strictEqual(parseNestConfig('[1,2]').problems.length, 1);
  });

  it('parses a full valid file with no problems', () => {
    const text = JSON.stringify({
      $schema: 'x',
      groupBy: 'date',
      rules: [{ match: 'a', folder: 'b' }],
      tags: { urgent: '#ff0000', calm: '#0af' },
      linkedFolders: ['~/a', '/b/*'],
      queue: { file: 'q.md', keyColumn: 'Key', stageColumn: 'Stage', titleColumn: 'Title' },
      fleet: { files: ['/x/fleet.jsonl'] },
      doneStages: ['Shipped'],
    });
    const { config, problems } = parseNestConfig(text);
    assert.deepStrictEqual(problems, []);
    assert.strictEqual(config.groupBy, 'date');
    assert.strictEqual(config.rules.length, 1);
    assert.deepStrictEqual(config.tags, { urgent: '#ff0000', calm: '#0af' });
    assert.deepStrictEqual(config.linkedFolders, ['~/a', '/b/*']);
    assert.deepStrictEqual(config.queue, { file: 'q.md', keyColumn: 'Key', stageColumn: 'Stage', titleColumn: 'Title' });
    assert.deepStrictEqual(config.fleetFiles, ['/x/fleet.jsonl']);
    assert.deepStrictEqual(config.doneStages, ['Shipped']);
  });

  it('defaults doneStages to Done and groupBy to auto', () => {
    const { config } = parseNestConfig('{}');
    assert.deepStrictEqual(config.doneStages, ['Done']);
    assert.strictEqual(config.groupBy, 'auto');
  });

  it('falls back per field without discarding valid siblings', () => {
    const { config, problems } = parseNestConfig(
      JSON.stringify({ groupBy: 'weekly', linkedFolders: 'nope', tags: { ok: '#123456' }, queue: { file: 'q.md' }, doneStages: [] }),
    );
    assert.strictEqual(config.groupBy, 'auto');
    assert.deepStrictEqual(config.linkedFolders, []);
    assert.deepStrictEqual(config.tags, { ok: '#123456' });
    assert.strictEqual(config.queue, null);
    assert.deepStrictEqual(config.doneStages, ['Done']);
    assert.ok(problems.length >= 4);
  });

  it('drops non-hex colors and reports them', () => {
    const { config, problems } = parseNestConfig(JSON.stringify({ tags: { a: 'red', b: '#12', c: '#abcdef' } }));
    assert.deepStrictEqual(config.tags, { c: '#abcdef' });
    assert.strictEqual(problems.length, 2);
  });

  it('caps string lengths, array sizes and strips control characters', () => {
    const longPath = '/' + 'a'.repeat(2000);
    const longName = 'n'.repeat(500);
    const { config } = parseNestConfig(
      JSON.stringify({
        linkedFolders: [longPath, ...Array.from({ length: 80 }, (_, i) => `/f${i}`)],
        tags: Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`t${i}`, '#000'])),
        rules: Array.from({ length: 300 }, () => ({ k: 'v' })),
        doneStages: [longName, 'a\u0000b'],
      }),
    );
    assert.strictEqual(config.linkedFolders.length, 50);
    assert.strictEqual(config.linkedFolders[0].length, 1024);
    assert.strictEqual(Object.keys(config.tags).length, 100);
    assert.strictEqual(config.rules.length, 200);
    assert.strictEqual(config.doneStages[0].length, 200);
    assert.strictEqual(config.doneStages[1], 'ab');
  });

  it('keeps unsafe rule keys out and ignores empty rules', () => {
    const { config, problems } = parseNestConfig('{"rules":[{"__proto__":"x","a":"b"},{},5]}');
    assert.strictEqual(config.rules.length, 1);
    assert.deepStrictEqual(Object.keys(config.rules[0]), ['a']);
    assert.strictEqual(problems.length, 1);
  });

  it('keeps a sanitized nested match object on a rule', () => {
    const { config, problems } = parseNestConfig(
      '{"rules":[{"match":{"role":"qa","ticket":true,"__proto__":"x","name":"' + 'a'.repeat(500) + '"},"tags":["qa"]}]}',
    );
    assert.deepStrictEqual(problems, []);
    const match = config.rules[0].match as { [k: string]: string | boolean };
    assert.strictEqual(match.role, 'qa');
    assert.strictEqual(match.ticket, true);
    assert.strictEqual(Object.keys(match).includes('__proto__'), false);
    // One character past the cap survives so the rule compiler can refuse the rule.
    assert.strictEqual(String(match.name).length, 201);
  });

  it('drops a rule whose match has a non-string, non-boolean condition and reports it', () => {
    const { config, problems } = parseNestConfig('{"rules":[{"match":{"role":"qa","name":5},"tags":["x"]}]}');
    assert.strictEqual(config.rules.length, 0);
    assert.ok(problems.some((p) => p.includes('rules[0].match')));
  });

  it('accepts comments, trailing commas and a BOM', () => {
    const text = '﻿{\n // note\n "groupBy": "tickets", /* x */\n "doneStages": ["a//b",],\n}';
    const { config, problems } = parseNestConfig(text);
    assert.deepStrictEqual(problems, []);
    assert.strictEqual(config.groupBy, 'tickets');
    assert.deepStrictEqual(config.doneStages, ['a//b']);
    assert.strictEqual(stripJsonComments('"//"'), '"//"');
  });
});

function fakeDeps(dirs: { [dir: string]: string[] }, links: { [p: string]: string } = {}): ExpandDeps {
  return {
    homedir: '/home/u',
    projectsRoot: '/home/u/.claude/projects',
    isDirectory: (p) => p in dirs,
    isFile: () => false,
    listDir: (p) => dirs[p] ?? [],
    realpath: (p) => {
      const resolved = links[p] ?? p;
      return resolved in dirs ? resolved : null;
    },
  };
}

describe('expandLinkedFolders', () => {
  const dirs: { [dir: string]: string[] } = {
    '/home/u': ['work', 'proj-a', 'proj-b', 'notes'],
    '/home/u/work': [],
    '/home/u/proj-a': [],
    '/home/u/proj-b': [],
    '/home/u/.claude/projects': ['x'],
    '/home/u/.claude/projects/x': [],
  };

  it('expands ~, keeps only existing directories and dedupes', () => {
    const r = expandLinkedFolders(['~/work', '~/work', '~/missing'], fakeDeps(dirs));
    assert.deepStrictEqual(r.paths, ['/home/u/work']);
  });

  it('expands a * in the last segment only', () => {
    const r = expandLinkedFolders(['~/proj-*'], fakeDeps(dirs));
    assert.deepStrictEqual(r.paths, ['/home/u/proj-a', '/home/u/proj-b']);
    const bad = expandLinkedFolders(['/home/*/work'], fakeDeps(dirs));
    assert.deepStrictEqual(bad.paths, []);
    assert.strictEqual(bad.problems.length, 1);
  });

  it('keeps a child folder whose name starts with two dots under its parent', () => {
    const r = isUnderProjectsRoot('/home/u/.claude/projects/..foo', fakeDeps(dirs));
    assert.strictEqual(r, true);
    assert.strictEqual(isUnderProjectsRoot('/home/u/.claude/projects-other', fakeDeps(dirs)), false);
    assert.strictEqual(isUnderProjectsRoot('/home/u/.claude', fakeDeps(dirs)), false);
  });

  it('reports no cap problem when expansion yields exactly the limit, and one when more are dropped', () => {
    const names = Array.from({ length: 51 }, (_, i) => `p${String(i).padStart(2, '0')}`);
    const d: { [dir: string]: string[] } = { '/home/u': names };
    for (const n of names) d[`/home/u/${n}`] = [];
    const exact = expandLinkedFolders(names.slice(0, 50).map((n) => `/home/u/${n}`), fakeDeps(d));
    assert.strictEqual(exact.paths.length, 50);
    assert.deepStrictEqual(exact.problems, []);
    const over = expandLinkedFolders(['/home/u/p*'], fakeDeps(d));
    assert.strictEqual(over.paths.length, 50);
    assert.strictEqual(over.problems.length, 1);
    const exactGlob = expandLinkedFolders(['/home/u/p0*', '/home/u/p1*', '/home/u/p2*', '/home/u/p3*', '/home/u/p4*'], fakeDeps({ ...d, '/home/u': names.slice(0, 50) }));
    assert.strictEqual(exactGlob.paths.length, 50);
    assert.deepStrictEqual(exactGlob.problems, []);
  });

  it('rejects relative paths', () => {
    const r = expandLinkedFolders(['relative/dir'], fakeDeps(dirs));
    assert.deepStrictEqual(r.paths, []);
    assert.strictEqual(r.problems.length, 1);
  });

  it('never resolves under the transcript root, by path or by symlink', () => {
    const deps = fakeDeps({ ...dirs, '/home/u/link': [] }, { '/home/u/link': '/home/u/.claude/projects/x' });
    const r = expandLinkedFolders(['~/.claude/projects', '~/.claude/projects/x', '~/link', '~/.claude/*'], deps);
    assert.deepStrictEqual(r.paths, []);
    assert.ok(r.problems.length >= 3);
  });

  it('caps expansion at 50 matches', () => {
    const names = Array.from({ length: 80 }, (_, i) => `d${String(i).padStart(2, '0')}`);
    const many: { [dir: string]: string[] } = { '/r': names };
    for (const n of names) {
      many['/r/' + n] = [];
    }
    const r = expandLinkedFolders(['/r/*'], { ...fakeDeps(many), homedir: '/h' });
    assert.strictEqual(r.paths.length, MAX_LINKED_EXPANSION);
  });
});

describe('resolveFleetFileEntries', () => {
  it('expands ~, drops wildcards, relative paths and transcript paths', () => {
    const deps = fakeDeps({ '/home/u/.claude/projects': [] });
    const r = resolveFleetFileEntries(
      ['~/a/fleet.jsonl', '/abs/*.jsonl', 'rel.jsonl', '~/.claude/projects/x/fleet.jsonl', '~/a/fleet.jsonl'],
      deps,
    );
    assert.deepStrictEqual(r.paths, [path.join('/home/u', 'a', 'fleet.jsonl')]);
    assert.strictEqual(r.problems.length, 3);
  });
});

describe('real filesystem expansion', () => {
  let root: string;
  before(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nest-config-')));
    fs.mkdirSync(path.join(root, 'home', '.claude', 'projects', 'p'), { recursive: true });
    fs.mkdirSync(path.join(root, 'home', 'ok'), { recursive: true });
    fs.symlinkSync(path.join(root, 'home', '.claude', 'projects', 'p'), path.join(root, 'home', 'escape'));
  });
  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rejects a symlink that escapes into the transcript root', () => {
    const deps: ExpandDeps = {
      ...defaultExpandDeps(),
      homedir: path.join(root, 'home'),
      projectsRoot: path.join(root, 'home', '.claude', 'projects'),
    };
    const r = expandLinkedFolders(['~/escape', '~/ok'], deps);
    assert.deepStrictEqual(r.paths, [path.join(root, 'home', 'ok')]);
    assert.ok(isUnderProjectsRoot(path.join(root, 'home', 'escape'), deps));
    assert.ok(!isUnderProjectsRoot(path.join(root, 'home', 'ok'), deps));
  });
});

describe('string-safe trailing comma removal', () => {
  it('keeps commas inside string values and drops real trailing commas', () => {
    const r = parseNestConfig('{"linkedFolders":["/a/b, ]c"],"doneStages":["Done, }x", /* c */ ],}');
    assert.deepStrictEqual(r.config.linkedFolders, ['/a/b, ]c']);
    assert.deepStrictEqual(r.config.doneStages, ['Done, }x']);
  });
});

describe('matchGlobSegment', () => {
  it('matches stars linearly and correctly', () => {
    assert.ok(matchGlobSegment('proj-*', 'proj-a'));
    assert.ok(matchGlobSegment('*a*b*', 'xxaxxb'));
    assert.ok(!matchGlobSegment('a*b', 'ac'));
    assert.ok(matchGlobSegment('a.b*', 'a.bz'));
    assert.ok(!matchGlobSegment('a.b', 'axb'));
  });
  it('does not blow up on many stars', () => {
    const start = Date.now();
    assert.ok(!matchGlobSegment('a*'.repeat(200) + 'b', 'a'.repeat(200)));
    assert.ok(Date.now() - start < 500);
  });
});
