// Pure kernels for org panel webview interactions: overlay teardown, folder click versus
// double-click timing, search reply freshness and join, and the dialog focus trap.
// media/orgPanel.js mirrors this logic.

// Body-level fixed overlays survive a list re-render and their buttons would act on a stale
// folder, so Escape and every inbound re-render close all of these. Add new overlays here.
export type TransientOverlayKey = 'colorPicker' | 'newFolderPopover' | 'folderMenu';

export const TRANSIENT_OVERLAY_KEYS: readonly TransientOverlayKey[] = [
  'colorPicker',
  'newFolderPopover',
  'folderMenu',
];

// A click that toggles a folder re-renders the tree and detaches the node a following
// double-click needs, so rename would never open. A lone click's toggle is deferred and
// cancelled when the second click or dblclick arrives within the window. The webview binds
// these functions to real events and a timer and clears the arm on re-render, Escape, the
// chevron or opening another overlay.
export const DOUBLE_CLICK_MS = 250;

export interface FolderClickState {
  // Time of the click that armed the pending toggle, or null when none is pending.
  lastClickAt: number | null;
  // Keyed by folder so a fast click on a different folder is not taken for a double-click.
  armedFolderId: string | null;
}

export function newFolderClickState(): FolderClickState {
  return { lastClickAt: null, armedFolderId: null };
}

export interface ClickDecision {
  // Null on the second click of a same-folder fast pair.
  armToggleFolderId: string | null;
  // True on the second click of a pair and when switching to a different folder.
  cancelPending: boolean;
}

// A fast second click on the same folder arms nothing because a dblclick owns it; a click on
// a different folder replaces the stale arm. Mutates state.
export function registerFolderClick(
  state: FolderClickState,
  folderId: string,
  now: number,
  delayMs: number = DOUBLE_CLICK_MS,
): ClickDecision {
  const withinWindow = state.lastClickAt !== null && now - state.lastClickAt < delayMs;
  if (withinWindow && state.armedFolderId === folderId) {
    // Reset so a third click starts fresh.
    state.lastClickAt = null;
    state.armedFolderId = null;
    return { armToggleFolderId: null, cancelPending: true };
  }
  const hadArm = state.armedFolderId !== null;
  state.lastClickAt = now;
  state.armedFolderId = folderId;
  return { armToggleFolderId: folderId, cancelPending: hadArm };
}

export interface DblClickDecision {
  cancelToggle: boolean;
  openRename: boolean;
}

export function registerFolderDblClick(state: FolderClickState): DblClickDecision {
  state.lastClickAt = null;
  state.armedFolderId = null;
  return { cancelToggle: true, openRename: true };
}

export function clearFolderToggleArm(state: FolderClickState): void {
  state.lastClickAt = null;
  state.armedFolderId = null;
}

// The host owns the text index and posts a ranked id list; the client owns the tag filter
// and sort. Results are the host ids that pass the tag filter, ordered by the client sort.
// The host replies twice per query and typing interleaves, so a reply for a changed query is
// dropped.

// Trim and lowercase, shared by the text filter and the reply compare so a fresh reply is
// never dropped as stale.
export function normalizeQuery(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

// An empty current filter trusts nothing; otherwise the reply must match it.
export function isFreshSearchReply(replyQuery: unknown, currentTextFilter: string): boolean {
  if (currentTextFilter.length === 0) {
    return false;
  }
  return normalizeQuery(replyQuery) === currentTextFilter;
}

export interface JoinRow {
  sessionId: string;
  tagIds?: string[];
}

export interface JoinTextHitsInput<R extends JoinRow> {
  // Host-ranked chat ids.
  order: readonly string[];
  // A missing or empty snippet means no snippet row (a title match sends none).
  snippetOf: (sessionId: string) => string | null | undefined;
  // Undefined when the chat is not in the current section model.
  rowOf: (sessionId: string) => R | undefined;
  rowMatches: (row: R) => boolean;
  // Host rank decides membership; this decides order.
  sortRows: (rows: R[]) => R[];
}

export interface JoinTextHitsResult<R extends JoinRow> {
  // Deduped, first occurrence wins.
  rows: R[];
  snippets: Map<string, string>;
}

// Decides a Tab keydown inside an open dialog: whether to preventDefault and which
// focusable index to focus (null lets the browser advance natively). activeIndex is -1 when
// focus is outside the dialog.
//   count 0          -> block Tab, no target
//   activeIndex < 0  -> snap to the first
//   Shift+Tab first  -> wrap to the last
//   Tab last         -> wrap to the first
export interface DialogFocusTrapAction {
  preventDefault: boolean;
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

// Walks the host order once, skipping repeats and ids that lack a row or fail the tag
// filter, then applies the panel sort. Does not mutate the input rows.
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
