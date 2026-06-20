import * as vscode from 'vscode';
import { ChatRecord } from '../model/types';
import { resolveDir, scanChats, ScannerOptions } from '../claude/chatScanner';
import { relativeTime } from './relativeTime';
import { ScanPrimable } from '../commands/refreshScanCommands';
import { MetadataStore } from '../store/metadataStore';
import { buildChatTooltip, tokenBadge } from './chatTooltip';
import { resolveFolderName, resolveStarred, resolveTagLabels } from './chatMeta';

// The claudeNest.flat tree view: a single flat list of every chat for the active
// workspace, each row showing the resolved title plus a relative-time and ~token
// badge. Clicking a row fires the open-chat command, which launches Claude's URI
// handler.
//
// getChildren(undefined) returns the chats; getChildren(child) returns [] (flat,
// no nesting). It never throws out of getChildren: a failed scan yields []. The
// empty state is handled by the viewsWelcome contribution in package.json.
//
// Slice 1 gave this view the same MetadataStore dependency FoldersProvider and
// TagsProvider already carry, so the flat-view hover card renders the SAME binding
// UI-SPEC card (folder + full tag set, not a degraded subset). The card content is
// built by the vscode-free buildChatTooltip from plain folder/tag values the
// provider resolves at the row's call site (DECISIONS.md 2026-06-19 Slice 1).

export const OPEN_CHAT_COMMAND = 'claudeNest.openChat';

export class FlatChatItem extends vscode.TreeItem {
  constructor(
    public readonly record: ChatRecord,
    folderName: string | null | undefined,
    tags: readonly string[],
    starred = false,
  ) {
    super(record.title, vscode.TreeItemCollapsibleState.None);
    this.id = record.sessionId;
    this.description = rowDescription(record);
    this.tooltip = new vscode.MarkdownString(buildChatTooltip(record, folderName, tags));
    this.contextValue = 'claudeNest.chat';
    // A starred chat swaps the chat icon for the star so the curation state is
    // visible on every primary surface, not only after the chat is archived
    // (matching the Archive view's star-full badge). ThemeIcon cannot composite two
    // glyphs, so the star replaces the default comment-discussion icon.
    this.iconPath = new vscode.ThemeIcon(starred ? 'star-full' : 'comment-discussion');
    this.command = {
      command: OPEN_CHAT_COMMAND,
      title: 'Open Chat',
      arguments: [record.sessionId],
    };
  }
}

export class FlatProvider implements vscode.TreeDataProvider<FlatChatItem>, ScanPrimable {
  private readonly emitter = new vscode.EventEmitter<FlatChatItem | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  // Memoize node objects by id so VSCode's reference-based element cache keeps
  // reveal and selection stable across refreshes (binding rule). A refresh
  // rebuilds only the records, reusing the existing FlatChatItem for an
  // unchanged id. The reuse identity now also covers the hover-card inputs
  // (folder name + tag labels) so a curation change (a re-file or a tag edit)
  // rebuilds the node and its tooltip, while an unchanged row keeps its object.
  private readonly nodesById = new Map<string, FlatChatItem>();
  private readonly reuseKeyById = new Map<string, string>();

  // The memoized scan snapshot, rebuilt lazily on the next getChildren after a
  // refresh (mirrors the other three providers' ensureSnapshot lazy-load). A
  // null snapshot means "rescan on next read"; a primeSnapshot under progress sets
  // it so the passive getChildren reads the primed records without rescanning.
  private records: ChatRecord[] | null = null;

  constructor(
    private readonly workspacePath: string | undefined,
    private readonly store: MetadataStore,
    private readonly options: ScannerOptions = {},
  ) {}

  // Resolve the encoded project key (the on-disk projects directory name) for the
  // active workspace ON DEMAND, mirroring FoldersProvider/TagsProvider, so the
  // hover card's folder/tag lookup recovers once Claude Code creates the project
  // dir without a window reload. Returns undefined when there is no workspace or
  // no dir yet.
  resolveProjectKey(): string | undefined {
    if (this.workspacePath === undefined) {
      return undefined;
    }
    return resolveDir(this.workspacePath, this.options) ?? undefined;
  }

