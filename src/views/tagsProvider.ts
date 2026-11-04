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
import { OPEN_CHAT_COMMAND } from '../launch/uriLauncher';
import { ScanPrimable } from '../commands/refreshScanCommands';
import { ProjectMeta } from '../store/schema';
import { buildChatTooltip, tokenBadge } from './chatTooltip';
import { resolveFolderName, resolveStarred, resolveTagLabels } from './chatMeta';

// The claudeNest.tags tree. A chat appears under each of its tags, or under the Untagged
// bucket when it has none. Occurrence ids are `${tagId}:${chatId}`, unique tree-wide, and
// every occurrence shares one ChatRecord. Node objects are memoized by id so the tree
// view's reference-keyed cache keeps reveal and selection stable across refreshes.
// Reveal targets an occurrence only; reveal-by-chat belongs to the Folders view.

export type TagTreeNode = TagItem | ChatOccurrenceItem;

// A tag row (a real stored tag or the synthetic Untagged bucket).
export class TagItem extends vscode.TreeItem {
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
    // Real tags get delete; the Untagged bucket gets no mutations.
    this.contextValue = synthetic ? 'claudeNest.untagged' : 'claudeNest.tag';
  }
}

// A chat occurrence under a tag; the record is shared across all occurrences of the chat.
export class ChatOccurrenceItem extends vscode.TreeItem {
  // What the hover card was built from, so the reuse check rebuilds on a re-file or tag edit.
  public cardFolderName: string | null | undefined = undefined;
  public cardTagsSignature = '';
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
    // Every occurrence's card lists the chat's full tag set, not just its own tag.
    this.tooltip = new vscode.MarkdownString(buildChatTooltip(record, folderName, tags));
    this.contextValue = 'claudeNest.tagChat';
    // ThemeIcon cannot composite glyphs, so the star replaces the chat icon.
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

  // Memoized nodes by id; see the header.
  private readonly nodesById = new Map<string, TagTreeNode>();

  // Progress and cancel hooks for one primed scan only, so passive reads scan plainly.
  private scanOverlay: ScannerOptions | null = null;

  // One snapshot per refresh cycle, so getParent and getChildren do not re-scan.
  private assembled: AssembledTagsTree | null = null;
  private recordsById = new Map<string, ChatRecord>();
  // Kept so hover cards resolve folder and tags without a second store read.
  private currentMeta: ProjectMeta | null = null;

  constructor(
    private readonly workspacePath: string | undefined,
    private readonly store: MetadataStore,
    private readonly options: ScannerOptions = {},
  ) {}

  // Resolved on demand so the view recovers once Claude Code creates the project dir,
  // without a window reload.
  resolveProjectKey(): string | undefined {
    if (this.workspacePath === undefined) {
      return undefined;
    }
    return resolveDir(this.workspacePath, this.options) ?? undefined;
  }

  // The snapshot is rebuilt lazily on the next getChildren.
  refresh(node?: TagTreeNode): void {
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

  getTreeItem(element: TagTreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TagTreeNode): TagTreeNode[] {
    const tree = this.ensureSnapshot();
    if (tree === null) {
      return [];
    }
    if (element === undefined) {
      const rows = tree.tags.map((node) => this.tagItemFor(node));
      rows.push(this.tagItemFor(tree.untagged));
      return rows;
    }
    if (element instanceof ChatOccurrenceItem) {
      return [];
    }
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

  // An occurrence's parent is the tag it renders under, recovered from its composite id.
  getParent(element: TagTreeNode): TagTreeNode | undefined {
    this.ensureSnapshot();
    if (element instanceof ChatOccurrenceItem) {
      const parsed = parseTagOccurrenceId(element.occurrence.id);
      const owningTagId = parsed ? parsed.tagId : element.occurrence.tagId;
      const node = this.findTagNode(owningTagId);
      return node ? this.tagItemFor(node) : undefined;
    }
    return undefined;
  }

  // Returns null only when there is no workspace or project dir. Scan errors yield an empty list.
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
    // These feed the tooltip, so the reuse check compares them to rebuild on a curation change.
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

  // Newest first, no timestamp last, matching the Folders view.
  private sortedOccurrences(occurrences: ChatOccurrence[]): ChatOccurrence[] {
    return [...occurrences].sort((a, b) => {
      const ta = this.recordsById.get(a.chatId)?.timestamp ?? 0;
      const tb = this.recordsById.get(b.chatId)?.timestamp ?? 0;
      return tb - ta;
    });
  }

  // Keeps the cache from growing as tags and chats come and go.
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
      // Uses the same id the node is memoized under, so live ids match the cache keys.
      if (this.recordsById.has(occurrence.chatId)) {
        into.add(occurrence.id);
      }
    }
  }
}

// Relative time plus token badge, matching the Folders rows.
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
