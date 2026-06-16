import * as vscode from 'vscode';
import { MetadataStore } from '../store/metadataStore';
import {
  DropIntent,
  DropTargetView,
  NEST_CHAT_MIME,
  reduceDrop,
} from './dropReducer';
import {
  FolderTreeNode,
  FolderItem,
  ChatMemberItem,
} from '../views/foldersProvider';
import {
  TagTreeNode,
  TagItem,
  ChatOccurrenceItem,
} from '../views/tagsProvider';
import {
  RECOGNIZED_PAYLOAD_MIMES,
  parseChatIds,
  pickPayload,
} from './dropPayload';

// dndController: the vscode-bound TreeDragAndDropController for the Folders and
// Tags views. It is the ONLY half of the drag-and-drop feature that imports
// vscode (TreeDragAndDropController, DataTransfer, DataTransferItem); the pure
// drop reducer (dropReducer.ts) holds the interpretation logic and stays
// vscode-free so the unit test can import it without pulling vscode in
// (ARCHITECTURE.md unit-gate rule; mirrors the occurrence.ts vs tagsProvider.ts
// split). This controller extracts the plain data (payload MIME, source chat ids,
// target view/id) out of the real DataTransfer and drop target, calls the
// reducer, and applies the returned intents.
//
// Binding rules honored (ARCHITECTURE.md "Drag and drop" + "Refresh coalescing"):
// - Cross-view drags REQUIRE the peer view's reserved MIME. VSCode 1.66 preserves
//   a custom MIME set in handleDrag into handleDrop only for a drop in the SAME
//   tree's controller; on a cross-tree drop the host strips the custom chat MIME
//   and carries ONLY the SOURCE tree's reserved MIME
//   (application/vnd.code.tree.<treeidlowercase>) between two trees of the same
//   extension. So each controller lists BOTH reserved MIMEs plus the shared chat
//   MIME in dropMimeTypes (so the host offers it as a drop target for a peer-view
//   drag), and handleDrag writes the chat-id payload under BOTH its own reserved
//   MIME (the cross-view carrier) AND the shared chat MIME (the within-view path).
// - handleDrop reads the payload from whichever recognized MIME is present
//   (dropPayload.pickPayload), parses the chat ids tolerantly, asserts the payload
//   MIME via the reducer's MIME guard, and interprets the drop strictly by the
//   TARGET view. An unrecognized source is a no-op.
// - A multi-select mutation is batched into ONE store write: the intents are
//   applied as N synchronous store.addChatTag / store.setChatFolder calls (which
//   coalesce into one pending write via the store's existing debounce), then a
//   single await store.flush() and a single provider.refresh() (same shape as
//   deleteFolder's cascade). No new batch API is added.

// The per-view reserved MIME types VSCode derives for each tree from its view id
// (application/vnd.code.tree.<viewidlowercase>). Re-exported from the pure
// dropPayload module so extension.ts (which constructs the controllers) and the
// deferred integration test (which asserts these match package.json) import them
// from one place, while the literals live with the cross-view carrier logic.
export {
  FOLDERS_RESERVED_MIME,
  TAGS_RESERVED_MIME,
} from './dropPayload';

// A minimal structural seam for the provider the controller refreshes after a
// drop. Both FoldersProvider and TagsProvider satisfy it (each has refresh()).
// Declared structurally so the controller does not couple to either concrete
// provider beyond the one method it calls.
export interface RefreshableProvider {
  refresh(): void;
}

// A minimal structural seam for resolving the active project key on demand,
// mirroring FolderCommandDeps.getProjectKey / TagCommandDeps.getProjectKey. The
// controller resolves the key per drop (the project dir can appear after
// activation), and a drop with no resolved project is a no-op.
export type ProjectKeyResolver = () => string | undefined;

