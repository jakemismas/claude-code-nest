import * as assert from 'assert';
import { scanTranscript } from '../../claude/jsonlReader';

// Pure-logic unit tests for the Sprint 2 tier-A summary absorbers on the
// tolerant transcript reader. No filesystem and no vscode import; the reader
// operates on raw JSONL text. These cover the additive fields only; the
// title/timestamp/PR/branch/uuid behavior is covered by jsonlReader.test.ts and
// must stay untouched (additive contract).

function jsonl(...objs: unknown[]): string {
  return objs.map((o) => JSON.stringify(o)).join('\n');
}

function userLine(text: string, extra: Record<string, unknown> = {}): unknown {
  return { type: 'user', timestamp: '2026-06-15T22:00:00.000Z', message: { content: text }, ...extra };
}

function assistantLine(extra: Record<string, unknown> = {}): unknown {
  return { type: 'assistant', timestamp: '2026-06-15T22:01:00.000Z', message: { content: 'reply' }, ...extra };
}

describe('jsonlReader tier-A: messageCount', () => {
  it('counts only user/assistant lines, not unrelated types', () => {
    const content = jsonl(
      { type: 'custom-title', customTitle: 'X' },
      userLine('a'),
      assistantLine(),
      { type: 'queue-operation', op: 'x' },
      userLine('b'),
      { type: 'file-history-snapshot', files: [] },
    );
    assert.strictEqual(scanTranscript(content).messageCount, 3);
  });

  it('defaults to 0 when no user/assistant line is present', () => {
    const content = jsonl({ type: 'ai-title', aiTitle: 'Y' }, { type: 'queue-operation', op: 'x' });
    assert.strictEqual(scanTranscript(content).messageCount, 0);
  });
});

