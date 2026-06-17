import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { scanChats, readChat, sessionIdFromPath, resolveDir } from '../../claude/chatScanner';

// File-reading unit tests run against a scratch fixture tree under the OS temp
// dir, NEVER the real ~/.claude files. No vscode import. The scanner is given an
// explicit projectsRoot pointing at the scratch tree.

let root: string;

function writeJsonl(dir: string, name: string, objs: unknown[]): void {
  fs.writeFileSync(path.join(dir, name), objs.map((o) => JSON.stringify(o)).join('\n'), 'utf8');
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-scanner-'));
  const proj = path.join(root, 'c--Users-Tester-proj');
  fs.mkdirSync(proj, { recursive: true });

  // A real transcript with a custom title and timestamps.
  writeJsonl(proj, 'aaaaaaaa-0000-0000-0000-000000000001.jsonl', [
    { type: 'custom-title', customTitle: 'Titled Chat' },
    { type: 'user', timestamp: '2026-06-15T10:00:00.000Z', cwd: 'c:\\Users\\Tester\\proj', message: { content: 'hello' } },
    { type: 'assistant', timestamp: '2026-06-15T10:05:00.000Z', message: { content: 'hi' } },
  ]);

  // A transcript with no title at all; title must fall back to sessionId.
  writeJsonl(proj, 'bbbbbbbb-0000-0000-0000-000000000002.jsonl', [
    { type: 'queue-operation', op: 'x' },
  ]);

  // A newer transcript, to assert newest-first sorting.
  writeJsonl(proj, 'cccccccc-0000-0000-0000-000000000003.jsonl', [
    { type: 'ai-title', aiTitle: 'Newer Chat' },
    { type: 'user', timestamp: '2026-06-15T12:00:00.000Z', cwd: 'c:\\Users\\Tester\\proj', message: { content: 'newer' } },
  ]);

  // A transcript carrying all five slice 6 smart-group signals: a pr-link line
  // (PR number/url/repo), a gitBranch on the user/assistant lines, and a leading
  // run of message uuids. Asserts readChat/scanChats wire each scan field through
  // to the ChatRecord (the seam between the reader and the engine's input).
  writeJsonl(proj, 'dddddddd-0000-0000-0000-000000000004.jsonl', [
    { type: 'custom-title', customTitle: 'Signal Chat' },
    {
      type: 'pr-link',
      prNumber: 42,
      prUrl: 'https://github.com/jakemismas/nest/pull/42',
      prRepository: 'jakemismas/nest',
    },
    {
      type: 'user',
      timestamp: '2026-06-15T11:00:00.000Z',
      cwd: 'c:\\Users\\Tester\\proj',
      gitBranch: 'slice/smart-groups',
      uuid: 'uuid-aaaa',
      message: { content: 'first' },
    },
    {
      type: 'assistant',
      timestamp: '2026-06-15T11:01:00.000Z',
      gitBranch: 'slice/smart-groups',
      uuid: 'uuid-bbbb',
      message: { content: 'reply' },
    },
  ]);

  // A bare-UUID transcript dir (no .jsonl extension) and a memory sidecar dir:
  // both must be ignored by the *.jsonl glob.
  fs.mkdirSync(path.join(proj, 'aaaaaaaa-0000-0000-0000-000000000001'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'memory'), { recursive: true });
  // A non-jsonl file that must not be picked up.
  fs.writeFileSync(path.join(proj, 'notes.txt'), 'ignore me', 'utf8');
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('chatScanner.sessionIdFromPath', () => {
  it('strips the .jsonl extension to yield the sessionId', () => {
    assert.strictEqual(
      sessionIdFromPath('/x/y/3ffbf9b4-9d3a-4c98-8616-10b0bec221e4.jsonl'),
      '3ffbf9b4-9d3a-4c98-8616-10b0bec221e4',
    );
  });
});

describe('chatScanner.resolveDir', () => {
  it('resolves the workspace path to the scratch project dir', () => {
    assert.strictEqual(
      resolveDir('c:\\Users\\Tester\\proj', { projectsRoot: root }),
      'c--Users-Tester-proj',
    );
  });

  it('returns null for an unknown workspace', () => {
    assert.strictEqual(resolveDir('c:\\Users\\Nobody\\nope', { projectsRoot: root }), null);
  });
});

describe('chatScanner.scanChats', () => {
  it('globs *.jsonl only, ignoring bare-UUID dirs, the memory dir, and non-jsonl files', () => {
    const records = scanChats('c:\\Users\\Tester\\proj', { projectsRoot: root });
    assert.strictEqual(records.length, 4);
    const ids = records.map((r) => r.sessionId).sort();
    assert.deepStrictEqual(ids, [
      'aaaaaaaa-0000-0000-0000-000000000001',
      'bbbbbbbb-0000-0000-0000-000000000002',
      'cccccccc-0000-0000-0000-000000000003',
      'dddddddd-0000-0000-0000-000000000004',
    ]);
  });

  it('resolves titles and falls back to sessionId when title-less', () => {
    const records = scanChats('c:\\Users\\Tester\\proj', { projectsRoot: root });
    const byId = new Map(records.map((r) => [r.sessionId, r]));
    assert.strictEqual(byId.get('aaaaaaaa-0000-0000-0000-000000000001')?.title, 'Titled Chat');
    assert.strictEqual(byId.get('cccccccc-0000-0000-0000-000000000003')?.title, 'Newer Chat');
    assert.strictEqual(
      byId.get('bbbbbbbb-0000-0000-0000-000000000002')?.title,
      'bbbbbbbb-0000-0000-0000-000000000002',
    );
  });

  it('sorts newest first, with null-timestamp records last', () => {
    const records = scanChats('c:\\Users\\Tester\\proj', { projectsRoot: root });
    assert.strictEqual(records[0].sessionId, 'cccccccc-0000-0000-0000-000000000003');
    assert.strictEqual(records[1].sessionId, 'dddddddd-0000-0000-0000-000000000004');
    assert.strictEqual(records[2].sessionId, 'aaaaaaaa-0000-0000-0000-000000000001');
    assert.strictEqual(records[3].sessionId, 'bbbbbbbb-0000-0000-0000-000000000002');
  });

  it('carries the slice 6 signal fields from the scan through to the ChatRecord', () => {
    const records = scanChats('c:\\Users\\Tester\\proj', { projectsRoot: root });
    const byId = new Map(records.map((r) => [r.sessionId, r]));
    const signal = byId.get('dddddddd-0000-0000-0000-000000000004');
    assert.ok(signal, 'expected the signal-carrying transcript to be scanned');
    assert.strictEqual(signal.prNumber, 42);
    assert.strictEqual(signal.prUrl, 'https://github.com/jakemismas/nest/pull/42');
    assert.strictEqual(signal.prRepository, 'jakemismas/nest');
    assert.strictEqual(signal.gitBranch, 'slice/smart-groups');
    assert.deepStrictEqual(signal.leadingMessageUuids, ['uuid-aaaa', 'uuid-bbbb']);
  });

  it('leaves the slice 6 signal fields null/empty for a transcript carrying none', () => {
    const records = scanChats('c:\\Users\\Tester\\proj', { projectsRoot: root });
    const byId = new Map(records.map((r) => [r.sessionId, r]));
    const plain = byId.get('aaaaaaaa-0000-0000-0000-000000000001');
    assert.ok(plain, 'expected the plain transcript to be scanned');
    assert.strictEqual(plain.prNumber, null);
    assert.strictEqual(plain.prUrl, null);
    assert.strictEqual(plain.prRepository, null);
    assert.deepStrictEqual(plain.leadingMessageUuids, []);
  });

  it('returns [] for an unresolved workspace without throwing', () => {
    assert.deepStrictEqual(scanChats('c:\\Users\\Nobody\\nope', { projectsRoot: root }), []);
  });

  it('does not modify any fixture file (read-only check)', () => {
    const proj = path.join(root, 'c--Users-Tester-proj');
    const before = fs.readdirSync(proj).sort();
    scanChats('c:\\Users\\Tester\\proj', { projectsRoot: root });
    const after = fs.readdirSync(proj).sort();
    assert.deepStrictEqual(after, before);
  });
});

describe('chatScanner.readChat', () => {
  it('returns null when the file cannot be read', () => {
    assert.strictEqual(readChat(path.join(root, 'does-not-exist.jsonl')), null);
  });
});
