import * as vscode from 'vscode';
import { ChatRecord, TokenTotals } from '../model/types';
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
import {
  LinkForest,
  LinkedChild,
  buildLinkForest,
  canExpandChild,
  canReuseLinkedChildItem,
  childrenOf,
  hasLinkedChildren,
  linksFromChats,
  parseLinkedChildId,
} from '../model/links';
import { decorateLinkedChild } from './linkDecoration';
import { OPEN_CHAT_COMMAND } from '../launch/uriLauncher';
import { ScanPrimable } from '../commands/refreshScanCommands';
import { ProjectMeta } from '../store/schema';
import { buildChatTooltip, tokenBadge } from './chatTooltip';
import { resolveFolderName, resolveStarred, resolveTagLabels } from './chatMeta';

// The claudeNest.folders tree. Each chat appears under exactly one folder (or the Unfiled
// bucket) as `${folderId}#${chatId}`, unique tree-wide. Node objects are memoized by id
// because a fresh object per getChildren breaks reveal and selection. getChildren never
// throws: a failed scan renders empty.

export type FolderTreeNode = FolderItem | ChatMemberItem | LinkedChildItem;

export class FolderItem extends vscode.TreeItem {
  // Plain name for the reuse check, since TreeItem.label is a union type.
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
    // Real folders get rename and delete; the Unfiled bucket gets neither.
    this.contextValue = synthetic ? 'claudeNest.unfiled' : 'claudeNest.folder';
  }
}

// A chat under a folder. Collapsible when it is the designated parent of linked children;
// hasLinks lets the reuse check rebuild the item when that flips.
export class ChatMemberItem extends vscode.TreeItem {
  // What the hover card was built from, so the reuse check rebuilds on a re-file or tag edit.
  public cardFolderName: string | null | undefined = undefined;
  public cardTagsSignature = '';
  public cardStarred = false;

  constructor(
    public readonly folderId: string,
    public readonly record: ChatRecord,
    public readonly hasLinks: boolean = false,
    folderName: string | null | undefined = undefined,
    tags: readonly string[] = [],
    starred = false,
  ) {
    super(
      record.title,
      hasLinks
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    this.id = chatNodeId(folderId, record.sessionId);
    this.description = chatRowDescription(record);
    this.tooltip = new vscode.MarkdownString(buildChatTooltip(record, folderName, tags));
    this.contextValue = 'claudeNest.chat';
    // ThemeIcon cannot composite glyphs, so the star replaces the chat icon.
    this.iconPath = new vscode.ThemeIcon(starred ? 'star-full' : 'comment-discussion');
    this.command = {
      command: OPEN_CHAT_COMMAND,
      title: 'Open Chat',
      arguments: [record.sessionId],
    };
  }
}

// A linked child nested under its designated parent chat, id `${parentChatId}>link>${chatId}`.
// record is undefined when broken. A broken or depth-capped child is a leaf.
export class LinkedChildItem extends vscode.TreeItem {
  constructor(
    public readonly child: LinkedChild,
    public readonly record: ChatRecord | undefined,
    expandable: boolean,
  ) {
    super(
      record !== undefined ? record.title : '',
      expandable
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    this.id = child.id;
    decorateLinkedChild(this, child, record);
  }
}

export class FoldersProvider implements vscode.TreeDataProvider<FolderTreeNode>, ScanPrimable {
  private readonly emitter = new vscode.EventEmitter<FolderTreeNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  // Progress and cancel hooks for one primed scan only, so passive reads never carry a stale callback.
  private scanOverlay: ScannerOptions | null = null;

  // Memoized nodes by id; see the header.
  private readonly nodesById = new Map<string, FolderTreeNode>();

  // One snapshot per refresh cycle, so getParent and getChildren do not re-scan.
  private assembled: AssembledTree | null = null;
  private recordsById = new Map<string, ChatRecord>();
  // Kept so hover cards resolve folder and tags without a second store read.
  private currentMeta: ProjectMeta | null = null;
  // chatId to owning folderId, used by getParent.
  private homeByChatId = new Map<string, string>();
  // Links are overlaid at render time; they are not part of the folder assembly.
  private linkForest: LinkForest = {
    childrenByParent: new Map(),
    designatedParentByChild: new Map(),
  };

