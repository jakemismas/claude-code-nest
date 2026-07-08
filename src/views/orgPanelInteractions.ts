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

// ---- Content-search reply freshness + host-hit x client-tag join (issue #83) ----
//
// The org panel's text search is a two-surface join: the HOST owns the text index
// (MiniSearch over titles + on-demand bodies) and posts a ranked id list; the
// CLIENT owns the tag AND-filter and the sort control. Membership of the flat
// results list is (host-ranked ids) INTERSECT (rows passing the client tag filter),
// deduped, then ordered by the client's chosen sort (host rank decides membership,
// sort decides order). Because the host posts TWICE per query (a warm tier-A reply
// then a body-indexed reply) and keystrokes interleave, a reply can arrive for a
// query the user has already changed; such a stale reply must be dropped. Both the
// query normalization and the freshness compare are pure decisions the webview must
// make identically on the inbound-message side and the render side, so they live
// here as the single source of truth and media/orgPanel.js mirrors them. DOM-free
// and vscode-free, so the headless unit gate covers the membership/ordering/drop
// contract that AC #3/#4 rest on.

// Normalize a raw query string the ONE way both the outbound text filter
// (textFilter) and the inbound search-reply compare use: trim, then lowercase.
// Sharing this is what guarantees a reply the host echoes (its raw trimmed query)
// compares equal to the client's stored textFilter for the SAME user input, so a
// fresh reply is never dropped as stale nor a stale one accepted.
export function normalizeQuery(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

// Whether a search reply for `replyQuery` corresponds to the query currently in the
// box (`currentTextFilter`, already normalized). A reply is trusted ONLY when its
// normalized query equals the current non-empty filter; an empty current filter (the
// box was cleared) trusts nothing, and a mismatch is a superseded reply to drop.
// This is exactly the webview's inbound `searchResults` guard AND its render-time
// haveFreshTextResults predicate, unified so they cannot diverge.
export function isFreshSearchReply(replyQuery: unknown, currentTextFilter: string): boolean {
  if (currentTextFilter.length === 0) {
    return false;
  }
  return normalizeQuery(replyQuery) === currentTextFilter;
}

// A minimal shape the join needs off each section row: its chat id and the tag ids
// it carries (for the client AND-filter). The webview row objects carry more; the
// kernel only reads these two.
export interface JoinRow {
  sessionId: string;
  tagIds?: string[];
}

export interface JoinTextHitsInput<R extends JoinRow> {
  // The host-ranked chat ids (searchHitOrder), in the order the host returned them.
  order: readonly string[];
  // The per-id snippet the host supplied (searchHitSnippets). A missing/empty entry
  // means "no snippet row for this chat" (a title match sends none).
  snippetOf: (sessionId: string) => string | null | undefined;
  // Resolve a chat id to its section row (rowsBySessionId). Returns undefined when
  // the id is not in the current section model (a hit for a chat not shown here).
  rowOf: (sessionId: string) => R | undefined;
  // The client tag AND-filter: true when the row passes the active tag chips.
  rowMatches: (row: R) => boolean;
  // The panel's sort applied to the resulting membership (host rank -> membership,
  // this -> order). Receives and returns the row array.
  sortRows: (rows: R[]) => R[];
}

export interface JoinTextHitsResult<R extends JoinRow> {
  // The visible rows: host-ranked ids that resolve to a row AND pass the tag filter,
  // deduped (first occurrence wins), then sorted by the panel's sort.
  rows: R[];
  // sessionId -> snippet, only for rows whose host snippet was a non-empty string.
  snippets: Map<string, string>;
}

// ---- Dialog focus-trap decision kernel (slice s3b-a11y, issue #89 AC3) ----

// The pure decision behind wireDialogFocusTrap in media/orgPanel.js. Given the count of
// visible focusable controls inside an open role="dialog" surface, the index of the
// currently-focused control within that list (-1 when focus is outside the dialog or on a
// node no longer in the list), and whether Shift was held, decide what a Tab keydown should
// do: whether to preventDefault the native tab, and which focusable index to move focus to
// (null = do not move; let the browser's native Tab advance focus within the dialog).
//
// The webview owns the DOM (querySelectorAll, offsetParent visibility filter, .focus()) and
// MIRRORS this decision; this kernel never touches a DOM. Branches, matching the contract in
// ARCHITECTURE.md and the TESTING.md keyboard step:
//   - count === 0        -> block Tab, focus nothing (no target exists).
//   - activeIndex < 0    -> focus escaped/outside; snap back to the first focusable.
//   - Shift+Tab at first -> wrap to the last focusable.
//   - Tab at last        -> wrap to the first focusable.
//   - otherwise          -> let native Tab move within the dialog.
// A single-focusable dialog (count === 1) keeps focus pinned on index 0 on either edge.
export interface DialogFocusTrapAction {
  // True when the native Tab must be suppressed (the kernel is taking over focus movement,
  // or there is nothing to move to).
  preventDefault: boolean;
  // The focusable index to move focus to, or null to leave focus where the browser puts it.
  focusIndex: number | null;
}

export function dialogFocusTrapAction(
  count: number,
  activeIndex: number,
  shiftKey: boolean,
): DialogFocusTrapAction {
  if (count <= 0) {
    return { preventDefault: true, focusIndex: null };
  }
  if (activeIndex < 0) {
    return { preventDefault: true, focusIndex: 0 };
  }
  const last = count - 1;
  if (shiftKey && activeIndex === 0) {
    return { preventDefault: true, focusIndex: last };
  }
  if (!shiftKey && activeIndex === last) {
    return { preventDefault: true, focusIndex: 0 };
  }
  return { preventDefault: false, focusIndex: null };
}

// Join the host text-hit ids with the client tag filter into the flat results set.
// Walk the host order once, skip ids already seen, skip ids that do not resolve to a
// row or that fail the tag filter, collect the row and (when present and non-empty)
// its snippet, then apply the panel sort to the collected rows. The dedup guards
// against a host order that repeats an id; the row/tag gates enforce the
// membership rule; the sort at the end enforces the ordering rule. Pure: no DOM, no
// mutation of the input rows.
export function joinTextHits<R extends JoinRow>(
  input: JoinTextHitsInput<R>,
): JoinTextHitsResult<R> {
  const seen = new Set<string>();
  const rows: R[] = [];
  const snippets = new Map<string, string>();
  for (const sessionId of input.order) {
    if (seen.has(sessionId)) {
      continue;
    }
    const row = input.rowOf(sessionId);
    if (row === undefined || !input.rowMatches(row)) {
      continue;
    }
    seen.add(sessionId);
    rows.push(row);
    const snip = input.snippetOf(sessionId);
    if (typeof snip === 'string' && snip.length > 0) {
      snippets.set(sessionId, snip);
    }
  }
  return { rows: input.sortRows(rows), snippets };
}
