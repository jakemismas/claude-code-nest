import * as assert from 'assert';
import { NEST_CHAT_MIME } from '../../dnd/dropReducer';
import {
  FOLDERS_RESERVED_MIME,
  RECOGNIZED_PAYLOAD_MIMES,
  TAGS_RESERVED_MIME,
  parseChatIds,
  pickPayload,
} from '../../dnd/dropPayload';

// Headless unit tests for the PURE drop-payload helpers the controller leans on
// before it reaches the reducer. dropPayload imports no vscode types (the
// controller hands it plain unknowns pulled off the real DataTransfer), so this
// test never transitively requires vscode (ARCHITECTURE.md unit-gate rule). It
// covers the parseChatIds tolerance contract (a missing / non-string / malformed
// / non-array value, non-string element filtering) and the pickPayload
// cross-view carrier selection that makes a Folders->Tags drag work, which the
// reducer never sees.

describe('parseChatIds tolerance', () => {
  it('parses the JSON id array handleDrag serializes', () => {
    assert.deepStrictEqual(parseChatIds(JSON.stringify(['c1', 'c2'])), ['c1', 'c2']);
  });

  it('returns [] for a missing value (undefined)', () => {
    assert.deepStrictEqual(parseChatIds(undefined), []);
  });

  it('returns [] for a null value', () => {
    assert.deepStrictEqual(parseChatIds(null), []);
  });

  it('returns [] for malformed JSON', () => {
    assert.deepStrictEqual(parseChatIds('{not json'), []);
  });

  it('returns [] when the JSON parses to a non-array (object)', () => {
    assert.deepStrictEqual(parseChatIds(JSON.stringify({ c1: true })), []);
  });

  it('returns [] when the JSON parses to a non-array (number)', () => {
    assert.deepStrictEqual(parseChatIds('42'), []);
  });

  it('filters non-string elements out of the array (a foreign payload shape)', () => {
    assert.deepStrictEqual(parseChatIds(JSON.stringify(['c1', 7, null, 'c2', {}])), [
      'c1',
      'c2',
    ]);
  });

  it('coerces a non-string raw value through String() before parsing (and tolerates the result)', () => {
    // A foreign DataTransferItem.value that is not our JSON string must not throw;
    // String(42) -> '42' -> a number, which is a non-array, hence [].
    assert.deepStrictEqual(parseChatIds(42), []);
  });

  it('an empty serialized array round-trips to []', () => {
    assert.deepStrictEqual(parseChatIds(JSON.stringify([])), []);
  });
});

describe('pickPayload recognized-MIME selection', () => {
  function found(entries: [string, unknown][]): Map<string, unknown> {
    return new Map(entries);
  }

  it('returns undefined when no recognized MIME is present (an unrecognized source)', () => {
    const picked = pickPayload(found([['application/vnd.code.tree.someOtherTree', '["c1"]']]));
    assert.strictEqual(picked, undefined);
  });

  it('returns undefined for an empty DataTransfer', () => {
    assert.strictEqual(pickPayload(found([])), undefined);
  });

  it('treats a recognized MIME mapped to undefined as absent', () => {
    // The host can offer a drop slot for a MIME without a populated item.
    const picked = pickPayload(found([[NEST_CHAT_MIME, undefined]]));
    assert.strictEqual(picked, undefined);
  });

  it('finds the within-view payload under the shared chat MIME', () => {
    const picked = pickPayload(found([[NEST_CHAT_MIME, '["c1","c2"]']]));
    assert.deepStrictEqual(picked, { mime: NEST_CHAT_MIME, raw: '["c1","c2"]' });
  });

  it('finds a CROSS-view payload under the Folders reserved MIME (a Folders->Tags drag)', () => {
    // On a cross-tree drop the host strips the shared chat MIME and carries only
    // the SOURCE tree reserved MIME; pickPayload must still recover the payload.
    const picked = pickPayload(found([[FOLDERS_RESERVED_MIME, '["c1"]']]));
    assert.deepStrictEqual(picked, { mime: FOLDERS_RESERVED_MIME, raw: '["c1"]' });
  });

  it('finds a CROSS-view payload under the Tags reserved MIME (a Tags->Folders drag)', () => {
    const picked = pickPayload(found([[TAGS_RESERVED_MIME, '["c1"]']]));
    assert.deepStrictEqual(picked, { mime: TAGS_RESERVED_MIME, raw: '["c1"]' });
  });

  it('prefers the shared chat MIME over a reserved carrier when both are present (within-view drop)', () => {
    // handleDrag sets both; a within-view drop preserves both, so the shared chat
    // MIME (first in priority order) wins.
    const picked = pickPayload(
      found([
        [FOLDERS_RESERVED_MIME, '["reserved"]'],
        [NEST_CHAT_MIME, '["chat"]'],
      ]),
    );
    assert.deepStrictEqual(picked, { mime: NEST_CHAT_MIME, raw: '["chat"]' });
  });
});

describe('dropPayload reserved-MIME literals match the tree-id contract', () => {
  it('derives application/vnd.code.tree.<viewidlowercase> for each view', () => {
    // VSCode derives the reserved MIME from the view id lowercased. Assert the
    // literals match so a future view-id rename cannot silently break cross-view
    // drops; the deferred electron test cross-checks these against package.json.
    assert.strictEqual(FOLDERS_RESERVED_MIME, 'application/vnd.code.tree.claudenest.folders');
    assert.strictEqual(TAGS_RESERVED_MIME, 'application/vnd.code.tree.claudenest.tags');
  });

  it('recognizes the shared chat MIME plus BOTH reserved MIMEs as payload carriers', () => {
    assert.deepStrictEqual(
      [...RECOGNIZED_PAYLOAD_MIMES],
      [NEST_CHAT_MIME, FOLDERS_RESERVED_MIME, TAGS_RESERVED_MIME],
    );
  });
});
