import * as vscode from 'vscode';
import { ChatRecord } from '../model/types';
import { scanChats, ScannerOptions } from '../claude/chatScanner';
import { relativeTime } from './relativeTime';
import { ScanPrimable } from '../commands/refreshScanCommands';

// The claudeNest.flat tree view: a single flat list of every chat for the active
// workspace, each row showing the resolved title and a relative time. Clicking a
// row fires the open-chat command, which launches Claude's URI handler.
//
// getChildren(undefined) returns the chats; getChildren(child) returns [] (flat,
// no nesting). It never throws out of getChildren: a failed scan yields []. The
// empty state is handled by the viewsWelcome contribution in package.json.

export const OPEN_CHAT_COMMAND = 'claudeNest.openChat';

export class FlatChatItem extends vscode.TreeItem {
  constructor(public readonly record: ChatRecord) {
    super(record.title, vscode.TreeItemCollapsibleState.None);
    this.id = record.sessionId;
    this.description = relativeTime(record.timestamp);
    this.tooltip = buildTooltip(record);
    this.contextValue = 'claudeNest.chat';
    this.iconPath = new vscode.ThemeIcon('comment-discussion');
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
  // unchanged id.
  private readonly nodesById = new Map<string, FlatChatItem>();

  // The memoized scan snapshot, rebuilt lazily on the next getChildren after a
  // refresh (mirrors the other three providers' ensureSnapshot lazy-load). A
  // null snapshot means "rescan on next read"; a primeSnapshot under progress sets
  // it so the passive getChildren reads the primed records without rescanning.
  private records: ChatRecord[] | null = null;

  constructor(
    private readonly workspacePath: string | undefined,
    private readonly options: ScannerOptions = {},
  ) {}

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
    const seen = new Set<string>();
    const items: FlatChatItem[] = [];
    for (const record of records) {
      seen.add(record.sessionId);
      const existing = this.nodesById.get(record.sessionId);
      if (existing !== undefined && existing.record.title === record.title &&
          existing.record.timestamp === record.timestamp) {
        items.push(existing);
      } else {
        const node = new FlatChatItem(record);
        this.nodesById.set(record.sessionId, node);
        items.push(node);
      }
    }
    // Drop memoized nodes that no longer correspond to a record.
    for (const id of Array.from(this.nodesById.keys())) {
      if (!seen.has(id)) {
        this.nodesById.delete(id);
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

function buildTooltip(record: ChatRecord): string {
  const when = record.timestamp !== null
    ? new Date(record.timestamp).toLocaleString()
    : 'no timestamp';
  return record.title + '\n' + record.sessionId + '\n' + when;
}
