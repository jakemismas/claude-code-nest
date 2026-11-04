import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { scanChats } from '../../claude/chatScanner';

// Tests for the vscode-free progress and cancel seam of scanChats (onProgress, shouldCancel) against a
// scratch fixture tree in the OS temp dir: per-file progress, and a prompt stop returning a sorted partial result.

let root: string;
const PROJECT = 'c--Users-Tester-scanprog';
const WORKSPACE = 'c:\\Users\\Tester\\scanprog';

function writeJsonl(dir: string, name: string, objs: unknown[]): void {
  fs.writeFileSync(path.join(dir, name), objs.map((o) => JSON.stringify(o)).join('\n'), 'utf8');
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-scanprog-'));
  const proj = path.join(root, PROJECT);
  fs.mkdirSync(proj, { recursive: true });
  for (let i = 1; i <= 5; i++) {
    const id = 'aaaaaaaa-0000-0000-0000-00000000000' + i;
    writeJsonl(proj, id + '.jsonl', [
      { type: 'custom-title', customTitle: 'Chat ' + i },
      {
        type: 'user',
        timestamp: '2026-06-1' + i + 'T10:00:00.000Z',
        cwd: WORKSPACE,
        message: { content: 'hi' },
      },
    ]);
  }
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('chatScanner progress + cancellation seam', () => {
  it('reports onProgress once per file with the running done/total counts', () => {
    const calls: Array<[number, number]> = [];
    const records = scanChats(WORKSPACE, {
      projectsRoot: root,
      onProgress: (done, total) => calls.push([done, total]),
    });
    assert.strictEqual(records.length, 5);
    assert.strictEqual(calls.length, 5);
    assert.deepStrictEqual(
      calls.map((c) => c[0]),
      [1, 2, 3, 4, 5],
    );
    for (const [, total] of calls) {
      assert.strictEqual(total, 5);
    }
  });

  it('stops early when shouldCancel turns true, returning the partial result sorted', () => {
    let seen = 0;
    const records = scanChats(WORKSPACE, {
      projectsRoot: root,
      // shouldCancel is polled before each file, so two files are read before the cancel lands.
      shouldCancel: () => seen >= 2,
      onProgress: () => {
        seen++;
      },
    });
    assert.strictEqual(records.length, 2);
    // The partial result is still sorted newest first.
    assert.ok(
      (records[0].timestamp ?? 0) >= (records[1].timestamp ?? 0),
      'partial result should be sorted newest-first',
    );
    for (const r of records) {
      assert.ok(/^Chat [1-5]$/.test(r.title), 'unexpected record title: ' + r.title);
    }
  });

  it('returns [] immediately when shouldCancel is true from the start', () => {
    const records = scanChats(WORKSPACE, {
      projectsRoot: root,
      shouldCancel: () => true,
    });
    assert.deepStrictEqual(records, []);
  });

  it('still scans normally when no progress/cancel callbacks are supplied', () => {
    const records = scanChats(WORKSPACE, { projectsRoot: root });
    assert.strictEqual(records.length, 5);
  });

  it('does not modify any fixture file (read-only check)', () => {
    const proj = path.join(root, PROJECT);
    const before = fs.readdirSync(proj).sort();
    scanChats(WORKSPACE, {
      projectsRoot: root,
      onProgress: () => {},
      shouldCancel: () => false,
    });
    const after = fs.readdirSync(proj).sort();
    assert.deepStrictEqual(after, before);
  });
});
