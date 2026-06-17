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
  LinkedChildItem,
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
import { stashDrag, takeDrag } from './dragContext';

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
// - Cross-view drags use an IN-PROCESS shared stash (dragContext), NOT the
//   DataTransfer. VSCode 1.66 does NOT deliver a source controller's custom
//   DataTransferItem to a DIFFERENT controller's handleDrop: verified against the
//   pinned source (extHostTreeViews $handleDrop only re-applies the source
//   handleDrag items when sourceViewId === destinationViewId; on a cross-tree drop
//   only the base transfer DTO crosses), and the @types/vscode 1.66 docs say the
//   same ("will only be included in the handleDrop when the drag was initiated
//   from an element in the same drag and drop controller"). So the chat-id JSON a
//   controller writes under its own reserved MIME does NOT reach the peer
//   controller. handleDrag therefore ALSO stashes the dragged chat ids in the
//   vscode-free dragContext singleton, and handleDrop falls back to that stash
//   when the DataTransfer carried no recognized Nest payload (the cross-view
//   case). The DataTransfer remains the authoritative source for a WITHIN-view
//   drop (the host preserves the custom item there). Each controller still lists
//   both reserved MIMEs plus the shared chat MIME in dropMimeTypes so the host
//   OFFERS the peer tree as a drop target for a cross-view drag (without that the
//   drop is never accepted and handleDrop never runs); the stash supplies the
//   payload the DataTransfer cannot carry across controllers.
// - handleDrop parses the chat ids from whichever recognized MIME the DataTransfer
//   carries (dropPayload.pickPayload + parseChatIds); when that parse yields NO ids
//   (an absent payload, OR the opaque host-internal value the host actually hands a
//   peer controller cross-tree, which parseChatIds rejects) it falls back to the
//   cross-view stash. It then asserts the payload MIME via the reducer's MIME guard
//   and interprets the drop strictly by the TARGET view. An unrecognized source with
//   no stash is a no-op.
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

// Resolve a chat's CURRENT home folder id (the real folder id, or the Unfiled
// sentinel for an unfiled chat), used only by the Folders controller to resolve a
// drop landing on a LinkedChildItem row to its underlying chat's folder home so
// the drop files the dragged chat ALONGSIDE that linked child rather than
// unfiling it. Returns undefined when the chat's home cannot be resolved (a
// not-yet-homed or unknown chat), which the controller then treats as a no-op for
// that target. The Tags controller does not supply this (a Tags drop never lands
// on a folder-home node).
export type ChatHomeResolver = (chatId: string) => string | undefined;

// The dependencies a controller needs: the store to mutate, the project-key
// resolver, the provider to refresh once after a drop, and the view this
// controller is attached to (which fixes the drop INTERPRETATION). deviceId is
// not needed here; the store stamps writes itself. resolveChatHome is optional and
// only the Folders controller passes it (see ChatHomeResolver).
export interface DndControllerDeps {
  store: MetadataStore;
  getProjectKey: ProjectKeyResolver;
  provider: RefreshableProvider;
  resolveChatHome?: ChatHomeResolver;
}

// The union of node types a drag can originate from across both views. handleDrag
// extracts each dragged chat's sessionId; non-chat nodes (a folder or tag row)
// contribute no chat id, so dragging a folder/tag carries an empty payload and
// the reducer no-ops on the drop.
type DraggableNode = FolderTreeNode | TagTreeNode;

// Extract the dragged chats' sessionIds from the selected source nodes. A chat
// node in the Folders view is a ChatMemberItem (record.sessionId); a chat node in
// the Tags view is a ChatOccurrenceItem (record.sessionId); a linked-child row in
// the Folders view is a LinkedChildItem whose dragged chat is the child chat
// (child.chatId). A folder or tag row contributes nothing, so dragging a non-chat
// row yields an empty payload and the drop is a no-op. The order follows the
// selection order VSCode passes.
function chatIdsFromSource(nodes: readonly DraggableNode[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    if (node instanceof ChatMemberItem) {
      ids.push(node.record.sessionId);
    } else if (node instanceof ChatOccurrenceItem) {
      ids.push(node.record.sessionId);
    } else if (node instanceof LinkedChildItem) {
      ids.push(node.child.chatId);
    }
  }
  return ids;
}

