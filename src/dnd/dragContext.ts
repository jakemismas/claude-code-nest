// dragContext: the in-process shared carrier for a Nest drag, and the RELIABLE
// path for a CROSS-VIEW (cross-tree) drop. It is vscode-free (ARCHITECTURE.md
// unit-gate rule) so the unit suite can exercise the stash/take/clear contract
// without the host.
//
// WHY this exists (corrects the Slice 3 DECISIONS.md assumption): VSCode 1.66
// does NOT deliver a source controller's custom DataTransferItem to a DIFFERENT
// controller's handleDrop. Verified against the pinned source: extHostTreeViews
// $handleDrop only re-applies the source handleDrag items
// (addAdditionalTransferItems) when `sourceViewId === destinationViewId`; on a
// cross-tree drop only the base transfer DTO crosses, so the chat-id JSON the
// source controller writes under its own reserved MIME never reaches the peer
// controller. The @types/vscode 1.66 docs say the same: a custom MIME added in
// handleDrag "will only be included in the handleDrop when the drag was initiated
// from an element in the same drag and drop controller," and a custom item "will
// be preserved [only] when the items are dropped on another tree item in the same
// tree." So the DataTransfer carrier is correct ONLY for a within-view drop.
//
// The within-view path still rides the DataTransfer (the host preserves the
// custom item there, and a value that survived a host round-trip is the
// authoritative source). This module is the cross-view fallback: handleDrag
// stashes the dragged chat ids here keyed by a monotonic drag token; handleDrop
// consults the DataTransfer FIRST (within-view) and falls back to the most-recent
// stash when no recognized payload arrived (cross-view). The stash is cleared
// when consumed and is single-entry (a new drag overwrites the previous), so a
// stale stash cannot leak chat ids into an unrelated later drop.

// One live drag's payload: the dragged chats' sessionIds and a monotonic token
// identifying the drag, so a drop can confirm it is consuming the CURRENT drag's
// stash and not a stale one left by an abandoned drag.
export interface DragStash {
  token: number;
  chatIds: string[];
}

// Module-singleton state. A single in-flight drag at a time is the VSCode model
// (one pointer, one drag operation), so a single slot is sufficient and a new
// drag deliberately overwrites the previous (an abandoned drag leaves at most one
// stale entry, which the next stash replaces and any consume clears).
let current: DragStash | undefined;
let nextToken = 1;

// Record the dragged chat ids for the current drag and return the token that
// identifies this stash. handleDrag calls this; the token can be written into the
// DataTransfer so a within-view drop could cross-check, but the cross-view path
// just takes the latest stash. An empty id list still stashes (so a drag that
// carries no chat clears any previous stash rather than letting a stale one win).
export function stashDrag(chatIds: string[]): number {
  const token = nextToken++;
  current = { token, chatIds: [...chatIds] };
  return token;
}

// Take (read and CLEAR) the current drag stash. Returns undefined when nothing is
// stashed. Clearing on take means a single drop consumes the stash exactly once;
// a second handleDrop (or a later unrelated drop) finds nothing and falls through
// to its own no-op, so a stale stash can never leak into an unrelated drop.
export function takeDrag(): DragStash | undefined {
  const taken = current;
  current = undefined;
  return taken;
}

// Peek at the current stash without clearing it. Exposed for diagnostics and the
// unit test; the controller uses takeDrag so consumption is one-shot.
export function peekDrag(): DragStash | undefined {
  return current;
}

// Explicitly clear the stash. Not required by the take path (take clears), but
// available so a controller can drop a stash on a known-abandoned drag.
export function clearDrag(): void {
  current = undefined;
}
