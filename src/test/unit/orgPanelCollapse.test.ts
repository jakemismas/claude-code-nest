import * as assert from 'assert';
import {
  CollapseFolderNode,
  deepestOpenLevelToCollapse,
  foldOneLevel,
} from '../../views/orgPanelCollapse';

// Unit tests for the pure collapse-one-level logic: deepest open folder selection,
// ties at the same depth, and the no-op cases.

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
    // Leaf folders have no nesting to collapse.
    const folders = [
      node({ id: 'a', depth: 0, hasChildFolder: false }),
      node({ id: 'b', depth: 0, hasChildFolder: false }),
    ];
    assert.deepStrictEqual(deepestOpenLevelToCollapse(folders), []);
  });

  it('collapses the deepest open parent level, not the leaves', () => {
    // The deepest open folder that has a child is mid, not the childless leaf.
    const folders = [
      node({ id: 'root', depth: 0, hasChildFolder: true }),
      node({ id: 'mid', depth: 1, hasChildFolder: true }),
      node({ id: 'leaf', depth: 2, hasChildFolder: false }),
    ];
    assert.deepStrictEqual(deepestOpenLevelToCollapse(folders), ['mid']);
  });

  it('collapses every qualifying folder at the deepest open level together', () => {
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
    // A hidden open folder is not on screen, so it is not a candidate.
    const folders = [
      node({ id: 'root', depth: 0, hasChildFolder: true, collapsed: true }),
      node({ id: 'mid', depth: 1, hasChildFolder: true, hasCollapsedAncestor: true }),
      node({ id: 'leaf', depth: 2, hasChildFolder: false, hasCollapsedAncestor: true }),
    ];
    assert.deepStrictEqual(deepestOpenLevelToCollapse(folders), []);
  });

  it('collapses the deepest VISIBLE open tier, not a deeper folder hidden under a collapsed ancestor', () => {
    // The deepest open folder by raw depth is hidden under a collapsed ancestor, so only the visible one collapses.
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
    const folders = [
      node({ id: 'root', depth: 0, hasChildFolder: true }),
      node({ id: 'mid', depth: 1, hasChildFolder: true }),
      node({ id: 'inner', depth: 2, hasChildFolder: true }),
      node({ id: 'leaf', depth: 3, hasChildFolder: false }),
    ];
    assert.deepStrictEqual(deepestOpenLevelToCollapse(folders), ['inner']);
  });
});

describe('foldOneLevel (collapse-one-level with the terminal re-expand-all branch)', () => {
  it('reports none when there are no real folders', () => {
    assert.deepStrictEqual(foldOneLevel([], false), { action: 'none' });
  });

  it('collapses the deepest visible open tier while one exists', () => {
    const folders = [
      node({ id: 'root', depth: 0, hasChildFolder: true }),
      node({ id: 'mid', depth: 1, hasChildFolder: true }),
      node({ id: 'leaf', depth: 2, hasChildFolder: false }),
    ];
    assert.deepStrictEqual(foldOneLevel(folders, true), { action: 'collapse', ids: ['mid'] });
  });

  it('re-expands all when nothing is collapsible but real folders exist', () => {
    // With nothing left to collapse, the click asks the webview to expand all.
    const folders = [
      node({ id: 'root', depth: 0, hasChildFolder: true, collapsed: true }),
      node({ id: 'mid', depth: 1, hasChildFolder: true, hasCollapsedAncestor: true }),
    ];
    assert.deepStrictEqual(foldOneLevel(folders, true), { action: 'expandAll' });
  });

  it('re-expands all when the tree is only leaf folders with nothing to collapse', () => {
    // With only leaf roots the terminal behavior is still expand-all; the webview guards on set size.
    const folders = [
      node({ id: 'a', depth: 0, hasChildFolder: false }),
      node({ id: 'b', depth: 0, hasChildFolder: false }),
    ];
    assert.deepStrictEqual(foldOneLevel(folders, true), { action: 'expandAll' });
  });

  it('drives the full fold-up-then-expand-all cycle for a root -> child tree', () => {
    // Models the webview loop: each fold mutates the collapsed projection, then re-asks foldOneLevel.
    const ids = ['root', 'child', 'grand'];
    const state: Record<string, { collapsed: boolean }> = {
      root: { collapsed: false },
      child: { collapsed: false },
      grand: { collapsed: false },
    };
    const depthOf: Record<string, number> = { root: 0, child: 1, grand: 2 };
    const parentOf: Record<string, string | null> = { root: null, child: 'root', grand: 'child' };
    const hasChild: Record<string, boolean> = { root: true, child: true, grand: false };

    const project = (): CollapseFolderNode[] =>
      ids.map((id) => {
        // hasCollapsedAncestor: any ancestor is collapsed.
        let p = parentOf[id];
        let hiddenAncestor = false;
        while (p !== null) {
          if (state[p].collapsed) {
            hiddenAncestor = true;
            break;
          }
          p = parentOf[p];
        }
        return node({
          id,
          depth: depthOf[id],
          hasChildFolder: hasChild[id],
          collapsed: state[id].collapsed,
          hasCollapsedAncestor: hiddenAncestor,
        });
      });

    const apply = (result: ReturnType<typeof foldOneLevel>): void => {
      if (result.action === 'collapse') {
        for (const id of result.ids) {
          state[id].collapsed = true;
        }
      } else if (result.action === 'expandAll') {
        for (const id of ids) {
          state[id].collapsed = false;
        }
      }
    };

    let r = foldOneLevel(project(), true);
    assert.deepStrictEqual(r, { action: 'collapse', ids: ['child'] });
    apply(r);

    r = foldOneLevel(project(), true);
    assert.deepStrictEqual(r, { action: 'collapse', ids: ['root'] });
    apply(r);

    r = foldOneLevel(project(), true);
    assert.deepStrictEqual(r, { action: 'expandAll' });
    apply(r);

    // After expand-all the next click restarts the cycle at the deepest tier.
    assert.strictEqual(state.root.collapsed, false);
    assert.strictEqual(state.child.collapsed, false);
    r = foldOneLevel(project(), true);
    assert.deepStrictEqual(r, { action: 'collapse', ids: ['child'] }, 'cycle restarts');
  });
});
