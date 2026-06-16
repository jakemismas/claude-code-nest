import * as assert from 'assert';
import { scanTranscript, resolveTitle } from '../../claude/jsonlReader';

// Pure-logic unit tests for the tolerant, line-type-driven transcript reader.
// No filesystem and no vscode import; the reader operates on raw JSONL text.

function jsonl(...objs: unknown[]): string {
  return objs.map((o) => JSON.stringify(o)).join('\n');
}

describe('jsonlReader.scanTranscript', () => {
  it('extracts customTitle, aiTitle, slug, and timestamp by line type', () => {
    const content = jsonl(
      { type: 'custom-title', sessionId: 's1', customTitle: 'My Custom Title' },
      { type: 'ai-title', sessionId: 's1', aiTitle: 'An AI Title' },
      { type: 'user', slug: 'a-slug', timestamp: '2026-06-15T22:07:19.176Z',
        message: { content: [{ type: 'text', text: 'first user message' }] } },
      { type: 'assistant', timestamp: '2026-06-15T22:08:09.964Z',
        message: { content: [{ type: 'text', text: 'reply' }] } },
    );
    const scan = scanTranscript(content);
    assert.strictEqual(scan.customTitle, 'My Custom Title');
    assert.strictEqual(scan.aiTitle, 'An AI Title');
    assert.strictEqual(scan.slug, 'a-slug');
    assert.strictEqual(scan.firstUserText, 'first user message');
    assert.strictEqual(scan.timestamp, Date.parse('2026-06-15T22:08:09.964Z'));
  });

  it('takes the latest user/assistant timestamp regardless of line order', () => {
    const content = jsonl(
      { type: 'assistant', timestamp: '2026-06-15T22:08:09.964Z', message: { content: 'x' } },
      { type: 'user', timestamp: '2026-06-15T22:07:19.176Z', message: { content: 'y' } },
    );
    const scan = scanTranscript(content);
    assert.strictEqual(scan.timestamp, Date.parse('2026-06-15T22:08:09.964Z'));
  });

  it('tolerates unrelated line types without throwing or polluting fields', () => {
    const content = jsonl(
      { type: 'queue-operation', op: 'enqueue' },
      { type: 'hook_success', hook: 'x' },
      { type: 'attachment', slug: 'attachment-slug', data: 'blob' },
      { type: 'deferred_tools_delta', delta: {} },
      { type: 'last-prompt', text: 'whatever' },
      { type: 'file-history-snapshot', files: [] },
      { type: 'system', subtype: 'info' },
    );
    const scan = scanTranscript(content);
    assert.strictEqual(scan.customTitle, null);
    assert.strictEqual(scan.aiTitle, null);
    // Slug may legitimately ride on an attachment line; capturing it is allowed.
    assert.strictEqual(scan.slug, 'attachment-slug');
    assert.strictEqual(scan.firstUserText, null);
    assert.strictEqual(scan.timestamp, null);
  });

  it('skips malformed (unparseable) and blank lines', () => {
    const content = [
      'not json at all',
      '{ truncated',
      '',
      '   ',
      JSON.stringify({ type: 'ai-title', aiTitle: 'Survives' }),
      '}{',
    ].join('\n');
    const scan = scanTranscript(content);
    assert.strictEqual(scan.aiTitle, 'Survives');
  });

  it('handles a string message body and a {content: string} body', () => {
    const stringBody = jsonl(
      { type: 'user', timestamp: '2026-06-15T22:00:00.000Z', message: 'plain string body' },
    );
    assert.strictEqual(scanTranscript(stringBody).firstUserText, 'plain string body');

    const contentStringBody = jsonl(
      { type: 'user', timestamp: '2026-06-15T22:00:00.000Z', message: { content: 'content string' } },
    );
    assert.strictEqual(scanTranscript(contentStringBody).firstUserText, 'content string');
  });

  it('ignores an invalid timestamp string', () => {
    const content = jsonl(
      { type: 'user', timestamp: 'not-a-date', message: { content: 'x' } },
    );
    assert.strictEqual(scanTranscript(content).timestamp, null);
  });

  it('captures only the first user-message text', () => {
    const content = jsonl(
      { type: 'user', timestamp: '2026-06-15T22:00:00.000Z', message: { content: 'first' } },
      { type: 'user', timestamp: '2026-06-15T22:01:00.000Z', message: { content: 'second' } },
    );
    assert.strictEqual(scanTranscript(content).firstUserText, 'first');
  });
});

describe('jsonlReader.resolveTitle', () => {
  const base = { customTitle: null, aiTitle: null, slug: null, firstUserText: null, timestamp: null };

  it('prefers customTitle over everything', () => {
    const title = resolveTitle({ ...base, customTitle: 'C', aiTitle: 'A', slug: 's', firstUserText: 'f' });
    assert.strictEqual(title, 'C');
  });

  it('falls to aiTitle when customTitle absent', () => {
    assert.strictEqual(resolveTitle({ ...base, aiTitle: 'A', slug: 's', firstUserText: 'f' }), 'A');
  });

  it('falls to slug when both titles absent', () => {
    assert.strictEqual(resolveTitle({ ...base, slug: 's', firstUserText: 'f' }), 's');
  });

  it('falls to truncated first user text when nothing else present', () => {
    const long = 'x'.repeat(200);
    const title = resolveTitle({ ...base, firstUserText: long });
    assert.ok(title !== null);
    assert.ok((title as string).length <= 80);
    assert.ok((title as string).endsWith('...'));
  });

  it('does not truncate a short first user text', () => {
    assert.strictEqual(resolveTitle({ ...base, firstUserText: 'short message' }), 'short message');
  });

  it('collapses whitespace in the first user text fallback', () => {
    assert.strictEqual(
      resolveTitle({ ...base, firstUserText: '  multi   line\n\ttext  ' }),
      'multi line text',
    );
  });

  it('returns null when no signal is present', () => {
    assert.strictEqual(resolveTitle({ ...base }), null);
  });

  it('treats whitespace-only titles as absent and falls through', () => {
    assert.strictEqual(resolveTitle({ ...base, customTitle: '   ', aiTitle: 'A' }), 'A');
  });
});
