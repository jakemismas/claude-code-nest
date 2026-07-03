// orgPanelInteractions: the PURE, vscode-free and DOM-free kernels behind two org
// panel webview interactions that carry real decision/timing risk. Kept separate
// from media/orgPanel.js so the headless unit gate can cover them, the same split
// that keeps orgPanelModel.ts, dropReducer.ts, and orgPanelCollapse.ts vscode-free.
// The webview owns the DOM and MIRRORS this logic; this module never touches a DOM.

// ---- Transient body-level overlays torn down on a cross-surface re-render ----

// The org panel appends three transient overlays to document.body (NOT inside the
// list), each position:fixed: the folder color picker, the new-folder popover, and
// the folder actions menu. Because they live outside the list and are fixed-
// positioned, a re-render (listEl.textContent = '') does NOT remove them; they
// float, orphaned, at a stale viewport point, and their captured-closure buttons
// still post mutations for a folderId that the same refresh may have recolored,
// renamed, or deleted. Both the Escape handler AND every inbound tree re-render
// ('sections' and 'state') must close ALL of these, so the set lives here as the
// single source of truth and both call sites iterate it. Adding a fourth body-level
// overlay means adding its key here once, and neither call site can drift.
export type TransientOverlayKey = 'colorPicker' | 'newFolderPopover' | 'folderMenu';

export const TRANSIENT_OVERLAY_KEYS: readonly TransientOverlayKey[] = [
  'colorPicker',
  'newFolderPopover',
  'folderMenu',
];

// ---- Folder-row single- vs double-click arbitration ----

// Issue #82 AC2 (and design README line 63): "Click toggles expand/collapse.
// Double-click enters inline rename." In the webview a click that toggles collapse
// re-renders the whole tree (listEl.textContent = ''), which detaches the very node
// a following double-click needs, so a naive per-click toggle races the rename: the
// first click of a double-click fires the toggle, re-renders, and the detached node
// never receives the dblclick, so rename never opens (and the tree flickers). The
// browser fires click, click, dblclick for a double-click, so the fix defers the
// single-click toggle briefly and cancels it if the second click / dblclick arrives
// inside the window. This module is the pure timing state machine; the webview binds
// it to real DOM events and a real timer.
//
// Contract (these are the functions exported below; the webview mirrors them):
//   newFolderClickState(): create the arming state the webview threads through the
//     calls below, mirroring it with its own real timer handle.
//   registerFolderClick(state, folderId, now): a folder-row click landed. Returns
//     whether to ARM a deferred toggle for that folder (fires after delayMs unless
//     cancelled) and whether to cancel a stale arm first. Arms nothing on the SECOND
//     click of a same-folder fast pair, so the dblclick that follows is the sole
//     action.
//   registerFolderDblClick(state): a dblclick landed; cancel any armed toggle and
//     open rename. Always returns { cancelToggle: true, openRename: true }.
//   clearFolderToggleArm(state): drop any armed toggle. The webview calls this from
//     the abort triggers (a cross-surface re-render, Escape, the chevron, and opening
//     a conflicting overlay) and clears its own timer handle alongside.
//
// The default DOUBLE_CLICK_MS window matches the common platform double-click
// threshold; a lone click's toggle is delayed by exactly this much, which is below
// the perceptible-lag threshold for a disclosure toggle and is the standard vanilla
// technique for click/dblclick disambiguation without a keyed renderer.
export const DOUBLE_CLICK_MS = 250;

export interface FolderClickState {
  // The timestamp (ms) of the most recent click that ARMED a pending toggle, or
  // null when no toggle is pending. The webview mirrors this with its timer handle.
  lastClickAt: number | null;
  // The folder id the armed toggle targets, or null when nothing is armed. Keyed by
  // folder so a fast second click on a DIFFERENT folder is not mistaken for a
  // double-click: it cancels the stale arm and arms the new folder instead.
  armedFolderId: string | null;
}

export function newFolderClickState(): FolderClickState {
  return { lastClickAt: null, armedFolderId: null };
}

export interface ClickDecision {
  // Arm a deferred toggle for `armToggleFolderId` (start the timer). Null when no
  // toggle should be armed (the second click of a same-folder fast pair).
  armToggleFolderId: string | null;
  // Cancel any currently-armed toggle (clear the timer) before deciding. True on the
  // second click of a same-folder pair AND when switching to a different folder.
  cancelPending: boolean;
}

// Decide what a folder-row click on `folderId` does, given the arming state and a
// monotonic clock. A first click (nothing armed, or the previous arm lapsed) arms a
// deferred toggle for that folder. A fast second click on the SAME folder cancels the
// pending toggle and arms nothing, because a dblclick is about to fire and must own
// the interaction. A fast click on a DIFFERENT folder cancels the stale arm and arms
// the new folder (it is not a double-click of either). Mutates `state` so the next
// call and the webview timer stay in sync.
export function registerFolderClick(
  state: FolderClickState,
  folderId: string,
  now: number,
  delayMs: number = DOUBLE_CLICK_MS,
): ClickDecision {
  const withinWindow = state.lastClickAt !== null && now - state.lastClickAt < delayMs;
  if (withinWindow && state.armedFolderId === folderId) {
    // Second click of a fast pair on the same folder: cancel the armed toggle; the
    // imminent dblclick owns it. Reset so a third click starts fresh.
    state.lastClickAt = null;
    state.armedFolderId = null;
    return { armToggleFolderId: null, cancelPending: true };
  }
  // First click, a click after the window lapsed, or a click on a different folder:
  // cancel any stale arm and arm this folder.
  const hadArm = state.armedFolderId !== null;
  state.lastClickAt = now;
  state.armedFolderId = folderId;
  return { armToggleFolderId: folderId, cancelPending: hadArm };
}

export interface DblClickDecision {
  cancelToggle: boolean;
  openRename: boolean;
}

// A dblclick always cancels any armed single-click toggle and opens rename. Clears
// the arm stamp so a later click starts a fresh cycle.
export function registerFolderDblClick(state: FolderClickState): DblClickDecision {
  state.lastClickAt = null;
  state.armedFolderId = null;
  return { cancelToggle: true, openRename: true };
}

// Clear any armed toggle (a cross-surface re-render, an Escape, or a chevron click
// aborts the deferred row toggle). The webview also clears its timer handle.
export function clearFolderToggleArm(state: FolderClickState): void {
  state.lastClickAt = null;
  state.armedFolderId = null;
}