describe('jsonlReader tier-A: last message text and role', () => {
  it('captures the last user/assistant turn text and role (last-wins)', () => {
    const content = jsonl(
      userLine('first user'),
      assistantLine({ message: { content: 'assistant reply' } }),
      userLine('the last word'),
    );
    const scan = scanTranscript(content);
    assert.strictEqual(scan.lastMessageText, 'the last word');
    assert.strictEqual(scan.lastMessageRole, 'user');
  });

  it('records the assistant as the last role when it speaks last', () => {
    const content = jsonl(userLine('hi'), assistantLine({ message: { content: 'bye' } }));
    const scan = scanTranscript(content);
    assert.strictEqual(scan.lastMessageText, 'bye');
    assert.strictEqual(scan.lastMessageRole, 'assistant');
  });

  it('advances the role on a textless assistant turn but keeps the prior text', () => {
    // A pure tool_use assistant turn has no extractable text; it is still a real
    // assistant action, so the role reflects that the assistant spoke last.
    const content = jsonl(
      userLine('a question'),
      { type: 'assistant', timestamp: '2026-06-15T22:02:00.000Z', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
    );
    const scan = scanTranscript(content);
    assert.strictEqual(scan.lastMessageRole, 'assistant');
    assert.strictEqual(scan.lastMessageText, 'a question');
  });

  it('does NOT advance the role to user on a trailing tool_result feedback line', () => {
    // The harness records a tool output as a type:user line whose content is a
    // tool_result block. That is machine feedback inside an assistant tool loop,
    // not a human turn: the awaiting-reply heuristic (lastMessageRole === 'user')
    // must read 'assistant' here, and the tool_result must not overwrite the
    // snippet text.
    const content = jsonl(
      userLine('please run the build'),
      { type: 'assistant', timestamp: '2026-06-15T22:02:00.000Z', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm run build' } }] } },
      { type: 'user', timestamp: '2026-06-15T22:03:00.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'build ok' }] } },
    );
    const scan = scanTranscript(content);
    assert.strictEqual(scan.lastMessageRole, 'assistant', 'tool_result feedback is not a human turn');
    assert.strictEqual(scan.lastMessageText, 'please run the build', 'snippet stays on the last genuine prose');
  });

  it('advances the role to user on a genuine human turn after a tool_result loop', () => {
    // A real human prose turn following the tool loop DOES make the human the
    // last speaker awaiting a reply.
    const content = jsonl(
      { type: 'assistant', timestamp: '2026-06-15T22:02:00.000Z', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
      { type: 'user', timestamp: '2026-06-15T22:03:00.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } },
      userLine('now do the next thing'),
    );
    const scan = scanTranscript(content);
    assert.strictEqual(scan.lastMessageRole, 'user');
    assert.strictEqual(scan.lastMessageText, 'now do the next thing');
  });

  it('counts a tool_result user line in messageCount even though it is not a genuine turn', () => {
    // messageCount is the count of user/assistant lines (spec), so a tool_result
    // feedback line still counts; only the role/snippet treat it as non-genuine.
    const content = jsonl(
      userLine('go'),
      { type: 'user', timestamp: '2026-06-15T22:03:00.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'r' }] } },
    );
    assert.strictEqual(scanTranscript(content).messageCount, 2);
  });

  it('truncates a long last-message snippet', () => {
    const long = 'word '.repeat(100);
    const content = jsonl(userLine(long));
    const scan = scanTranscript(content);
    assert.ok(scan.lastMessageText !== null);
    assert.ok((scan.lastMessageText as string).length <= 200);
    assert.ok((scan.lastMessageText as string).endsWith('...'));
  });

  it('defaults to null/null when no message turn is present', () => {
    const scan = scanTranscript(jsonl({ type: 'ai-title', aiTitle: 'Z' }));
    assert.strictEqual(scan.lastMessageText, null);
    assert.strictEqual(scan.lastMessageRole, null);
  });
});

describe('jsonlReader tier-A: token totals', () => {
  it('sums the four trusted usage fields across assistant lines, ignoring extras', () => {
    const content = jsonl(
      userLine('q'),
      assistantLine({
        message: {
          content: 'r1',
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 20,
            server_tool_use: { web_search_requests: 3 },
            service_tier: 'standard',
          },
        },
      }),
      assistantLine({
        message: {
          content: 'r2',
          usage: { input_tokens: 50, output_tokens: 8, cache_read_input_tokens: 80 },
        },
      }),
    );
    const scan = scanTranscript(content);
    assert.deepStrictEqual(scan.tokenTotals, {
      input: 150,
      output: 18,
      cacheCreation: 5,
      cacheRead: 100,
    });
  });

  it('tolerates a missing, non-object, or garbage usage block (contributes 0)', () => {
    const content = jsonl(
      assistantLine({ message: { content: 'no usage' } }),
      assistantLine({ message: { content: 'bad usage', usage: 'not-an-object' } }),
      assistantLine({
        message: {
          content: 'partial garbage',
          usage: { input_tokens: 'NaN', output_tokens: null, cache_read_input_tokens: 7 },
        },
      }),
    );
    const scan = scanTranscript(content);
    assert.deepStrictEqual(scan.tokenTotals, { input: 0, output: 0, cacheCreation: 0, cacheRead: 7 });
  });

  it('counts a multi-line turn ONCE: dedupes the repeated usage by message.id', () => {
    // Real transcripts emit one logical assistant turn as several JSONL lines
    // sharing one message.id, each repeating the IDENTICAL usage block. The sum
    // must count that turn once, not once per line.
    const turnUsage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 200,
    };
    const content = jsonl(
      userLine('q'),
      assistantLine({ message: { id: 'msg_A', content: 'thinking', usage: turnUsage } }),
      assistantLine({ message: { id: 'msg_A', content: 'text', usage: turnUsage } }),
      assistantLine({ message: { id: 'msg_A', content: 'tool', usage: turnUsage } }),
      assistantLine({
        message: {
          id: 'msg_B',
          content: 'second turn',
          usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 9 },
        },
      }),
    );
    const scan = scanTranscript(content);
    assert.deepStrictEqual(scan.tokenTotals, {
      input: 105,
      output: 57,
      cacheCreation: 10,
      cacheRead: 209,
    });
  });

  it('still sums every line when no message.id is present (cannot dedupe)', () => {
    // Without a message.id the lines cannot be deduped, so they are all counted;
    // this preserves the prior behavior for id-less data.
    const content = jsonl(
      assistantLine({ message: { content: 'r1', usage: { output_tokens: 4 } } }),
      assistantLine({ message: { content: 'r2', usage: { output_tokens: 6 } } }),
    );
    assert.strictEqual(scanTranscript(content).tokenTotals.output, 10);
  });

  it('does not absorb usage off a user line', () => {
    const content = jsonl(
      userLine('q', { message: { content: 'q', usage: { input_tokens: 999 } } }),
      assistantLine({ message: { content: 'r' } }),
    );
    assert.deepStrictEqual(scanTranscript(content).tokenTotals, {
      input: 0,
      output: 0,
      cacheCreation: 0,
      cacheRead: 0,
    });
  });

  it('defaults all totals to 0 when nothing carried usage', () => {
    assert.deepStrictEqual(scanTranscript(jsonl(userLine('hi'))).tokenTotals, {
      input: 0,
      output: 0,
      cacheCreation: 0,
      cacheRead: 0,
    });
  });
});

describe('jsonlReader tier-A: filesTouched', () => {
  it('collects distinct file_path from Read/Edit/Write tool_use blocks, deduped in first-seen order', () => {
    const content = jsonl(
      userLine('q'),
      {
        type: 'assistant',
        timestamp: '2026-06-15T22:02:00.000Z',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } },
            { type: 'tool_use', name: 'Edit', input: { file_path: 'b.ts' } },
            { type: 'text', text: 'working' },
            { type: 'tool_use', name: 'Write', input: { file_path: 'a.ts' } },
          ],
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-06-15T22:03:00.000Z',
        message: {
          content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'c.ts' } }],
        },
      },
    );
    assert.deepStrictEqual(scanTranscript(content).filesTouched, ['a.ts', 'b.ts', 'c.ts']);
  });

  it('ignores tool_use blocks without a string file_path', () => {
    const content = jsonl({
      type: 'assistant',
      timestamp: '2026-06-15T22:02:00.000Z',
      message: {
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_use', name: 'Read', input: { file_path: 123 } },
          { type: 'tool_use', name: 'Read', input: {} },
          { type: 'tool_use', name: 'Edit', input: { file_path: 'real.ts' } },
        ],
      },
    });
    assert.deepStrictEqual(scanTranscript(content).filesTouched, ['real.ts']);
  });

  it('caps the distinct files-touched set', () => {
    const blocks: unknown[] = [];
    for (let i = 0; i < 200; i++) {
      blocks.push({ type: 'tool_use', name: 'Read', input: { file_path: 'f' + i + '.ts' } });
    }
    const content = jsonl({
      type: 'assistant',
      timestamp: '2026-06-15T22:02:00.000Z',
      message: { content: blocks },
    });
    const scan = scanTranscript(content);
    assert.ok(scan.filesTouched.length <= 64, 'files-touched capture is capped');
    assert.strictEqual(scan.filesTouched[0], 'f0.ts', 'the leading run is retained');
  });

  it('defaults to [] when no tool_use carried a file_path', () => {
    assert.deepStrictEqual(scanTranscript(jsonl(userLine('hi'))).filesTouched, []);
  });
});