  constructor(
    private readonly workspacePath: string | undefined,
    private readonly store: MetadataStore,
    private readonly options: ScannerOptions = {},
  ) {}

  // Resolved on every call so the view and its commands recover once Claude Code creates
  // the project dir, without a window reload.
  resolveProjectKey(): string | undefined {
    if (this.workspacePath === undefined) {
      return undefined;
    }
    return resolveDir(this.workspacePath, this.options) ?? undefined;
  }

  // The snapshot is rebuilt lazily on the next getChildren.
  refresh(node?: FolderTreeNode): void {
    this.assembled = null;
    this.emitter.fire(node);
  }

  // Scans once under the given progress options, then fires so getChildren reads the result.
  primeSnapshot(scanOptions: ScannerOptions): void {
    this.scanOverlay = scanOptions;
    this.assembled = null;
    try {
      this.ensureSnapshot();
    } finally {
      this.scanOverlay = null;
    }
    this.emitter.fire();
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
      const roots = tree.roots.map((node) => this.folderItemFor(node));
      roots.push(this.folderItemFor(tree.unfiled));
      return roots;
    }
    if (element instanceof ChatMemberItem) {
      // This chat is the root of its link subtree, so the path is just itself.
      return this.linkedChildrenOf(element.record.sessionId, new Set([element.record.sessionId]), 0);
    }
    if (element instanceof LinkedChildItem) {
      // The path is rebuilt from the single-parent forest so cycles and diamonds are pruned.
      if (element.record === undefined) {
        return [];
      }
      const path = this.linkPathTo(element.child.chatId);
      if (!canExpandChild(element.child, path)) {
        return [];
      }
      const visited = new Set(path);
      visited.add(element.child.chatId);
      return this.linkedChildrenOf(element.child.chatId, visited, element.child.depth);
    }
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

  // Each node has one parent, which makes this view the reveal target for a chat.
  getParent(element: FolderTreeNode): FolderTreeNode | undefined {
    this.ensureSnapshot();
    if (element instanceof LinkedChildItem) {
      // The parent is the parent chat's member node, not a folder. child.id is parsed
      // because TreeItem.id is typed string | undefined.
      const parsed = parseLinkedChildId(element.child.id);
      const parentChatId = parsed ? parsed.parentChatId : element.child.parentChatId;
      return this.memberNodeForChat(parentChatId);
    }
    if (element instanceof ChatMemberItem) {
      const owner = resolveChatHomeFolderId(
        this.homeByChatId,
        element.record.sessionId,
        element.folderId,
      );
      const node = this.findFolderNode(owner);
      return node ? this.folderItemFor(node) : undefined;
    }
    if (element.parentFolderId === null) {
      return undefined;
    }
    const parent = this.findFolderNode(element.parentFolderId);
    return parent ? this.folderItemFor(parent) : undefined;
  }

  // Title and timestamp per chat for the link target pick list. Returns a copy so callers
  // cannot mutate the record cache.
  chatRecords(): Map<string, { title: string; timestamp: number | null }> {
    this.ensureSnapshot();
    const out = new Map<string, { title: string; timestamp: number | null }>();
    for (const [chatId, record] of this.recordsById) {
      out.set(chatId, { title: record.title, timestamp: record.timestamp });
    }
    return out;
  }

  // Token totals per chat for the rollup, which chatRecords omits. Returns a copy.
  tokenTotalsByChat(): Map<string, TokenTotals> {
    this.ensureSnapshot();
    const out = new Map<string, TokenTotals>();
    for (const [chatId, record] of this.recordsById) {
      out.set(chatId, record.tokenTotals);
    }
    return out;
  }

