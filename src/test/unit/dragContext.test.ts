import * as assert from 'assert';
import {
  clearDrag,
  peekDrag,
  stashDrag,
  takeDrag,
} from '../../dnd/dragContext';

// Headless unit tests for the in-process cross-view drag stash. dragContext is
// vscode-free (the cross-view payload carrier the DataTransfer cannot deliver
// across controllers), so this test never transitively requires vscode
// (ARCHITECTURE.md unit-gate rule). It covers the one-shot take contract that
// keeps a stale stash from leaking into a later unrelated drop, the
// overwrite-on-new-drag behavior, and the defensive copy.

describe('dragContext cross-view stash', () => {
  beforeEach(() => clearDrag());

  it('stashes chat ids and takes them back once', () => {
    stashDrag(['c1', 'c2']);
    const taken = takeDrag();
    assert.deepStrictEqual(taken?.chatIds, ['c1', 'c2']);
  });

  it('take is ONE-SHOT: a second take returns undefined (no leak into a later drop)', () => {
    stashDrag(['c1']);
    assert.deepStrictEqual(takeDrag()?.chatIds, ['c1']);
    assert.strictEqual(
      takeDrag(),
      undefined,
      'the stash must be cleared on take so a within-view drop cannot leak it cross-view',
    );
  });

  it('a new drag overwrites the previous stash (one live drag at a time)', () => {
    stashDrag(['old']);
    stashDrag(['new1', 'new2']);
    assert.deepStrictEqual(takeDrag()?.chatIds, ['new1', 'new2']);
  });

  it('an empty stash overwrites a prior one (a no-chat drag clears the carrier)', () => {
    stashDrag(['c1']);
    stashDrag([]);
    const taken = takeDrag();
    assert.deepStrictEqual(taken?.chatIds, []);
  });

  it('clearDrag empties the stash', () => {
    stashDrag(['c1']);
    clearDrag();
    assert.strictEqual(takeDrag(), undefined);
  });

  it('the token is monotonic across stashes (identifies the current drag)', () => {
    const t1 = stashDrag(['a']);
    const t2 = stashDrag(['b']);
    assert.ok(t2 > t1, 'each stash gets a fresh, larger token');
  });

  it('stash takes a defensive copy: mutating the source array does not change the stash', () => {
    const source = ['c1'];
    stashDrag(source);
    source.push('c2');
    assert.deepStrictEqual(peekDrag()?.chatIds, ['c1'], 'stash is insulated from later mutation');
  });
});
