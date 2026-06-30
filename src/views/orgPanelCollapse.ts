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
