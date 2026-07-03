// orgPanelCollapse: the PURE, vscode-free logic behind the org panel's "collapse
// one level" toolbar control (issue #64). Kept separate from the webview DOM so
// the deepest-open-level computation is covered by the headless unit gate, the
// same split that keeps orgPanelModel.ts and dropReducer.ts vscode-free.
//
// The webview owns the DOM and the collapsed Set; it projects the folder
// hierarchy to this plain shape, asks which ids the action should collapse, then
// mutates its own Set and re-renders. This module never touches the DOM.

// One folder node projected from the rendered hierarchy. depth is the nesting
// depth (0 for a root folder section). hasChildFolder is true when the folder has
// at least one descendant folder section (a leaf folder, even an expanded one,
// has no deeper level to collapse). collapsed reflects the live collapsed Set.
// hasCollapsedAncestor is true when some ancestor folder is collapsed, so this
// folder is not actually visible even though its own collapsed flag is false.
export interface CollapseFolderNode {
  id: string;
  depth: number;
  hasChildFolder: boolean;
  collapsed: boolean;
  hasCollapsedAncestor: boolean;
}

// Decide which folder ids the "collapse one level" action collapses: the deepest
// VISIBLE level that is still open. A folder is a candidate only when it is
// currently expanded, NOT hidden inside a collapsed ancestor, AND has at least one
// descendant folder. The ancestor check matters because a folder whose own flag is
// open but whose parent is collapsed is not on screen; counting it would let the
// action collapse an invisible folder and appear to do nothing while silently
// mutating state. Collapsing a folder with no child folder also removes no nesting
// level (its body is just chat rows). Among the candidates we take the maximum
// depth and collapse every candidate at that depth, so one click folds back the
// innermost visible open tier uniformly.
//
// Returns an empty array when nothing qualifies (the visible tree is already
// collapsed to a single level), which the caller treats as a no-op.
export function deepestOpenLevelToCollapse(folders: readonly CollapseFolderNode[]): string[] {
  const isCandidate = (f: CollapseFolderNode): boolean =>
    !f.collapsed && !f.hasCollapsedAncestor && f.hasChildFolder;
  let deepest = -1;
  for (const f of folders) {
    if (isCandidate(f) && f.depth > deepest) {
      deepest = f.depth;
    }
  }
  if (deepest < 0) {
    return [];
  }
  const ids: string[] = [];
  for (const f of folders) {
    if (isCandidate(f) && f.depth === deepest) {
      ids.push(f.id);
    }
  }
  return ids;
}

// The outcome of one "collapse one level" (^) click, so the webview knows whether
// to add ids to its collapsed Set, clear the Set entirely (re-expand all), or do
// nothing. This wraps deepestOpenLevelToCollapse to add the design's terminal
// branch (README line 72, prototype ChatSidebar.dc.html collapseLevel): repeated
// clicks fold the innermost visible open tier upward, and "once all folded, the
// next click re-expands all".
//   { action: 'collapse', ids } -> collapse the deepest visible open tier
//   { action: 'expandAll' }     -> nothing is collapsible but real folders exist,
//                                  so the whole tree is folded; clear the set
//   { action: 'none' }          -> there are no real folders at all (nothing to do)
export type FoldOneLevelResult =
  | { action: 'collapse'; ids: string[] }
  | { action: 'expandAll' }
  | { action: 'none' };

// Decide the next "collapse one level" action for the current visible hierarchy.
// hasRealFolders is whether the tree contains at least one non-synthetic folder
// section (the synthetic Unsorted bucket does not count); it distinguishes the
// terminal all-folded state (expand all) from a genuinely empty tree (no-op). This
// stays a PURE decision so the fold-up-then-expand-all cycle is covered by the
// headless unit gate; the webview owns the collapsed Set and the DOM.
export function foldOneLevel(
  folders: readonly CollapseFolderNode[],
  hasRealFolders: boolean,
): FoldOneLevelResult {
  const ids = deepestOpenLevelToCollapse(folders);
  if (ids.length > 0) {
    return { action: 'collapse', ids };
  }
  // Nothing is collapsible. If the tree has real folders, they are all already
  // folded to their shallowest level, so the terminal click re-expands them all.
  // With no real folders there is nothing to fold or expand.
  return hasRealFolders ? { action: 'expandAll' } : { action: 'none' };
}
