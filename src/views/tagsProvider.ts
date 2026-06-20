import * as vscode from 'vscode';
import { ChatRecord } from '../model/types';
import { resolveDir, scanChats, ScannerOptions } from '../claude/chatScanner';
import { relativeTime } from './relativeTime';
import { MetadataStore } from '../store/metadataStore';
import {
  ChatOccurrence,
  canReuseOccurrenceItem,
  memoizeById,
  parseTagOccurrenceId,
} from '../model/occurrence';
import {
  AssembledTagsTree,
  TagNode,
  assembleTagsTree,
  isUntaggedId,
} from '../model/untagged';
import { OPEN_CHAT_COMMAND } from './flatProvider';
import { ScanPrimable } from '../commands/refreshScanCommands';
import { ProjectMeta } from '../store/schema';
import { buildChatTooltip, tokenBadge } from './chatTooltip';
import { resolveFolderName, resolveStarred, resolveTagLabels } from './chatMeta';

// The claudeNest.tags tree: the MANY-TO-MANY tag membership. A chat appears once
// under EACH tag it is assigned to (and once under the synthetic Untagged bucket
// when its effective tag set is empty). Each appearance is a distinct occurrence
// node whose id is the composite `${tagId}:${chatId}`, every one dereferencing the
// ONE shared ChatRecord resolved from a records map.
//
// Binding rules honored (ARCHITECTURE.md "Tree and VSCode API binding rules"):
// - Composite ids: a tag node id is the separator-free tag id (or the
//   '__untagged__' sentinel); an occurrence node id is `${tagId}:${chatId}`,
//   unique tree-wide because the (tagId, chatId) pair is unique.
// - Memoize node objects by id across refreshes: a refresh recomputes the
//   assembly (and the Untagged membership) but reuses the existing node object
//   for an unchanged id, so VSCode's reference-keyed element cache keeps reveal
//   and selection stable.
// - getParent returns EXACTLY one parent: an occurrence node's parent is its one
//   owning tag (recovered from the FIRST ':' of its composite id); a tag node has
//   no parent. The Tags view reveals a specific OCCURRENCE only; the chat's
//   single-home reveal-by-chat target is the Folders view (ARCHITECTURE.md line
//   102), so this provider deliberately exposes NO memberNodeForChat-style reveal.
// - getChildren(undefined) returns [] when there are no sessions; never throws out
//   of getChildren. The viewsWelcome contribution shows the no-sessions message.

// The kinds of node the Tags tree renders.
export type TagTreeNode = TagItem | ChatOccurrenceItem;

// A tag row (a real stored tag or the synthetic Untagged bucket).
export class TagItem extends vscode.TreeItem {
  // The tag's plain label, retained for cheap memoization comparison.
  public readonly tagLabel: string;

  constructor(
    public readonly tagId: string,
    label: string,
    synthetic: boolean,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.tagLabel = label;
    this.id = tagId;
    this.iconPath = new vscode.ThemeIcon(synthetic ? 'circle-slash' : 'tag');
    // contextValue drives the per-row menu: real tags get delete; the synthetic
    // Untagged bucket gets no mutations.
    this.contextValue = synthetic ? 'claudeNest.untagged' : 'claudeNest.tag';
  }
}

// A chat occurrence under a tag. Its id is the composite `${tagId}:${chatId}`. The
// wrapper holds the occurrence (two ids) and the shared ChatRecord it dereferences;
// the record object is shared across every occurrence of the same chat.
export class ChatOccurrenceItem extends vscode.TreeItem {
  // The folder name and tag-label signature the hover card was built from, used by
  // the provider's reuse check so a re-file or tag edit rebuilds the node and its
  // tooltip. Set by the provider right after construction.
  public cardFolderName: string | null | undefined = undefined;
  public cardTagsSignature = '';
  // The starred flag the row icon was built from, used by the provider's reuse
  // check so a star toggle rebuilds the node and re-renders its badge.
  public cardStarred = false;

  constructor(
    public readonly occurrence: ChatOccurrence,
    public readonly record: ChatRecord,
    folderName: string | null | undefined = undefined,
    tags: readonly string[] = [],
    starred = false,
  ) {
    super(record.title, vscode.TreeItemCollapsibleState.None);
    this.id = occurrence.id;
    this.description = chatRowDescription(record);
    // The rich slice-1 hover card built to the binding UI-SPEC. The Tags view
    // shows EACH occurrence of a chat, so every occurrence's card lists the chat's
    // FULL tag set (not just the tag under which this occurrence renders), matching
    // the spec's "full tag set" card field. folderName/tags are resolved by the
    // provider from the meta it already reads; buildChatTooltip stays vscode-free.
    this.tooltip = new vscode.MarkdownString(buildChatTooltip(record, folderName, tags));
    this.contextValue = 'claudeNest.tagChat';
    // A starred chat swaps the chat icon for the star so the curation state is
    // visible here too, not only after the chat is archived (matching the Archive
    // and flat views). ThemeIcon cannot composite glyphs, so the star replaces the
    // default comment-discussion icon.
    this.iconPath = new vscode.ThemeIcon(starred ? 'star-full' : 'comment-discussion');
    this.command = {
      command: OPEN_CHAT_COMMAND,
      title: 'Open Chat',
      arguments: [record.sessionId],
    };
  }
}

