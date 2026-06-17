import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { scanChats } from '../../claude/chatScanner';

// The Polish slice adds a vscode-free progress/cancellation seam to scanChats
// (ScannerOptions.onProgress / shouldCancel). These run against a scratch fixture
// tree under the OS temp dir, never the real ~/.claude files, and import no
// vscode (unit-gate rule). They prove the scanner reports per-file progress and
// stops promptly on a cancel, returning the partial-but-sorted result.

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
  // Five transcripts so progress reports a known total and a cancel can stop early.
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
    // total is constant; done climbs 1..5.
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
      // Cancel after two files have been read. shouldCancel is polled BEFORE each
      // file, so allow the first two through, then cancel before the third.
      shouldCancel: () => seen >= 2,
      onProgress: () => {
        seen++;
      },
    });
    // Exactly two of the five were read before the cancel took effect.
    assert.strictEqual(records.length, 2);
    // The partial result is still sorted newest-first (readdir order is not asserted,
    // only that the partial set comes back sorted by timestamp descending).
    assert.ok(
      (records[0].timestamp ?? 0) >= (records[1].timestamp ?? 0),
      'partial result should be sorted newest-first',
    );
    // Every returned record is one of the fixture chats (no phantom records).
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