  // The memoized member node for a chat, for reveal; undefined when the chat is unknown.
  memberNodeForChat(chatId: string): ChatMemberItem | undefined {
    this.ensureSnapshot();
    const folderId = this.homeByChatId.get(chatId);
    const record = this.recordsById.get(chatId);
    if (folderId === undefined || record === undefined) {
      return undefined;
    }
    return this.chatMemberItemFor(folderId, record);
  }

  // Returns null only when there is no workspace or project dir. Scan errors yield an empty list.
  private ensureSnapshot(): AssembledTree | null {
    if (this.assembled !== null) {
      return this.assembled;
    }
    // Resolved per rebuild so a project dir created later is picked up on the next refresh.
    const projectKey = this.resolveProjectKey();
    if (this.workspacePath === undefined || projectKey === undefined) {
      return null;
    }
    let records: ChatRecord[];
    try {
      records = scanChats(this.workspacePath, { ...this.options, ...this.scanOverlay });
    } catch {
      records = [];
    }
    this.recordsById = new Map(records.map((r) => [r.sessionId, r]));

    const meta = this.store.getProjectMeta(projectKey);
    this.currentMeta = meta;
    const chatHomes: { [chatId: string]: string | null | undefined } = {};
    for (const record of records) {
      const chatMeta = meta.chats[record.sessionId];
      chatHomes[record.sessionId] = chatMeta ? chatMeta.folderId : null;
    }

    const tree = assembleFolderTree({ folders: meta.folders, chatHomes });

    // Unfiled chats map to the Unfiled sentinel so reveal still resolves a parent.
    this.homeByChatId = buildChatHomeIndex(tree);

    // A target absent from the scanned set is broken. The forest gives each child one
    // designated parent (smallest source chat id), so it nests once per render.
    this.linkForest = buildLinkForest({
      links: linksFromChats(meta.chats),
      knownChatIds: new Set(this.recordsById.keys()),
    });

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
    // Part of the reuse identity: a cached leaf must rebuild when link children appear or
    // vanish, or the twistie would not update.
    const hasLinks = hasLinkedChildren(this.linkForest, record.sessionId);
    // These feed the tooltip, so the reuse check compares them to rebuild on a curation change.
    const meta = this.currentMeta ?? undefined;
    const folderName = resolveFolderName(meta, record.sessionId);
    const tags = resolveTagLabels(meta, record.sessionId);
    const tagsSignature = tags.join('::');
    const starred = resolveStarred(meta, record.sessionId);
    const existing = this.nodesById.get(id);
    if (
      existing instanceof ChatMemberItem &&
      canReuseChatMemberItem(existing.record, record) &&
      existing.hasLinks === hasLinks &&
      existing.cardFolderName === folderName &&
      existing.cardTagsSignature === tagsSignature &&
      existing.cardStarred === starred
    ) {
      return existing;
    }
    const item = new ChatMemberItem(folderId, record, hasLinks, folderName, tags, starred);
    item.cardFolderName = folderName;
    item.cardTagsSignature = tagsSignature;
    item.cardStarred = starred;
    this.nodesById.set(id, item);
    return item;
  }

  // visited is the chat-id path from the root through the parent; childrenOf uses it and
  // currentDepth (0 at a chat member) to prune cycles and apply the depth cap.
  private linkedChildrenOf(
    parentChatId: string,
    visited: Set<string>,
    currentDepth: number,
  ): LinkedChildItem[] {
    const children = childrenOf(this.linkForest, parentChatId, visited, currentDepth);
    const out: LinkedChildItem[] = [];
    for (const child of children) {
      out.push(this.linkedChildItemFor(child, visited));
    }
    return out;
  }

  // The ancestor path is unique because each child has one designated parent, so expansion
  // does not depend on how VS Code requested the node. The guard set stops a corrupt
  // parent cycle from looping.
  private linkPathTo(childChatId: string): Set<string> {
    const path = new Set<string>();
    let current = this.linkForest.designatedParentByChild.get(childChatId);
    while (current !== undefined && !path.has(current)) {
      path.add(current);
      current = this.linkForest.designatedParentByChild.get(current);
    }
    return path;
  }