export class TagsProvider implements vscode.TreeDataProvider<TagTreeNode>, ScanPrimable {
  private readonly emitter = new vscode.EventEmitter<TagTreeNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  // Memoized node objects by tree-wide-unique id (tag id, or `${tagId}:${chatId}`).
  // Reused across refreshes so VSCode's reference-keyed element cache keeps reveal
  // and selection stable (ARCHITECTURE.md "Memoize node objects by id").
  private readonly nodesById = new Map<string, TagTreeNode>();

  // A transient per-rebuild scan-options overlay (onProgress/shouldCancel) used by
  // the next ensureSnapshot ONLY; set by primeSnapshot under a progress-wrapped
  // scan then cleared, so the passive getChildren/getParent path scans plainly.
  private scanOverlay: ScannerOptions | null = null;

  // The latest assembled tree, kept so getParent and getChildren read a single
  // consistent snapshot per refresh cycle rather than re-scanning per call.
  private assembled: AssembledTagsTree | null = null;
  // sessionId -> ChatRecord for the latest scan, so an occurrence node can
  // dereference the ONE shared record by its chatId.
  private recordsById = new Map<string, ChatRecord>();
  // The latest project curation document for the current snapshot, retained so an
  // occurrence node can resolve the chat's folder name and FULL tag set for the
  // hover card without a second store read. Null until the first ensureSnapshot.
  private currentMeta: ProjectMeta | null = null;

  constructor(
    private readonly workspacePath: string | undefined,
    private readonly store: MetadataStore,
    private readonly options: ScannerOptions = {},
  ) {}

  // Resolve the encoded project key ON DEMAND (mirroring FoldersProvider), so the
  // view and its commands recover once Claude Code creates the project dir without
  // a window reload. Returns undefined when there is no workspace or no dir yet.
  resolveProjectKey(): string | undefined {
    if (this.workspacePath === undefined) {
      return undefined;
    }
    return resolveDir(this.workspacePath, this.options) ?? undefined;
  }

  // Fire a refresh. A targeted node refreshes that subtree; undefined refreshes
  // the whole tree. The snapshot (and the recomputed Untagged membership) is
  // rebuilt lazily on the next getChildren.
  refresh(node?: TagTreeNode): void {
    this.assembled = null;
    this.emitter.fire(node);
  }

  // ScanPrimable: prime the snapshot under an explicit progress-wrapped scan. Set
  // the one-shot scan overlay, force a fresh ensureSnapshot, clear the overlay,
  // then fire the change event so the passive getChildren reads the primed snapshot.
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

  getTreeItem(element: TagTreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TagTreeNode): TagTreeNode[] {
    const tree = this.ensureSnapshot();
    if (tree === null) {
      return [];
    }
    if (element === undefined) {
      // Top level: real tag rows, then the Untagged bucket last.
      const rows = tree.tags.map((node) => this.tagItemFor(node));
      rows.push(this.tagItemFor(tree.untagged));
      return rows;
    }
    if (element instanceof ChatOccurrenceItem) {
      return [];
    }
    // A tag row: its occurrence nodes, newest chat first.
    const node = this.findTagNode(element.tagId);
    if (node === null) {
      return [];
    }
    const children: TagTreeNode[] = [];
    for (const occurrence of this.sortedOccurrences(node.occurrences)) {
      const record = this.recordsById.get(occurrence.chatId);
      if (record !== undefined) {
        children.push(this.occurrenceItemFor(occurrence, record));
      }
    }
    return children;
  }

  // getParent returns the SINGLE parent of a node (ARCHITECTURE.md line 100). An
  // occurrence node's parent is its ONE owning tag (recovered from the first ':'
  // of its composite id, so even a many-to-many chat resolves to exactly the tag
  // under which THIS occurrence renders); a tag node has no parent.
  getParent(element: TagTreeNode): TagTreeNode | undefined {
    this.ensureSnapshot();
    if (element instanceof ChatOccurrenceItem) {
      // The owning tag id is carried on the occurrence; the composite-id parser is
      // the authoritative recovery and a defensive cross-check.
      const parsed = parseTagOccurrenceId(element.occurrence.id);
      const owningTagId = parsed ? parsed.tagId : element.occurrence.tagId;
      const node = this.findTagNode(owningTagId);
      return node ? this.tagItemFor(node) : undefined;
    }
    // A tag row is a top-level node.
    return undefined;
  }