describe('jsonlReader tier-A: models', () => {
  it('collects distinct message.model values in first-seen order', () => {
    const content = jsonl(
      assistantLine({ message: { content: 'r1', model: 'claude-opus-4-8' } }),
      assistantLine({ message: { content: 'r2', model: 'claude-opus-4-8' } }),
      assistantLine({ message: { content: 'r3', model: 'claude-sonnet-4-5' } }),
    );
    assert.deepStrictEqual(scanTranscript(content).models, ['claude-opus-4-8', 'claude-sonnet-4-5']);
  });

  it('defaults to [] when no model was present', () => {
    assert.deepStrictEqual(scanTranscript(jsonl(userLine('hi'))).models, []);
  });
});

describe('jsonlReader tier-A: malformed-line tolerance and all-absent defaults', () => {
  it('skips malformed lines and still absorbs tier-A from the valid ones', () => {
    const content = [
      'not json',
      '{ truncated',
      JSON.stringify(assistantLine({ message: { content: 'survives', model: 'claude-opus-4-8', usage: { output_tokens: 4 } } })),
      '}{',
    ].join('\n');
    const scan = scanTranscript(content);
    assert.strictEqual(scan.messageCount, 1);
    assert.strictEqual(scan.lastMessageText, 'survives');
    assert.strictEqual(scan.lastMessageRole, 'assistant');
    assert.deepStrictEqual(scan.models, ['claude-opus-4-8']);
    assert.strictEqual(scan.tokenTotals.output, 4);
  });

  it('yields full all-absent defaults for a transcript with no message lines', () => {
    const scan = scanTranscript(jsonl({ type: 'queue-operation', op: 'x' }, { type: 'hook_success', hook: 'h' }));
    assert.strictEqual(scan.messageCount, 0);
    assert.strictEqual(scan.lastMessageText, null);
    assert.strictEqual(scan.lastMessageRole, null);
    assert.deepStrictEqual(scan.tokenTotals, { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });
    assert.deepStrictEqual(scan.filesTouched, []);
    assert.deepStrictEqual(scan.models, []);
  });

  it('leaves the existing title/timestamp/signal behavior intact (additive contract)', () => {
    const content = jsonl(
      { type: 'custom-title', customTitle: 'Kept' },
      userLine('first user text'),
      assistantLine({ message: { content: 'r', model: 'm', usage: { input_tokens: 1 } } }),
    );
    const scan = scanTranscript(content);
    assert.strictEqual(scan.customTitle, 'Kept');
    assert.strictEqual(scan.firstUserText, 'first user text');
    assert.strictEqual(scan.timestamp, Date.parse('2026-06-15T22:01:00.000Z'));
  });
});
