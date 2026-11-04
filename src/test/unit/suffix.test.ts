import * as assert from 'assert';
import { SUFFIX_MAX_LEN, chatSuffix, removeTicket } from '../../fleet/suffix';

describe('chatSuffix', () => {
  it('removes the ticket id and keeps the rest', () => {
    assert.strictEqual(chatSuffix('TKT-12 round 2', 'TKT-12', '', ''), 'round 2');
  });
  it('removes the ticket id case-insensitively', () => {
    assert.strictEqual(chatSuffix('tkt-12 data check', 'TKT-12', '', ''), 'data check');
  });
  it('removes the title words as whole words', () => {
    assert.strictEqual(chatSuffix('TKT-12 Import data check', 'TKT-12', 'Import', ''), 'data check');
    assert.strictEqual(chatSuffix('TKT-12 important check', 'TKT-12', 'Import', ''), 'important check');
  });
  it('removes the agent word', () => {
    assert.strictEqual(chatSuffix('TKT-12 build round 2', 'TKT-12', '', 'build'), 'round 2');
  });
  it('returns an empty string when nothing is left', () => {
    assert.strictEqual(chatSuffix('TKT-12 build', 'TKT-12', '', 'build'), '');
    assert.strictEqual(chatSuffix('', 'TKT-12', '', ''), '');
  });
  it('truncates to 24 characters', () => {
    const out = chatSuffix('TKT-12 aaaaaaaaaa bbbbbbbbbb cccccccccc dddd', 'TKT-12', '', '');
    assert.ok(out.length <= SUFFIX_MAX_LEN, out);
    assert.strictEqual(out, 'aaaaaaaaaa bbbbbbbbbb cc');
  });
  it('trims separators left behind by a removal', () => {
    assert.strictEqual(chatSuffix('TKT-12: build - round 2', 'TKT-12', '', 'build'), 'round 2');
  });
  it('treats ticket text with pattern characters literally', () => {
    assert.strictEqual(removeTicket('A.B+1 note', 'A.B+1'), 'note');
    assert.strictEqual(removeTicket('AxB+1 note', 'A.B+1'), 'AxB+1 note');
  });
});

describe('removeTicket boundaries', () => {
  it('does not strip a ticket id inside a longer id', () => {
    assert.strictEqual(removeTicket('ABC-12 fix login', 'ABC-1'), 'ABC-12 fix login');
  });
  it('strips the whole-id match only', () => {
    assert.strictEqual(removeTicket('ABC-1 and ABC-12 fix', 'ABC-1'), 'and ABC-12 fix');
  });
});
