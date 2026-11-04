'use strict';
// Tests for the private-words push check: word matching, diff parsing and exit codes.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseWordList, buildMatcher, scan, parseDiff, main } = require('./check');

describe('private-words check', () => {
  it('parses a word list, skipping blanks and comments', () => {
    assert.deepStrictEqual(parseWordList('# names\nacme\n\n  Globex Corp  \r\n#x\n'), ['acme', 'Globex Corp']);
  });

  it('matches case-insensitively on word boundaries only', () => {
    const match = buildMatcher(['acme', 'globex corp']);
    assert.deepStrictEqual(match('ACME-repo'), ['acme']);
    assert.deepStrictEqual(match("see Acme's notes"), ['acme']);
    assert.deepStrictEqual(match('acmeville'), []);
    assert.deepStrictEqual(match('Globex Corp ticket'), ['globex corp']);
    assert.deepStrictEqual(match('a.b(c)'), []);
  });

  it('treats regex metacharacters in a listed word literally', () => {
    const match = buildMatcher(['a.c']);
    assert.deepStrictEqual(match('abc'), []);
    assert.deepStrictEqual(match('x a.c y'), ['a.c']);
  });

  it('reports hits in commit messages, paths, and added lines', () => {
    const hits = scan({
      messages: [{ sha: 'abc', text: 'Fix acme import' }],
      paths: ['src/acme/x.ts', 'src/ok.ts'],
      addedLines: [{ file: 'src/ok.ts', line: 4, text: 'const client = "Acme";' }],
    }, ['acme']);
    assert.deepStrictEqual(hits.map((h) => h.where), ['commit abc', 'path src/acme/x.ts', 'src/ok.ts:4']);
  });

  it('parses added lines with their new-file line numbers', () => {
    const diff = [
      'diff --git a/f.txt b/f.txt',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,0 +2,2 @@',
      '+one',
      '+two',
      '@@ -9 +11 @@',
      '-old',
      '+new',
    ].join('\n');
    assert.deepStrictEqual(parseDiff(diff), [
      { file: 'f.txt', line: 2, text: 'one' },
      { file: 'f.txt', line: 3, text: 'two' },
      { file: 'f.txt', line: 11, text: 'new' },
    ]);
  });

  describe('against a real repository', () => {
    let dir;
    let listFile;
    let cwd;
    let savedEnv;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-pw-'));
      listFile = path.join(dir, 'words.txt');
      const repo = path.join(dir, 'repo');
      fs.mkdirSync(repo);
      const g = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
      g('init', '-q', '-b', 'main');
      g('config', 'user.name', 'Test');
      g('config', 'user.email', 'test@example.com');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
      g('add', '.');
      g('commit', '-q', '-m', 'base');
      g('branch', 'base');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'base\nhello acme\n');
      g('commit', '-q', '-am', 'second');
      cwd = process.cwd();
      savedEnv = process.env.NEST_PRIVATE_WORDS;
      process.chdir(repo);
      process.env.NEST_PRIVATE_WORDS = listFile;
    });

    afterEach(() => {
      process.chdir(cwd);
      if (savedEnv === undefined) delete process.env.NEST_PRIVATE_WORDS;
      else process.env.NEST_PRIVATE_WORDS = savedEnv;
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const quiet = (fn) => {
      const out = process.stdout.write;
      const err = process.stderr.write;
      process.stdout.write = () => true;
      process.stderr.write = () => true;
      try { return fn(); } finally { process.stdout.write = out; process.stderr.write = err; }
    };

    it('fails closed when the list is missing', () => {
      assert.strictEqual(quiet(() => main(['base..main'])), 2);
    });

    it('fails closed when the list is empty', () => {
      fs.writeFileSync(listFile, '# nothing yet\n');
      assert.strictEqual(quiet(() => main(['base..main'])), 2);
    });

    it('refuses a range that adds a listed word', () => {
      fs.writeFileSync(listFile, 'acme\n');
      assert.strictEqual(quiet(() => main(['base..main'])), 1);
    });

    it('passes a clean range', () => {
      fs.writeFileSync(listFile, 'globex\n');
      assert.strictEqual(quiet(() => main(['base..main'])), 0);
    });

    it('rejects a malformed range argument', () => {
      fs.writeFileSync(listFile, 'globex\n');
      assert.strictEqual(quiet(() => main(['main;echo x'])), 2);
    });
  });
});
