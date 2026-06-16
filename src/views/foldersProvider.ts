import * as vscode from 'vscode';
import { ChatRecord } from '../model/types';
import { resolveDir, scanChats, ScannerOptions } from '../claude/chatScanner';
import { relativeTime } from './relativeTime';
import { MetadataStore } from '../store/metadataStore';
import {
  AssembledTree,
  FolderNode,
  assembleFolderTree,
  buildChatHomeIndex,
  canReuseChatMemberItem,
  canReuseFolderItem,
  chatNodeId,
  isUnfiledId,
  parseChatNodeId,
  resolveChatHomeFolderId,
} from '../model/folderTree';
import { OPEN_CHAT_COMMAND } from './flatProvider';

// The claudeNest.folders tree: the single-home folder hierarchy. Folder nodes are
// collapsible; each chat appears under EXACTLY one folder (its ChatMeta.folderId,
// or the synthetic Unfiled bucket) as a leaf chat-member node whose id is the
// composite `${folderId}#${chatId}`.
//
// Binding rules honored (ARCHITECTURE.md "Tree and VSCode API binding rules"):
// - Composite ids: a folder node id is the separator-free folder id (or the
//   '__unfiled__' sentinel); a chat-member node id is `${folderId}#${chatId}`,
//   unique tree-wide because a chat has exactly one home.
// - Memoize node objects by id across refreshes: returning a fresh object with
//   the same id on every getChildren breaks reveal/selection. A refresh rebuilds
//   the assembly but reuses the existing node object for an unchanged id.
// - getParent returns EXACTLY one parent: a chat-member node's parent is its one
//   owning folder; a folder node's parent is its parent folder (undefined for a
//   root or the Unfiled bucket). reveal-by-chat targets THIS view (the chat's
//   single home).
// - getChildren(undefined) returns [] when there are no sessions; never throws
//   out of getChildren (a failed scan renders empty). The viewsWelcome
//   contribution shows the no-sessions message.

// The kinds of node the Folders tree renders.
export type FolderTreeNode = FolderItem | ChatMemberItem;

// A folder row (a real stored folder or the synthetic Unfiled bucket).
export class FolderItem extends vscode.TreeItem {
  // The folder's plain name, retained for cheap memoization comparison (TreeItem
  // types label as a possibly-rich union, so a dedicated field is clearer).
  public readonly folderName: string;

  constructor(
    public readonly folderId: string,
    public readonly parentFolderId: string | null,
    label: string,
    synthetic: boolean,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.folderName = label;
    this.id = folderId;
    this.iconPath = new vscode.ThemeIcon(synthetic ? 'inbox' : 'folder');
    // contextValue drives the per-row menu: real folders get rename/delete; the
    // synthetic Unfiled bucket gets neither.
    this.contextValue = synthetic ? 'claudeNest.unfiled' : 'claudeNest.folder';
  }
}

// A chat occurrence under a folder. Its id is the composite `${folderId}#${chatId}`.
export class ChatMemberItem extends vscode.TreeItem {
  constructor(
    public readonly folderId: string,
    public readonly record: ChatRecord,
  ) {
    super(record.title, vscode.TreeItemCollapsibleState.None);
    this.id = chatNodeId(folderId, record.sessionId);
    this.description = relativeTime(record.timestamp);
    this.tooltip = record.title + '\n' + record.sessionId;
    this.contextValue = 'claudeNest.chat';
    this.iconPath = new vscode.ThemeIcon('comment-discussion');
    this.command = {
      command: OPEN_CHAT_COMMAND,
      title: 'Open Chat',
      arguments: [record.sessionId],
    };
  }
}

export class FoldersProvider implements vscode.TreeDataProvider<FolderTreeNode> {
  private readonly emitter = new vscode.EventEmitter<FolderTreeNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  // Memoized node objects by tree-wide-unique id (folder id, or `${folderId}#${chatId}`).
  // Reused across refreshes so VSCode's reference-keyed element cache keeps reveal
  // and selection stable.
  private readonly nodesById = new Map<string, FolderTreeNode>();

  // The latest assembled tree, kept so getParent and getChildren read a single
  // consistent snapshot per refresh cycle rather than re-scanning per call.
  private assembled: AssembledTree | null = null;
  // sessionId -> ChatRecord for the latest scan, so a chat-member node can render
  // its title/time and getChildren can build member items.
  private recordsById = new Map<string, ChatRecord>();
  // chatId -> owning folderId for the current snapshot, the inverse used by
  // getParent to recover a chat's single home.
  private homeByChatId = new Map<string, string>();