// The dependencies a controller needs: the store to mutate, the project-key
// resolver, the provider to refresh once after a drop, and the view this
// controller is attached to (which fixes the drop INTERPRETATION). deviceId is
// not needed here; the store stamps writes itself.
export interface DndControllerDeps {
  store: MetadataStore;
  getProjectKey: ProjectKeyResolver;
  provider: RefreshableProvider;
}

// The union of node types a drag can originate from across both views. handleDrag
// extracts each dragged chat's sessionId; non-chat nodes (a folder or tag row)
// contribute no chat id, so dragging a folder/tag carries an empty payload and
// the reducer no-ops on the drop.
type DraggableNode = FolderTreeNode | TagTreeNode;

// Extract the dragged chats' sessionIds from the selected source nodes. A chat
// node in the Folders view is a ChatMemberItem (record.sessionId); a chat node in
// the Tags view is a ChatOccurrenceItem (record.sessionId). A folder or tag row
// contributes nothing, so dragging a non-chat row yields an empty payload and the
// drop is a no-op. The order follows the selection order VSCode passes.
function chatIdsFromSource(nodes: readonly DraggableNode[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    if (node instanceof ChatMemberItem) {
      ids.push(node.record.sessionId);
    } else if (node instanceof ChatOccurrenceItem) {
      ids.push(node.record.sessionId);
    }
  }
  return ids;
}

// Resolve the drop TARGET id from the node the drop landed on, interpreted in the
// target view. The reducer turns this id into the move/tag target:
// - Folders view: a FolderItem contributes its folderId (real folder or the
//   Unfiled sentinel); a ChatMemberItem contributes its OWNING folder id, so
//   dropping a chat onto another chat files it alongside that chat. undefined
//   (a drop on empty space / the view root) unfiles in the reducer.
// - Tags view: a TagItem contributes its tagId (real tag or the Untagged
//   sentinel); a ChatOccurrenceItem contributes its OWNING tag id, so dropping a
//   chat onto an occurrence adds that occurrence's tag. undefined yields no tag
//   intents in the reducer.
function targetIdFor(
  view: DropTargetView,
  target: DraggableNode | undefined,
): string | undefined {
  if (target === undefined) {
    return undefined;
  }
  if (view === 'claudeNest.folders') {
    if (target instanceof FolderItem) {
      return target.folderId;
    }
    if (target instanceof ChatMemberItem) {
      return target.folderId;
    }
    return undefined;
  }
  // Tags view.
  if (target instanceof TagItem) {
    return target.tagId;
  }
  if (target instanceof ChatOccurrenceItem) {
    return target.occurrence.tagId;
  }
  return undefined;
}

