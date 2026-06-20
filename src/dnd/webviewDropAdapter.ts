// webviewDropAdapter: the vscode-thin shell that turns an IN-PANEL webview drop
// into store mutations by reusing the EXISTING, UNCHANGED pure drop reducer
// (src/dnd/dropReducer.ts). It is the webview analogue of dndController.ts, but
// far simpler, because a webview drag-and-drop is FULLY IN-PROCESS: the drop
// message the webview posts carries the dragged chat ids directly, so there is no
// cross-controller DataTransfer gap and NO dragContext stash is consulted (the
// stash exists only for the cross-tree TreeView case, where VSCode 1.66 will not
// deliver a controller's custom DataTransferItem to a peer controller; see
// dragContext.ts and ARCHITECTURE.md "Drag and drop"). This adapter never imports
// dragContext.
//
// This module imports NO vscode types (it depends on the MetadataStore structural
// seam, which is itself vscode-free) and does no filesystem work, so the unit test
// that exercises the message-to-DropInput mapping never transitively requires
// vscode (ARCHITECTURE.md unit-gate rule). The DnD-shell-only contract holds: the
// only thing this slice adds on the drop path is the extraction shell here; the
// interpretation stays in the unchanged reduceDrop.
//
// Binding rules honored (ARCHITECTURE.md "Drag and drop" + "Refresh coalescing"):
// - The drop is interpreted strictly BY THE TARGET VIEW via reduceDrop: an
//   in-panel folder row / empty space maps to {targetView:'claudeNest.folders'},
//   a tag chip maps to {targetView:'claudeNest.tags'}. The reducer (not this
//   shell) decides folder-move vs tag-add.
// - The payload MIME is set to the shared chat MIME (NEST_CHAT_MIME) so the
//   reducer's MIME guard passes for a genuine in-panel chat drag; an empty id
//   list still reduces to a no-op.
// - A multi-select drop applies the reducer's intents as N synchronous store
//   calls (which coalesce into ONE pending write via the store's debounce), then
//   ONE flush and ONE refresh, the same shape dndController.ts uses.

import { MetadataStore } from '../store/metadataStore';
import {
  DropInput,
  DropIntent,
  DropTargetView,
  NEST_CHAT_MIME,
  reduceDrop,
} from './dropReducer';

// The plain message the org-panel webview posts on a drop. It is fully
// self-describing: sourceChatIds are the dragged chats (the webview tracks the
// drag start in-process and lists every selected chat id), and the target tells
// the adapter which kind of in-panel surface received the drop and its id.
//
// targetKind distinguishes the two drop surfaces so the adapter can map to the
// correct reducer targetView without the webview needing to know the reserved
// view-id strings:
//   'folder'  -> a folder row (targetId is the real folder id, the Unsorted
//                sentinel '__unfiled__', or undefined for empty space): a
//                folder-move (or unfile) in the reducer.
//   'tag'     -> a tag chip (targetId is the real tag id): a tag-add in the
//                reducer.
export interface WebviewDropMessage {
  sourceChatIds: string[];
  targetKind: 'folder' | 'tag';
  targetId: string | undefined;
}

// The dependencies the adapter needs: the store to mutate, the project-key
// resolver (resolved per drop because the project dir can appear after
// activation, mirroring dndController), and the single refresh to fire once the
// batched write has flushed. These mirror dndController.DndControllerDeps minus
// the per-view binding (the message carries the target) and the linked-child
// resolver (a webview drop never lands on a linked-child row).
export interface WebviewDropDeps {
  store: MetadataStore;
  getProjectKey: () => string | undefined;
  refresh: () => void;
}

// Map an in-panel drop message to the reducer's plain DropInput. PURE and
// vscode-free, so the unit test asserts the mapping directly. A 'folder' drop
// maps to the Folders target view (so the reducer does a folder-move or, on the
// Unsorted sentinel / empty space, an unfile); a 'tag' drop maps to the Tags
// target view (a tag-add on a real tag, a no-op on no tag). The payload MIME is
// always the shared chat MIME so the reducer's guard passes for a genuine chat
// drag; the reducer still no-ops on an empty source id list.
export function dropInputFromMessage(message: WebviewDropMessage): DropInput {
  const targetView: DropTargetView =
    message.targetKind === 'tag' ? 'claudeNest.tags' : 'claudeNest.folders';
  return {
    payloadMime: NEST_CHAT_MIME,
    sourceChatIds: Array.isArray(message.sourceChatIds) ? message.sourceChatIds : [],
    targetView,
    targetId: message.targetId,
  };
}

// Handle one in-panel drop: map the message to a DropInput, run the UNCHANGED
// reducer, and apply the resulting intents as N synchronous store calls that
// coalesce into ONE pending write, then flush once and refresh once. Returns the
// number of intents applied (0 for a no-op drop), so the caller/test can assert a
// foreign or empty drop did nothing. Tolerant: an unresolved project key applies
// nothing (and does not refresh), matching dndController.
export async function handleWebviewDrop(
  deps: WebviewDropDeps,
  message: WebviewDropMessage,
): Promise<number> {
  const intents = reduceDrop(dropInputFromMessage(message));
  if (intents.length === 0) {
    return 0;
  }
  const projectKey = deps.getProjectKey();
  if (projectKey === undefined) {
    return 0;
  }
  applyIntents(deps.store, projectKey, intents);
  // One flush, one refresh for the whole (possibly multi-select) mutation
  // (ARCHITECTURE.md "Refresh coalescing").
  await deps.store.flush();
  deps.refresh();
  return intents.length;
}

// Apply each intent as exactly one synchronous store call. The burst coalesces
// into a single pending write via the store's existing debounce; no new batch API
// is introduced (the same mechanism dndController.applyIntents relies on).
function applyIntents(store: MetadataStore, projectKey: string, intents: DropIntent[]): void {
  for (const intent of intents) {
    if (intent.kind === 'setFolder') {
      store.setChatFolder(projectKey, intent.chatId, intent.folderId);
    } else {
      store.addChatTag(projectKey, intent.chatId, intent.tagId);
    }
  }
}
