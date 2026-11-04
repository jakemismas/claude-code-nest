// TreeDragAndDropController for the Folders and Tags views; drop logic lives in the pure reduceDrop.
// VS Code 1.66 does not deliver a custom DataTransferItem across trees, so handleDrag also
// stashes the chat ids in dragContext and handleDrop falls back to that stash.

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

// Re-exported so extension.ts and tests import the reserved MIMEs from one place.
export {
  FOLDERS_RESERVED_MIME,
  TAGS_RESERVED_MIME,
} from './dropPayload';

// Both FoldersProvider and TagsProvider satisfy this.
export interface RefreshableProvider {
  refresh(): void;
}

// Resolved per drop because the project dir can appear after activation; no project means a no-op drop.
export type ProjectKeyResolver = () => string | undefined;

// Only the Folders controller uses this, to file a drop on a linked-child row alongside that
// chat. Undefined (home unknown) makes the drop a no-op.
export type ChatHomeResolver = (chatId: string) => string | undefined;

export interface DndControllerDeps {
  store: MetadataStore;
  getProjectKey: ProjectKeyResolver;
  provider: RefreshableProvider;
  resolveChatHome?: ChatHomeResolver;
}

// A folder or tag row contributes no chat id, so dragging one is a no-op drop.
type DraggableNode = FolderTreeNode | TagTreeNode;

// A linked-child row drags its child chat. Ids follow the selection order.
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

// Distinct from undefined, which means empty space and unfiles on the Folders view. This marks
// a drop on an unresolvable linked-child row, which must do nothing instead of unfiling.
const NOOP_TARGET = Symbol('noop-target');
type ResolvedTarget = string | undefined | typeof NOOP_TARGET;

// One instance per view; extension.ts passes it to createTreeView.
export class NestDragAndDropController<TNode extends DraggableNode>
  implements vscode.TreeDragAndDropController<TNode>
{
  // Includes the peer view's reserved MIME so the host offers this tree as a drop target
  // for the other view's drags; without it handleDrop never runs on a cross-view drop.
  public readonly dropMimeTypes: string[];
  public readonly dragMimeTypes: string[];

  private readonly reservedMime: string;

  constructor(
    private readonly deps: DndControllerDeps,
    private readonly view: DropTargetView,
    reservedMime: string,
  ) {
    this.reservedMime = reservedMime;
    this.dragMimeTypes = [reservedMime, NEST_CHAT_MIME];
    this.dropMimeTypes = [...RECOGNIZED_PAYLOAD_MIMES];
  }

  // A drag with no chat node stashes an empty list, which clears any prior stash.
  handleDrag(
    source: readonly TNode[],
    dataTransfer: vscode.DataTransfer,
  ): void {
    const chatIds = chatIdsFromSource(source);
    const payload = JSON.stringify(chatIds);
    dataTransfer.set(NEST_CHAT_MIME, new vscode.DataTransferItem(payload));
    dataTransfer.set(this.reservedMime, new vscode.DataTransferItem(payload));
    // The peer controller's handleDrop reads this on a cross-tree drop.
    stashDrag(chatIds);
  }

  // The DataTransfer wins for a same-tree drop; the stash covers a cross-tree drop. Intents apply
  // as synchronous store calls that coalesce into one write, then one flush and one refresh.
  async handleDrop(
    target: TNode | undefined,
    dataTransfer: vscode.DataTransfer,
  ): Promise<void> {
    // Resolve the target first: NOOP_TARGET must not reach the reducer, which would unfile on undefined.
    const resolved = this.resolveTarget(target);
    if (resolved === NOOP_TARGET) {
      // Clear the stash so it cannot leak into a later drop.
      takeDrag();
      return;
    }

    const found = new Map<string, unknown>();
    for (const mime of RECOGNIZED_PAYLOAD_MIMES) {
      const item = dataTransfer.get(mime);
      if (item !== undefined) {
        found.set(mime, item.value);
      }
    }
    const payload = pickPayload(found);

    // Take the stash on every drop so it never leaks. On a cross-tree drop the host sends an opaque
    // value (e.g. {itemHandles:['0'],hostInternal:true}) that pickPayload returns but parseChatIds
    // rejects, so the fallback keys on an empty parse, not on a missing payload.
    const stashed = takeDrag();
    const dtChatIds = payload !== undefined ? parseChatIds(payload.raw) : [];
    const usedStash = dtChatIds.length === 0;
    const sourceChatIds = usedStash ? stashed?.chatIds ?? [] : dtChatIds;
    // Chat ids from either source count as a Nest drop; none yields undefined, which the reducer rejects.
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

    this.applyIntents(projectKey, intents);
    await this.deps.store.flush();
    this.deps.provider.refresh();
  }

  // A chat row resolves to its owning folder or tag, so dropping onto a chat files or tags
  // alongside it. A linked-child row resolves through deps.resolveChatHome.
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
        // A linked child is not a folder-home node (its tree id is the link composite), so look up its home by chat id.
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