  // ---- Snapshot + memoization internals ----

  // Build (or reuse) the current snapshot: scan the chats, read the stored tags and
  // per-chat tag lists, and assemble the many-to-many tree (recomputing Untagged).
  // Returns null only when there is no workspace/project (the empty state). Never
  // throws.
  private ensureSnapshot(): AssembledTagsTree | null {
    if (this.assembled !== null) {
      return this.assembled;
    }
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
    const chatTags: { [chatId: string]: string[] | undefined } = {};
    for (const record of records) {
      const chatMeta = meta.chats[record.sessionId];
      chatTags[record.sessionId] = chatMeta ? chatMeta.tags : undefined;
    }

    const tree = assembleTagsTree({ tags: meta.tags, chatTags });

    this.assembled = tree;
    this.pruneMemoized(tree);
    return tree;
  }

  private tagItemFor(node: TagNode): TagItem {
    return memoizeById(
      this.nodesById,
      node.id,
      (cached) => cached instanceof TagItem && cached.tagLabel === node.label,
      () => new TagItem(node.id, node.label, node.synthetic),
    ) as TagItem;
  }

  private occurrenceItemFor(
    occurrence: ChatOccurrence,
    record: ChatRecord,
  ): ChatOccurrenceItem {
    // Resolve the chat's folder name and FULL tag set for the hover card from the
    // current meta. These feed the tooltip, so a curation change rebuilds the node;
    // tagsSignature captures the resolved labels for the reuse check.
    const meta = this.currentMeta ?? undefined;
    const folderName = resolveFolderName(meta, record.sessionId);
    const tags = resolveTagLabels(meta, record.sessionId);
    const tagsSignature = tags.join(' ');
    const starred = resolveStarred(meta, record.sessionId);
    return memoizeById(
      this.nodesById,
      occurrence.id,
      (cached) =>
        cached instanceof ChatOccurrenceItem &&
        canReuseOccurrenceItem(cached.record, record) &&
        cached.cardFolderName === folderName &&
        cached.cardTagsSignature === tagsSignature &&
        cached.cardStarred === starred,
      () => {
        const item = new ChatOccurrenceItem(occurrence, record, folderName, tags, starred);
        item.cardFolderName = folderName;
        item.cardTagsSignature = tagsSignature;
        item.cardStarred = starred;
        return item;
      },
    ) as ChatOccurrenceItem;
  }

  private findTagNode(tagId: string): TagNode | null {
    if (this.assembled === null) {
      return null;
    }
    if (isUntaggedId(tagId)) {
      return this.assembled.untagged;
    }
    for (const node of this.assembled.tags) {
      if (node.id === tagId) {
        return node;
      }
    }
    return null;
  }

  // Sort a tag's occurrences newest-chat-first (no timestamp sorts last), matching
  // the flat and folders views. The pure model leaves chat order to the view
  // because timestamps live outside it.
  private sortedOccurrences(occurrences: ChatOccurrence[]): ChatOccurrence[] {
    return [...occurrences].sort((a, b) => {
      const ta = this.recordsById.get(a.chatId)?.timestamp ?? 0;
      const tb = this.recordsById.get(b.chatId)?.timestamp ?? 0;
      return tb - ta;
    });
  }

  // Drop memoized nodes whose id is no longer present in the current tree, so the
  // cache does not grow unbounded as tags/chats come and go.
  private pruneMemoized(tree: AssembledTagsTree): void {
    const live = new Set<string>();
    for (const node of tree.tags) {
      this.collectLiveIdsForNode(node, live);
    }
    this.collectLiveIdsForNode(tree.untagged, live);
    for (const id of Array.from(this.nodesById.keys())) {
      if (!live.has(id)) {
        this.nodesById.delete(id);
      }
    }
  }

  private collectLiveIdsForNode(node: TagNode, into: Set<string>): void {
    into.add(node.id);
    for (const occurrence of node.occurrences) {
      // Use the occurrence's own canonical composite id (the same value the node
      // is memoized under) so the live set can never drift from the cache keys.
      if (this.recordsById.has(occurrence.chatId)) {
        into.add(occurrence.id);
      }
    }
  }
}

// An occurrence row's description: relative time plus the ~token badge (from the
// tier-A token totals on the snapshot record; no body read). Matches the flat and
// folders views so every surface reads identically.
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
