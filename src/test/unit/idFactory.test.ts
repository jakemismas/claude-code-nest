import * as assert from 'assert';
import {
  RESERVED_SEPARATORS,
  RESERVED_SENTINELS,
  assertMintableId,
  assertSeparatorFree,
  isMintableId,
  isSeparatorFree,
  mintFolderId,
} from '../../model/idFactory';

// Pure-logic unit tests for the id factory. No vscode import, no filesystem.
// ARCHITECTURE.md: folder/tag/chat ids must be free of ':' '#' '>' and the rule
// must be enforced in the id factory; the accepted patch adds that '__unfiled__'
// (and '__untagged__') are excluded from the mintable space.

describe('idFactory separator discipline', () => {
  it('treats all three reserved separators as reserved', () => {
    assert.deepStrictEqual([...RESERVED_SEPARATORS], [':', '#', '>']);
  });

  it('isSeparatorFree rejects each separator and accepts a clean value', () => {
    assert.strictEqual(isSeparatorFree('a:b'), false);
    assert.strictEqual(isSeparatorFree('a#b'), false);
    assert.strictEqual(isSeparatorFree('a>b'), false);
    assert.strictEqual(isSeparatorFree('a-b-c'), true);
    assert.strictEqual(isSeparatorFree('123e4567-e89b-12d3-a456-426614174000'), true);
  });

  it('assertSeparatorFree throws on a reserved separator and is silent otherwise', () => {
    assert.throws(() => assertSeparatorFree('x#y', 'folder id'), /reserved composite-id/);
    assert.doesNotThrow(() => assertSeparatorFree('clean-id', 'folder id'));
  });
});

describe('idFactory mintable space', () => {
  it('excludes the synthetic sentinels from the mintable space', () => {
    assert.strictEqual(isMintableId('__unfiled__'), false);
    assert.strictEqual(isMintableId('__untagged__'), false);
    assert.ok(RESERVED_SENTINELS.has('__unfiled__'));
    assert.ok(RESERVED_SENTINELS.has('__untagged__'));
  });

  it('assertMintableId rejects a sentinel and a separator-bearing id, accepts a clean id', () => {
    assert.throws(() => assertMintableId('__unfiled__', 'folder id'), /reserved synthetic sentinel/);
    assert.throws(() => assertMintableId('a:b', 'folder id'), /reserved composite-id/);
    assert.doesNotThrow(() => assertMintableId('a-clean-folder-id', 'folder id'));
  });

  it('rejects the empty string as non-mintable', () => {
    assert.strictEqual(isMintableId(''), false);
  });
});

describe('idFactory mintFolderId', () => {
  it('never mints an id containing a reserved separator or a sentinel, across many generations', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const id = mintFolderId();
      assert.ok(isMintableId(id), `minted id is not mintable: ${id}`);
      assert.strictEqual(isSeparatorFree(id), true, `minted id has a separator: ${id}`);
      assert.strictEqual(RESERVED_SENTINELS.has(id), false, `minted a sentinel: ${id}`);
      seen.add(id);
    }
    // The generator should be effectively collision-free over this sample.
    assert.ok(seen.size > 4990, `unexpected collisions: only ${seen.size} unique of 5000`);
  });
});