  // Reuse identity includes the expandable state so the twistie flips when a child gains
  // or loses its own linked children.
  private linkedChildItemFor(
    child: LinkedChild,
    parentVisited: Set<string>,
  ): LinkedChildItem {
    const record = this.recordsById.get(child.chatId);
    // Matches what getChildren computes: the next path is the parent path plus this child.
    const visitedForChild = new Set(parentVisited);
    visitedForChild.add(child.chatId);
    const expandable =
      canExpandChild(child, parentVisited) &&
      hasLinkedChildren(this.linkForest, child.chatId) &&
      this.anyChildNotOnPath(child.chatId, visitedForChild);
    const existing = this.nodesById.get(child.id);
    if (
      existing instanceof LinkedChildItem &&
      canReuseLinkedChildItem(
        { title: existing.record?.title ?? null, timestamp: existing.record?.timestamp ?? null, broken: existing.child.broken },
        { title: record?.title ?? null, timestamp: record?.timestamp ?? null, broken: child.broken },
      ) &&
      existing.collapsibleState ===
        (expandable
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None)
    ) {
      return existing;
    }
    const item = new LinkedChildItem(child, record, expandable);
    this.nodesById.set(child.id, item);
    return item;
  }

  // Without this, a parent whose children are all on the path (a pure cycle) would show a
  // twistie that expands to nothing.
  private anyChildNotOnPath(parentChatId: string, visited: Set<string>): boolean {
    const direct = this.linkForest.childrenByParent.get(parentChatId) ?? [];
    for (const child of direct) {
      if (!visited.has(child.chatId)) {
        return true;
      }
    }
    return false;
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

  // Newest first, no timestamp last, matching the flat view.
  private sortedChatIds(chatIds: string[]): string[] {
    return [...chatIds].sort((a, b) => {
      const ta = this.recordsById.get(a)?.timestamp ?? 0;
      const tb = this.recordsById.get(b)?.timestamp ?? 0;
      return tb - ta;
    });
  }

  // Keeps the cache from growing as folders and chats come and go. A linked child is live
  // only when the render's own traversal reaches it.
  private pruneMemoized(tree: AssembledTree): void {
    const live = new Set<string>();
    collectLiveIds(tree.roots, this.recordsById, live);
    collectLiveIdsForNode(tree.unfiled, this.recordsById, live);
    this.collectLiveLinkedChildIds(live);
    for (const id of Array.from(this.nodesById.keys())) {
      if (!live.has(id)) {
        this.nodesById.delete(id);
      }
    }
  }

  // Walks from every scanned chat, as the render does. Walking only from forest roots would
  // miss a pure link cycle (A under B and B under A have no root) and evict rendered ids.
  // Overlapping walks only re-add the same ids.
  private collectLiveLinkedChildIds(into: Set<string>): void {
    for (const rootChatId of this.recordsById.keys()) {
      this.collectLinkedIdsFrom(rootChatId, new Set([rootChatId]), 0, into);
    }
  }

  private collectLinkedIdsFrom(
    parentChatId: string,
    visited: Set<string>,
    currentDepth: number,
    into: Set<string>,
  ): void {
    const children = childrenOf(this.linkForest, parentChatId, visited, currentDepth);
    for (const child of children) {
      into.add(child.id);
      if (canExpandChild(child, visited)) {
        const nextVisited = new Set(visited);
        nextVisited.add(child.chatId);
        this.collectLinkedIdsFrom(child.chatId, nextVisited, child.depth, into);
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

// Relative time plus token badge, matching the flat view.
function chatRowDescription(record: ChatRecord): string {
  const rel = relativeTime(record.timestamp);
  const badge = tokenBadge(record);
  if (badge.length === 0) {
    return rel;
  }
  if (rel.length === 0) {
    return badge;
  }
  return rel + ' | ' + badge;
}

// Lets command handlers recover the folder id from a selected node without importing the model.
export { parseChatNodeId };