  constructor(
    private readonly workspacePath: string | undefined,
    private readonly store: MetadataStore,
    private readonly options: ScannerOptions = {},
  ) {}

  // Resolve the encoded project key (the on-disk projects directory name) for the
  // active workspace ON DEMAND, mirroring scanChats: resolveDir is re-run every
  // call so the view recovers once Claude Code creates the project dir, without a
  // window reload. Returns undefined when there is no workspace or no dir yet.
  // The Folders-view commands share this same lazy resolution (folderCommands.ts
  // FolderCommandDeps.getProjectKey) so create/rename/delete/assign stop reporting
  // "no project resolved" once the dir appears.
  resolveProjectKey(): string | undefined {
    if (this.workspacePath === undefined) {
      return undefined;
    }
    return resolveDir(this.workspacePath, this.options) ?? undefined;
  }

  // Fire a refresh. A targeted node refreshes that subtree; undefined refreshes
  // the whole tree. The snapshot is rebuilt lazily on the next getChildren.
  refresh(node?: FolderTreeNode): void {
    this.assembled = null;
    this.emitter.fire(node);
  }

  getTreeItem(element: FolderTreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: FolderTreeNode): FolderTreeNode[] {
    const tree = this.ensureSnapshot();
    if (tree === null) {
      return [];
    }
    if (element === undefined) {
      // Top level: real root folders, then the Unfiled bucket last.
      const roots = tree.roots.map((node) => this.folderItemFor(node));
      roots.push(this.folderItemFor(tree.unfiled));
      return roots;
    }
    if (element instanceof ChatMemberItem) {
      return [];
    }
    // A folder row: its child folders followed by its directly-homed chats.
    const node = this.findFolderNode(element.folderId);
    if (node === null) {
      return [];
    }
    const children: FolderTreeNode[] = node.childFolders.map((child) =>
      this.folderItemFor(child),
    );
    for (const chatId of this.sortedChatIds(node.chatIds)) {
      const record = this.recordsById.get(chatId);
      if (record !== undefined) {
        children.push(this.chatMemberItemFor(node.id, record));
      }
    }
    return children;
  }

  // getParent returns the SINGLE parent of a node (ARCHITECTURE.md). A chat
  // member's parent is its one owning folder; a folder's parent is its parent
  // folder, or undefined for a root or the Unfiled bucket. The Folders view is the
  // reveal target for a chat (its single home).
  getParent(element: FolderTreeNode): FolderTreeNode | undefined {
    this.ensureSnapshot();
    if (element instanceof ChatMemberItem) {
      // Delegate the single-home resolution (chatId -> owning folder id, with the
      // member node's own folderId as the fallback hint) to the pure model.
      const owner = resolveChatHomeFolderId(
        this.homeByChatId,
        element.record.sessionId,
        element.folderId,
      );
      const node = this.findFolderNode(owner);
      return node ? this.folderItemFor(node) : undefined;
    }
    // A folder item: parent folder, if any.
    if (element.parentFolderId === null) {
      return undefined;
    }
    const parent = this.findFolderNode(element.parentFolderId);
    return parent ? this.folderItemFor(parent) : undefined;
  }

  // Resolve the composite id of a chat to its memoized member node, for reveal.
  // Returns undefined when the chat is not currently homed/known.
  memberNodeForChat(chatId: string): ChatMemberItem | undefined {
    this.ensureSnapshot();
    const folderId = this.homeByChatId.get(chatId);
    const record = this.recordsById.get(chatId);
    if (folderId === undefined || record === undefined) {
      return undefined;
    }
    return this.chatMemberItemFor(folderId, record);
  }

  // ---- Snapshot + memoization internals ----

