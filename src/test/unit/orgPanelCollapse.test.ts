import * as assert from 'assert';
import {
  CollapseFolderNode,
  deepestOpenLevelToCollapse,
} from '../../views/orgPanelCollapse';

// Headless unit tests for the PURE "collapse one level" logic (issue #64). It
// imports no vscode types, so this test never transitively requires the vscode
// module (ARCHITECTURE.md unit-gate rule). It covers the deepest-open-level
// selection: only expanded folders that have a descendant folder qualify, the
// max-depth tier is chosen, all candidates at that tier collapse together, and the
// no-op cases.

function node(over: Partial<CollapseFolderNode> & { id: string }): CollapseFolderNode {
  return {
    id: over.id,
    depth: over.depth ?? 0,
    hasChildFolder: over.hasChildFolder ?? false,
    collapsed: over.collapsed ?? false,
    hasCollapsedAncestor: over.hasCollapsedAncestor ?? false,
  };
}

describe('deepestOpenLevelToCollapse', () => {
  it('returns an empty list when there are no folders', () => {
    assert.deepStrictEqual(deepestOpenLevelToCollapse([]), []);
  });

  it('returns an empty list when no expanded folder has a child folder', () => {
    // Two leaf root folders: each is expanded but has no nesting to collapse.
    const folders = [
      node({ id: 'a', depth: 0, hasChildFolder: false }),
      node({ id: 'b', depth: 0, hasChildFolder: false }),
    ];
    assert.deepStrictEqual(deepestOpenLevelToCollapse(folders), []);
  });

  it('collapses the deepest open parent level, not the leaves', () => {
    // root(0,parent) -> mid(1,parent) -> leaf(2). The deepest OPEN folder that has
    // a child is mid at depth 1, so collapse it (not the depth-2 leaf, which has no
    // child to fold).
    const folders = [
      node({ id: 'root', depth: 0, hasChildFolder: true }),
      node({ id: 'mid', depth: 1, hasChildFolder: true }),
      node({ id: 'leaf', depth: 2, hasChildFolder: false }),
    ];
    assert.deepStrictEqual(deepestOpenLevelToCollapse(folders), ['mid']);
  });

  it('collapses every qualifying folder at the deepest open level together', () => {
    // Two sibling depth-1 parents, each with a child; both collapse in one action.
    const folders = [
      node({ id: 'root', depth: 0, hasChildFolder: true }),
      node({ id: 'mid1', depth: 1, hasChildFolder: true }),
      node({ id: 'leaf1', depth: 2, hasChildFolder: false }),
      node({ id: 'mid2', depth: 1, hasChildFolder: true }),
      node({ id: 'leaf2', depth: 2, hasChildFolder: false }),
    ];
    assert.deepStrictEqual(deepestOpenLevelToCollapse(folders), ['mid1', 'mid2']);
  });

  it('skips an already-collapsed folder and falls to the next-deepest open tier', () => {
    // mid is already collapsed, so the deepest OPEN parent is root at depth 0.
    const folders = [
      node({ id: 'root', depth: 0, hasChildFolder: true }),
      node({ id: 'mid', depth: 1, hasChildFolder: true, collapsed: true }),
    ];
    assert.deepStrictEqual(deepestOpenLevelToCollapse(folders), ['root']);
  });

  it('is a no-op when the only parent folder is already collapsed', () => {
    const folders = [
      node({ id: 'root', depth: 0, hasChildFolder: true, collapsed: true }),
      node({ id: 'child', depth: 1, hasChildFolder: false }),
    ];
    assert.deepStrictEqual(deepestOpenLevelToCollapse(folders), []);
  });

  it('ignores an open folder that is hidden inside a collapsed ancestor (no invisible collapse)', () => {
    // root(0) is collapsed, hiding mid(1, open, has child) and leaf(2). mid is open
    // but not on screen, so it must NOT be a candidate; nothing visible qualifies.
    const folders = [
      node({ id: 'root', depth: 0, hasChildFolder: true, collapsed: true }),
      node({ id: 'mid', depth: 1, hasChildFolder: true, hasCollapsedAncestor: true }),
      node({ id: 'leaf', depth: 2, hasChildFolder: false, hasCollapsedAncestor: true }),
    ];
    assert.deepStrictEqual(deepestOpenLevelToCollapse(folders), []);
  });

  it('collapses the deepest VISIBLE open tier, not a deeper folder hidden under a collapsed ancestor', () => {
    // Branch A: a0(0) collapsed hides a1(1, open, has child) and a2(2). Branch B:
    // b0(0, open, has child) is visible. The deepest open folder by raw depth is the
    // hidden a1, but only the visible b0 may collapse.
    const folders = [
      node({ id: 'a0', depth: 0, hasChildFolder: true, collapsed: true }),
      node({ id: 'a1', depth: 1, hasChildFolder: true, hasCollapsedAncestor: true }),
      node({ id: 'a2', depth: 2, hasChildFolder: false, hasCollapsedAncestor: true }),
      node({ id: 'b0', depth: 0, hasChildFolder: true }),
      node({ id: 'b1', depth: 1, hasChildFolder: false }),
    ];
    assert.deepStrictEqual(deepestOpenLevelToCollapse(folders), ['b0']);
  });

  it('collapses only the deepest tier when parents exist at multiple depths', () => {
    // root(0) and mid(1) are both open parents; deepest open parent is mid(1).
    const folders = [
      node({ id: 'root', depth: 0, hasChildFolder: true }),
      node({ id: 'mid', depth: 1, hasChildFolder: true }),
      node({ id: 'inner', depth: 2, hasChildFolder: true }),
      node({ id: 'leaf', depth: 3, hasChildFolder: false }),
    ];
    // inner at depth 2 is the deepest open parent.
    assert.deepStrictEqual(deepestOpenLevelToCollapse(folders), ['inner']);
  });
});