  refresh(): void {
    this.records = null;
    this.emitter.fire();
  }

  // ScanPrimable: prime the snapshot under an explicit progress-wrapped scan
  // (refreshScanCommands.refreshWithProgress). The supplied scanOptions carry the
  // onProgress/shouldCancel callbacks; this rebuilds the records once with them and
  // fires the change event so the passive getChildren reads the primed snapshot.
  primeSnapshot(scanOptions: ScannerOptions): void {
    this.records = this.scan(scanOptions);
    this.emitter.fire();
  }

  getTreeItem(element: FlatChatItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: FlatChatItem): FlatChatItem[] {
    if (element !== undefined) {
      return [];
    }
    if (this.workspacePath === undefined) {
      return [];
    }
    const records = this.ensureSnapshot();
    // Resolve the project's curation document ONCE per render so each row's hover
    // card can show its real folder name and full tag set. The store read is
    // tolerant: an unresolved project key (no dir yet) leaves folder/tags empty and
    // the card renders "Unfiled"/"none" rather than throwing.
    const projectKey = this.resolveProjectKey();
    const meta = projectKey !== undefined ? this.store.getProjectMeta(projectKey) : undefined;
    const seen = new Set<string>();
    const items: FlatChatItem[] = [];
    for (const record of records) {
      seen.add(record.sessionId);
      const folderName = resolveFolderName(meta, record.sessionId);
      const tags = resolveTagLabels(meta, record.sessionId);
      const starred = resolveStarred(meta, record.sessionId);
      const reuseKey = nodeReuseKey(record, folderName, tags, starred);
      const existing = this.nodesById.get(record.sessionId);
      if (existing !== undefined && this.reuseKeyById.get(record.sessionId) === reuseKey) {
        items.push(existing);
      } else {
        const node = new FlatChatItem(record, folderName, tags, starred);
        this.nodesById.set(record.sessionId, node);
        this.reuseKeyById.set(record.sessionId, reuseKey);
        items.push(node);
      }
    }
    // Drop memoized nodes that no longer correspond to a record.
    for (const id of Array.from(this.nodesById.keys())) {
      if (!seen.has(id)) {
        this.nodesById.delete(id);
        this.reuseKeyById.delete(id);
      }
    }
    return items;
  }

  // Build (or reuse) the memoized scan snapshot. Returns [] when there is no
  // workspace; never throws (a failed scan renders empty). Lazy per the slice fit
  // patch: the scan runs on demand and memoizes until the next refresh.
  private ensureSnapshot(): ChatRecord[] {
    if (this.records !== null) {
      return this.records;
    }
    this.records = this.scan(this.options);
    return this.records;
  }

  // Scan with the given options, tolerating a failed scan as an empty result so
  // getChildren never throws (binding rule: never throw out of getChildren).
  private scan(scanOptions: ScannerOptions): ChatRecord[] {
    if (this.workspacePath === undefined) {
      return [];
    }
    try {
      return scanChats(this.workspacePath, { ...this.options, ...scanOptions });
    } catch {
      return [];
    }
  }
}

// The row description: the relative time, plus the ~token badge when usage was
// recorded. Both come from the tier-A summary on the snapshot record (no body
// read). A usage-less chat shows only the relative time.
function rowDescription(record: ChatRecord): string {
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

// A stable string capturing everything that affects a row's rendered description
// and hover card, so the memoization rebuilds the node (and its tooltip) when any
// of it changes and reuses the object otherwise. Includes the token total because
// a later scan can change it, and the folder/tag inputs because curation can.
function nodeReuseKey(
  record: ChatRecord,
  folderName: string | null | undefined,
  tags: readonly string[],
  starred: boolean,
): string {
  const t = record.tokenTotals;
  const total = t.input + t.output + t.cacheCreation + t.cacheRead;
  return [
    record.title,
    String(record.timestamp),
    String(total),
    folderName ?? '',
    tags.join(''),
    starred ? 's' : '-',
  ].join(' ');
}