// The sentinel a drop-target resolution returns when the drop landed on a node
// that is a recognized drop surface but yields NO actionable target (e.g. a
// LinkedChildItem whose underlying chat's folder home cannot be resolved). It is
// DISTINCT from undefined: undefined means "the view root / empty space", which on
// the Folders view legitimately unfiles, whereas this sentinel must be a strict
// no-op so a drop on an unresolvable linked-child row never silently unfiles the
// dragged chat. handleDrop short-circuits to a no-op on this sentinel BEFORE
// calling the reducer.
const NOOP_TARGET = Symbol('noop-target');
type ResolvedTarget = string | undefined | typeof NOOP_TARGET;

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
  // reserved MIME makes the host OFFER this tree as a drop target for the other
  // view's drags so handleDrop runs at all on a cross-view drop; the shared chat
  // MIME is the within-view custom carrier. The cross-view PAYLOAD itself rides the
  // in-process dragContext stash, not these MIMEs (the host does not deliver a
  // peer controller's custom MIME value cross-tree). handleDrop's recognition order
  // lives in dropPayload.RECOGNIZED_PAYLOAD_MIMES.
  public readonly dropMimeTypes: string[];
  // The MIME types this controller PRODUCES on a drag: its own reserved MIME (so
  // the host offers a drop target) plus the shared chat MIME (the within-view
  // carrier the host preserves for a same-tree drop).
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
  // host preserves our custom item) AND this controller's own reserved MIME (so
  // the host offers a drop target). They are ALSO stashed in the in-process
  // dragContext: that stash is the RELIABLE carrier for a CROSS-view drop, where
  // the host does not deliver this controller's custom MIME value to the peer
  // controller's handleDrop. A drag that includes no chat node (a folder/tag row
  // only) sets and stashes an empty list, which the reducer treats as a no-op on
  // drop and which clears any prior stash.
  handleDrag(
    source: readonly TNode[],
    dataTransfer: vscode.DataTransfer,
  ): void {
    const chatIds = chatIdsFromSource(source);
    const payload = JSON.stringify(chatIds);
    dataTransfer.set(NEST_CHAT_MIME, new vscode.DataTransferItem(payload));
    dataTransfer.set(this.reservedMime, new vscode.DataTransferItem(payload));
    // The cross-view carrier: the peer controller's handleDrop reads this when the
    // DataTransfer carried no recognized Nest payload (the cross-tree case).
    stashDrag(chatIds);
  }

  // Handle a drop. Prefer the DataTransfer payload (the authoritative within-view
  // carrier, present when the host preserved our custom item for a same-tree drop);
  // when the DataTransfer yields no usable chat ids - whether it carried no
  // recognized MIME at all OR carried an opaque host-internal value under the peer
  // reserved MIME that parses empty (the real cross-tree case) - fall back to the
  // in-process drag stash (the cross-view carrier the DataTransfer cannot deliver
  // across controllers). Parse the chat ids tolerantly, run the pure reducer, and
  // apply the resulting intents as N synchronous store calls that coalesce into ONE
  // pending write, then flush once and refresh once.
  async handleDrop(
    target: TNode | undefined,
    dataTransfer: vscode.DataTransfer,
  ): Promise<void> {
    // Resolve the drop target FIRST. A NOOP_TARGET (e.g. a LinkedChildItem whose
    // chat home cannot be resolved) is a strict no-op: it must NOT fall through to
    // the reducer, which would map an undefined Folders target to unfile.
    const resolved = this.resolveTarget(target);
    if (resolved === NOOP_TARGET) {
      // Consume the stash so an abandoned no-op drop does not leave it for a later
      // unrelated drop.
      takeDrag();
      return;
    }

    // Pull the raw value out of every recognized MIME the real DataTransfer
    // carries, then let the pure picker choose by priority. A within-view drop
    // carries our custom item; a cross-view drop carries none of our MIMEs, so the
    // stash supplies the payload instead.
    const found = new Map<string, unknown>();
    for (const mime of RECOGNIZED_PAYLOAD_MIMES) {
      const item = dataTransfer.get(mime);
      if (item !== undefined) {
        found.set(mime, item.value);
      }
    }
    const payload = pickPayload(found);

    // The stash is consumed on EVERY drop (one-shot) so a within-view drop also
    // clears it and it can never leak into a later unrelated drop. It is USED
    // whenever the DataTransfer payload yielded no usable chat ids: that covers
    // both the absent-payload case AND the case the cross-view drop actually hits,
    // where the host delivers an OPAQUE host-internal value under the source's
    // reserved MIME (e.g. {itemHandles:['0'],hostInternal:true}). pickPayload then
    // returns that opaque value (payload !== undefined), but parseChatIds rejects it
    // and returns [], so keying the fallback only on payload === undefined would
    // skip the stash and silently no-op the whole cross-view drag (the precise
    // failure DECISIONS.md says the stash prevents). Parse the DataTransfer payload
    // FIRST and fall back to the stash whenever the parse came up empty.
    const stashed = takeDrag();
    const dtChatIds = payload !== undefined ? parseChatIds(payload.raw) : [];
    const usedStash = dtChatIds.length === 0;
    const sourceChatIds = usedStash ? stashed?.chatIds ?? [] : dtChatIds;
    // A Nest drop is recognized when EITHER the DataTransfer carried parseable chat
    // ids (the within-view case) OR the cross-view stash supplied chat ids; both
    // normalize to the shared chat MIME for the reducer's guard. Neither present ->
    // undefined, which the reducer rejects as a no-op (a foreign or empty drag).
    const payloadMime =
      sourceChatIds.length > 0 ? NEST_CHAT_MIME : undefined;

    const intents = reduceDrop({
      payloadMime,
      sourceChatIds,
      targetView: this.view,
      targetId: resolved,
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

  // Resolve the drop TARGET id from the node the drop landed on, interpreted in
  // this controller's view. The reducer turns this id into the move/tag target:
  // - Folders view: a FolderItem contributes its folderId (real folder or the
  //   Unfiled sentinel); a ChatMemberItem contributes its OWNING folder id, so
  //   dropping a chat onto another chat files it alongside that chat; a
  //   LinkedChildItem resolves its underlying chat's home folder (via
  //   deps.resolveChatHome) so a drop files alongside the linked child rather than
  //   silently unfiling, and yields NOOP_TARGET when that home cannot be resolved;
  //   undefined (a drop on empty space / the view root) unfiles in the reducer.
  // - Tags view: a TagItem contributes its tagId (real tag or the Untagged
  //   sentinel); a ChatOccurrenceItem contributes its OWNING tag id, so dropping a
  //   chat onto an occurrence adds that occurrence's tag. undefined yields no tag
  //   intents in the reducer.
  private resolveTarget(target: TNode | undefined): ResolvedTarget {
    if (target === undefined) {
      return undefined;
    }
    if (this.view === 'claudeNest.folders') {
      if (target instanceof FolderItem) {
        return target.folderId;
      }
      if (target instanceof ChatMemberItem) {
        return target.folderId;
      }
      if (target instanceof LinkedChildItem) {
        // File alongside the linked child: resolve ITS underlying chat's current
        // home folder. A LinkedChildItem is NOT a folder-home node (its tree id is
        // the link composite, not `${folderId}#${chatId}`), so its folder home must
        // be looked up by chat id. Without a resolver (or when the home is
        // unknown), return NOOP_TARGET so the drop does nothing rather than
        // unfiling the dragged chat.
        const home = this.deps.resolveChatHome?.(target.child.chatId);
        return home ?? NOOP_TARGET;
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
