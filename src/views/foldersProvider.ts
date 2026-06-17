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
export type FolderTreeNode = FolderItem | ChatMemberItem | LinkedChildItem;

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
// It becomes COLLAPSIBLE (rather than a leaf) when the chat is the designated parent
// of one or more linked children (slice 5): getChildren then returns those
// linkedChild nodes. hasLinks records whether it has children so the memoization
// predicate rebuilds the item when its collapsible state must flip.
export class ChatMemberItem extends vscode.TreeItem {
  constructor(
    public readonly folderId: string,
    public readonly record: ChatRecord,
    public readonly hasLinks: boolean = false,
  ) {
    super(
      record.title,
      hasLinks
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
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

// A linked child occurrence nested beneath its one DESIGNATED parent chat-member
// node. Its id is the composite `${parentChatId}>link>${chatId}` (links.ts grammar).
// It carries the LinkedChild model node (parent chat id, child chat id, depth,
// broken flag) and the resolved target ChatRecord (undefined when broken). It is
// collapsible only when it is expandable AND itself a designated parent of further
// linked children; a broken or depth-capped child is a leaf. The visual decoration
// (git-branch icon, muted broken rendering, open command) is applied by
// linkDecoration.decorateLinkedChild so this class stays a thin id/state shell.
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
  // The link forest for the current snapshot: parent chat id -> its direct linked
  // children, plus the designated-parent inverse. Built in ensureSnapshot from the
  // stored links and the scanned chat-id set, consumed at render time (the
  // assembleFolderTree result still carries only folders+chatHomes; links are
  // overlaid here, not folded into the folder assembly).
  private linkForest: LinkForest = {
    childrenByParent: new Map(),
    designatedParentByChild: new Map(),
  };

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
      // A chat-member node: its linked children (depth 1), if any. The visited set
      // for the path is just this chat (it is the root of its link subtree).
      return this.linkedChildrenOf(element.record.sessionId, new Set([element.record.sessionId]), 0);
    }
    if (element instanceof LinkedChildItem) {
      // A linked-child node: recurse into ITS linked children, unless it is broken,
      // depth-capped, or already on the path (canExpandChild). The visited set is the
      // ancestor chat-id path reconstructed from the single-parent forest plus this
      // child, so a transitive cycle or diamond is pruned.
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
    if (element instanceof LinkedChildItem) {
      // A linked child's single parent is the PARENT CHAT-MEMBER occurrence (the
      // parent chat where it nests), NOT a folder. Recover the parent chat id from
      // the composite id by splitting on the FIRST '>' (parseLinkedChildId), then
      // resolve that parent chat's member node in its own folder home. This mirrors
      // occurrence.ts/folderTree.ts first-separator recovery and ARCHITECTURE.md's
      // one-parent-per-node rule.
      // element.child.id is the same composite the TreeItem.id carries, but is typed
      // string (TreeItem.id is string | undefined), so parse that one.
      const parsed = parseLinkedChildId(element.child.id);
      const parentChatId = parsed ? parsed.parentChatId : element.child.parentChatId;
      return this.memberNodeForChat(parentChatId);
    }
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

  // Expose the current scanned chat records (sessionId -> title/timestamp) for the
  // link commands' target pick list. Ensures a fresh snapshot first so the list
  // reflects the latest scan. Returns a NEW map so a caller cannot mutate the
  // provider's internal record cache.
  chatRecords(): Map<string, { title: string; timestamp: number | null }> {
    this.ensureSnapshot();
    const out = new Map<string, { title: string; timestamp: number | null }>();
    for (const [chatId, record] of this.recordsById) {
      out.set(chatId, { title: record.title, timestamp: record.timestamp });
    }
    return out;
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

    // Build the link forest from the stored links and the scanned chat-id set. A
    // target chat id absent from the scanned set is BROKEN (rendered muted). The
    // forest carries each child's single designated parent (smallest source chat
    // id), so a child nests under exactly one parent every render. assembleFolderTree
    // is deliberately NOT extended to carry links: folder home and link parentage are
    // orthogonal, and the link overlay is consumed here at render time.
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
    // Whether this chat is the designated parent of any linked children decides its
    // collapsible state, so it is part of the reuse identity: a cached leaf must
    // rebuild into a collapsible node (and vice versa) when its link children appear
    // or disappear, or the twistie would not update.
    const hasLinks = hasLinkedChildren(this.linkForest, record.sessionId);
    const existing = this.nodesById.get(id);
    if (
      existing instanceof ChatMemberItem &&
      canReuseChatMemberItem(existing.record, record) &&
      existing.hasLinks === hasLinks
    ) {
      return existing;
    }
    const item = new ChatMemberItem(folderId, record, hasLinks);
    this.nodesById.set(id, item);
    return item;
  }

  // Build the linkedChild nodes directly beneath a parent chat id, applying the
  // visited-set cycle/diamond prune and the depth cap via the pure model
  // (links.childrenOf). currentDepth is the parent's depth (0 for a chat-member
  // root, the child's depth for a nested linkedChild). visited is the chat-id path
  // from the root down to and including the parent, so a transitive cycle or a
  // diamond's second path is pruned. Each surviving child is memoized by its
  // composite id and decorated (branch icon, or muted when broken).
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

  // Reconstruct the chat-id path from a link-forest ROOT down to (but not including)
  // a given child chat id, by walking the single-parent inverse upward. Because each
  // child has exactly one designated parent, the ancestor path is unique and
  // deterministic, so the visited set a linkedChild expands with does not depend on
  // how VSCode happened to request the node. Bounded by a local guard set so a
  // corrupt store that somehow produced a parent-cycle in the inverse cannot loop.
  private linkPathTo(childChatId: string): Set<string> {
    const path = new Set<string>();
    let current = this.linkForest.designatedParentByChild.get(childChatId);
    while (current !== undefined && !path.has(current)) {
      path.add(current);
      current = this.linkForest.designatedParentByChild.get(current);
    }
    return path;
  }

  // Memoize a linkedChild node by its composite id. The reuse identity is the target
  // chat's title + timestamp + broken state (canReuseLinkedChildItem) AND the
  // expandable state (a child that gains/loses its own linked children must flip its
  // twistie). A broken child has no record, so title/timestamp compare as null/null
  // and the broken flag carries the change.
  private linkedChildItemFor(
    child: LinkedChild,
    parentVisited: Set<string>,
  ): LinkedChildItem {
    const record = this.recordsById.get(child.chatId);
    // Expandable only when the model permits recursion (not broken, not depth-capped,
    // not already on the path) AND the child is itself a designated parent of further
    // linked children. The visited set for the recursion check is the parent path
    // plus this child (it would be the next path), matching what getChildren computes.
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

  // True when the parent chat id has at least one direct linked child that is NOT
  // already on the given path (so expanding it would actually render a row). Without
  // this, a parent whose only linked children are all on the path (a pure cycle)
  // would render collapsible but expand to nothing; this keeps the twistie honest.
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
  // cache does not grow unbounded as folders/chats come and go. This now also tracks
  // the linkedChild composite ids alongside the folder-member ids: a linkedChild id
  // is live only when it is actually reachable in the link forest's visited-set
  // traversal (the same prune the render does), so a child removed from the links, a
  // pruned cycle path, or a depth-capped node is evicted from the cache.
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

  // Collect every linkedChild composite id reachable in the current forest, MIRRORING
  // the render: getChildren roots a link walk at EVERY chat-member node (every scanned
  // chat that is a folder member), each with its own fresh visited set of just that
  // chat. So the prune must walk from every scanned chat too, with the same per-chat
  // fresh visited set, same visited-set cycle/diamond prune, and same depth cap, or the
  // live set will not contain an id the tree actually shows. Walking only from forest
  // roots (chats that are not designated children) under-collects in a pure link cycle:
  // with B linked under A and A linked under B, both A and B are designated children,
  // so neither is a root and NO walk would run, evicting the rendered ids
  // 'A>link>B'/'B>link>A' on every refresh and breaking the memoize-by-id invariant for
  // cycle-participant rows. Redundant overlap (a subtree reached from several chat-member
  // roots) only re-adds the same ids and is harmless; under-collection is not. A broken
  // child contributes its own id (it renders) but is not recursed into.
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

// Re-export the composite-id parser so command handlers can recover an owning
// folder id from a selected chat-member node without reaching into the model.
export { parseChatNodeId };
