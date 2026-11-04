import * as assert from 'assert';
import { MAX_QUEUE_CELL, MAX_QUEUE_ROWS, parseQueueTable } from '../../fleet/queueTable';

const cols = { keyColumn: 'Ticket', stageColumn: 'Stage', titleColumn: 'Title' };

describe('parseQueueTable', () => {
  it('reads rows in file order', () => {
    const text = ['# Queue', '', '| Ticket | Title | Stage |', '| --- | :---: | ---: |', '| T-102 | Second | Review |', '| T-101 | First | Build |'].join('\n');
    assert.deepStrictEqual(parseQueueTable(text, cols), [
      { key: 'T-102', stage: 'Review', title: 'Second' },
      { key: 'T-101', stage: 'Build', title: 'First' },
    ]);
  });

  it('skips a table that lacks the key or stage column and uses the next one', () => {
    const text = ['| Name | Note |', '| - | - |', '| a | b |', '', '| ticket | stage |', '|---|---|', '| T-1 | Plan |'].join('\n');
    assert.deepStrictEqual(parseQueueTable(text, { keyColumn: 'Ticket', stageColumn: 'Stage' }), [
      { key: 'T-1', stage: 'Plan', title: null },
    ]);
  });

  it('returns an empty list when columns or tables are missing', () => {
    assert.deepStrictEqual(parseQueueTable('', cols), []);
    assert.deepStrictEqual(parseQueueTable('no table here', cols), []);
    assert.deepStrictEqual(parseQueueTable('| A | B |\n|---|---|\n| 1 | 2 |', cols), []);
  });

  it('handles tables with no outer pipes and escaped pipes', () => {
    const text = 'Ticket | Stage\n--- | ---\nT-1 | a \\| b';
    assert.deepStrictEqual(parseQueueTable(text, { keyColumn: 'Ticket', stageColumn: 'Stage' }), [
      { key: 'T-1', stage: 'a | b', title: null },
    ]);
  });

  it('stops at the end of the table and skips rows with no key', () => {
    const text = ['| Ticket | Stage |', '|---|---|', '|  | x |', '| T-1 | y |', '', '| T-2 | z |'].join('\n');
    assert.deepStrictEqual(parseQueueTable(text, { keyColumn: 'Ticket', stageColumn: 'Stage' }).map((r) => r.key), ['T-1']);
  });

  it('caps rows at 500 and cells at 200 characters, stripping control characters', () => {
    const rows = Array.from({ length: 600 }, (_, i) => `| T-${i} | ${i === 0 ? 'a\u0007' + 'x'.repeat(400) : 's'} |`);
    const out = parseQueueTable(['| Ticket | Stage |', '|---|---|', ...rows].join('\n'), { keyColumn: 'Ticket', stageColumn: 'Stage' });
    assert.strictEqual(out.length, MAX_QUEUE_ROWS);
    assert.strictEqual(out[0].stage.length, MAX_QUEUE_CELL);
    assert.ok(![...(out[0].stage)].some((ch) => ch.charCodeAt(0) < 32));
  });
});
