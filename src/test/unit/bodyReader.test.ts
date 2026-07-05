import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  readTranscriptBodies,
  extractBodies,
  selectPreviewBodies,
  ChatMessageBody,
} from '../../claude/bodyReader';

// Headless unit tests for the on-demand single-chat body reader (slice 1). The
// file-reading path runs against a scratch fixture under the OS temp dir, NEVER
// the real ~/.claude files. No vscode import. The reader is read-only and must
// never throw: a malformed line is skipped, an unreadable file yields [].

let root: string;
let goodFile: string;

function writeJsonl(file: string, objs: unknown[]): void {
  fs.writeFileSync(file, objs.map((o) => JSON.stringify(o)).join('\n'), 'utf8');
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-bodyreader-'));
  goodFile = path.join(root, 'good.jsonl');
  writeJsonl(goodFile, [
    { type: 'custom-title', customTitle: 'X' },
    { type: 'user', uuid: 'u1', message: { content: 'first user message' } },
    { type: 'assistant', uuid: 'a1', message: { content: 'assistant reply' } },
    { type: 'queue-operation', op: 'x' },
    { type: 'user', uuid: 'u2', message: { content: [{ type: 'tool_result', content: 'out' }] } },
    { type: 'assistant', uuid: 'a2', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
  ]);
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('bodyReader: ordered extraction over a fixture', () => {
  it('returns every user/assistant body in transcript order', () => {
    const bodies = readTranscriptBodies(goodFile);
    assert.strictEqual(bodies.length, 4, 'four user/assistant lines (unrelated types skipped)');
    assert.deepStrictEqual(
      bodies.map((b) => b.role),
      ['user', 'assistant', 'user', 'assistant'],
    );
    assert.strictEqual(bodies[0].text, 'first user message');
    assert.strictEqual(bodies[0].uuid, 'u1');
    assert.strictEqual(bodies[1].text, 'assistant reply');
  });

  it('carries null text for a tool_result-only and a pure tool_use turn', () => {
    const bodies = readTranscriptBodies(goodFile);
    // The tool_result-only user line and the pure tool_use assistant line have no
    // extractable prose; they are still returned in order with text null.
    assert.strictEqual(bodies[2].role, 'user');
    assert.strictEqual(bodies[2].text, null);
    assert.strictEqual(bodies[3].role, 'assistant');
    assert.strictEqual(bodies[3].text, null);
  });
});

describe('bodyReader: tolerance (never throws)', () => {
  it('returns [] for an unreadable / missing file', () => {
    const missing = path.join(root, 'does-not-exist.jsonl');
    assert.deepStrictEqual(readTranscriptBodies(missing), []);
  });

  it('skips malformed lines without throwing', () => {
    const bodies = extractBodies(
      [
        'not json at all',
        JSON.stringify({ type: 'user', message: { content: 'a' } }),
        '{ broken',
        JSON.stringify({ type: 'assistant', message: { content: 'b' } }),
      ].join('\n'),
    );
    assert.strictEqual(bodies.length, 2);
    assert.strictEqual(bodies[0].text, 'a');
    assert.strictEqual(bodies[1].text, 'b');
  });

  it('returns [] for content with no user/assistant lines', () => {
    const bodies = extractBodies(
      [JSON.stringify({ type: 'ai-title', aiTitle: 'Y' }), JSON.stringify({ type: 'queue-operation' })].join('\n'),
    );
    assert.deepStrictEqual(bodies, []);
  });

  it('handles the string-message and {content:[{text}]} shapes', () => {
    const bodies = extractBodies(
      [
        JSON.stringify({ type: 'user', message: 'bare string body' }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'block text' }] } }),
      ].join('\n'),
    );
    assert.strictEqual(bodies[0].text, 'bare string body');
    assert.strictEqual(bodies[1].text, 'block text');
  });
});

// The hover card's first-user / last-assistant selection (slice s3b-hover-card,
// issue #84). Pure over the ordered bodies; the caller reads them on demand and
// discards both the bodies and this result when the card closes.
describe('bodyReader: selectPreviewBodies (hover card lines, issue #84)', () => {
  function b(role: 'user' | 'assistant', text: string | null): ChatMessageBody {
    return { role, text, uuid: null };
  }

  it('picks the FIRST user body and the LAST assistant body', () => {
    const sel = selectPreviewBodies([
      b('user', 'u1 first'),
      b('assistant', 'a1'),
      b('user', 'u2'),
      b('assistant', 'a2 last'),
    ]);
    assert.strictEqual(sel.firstUser, 'u1 first');
    assert.strictEqual(sel.lastAssistant, 'a2 last');
  });

  it('skips textless turns (tool_use / tool_result) when selecting', () => {
    const sel = selectPreviewBodies([
      b('user', null), // a tool_result-only user line: not the "first user"
      b('user', 'real first user'),
      b('assistant', 'real assistant'),
      b('assistant', null), // a pure tool_use assistant turn: not the "last assistant"
    ]);
    assert.strictEqual(sel.firstUser, 'real first user');
    assert.strictEqual(sel.lastAssistant, 'real assistant');
  });

  it('returns null for a missing role (no user, or no assistant reply yet)', () => {
    const noAssistant = selectPreviewBodies([b('user', 'only a question')]);
    assert.strictEqual(noAssistant.firstUser, 'only a question');
    assert.strictEqual(noAssistant.lastAssistant, null);

    const noUser = selectPreviewBodies([b('assistant', 'opens with assistant')]);
    assert.strictEqual(noUser.firstUser, null);
    assert.strictEqual(noUser.lastAssistant, 'opens with assistant');
  });

  it('returns null/null for an empty transcript', () => {
    const sel = selectPreviewBodies([]);
    assert.strictEqual(sel.firstUser, null);
    assert.strictEqual(sel.lastAssistant, null);
  });
});