  // Build (or reuse) the current snapshot: scan the chats, read the stored folder
  // hierarchy and chat homes, and assemble the single-home tree. Returns null only
  // when there is no workspace/project (the empty state). Never throws.
  private ensureSnapshot(): AssembledTree | null {
    if (this.assembled !== null) {
      return this.assembled;
    }
    // Resolve the project key lazily on each rebuild (refresh() clears assembled),
    // so a brand-new workspace that gets its dir created later recovers on the next
    // refresh instead of staying empty until a window reload (the flat view already
    // does this via scanChats -> resolveDir).
    const projectKey = this.resolveProjectKey();
    if (this.workspacePath === undefined || projectKey === undefined) {
      return null;
    }
    let records: ChatRecord[];
    try {
      records = scanChats(this.workspacePath, this.options);
    } catch {
      records = [];
    }
    this.recordsById = new Map(records.map((r) => [r.sessionId, r]));

    const meta = this.store.getProjectMeta(projectKey);
    const chatHomes: { [chatId: string]: string | null | undefined } = {};
    for (const record of records) {
      const chatMeta = meta.chats[record.sessionId];
      chatHomes[record.sessionId] = chatMeta ? chatMeta.folderId : null;
    }

    const tree = assembleFolderTree({ folders: meta.folders, chatHomes });

    // Rebuild the chatId -> owning folderId inverse for getParent via the pure
    // model. A chat routed to Unfiled maps to the Unfiled sentinel so reveal still
    // resolves a parent. The single-home resolution itself is unit-tested in the
    // vscode-free model (buildChatHomeIndex); the provider only consumes it.
    this.homeByChatId = buildChatHomeIndex(tree);

    this.assembled = tree;
    this.pruneMemoized(tree);
    return tree;
  }

  private folderItemFor(node: FolderNode): FolderItem {
    const existing = this.nodesById.get(node.id);
    if (
      existing instanceof FolderItem &&
      canReuseFolderItem(existing.folderName, node.name)
    ) {
      return existing;
    }
    const item = new FolderItem(node.id, node.parentId, node.name, node.synthetic);
    this.nodesById.set(node.id, item);
    return item;
  }

  private chatMemberItemFor(folderId: string, record: ChatRecord): ChatMemberItem {
    const id = chatNodeId(folderId, record.sessionId);
    const existing = this.nodesById.get(id);
    if (existing instanceof ChatMemberItem && canReuseChatMemberItem(existing.record, record)) {
      return existing;
    }
    const item = new ChatMemberItem(folderId, record);
    this.nodesById.set(id, item);
    return item;
  }

  private findFolderNode(folderId: string): FolderNode | null {
    if (this.assembled === null) {
      return null;
    }
    if (isUnfiledId(folderId)) {
      return this.assembled.unfiled;
    }
    return findNode(this.assembled.roots, folderId);
  }

  // Sort a folder's directly-homed chats newest-first (no timestamp sorts last),
  // matching the flat view's ordering. The pure model leaves chat order to the
  // view because timestamps live outside it.
  private sortedChatIds(chatIds: string[]): string[] {
    return [...chatIds].sort((a, b) => {
      const ta = this.recordsById.get(a)?.timestamp ?? 0;
      const tb = this.recordsById.get(b)?.timestamp ?? 0;
      return tb - ta;
    });
  }

  // Drop memoized nodes whose id is no longer present in the current tree, so the
  // cache does not grow unbounded as folders/chats come and go.
  private pruneMemoized(tree: AssembledTree): void {
    const live = new Set<string>();
    collectLiveIds(tree.roots, this.recordsById, live);
    collectLiveIdsForNode(tree.unfiled, this.recordsById, live);
    for (const id of Array.from(this.nodesById.keys())) {
      if (!live.has(id)) {
        this.nodesById.delete(id);
      }
    }
  }
}

function findNode(nodes: FolderNode[], folderId: string): FolderNode | null {
  for (const node of nodes) {
    if (node.id === folderId) {
      return node;
    }
    const inChild = findNode(node.childFolders, folderId);
    if (inChild !== null) {
      return inChild;
    }
  }
  return null;
}

function collectLiveIds(
  nodes: FolderNode[],
  records: Map<string, ChatRecord>,
  into: Set<string>,
): void {
  for (const node of nodes) {
    collectLiveIdsForNode(node, records, into);
  }
}

function collectLiveIdsForNode(
  node: FolderNode,
  records: Map<string, ChatRecord>,
  into: Set<string>,
): void {
  into.add(node.id);
  for (const chatId of node.chatIds) {
    if (records.has(chatId)) {
      into.add(chatNodeId(node.id, chatId));
    }
  }
  for (const child of node.childFolders) {
    collectLiveIdsForNode(child, records, into);
  }
}

// Re-export the composite-id parser so command handlers can recover an owning
// folder id from a selected chat-member node without reaching into the model.
export { parseChatNodeId };
