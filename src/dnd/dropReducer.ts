// dropReducer: the PURE drop reducer behind the drag-and-drop controllers. Given
// a drop's payload MIME, the dragged chat ids, the TARGET view, and the target
// node id, it returns the ordered list of store-mutation INTENTS the controller
// should apply. It interprets a drop strictly by the TARGET view (a drop on the
// Tags view tags; a drop on the Folders view moves the home), asserts the payload
// MIME against the shared chat MIME, and treats an unrecognized source as a no-op
// (an empty intent list).
//
// This module is vscode-free (ARCHITECTURE.md unit-gate rule): it imports no
// vscode types (no DataTransfer, no TreeDragAndDropController) and touches no
// filesystem. The vscode-bound controller (dndController.ts) extracts the plain
// data (payload MIME, source chat ids, target view/id) out of the real
// DataTransfer and drop target, calls this reducer, then applies the returned
// intents as N synchronous store calls (which coalesce into one pending write).
// The split mirrors occurrence.ts vs tagsProvider.ts so the unit test that
// imports this reducer never transitively requires vscode.
//
// Binding rules honored (ARCHITECTURE.md "Drag and drop"):
// - handleDrop asserts the payload MIME and interprets by the TARGET view.
// - Reject unrecognized sources as a no-op (here: an empty intent list).
// - Refresh coalescing: the controller batches the returned intents into ONE
//   store write and a single refresh; this reducer just enumerates them.

// The shared custom chat MIME used for CROSS-VIEW drags. Both controllers declare
// it (alongside their own reserved MIME) so a chat dragged from one view can be
// dropped on the other. The handleDrag side sets a DataTransferItem under this
// type carrying the dragged chat ids. The value is namespaced so it cannot
// collide with VSCode's own tree MIME or another extension's.
export const NEST_CHAT_MIME = 'application/vnd.code.tree.claudenest.chat';

// The two view targets a drop can land on. The reducer interprets the drop by
// this value: a Folders-view drop moves the chats' single home; a Tags-view drop
// adds a tag to each chat. The string values match the contributed view ids so
// the controller can pass its own view id straight through.
export type DropTargetView = 'claudeNest.folders' | 'claudeNest.tags';

// One store-mutation intent produced by the reducer. A 'setFolder' intent sets a
// chat's single home folder (folderId null unfiles it); a 'addTag' intent adds a
// tag id to a chat. The controller maps each to exactly one synchronous store
// call (setChatFolder / addChatTag), and the burst coalesces into one pending
// write via the store's existing debounce (ARCHITECTURE.md "Refresh coalescing").
export type DropIntent =
  | { kind: 'setFolder'; chatId: string; folderId: string | null }
  | { kind: 'addTag'; chatId: string; tagId: string };

// The plain-data input the controller extracts from the real DataTransfer and the
// drop target before calling the reducer. payloadMime is the MIME under which the
// drag payload was found (or undefined / a foreign value when the drop carries no
// recognized Nest payload). sourceChatIds are the dragged chats' sessionIds.
// targetView is the view the drop landed on. targetId is the id of the node the
// drop landed on (a folder id, the Unfiled sentinel, a tag id, the Untagged
// sentinel, or undefined for a drop on empty space / the view root).
export interface DropInput {
  payloadMime: string | undefined;
  sourceChatIds: string[];
  targetView: DropTargetView;
  targetId: string | undefined;
}

// The Folders-view synthetic Unfiled bucket id. Duplicated as a literal here
// rather than imported from folderTree.ts so this pure reducer stays free of any
// transitive import that might pull vscode in; the value is the binding contract
// and is asserted equal in the unit test. A drop ONTO the Unfiled bucket unfiles
// the chats (folderId null), matching a "move out of any folder" gesture.
const UNFILED_FOLDER_ID = '__unfiled__';

// The Tags-view synthetic Untagged bucket id. A drop ONTO the Untagged bucket is
// a no-op for tagging: there is no real tag to add, and "untag everything" is not
// a drag gesture (removal is an explicit context-menu action), so it yields no
// intents rather than guessing.
const UNTAGGED_TAG_ID = '__untagged__';

// Reduce a drop to its ordered list of store-mutation intents.
//
// MIME guard: the payload MUST be the shared chat MIME. Any other value (a
// foreign tree's reserved MIME, a file drop, undefined) is an unrecognized source
// and yields NO intents (a no-op), per ARCHITECTURE.md "Reject unrecognized
// sources as a no-op". The per-view reserved MIME is deliberately NOT accepted
// here: a same-view reorder is out of scope for this slice, and accepting a
// reserved MIME as a cross-view payload would let a Folders reorder payload tag a
// chat. Only the shared chat MIME crosses views.
//
// Interpretation BY TARGET VIEW (never by source):
// - Folders view: each dragged chat's single home is set to the target folder id
//   (or unfiled when the target is the Unfiled bucket or the view root/empty
//   space). One 'setFolder' intent per chat.
// - Tags view: the target tag id is added to each dragged chat. One 'addTag'
//   intent per chat. A drop on the Untagged bucket or the view root yields no
//   intents (no real tag to add).
//
// Multi-node batching: the input carries every dragged chat id, so a multi-select
// drag yields one intent per chat in source order, de-duplicated. The controller
// applies them as N synchronous store calls that coalesce into ONE pending write
// and fires a single refresh.
export function reduceDrop(input: DropInput): DropIntent[] {
  // MIME guard first: only the shared chat MIME is a recognized cross-view drop.
  if (input.payloadMime !== NEST_CHAT_MIME) {
    return [];
  }

  // De-duplicate the dragged chat ids while preserving first-seen order, so a
  // selection that somehow lists a chat twice does not stage two intents for it
  // (the store mutations are idempotent, but a clean intent list keeps the batch
  // count honest for the refresh-coalescing assertion).
  const chatIds = dedupePreserveOrder(input.sourceChatIds).filter(
    (id) => id.length > 0,
  );
  if (chatIds.length === 0) {
    return [];
  }

  if (input.targetView === 'claudeNest.folders') {
    // A drop on the Unfiled bucket, on empty space, or on the view root unfiles
    // (folderId null). A drop on a real folder sets that folder as the home.
    const folderId =
      input.targetId === undefined || input.targetId === UNFILED_FOLDER_ID
        ? null
        : input.targetId;
    return chatIds.map((chatId) => ({ kind: 'setFolder', chatId, folderId }));
  }

  // Tags view. A drop must land on a REAL tag to add it; a drop on the Untagged
  // bucket, on empty space, or on the view root yields no intents.
  if (
    input.targetId === undefined ||
    input.targetId === UNTAGGED_TAG_ID
  ) {
    return [];
  }
  const tagId = input.targetId;
  return chatIds.map((chatId) => ({ kind: 'addTag', chatId, tagId }));
}

// De-duplicate a list of strings preserving the first occurrence order.
function dedupePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}
