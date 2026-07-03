import * as assert from 'assert';
import {
  CollapseFolderNode,
  deepestOpenLevelToCollapse,
  foldOneLevel,
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
    // Everything is already collapsed to its shallowest level: root is collapsed and
    // its descendants are hidden. No candidate remains, so the terminal click asks
    // the webview to clear its collapsed set (expand all).
    const folders = [
      node({ id: 'root', depth: 0, hasChildFolder: true, collapsed: true }),
      node({ id: 'mid', depth: 1, hasChildFolder: true, hasCollapsedAncestor: true }),
    ];
    assert.deepStrictEqual(foldOneLevel(folders, true), { action: 'expandAll' });
  });

  it('re-expands all when the tree is only leaf folders with nothing to collapse', () => {
    // Two leaf roots: no nesting to fold, but real folders exist, so the button's
    // terminal behavior is expand-all (a harmless clear when the set is already empty
    // in the webview, which the webview guards on set size).
    const folders = [
      node({ id: 'a', depth: 0, hasChildFolder: false }),
      node({ id: 'b', depth: 0, hasChildFolder: false }),
    ];
    assert.deepStrictEqual(foldOneLevel(folders, true), { action: 'expandAll' });
  });

  it('drives the full fold-up-then-expand-all cycle for a root -> child tree', () => {
    // Model the webview loop over a two-tier tree root(0,parent) -> child(1,parent)
    // -> grandchild(2). Each fold click mutates the collapsed / hasCollapsedAncestor
    // projection the way the webview's Set would, then re-asks foldOneLevel.
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

    // Click 1: deepest visible open parent is child(1) -> collapse it.
    let r = foldOneLevel(project(), true);
    assert.deepStrictEqual(r, { action: 'collapse', ids: ['child'] });
    apply(r);

    // Click 2: child is collapsed (grand now hidden), deepest visible open parent is
    // root(0) -> collapse it.
    r = foldOneLevel(project(), true);
    assert.deepStrictEqual(r, { action: 'collapse', ids: ['root'] });
    apply(r);

    // Click 3: everything is folded to the shallowest tier; nothing collapsible ->
    // re-expand all.
    r = foldOneLevel(project(), true);
    assert.deepStrictEqual(r, { action: 'expandAll' });
    apply(r);

    // After expand-all the tree is fully open again, and the next click restarts the
    // cycle by collapsing the deepest tier.
    assert.strictEqual(state.root.collapsed, false);
    assert.strictEqual(state.child.collapsed, false);
    r = foldOneLevel(project(), true);
    assert.deepStrictEqual(r, { action: 'collapse', ids: ['child'] }, 'cycle restarts');
  });
});