// The TreeDragAndDropController for ONE view. Constructed per view (Folders or
// Tags) and passed to createTreeView's dragAndDropController option in
// extension.ts; it is not self-registering. The generic parameter is the view's
// node union so handleDrag receives the right element type.
export class NestDragAndDropController<TNode extends DraggableNode>
  implements vscode.TreeDragAndDropController<TNode>
{
  // The MIME types this controller can RECEIVE on a drop: BOTH per-view reserved
  // MIMEs plus the shared chat MIME. The OWN reserved MIME makes the host offer
  // this tree as a drop target for its own drags (the within-view path); the PEER
  // reserved MIME makes it a drop target for the other view's drags (the only item
  // the host carries cross-tree) so the cross-view feature works; the shared chat
  // MIME is the within-view custom carrier. handleDrop's recognition order lives in
  // dropPayload.RECOGNIZED_PAYLOAD_MIMES.
  public readonly dropMimeTypes: string[];
  // The MIME types this controller PRODUCES on a drag: its own reserved MIME (the
  // cross-view carrier the host preserves between trees) plus the shared chat MIME
  // (the within-view carrier), so the payload is droppable both within this view
  // and on the other view.
  public readonly dragMimeTypes: string[];

  // The controller's own reserved MIME, retained so handleDrag can write the
  // cross-view carrier under it.
  private readonly reservedMime: string;

  constructor(
    private readonly deps: DndControllerDeps,
    private readonly view: DropTargetView,
    reservedMime: string,
  ) {
    this.reservedMime = reservedMime;
    this.dragMimeTypes = [reservedMime, NEST_CHAT_MIME];
    // Accept every recognized payload MIME (both reserved + the shared chat MIME),
    // not just this view's own, so a peer-view drag is offered this tree as a drop
    // target and arrives under the peer's reserved MIME.
    this.dropMimeTypes = [...RECOGNIZED_PAYLOAD_MIMES];
  }

  // Set the drag payload. The dragged chats' sessionIds are serialized as JSON
  // under BOTH the shared chat MIME (recovered on a within-view drop, where the
  // host preserves our custom item) AND this controller's own reserved MIME (the
  // cross-view carrier: the only item the host moves to the OTHER tree of the same
  // extension, since the custom chat MIME is stripped on a cross-tree drop). A drag
  // that includes no chat node (a folder/tag row only) sets an empty list, which
  // the reducer treats as a no-op on drop.
  handleDrag(
    source: readonly TNode[],
    dataTransfer: vscode.DataTransfer,
  ): void {
    const payload = JSON.stringify(chatIdsFromSource(source));
    dataTransfer.set(NEST_CHAT_MIME, new vscode.DataTransferItem(payload));
    dataTransfer.set(this.reservedMime, new vscode.DataTransferItem(payload));
  }

  // Handle a drop. Find the payload under whichever recognized MIME is present
  // (the shared chat MIME for a within-view drop, or a reserved MIME for a
  // cross-view drop), parse the chat ids tolerantly, run the pure reducer, and
  // apply the resulting intents as N synchronous store calls that coalesce into
  // ONE pending write, then flush once and refresh once.
  async handleDrop(
    target: TNode | undefined,
    dataTransfer: vscode.DataTransfer,
  ): Promise<void> {
    // Pull the raw value out of every recognized MIME the real DataTransfer
    // carries, then let the pure picker choose by priority. pickPayload returns
    // undefined when no recognized MIME carried a value (an unrecognized source),
    // which the reducer's MIME guard then treats as a no-op.
    const found = new Map<string, unknown>();
    for (const mime of RECOGNIZED_PAYLOAD_MIMES) {
      const item = dataTransfer.get(mime);
      if (item !== undefined) {
        found.set(mime, item.value);
      }
    }
    const payload = pickPayload(found);
    // Normalize the carrier MIME to the shared chat MIME for the reducer's guard:
    // a payload found under EITHER reserved MIME (a cross-view carrier) or the
    // shared chat MIME is a recognized Nest drop. No recognized MIME -> undefined,
    // which the reducer rejects as a no-op.
    const payloadMime = payload !== undefined ? NEST_CHAT_MIME : undefined;
    const sourceChatIds = parseChatIds(payload?.raw);

    const intents = reduceDrop({
      payloadMime,
      sourceChatIds,
      targetView: this.view,
      targetId: targetIdFor(this.view, target),
    });
    if (intents.length === 0) {
      return;
    }

    const projectKey = this.deps.getProjectKey();
    if (projectKey === undefined) {
      return;
    }

    // Apply every intent as a synchronous store call. The store debounces and
    // coalesces this burst into a SINGLE pending write (same mechanism the
    // deleteFolder cascade relies on); no new batch API is introduced.
    this.applyIntents(projectKey, intents);
    // One flush, one refresh (ARCHITECTURE.md "Refresh coalescing": fire
    // onDidChangeTreeData once for the whole multi-select mutation).
    await this.deps.store.flush();
    this.deps.provider.refresh();
  }

  private applyIntents(projectKey: string, intents: DropIntent[]): void {
    for (const intent of intents) {
      if (intent.kind === 'setFolder') {
        this.deps.store.setChatFolder(projectKey, intent.chatId, intent.folderId);
      } else {
        this.deps.store.addChatTag(projectKey, intent.chatId, intent.tagId);
      }
    }
  }
}
