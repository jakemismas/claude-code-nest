// Pure logic for the org panel's "collapse one level" control. The webview projects its
// folder hierarchy to this shape and owns the collapsed Set and the DOM.

// A folder projected from the rendered hierarchy. depth is 0 for a root folder.
// hasCollapsedAncestor means the folder is hidden even though its own flag is open.
export interface CollapseFolderNode {
  id: string;
  depth: number;
  hasChildFolder: boolean;
  collapsed: boolean;
  hasCollapsedAncestor: boolean;
}

// The ids of the deepest visible open tier that has child folders. Hidden folders and
// leaf folders are skipped: collapsing them would change nothing on screen. Returns []
// when nothing qualifies.
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

// One click's outcome: collapse these ids, clear the Set to re-expand all (the tree is
// already fully folded), or do nothing (no real folders).
export type FoldOneLevelResult =
  | { action: 'collapse'; ids: string[] }
  | { action: 'expandAll' }
  | { action: 'none' };

// hasRealFolders excludes the synthetic Unsorted bucket; it separates the all-folded
// state (expand all) from an empty tree (no-op).
export function foldOneLevel(
  folders: readonly CollapseFolderNode[],
  hasRealFolders: boolean,
): FoldOneLevelResult {
  const ids = deepestOpenLevelToCollapse(folders);
  if (ids.length > 0) {
    return { action: 'collapse', ids };
  }
  return hasRealFolders ? { action: 'expandAll' } : { action: 'none' };
}
