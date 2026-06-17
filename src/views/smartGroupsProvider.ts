import * as vscode from 'vscode';
import { ChatRecord, SmartSignalsInput } from '../model/types';
import { resolveDir, scanChats, ScannerOptions } from '../claude/chatScanner';
import { relativeTime } from './relativeTime';
import { memoizeById } from '../model/occurrence';
import { SmartBucket } from '../smart/signals/bucket';
import {
  SmartGroupNode,
  SmartGroupsTree,
  computeSmartGroups,
  smartBucketNodeId,
} from '../smart/smartGroupEngine';
import { OPEN_CHAT_COMMAND } from './flatProvider';

// The claudeNest.smartGroups tree: read-only, recomputed-on-refresh buckets over
// the four signals (PR solid; ticket, branch, fork-lineage best-effort and
// possibly empty). It NEVER mutates the store and NEVER auto-files; the only write
// is an explicit promote-to-folder / promote-to-tag command on a bucket row.
//
// Binding rules honored (ARCHITECTURE.md):
// - Synthetic group rows are keyed by separator-free reserved sentinels
//   ('__smart_*__') distinct from '__unfiled__'/'__untagged__'. Bucket rows use
//   the '<groupId>::<bucketKey>' id from the engine. Chat-occurrence rows under a
//   bucket use a composite '<bucketNodeId>::<chatId>' so the SAME chat appearing
//   in two buckets yields two distinct tree-wide-unique nodes (a chat can carry a
//   PR and a branch); the bare ChatRecord is never returned under two parents.
// - memoize node objects by id across refreshes (memoizeById), so VSCode's
//   reference-keyed element cache keeps reveal/selection stable.
// - getChildren(undefined) returns [] when there is no project; never throws out
//   of getChildren. A viewsWelcome contribution shows the empty state.
// - This is the ONLY vscode-bound module of the slice; all bucketing logic lives
//   in the vscode-free src/smart/* modules (unit-gate rule).

// The chat-row id separator under a bucket. Reuses the engine's '::' bucket
// separator so a chat row id is '<groupId>::<bucketKey>::<chatId>'; this stays in
// the smart-group '__smart_*__' namespace and is never parsed by another view.
const CHAT_ROW_SEPARATOR = '::';

export type SmartTreeNode = SmartGroupItem | SmartBucketItem | SmartChatItem;

// A signal-group row (By Pull Request / By Ticket Prefix / By Git Branch / By
// Fork Lineage). Always rendered, even with zero buckets, so an empty best-effort
// group shows as a childless row rather than vanishing.
export class SmartGroupItem extends vscode.TreeItem {
  constructor(
    public readonly groupId: string,
    label: string,
    public readonly solid: boolean,
    public readonly bucketCount: number,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = groupId;
    // Best-effort groups are marked so the user reads an empty one as expected,
    // not broken. The count rides in the description.
    this.description = bucketCount === 0
      ? (solid ? 'none' : 'best-effort, none')
      : String(bucketCount) + (bucketCount === 1 ? ' group' : ' groups');
    this.iconPath = new vscode.ThemeIcon(solid ? 'git-pull-request' : 'list-tree');
    this.contextValue = 'claudeNest.smartGroup';
  }
}

// A bucket row under a signal group (one PR, one ticket, one branch, one fork
// family). This is the promotable row: its contextValue gates the promote
// commands. It carries the bucket's member chat ids so a promote reads them
// directly without re-deriving signals.
export class SmartBucketItem extends vscode.TreeItem {
  constructor(
    public readonly groupId: string,
    public readonly bucket: SmartBucket,
  ) {
    super(bucket.label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = smartBucketNodeId(groupId, bucket.key);
    const n = bucket.memberChatIds.length;
    this.description = String(n) + (n === 1 ? ' chat' : ' chats');
    this.iconPath = new vscode.ThemeIcon('layers');
    this.contextValue = 'claudeNest.smartGroupBucket';
  }
}

// A chat occurrence under a bucket. Its id is the composite
// '<bucketNodeId>::<chatId>', tree-wide-unique because (bucketNodeId, chatId) is
// unique; it dereferences the ONE shared ChatRecord resolved from the records map.
export class SmartChatItem extends vscode.TreeItem {
  constructor(
    public readonly bucketNodeId: string,
    public readonly record: ChatRecord,
  ) {
    super(record.title, vscode.TreeItemCollapsibleState.None);
    this.id = bucketNodeId + CHAT_ROW_SEPARATOR + record.sessionId;
    this.description = relativeTime(record.timestamp);
    this.tooltip = record.title + '\n' + record.sessionId;
    this.contextValue = 'claudeNest.smartGroupChat';
    this.iconPath = new vscode.ThemeIcon('comment-discussion');
    this.command = {
      command: OPEN_CHAT_COMMAND,
      title: 'Open Chat',
      arguments: [record.sessionId],
    };
  }
}

export class SmartGroupsProvider implements vscode.TreeDataProvider<SmartTreeNode> {
  private readonly emitter = new vscode.EventEmitter<SmartTreeNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  // Memoized node objects by tree-wide-unique id, reused across refreshes so
  // VSCode's reference-keyed element cache keeps reveal/selection stable.
  private readonly nodesById = new Map<string, SmartTreeNode>();

  // The latest recomputed tree, kept so getChildren reads one consistent snapshot
  // per refresh rather than re-scanning per call.
  private tree: SmartGroupsTree | null = null;
  // sessionId -> ChatRecord for the latest scan, so a chat row dereferences the
  // ONE shared record by its chatId.
  private recordsById = new Map<string, ChatRecord>();

  constructor(
    private readonly workspacePath: string | undefined,
    private readonly options: ScannerOptions = {},
  ) {}

  // Resolve the encoded project key ON DEMAND (mirroring the other providers), so
  // the view recovers once Claude Code creates the project dir without a reload.
  resolveProjectKey(): string | undefined {
    if (this.workspacePath === undefined) {
      return undefined;
    }
    return resolveDir(this.workspacePath, this.options) ?? undefined;
  }

  // Fire a refresh. The snapshot (and recomputed buckets) is rebuilt lazily on the
  // next getChildren. A promote refreshes this view so a freshly created folder/tag
  // does not change the read-only buckets, but the description counts stay live.
  refresh(node?: SmartTreeNode): void {
    this.tree = null;
    this.emitter.fire(node);
  }

  getTreeItem(element: SmartTreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SmartTreeNode): SmartTreeNode[] {
    const tree = this.ensureSnapshot();
    if (tree === null) {
      return [];
    }
    if (element === undefined) {
      // Top level: the four signal groups in fixed order.
      return tree.groups.map((group) => this.groupItemFor(group));
    }
    if (element instanceof SmartGroupItem) {
      const group = this.findGroup(element.groupId);
      if (group === null) {
        return [];
      }
      return group.buckets.map((bucket) => this.bucketItemFor(group.id, bucket));
    }
    if (element instanceof SmartBucketItem) {
      const children: SmartTreeNode[] = [];
      for (const chatId of element.bucket.memberChatIds) {
        const record = this.recordsById.get(chatId);
        if (record !== undefined) {
          children.push(this.chatItemFor(element.id as string, record));
        }
      }
      return children;
    }
    // A chat row is a leaf.
    return [];
  }

  // ---- Snapshot + memoization internals ----

  // Build (or reuse) the current snapshot: scan the chats, derive the per-chat
  // signal inputs, and recompute the four signal groups. Returns null only when
  // there is no workspace/project (the empty state). Never throws.
  private ensureSnapshot(): SmartGroupsTree | null {
    if (this.tree !== null) {
      return this.tree;
    }
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

    const rows: SmartSignalsInput[] = records.map((r) => ({
      sessionId: r.sessionId,
      prNumber: r.prNumber,
      prUrl: r.prUrl,
      prRepository: r.prRepository,
      gitBranch: r.gitBranch,
      leadingMessageUuids: r.leadingMessageUuids,
      title: r.title,
    }));

    const tree = computeSmartGroups(rows);
    this.tree = tree;
    this.pruneMemoized(tree);
    return tree;
  }

  private groupItemFor(group: SmartGroupNode): SmartGroupItem {
    return memoizeById(
      this.nodesById,
      group.id,
      (cached) =>
        cached instanceof SmartGroupItem &&
        cached.solid === group.solid &&
        cached.bucketCount === group.buckets.length,
      () => new SmartGroupItem(group.id, group.label, group.solid, group.buckets.length),
    ) as SmartGroupItem;
  }

  private bucketItemFor(groupId: string, bucket: SmartBucket): SmartBucketItem {
    const id = smartBucketNodeId(groupId, bucket.key);
    return memoizeById(
      this.nodesById,
      id,
      (cached) =>
        cached instanceof SmartBucketItem &&
        cached.bucket.label === bucket.label &&
        sameMembers(cached.bucket.memberChatIds, bucket.memberChatIds),
      () => new SmartBucketItem(groupId, bucket),
    ) as SmartBucketItem;
  }

  private chatItemFor(bucketNodeId: string, record: ChatRecord): SmartChatItem {
    const id = bucketNodeId + CHAT_ROW_SEPARATOR + record.sessionId;
    return memoizeById(
      this.nodesById,
      id,
      (cached) =>
        cached instanceof SmartChatItem &&
        cached.record.title === record.title &&
        cached.record.timestamp === record.timestamp,
      () => new SmartChatItem(bucketNodeId, record),
    ) as SmartChatItem;
  }

  private findGroup(groupId: string): SmartGroupNode | null {
    if (this.tree === null) {
      return null;
    }
    for (const group of this.tree.groups) {
      if (group.id === groupId) {
        return group;
      }
    }
    return null;
  }

  // Drop memoized nodes whose id is no longer present in the current tree, so the
  // cache does not grow unbounded as chats/buckets come and go.
  private pruneMemoized(tree: SmartGroupsTree): void {
    const live = new Set<string>();
    for (const group of tree.groups) {
      live.add(group.id);
      for (const bucket of group.buckets) {
        const bucketNodeId = smartBucketNodeId(group.id, bucket.key);
        live.add(bucketNodeId);
        for (const chatId of bucket.memberChatIds) {
          if (this.recordsById.has(chatId)) {
            live.add(bucketNodeId + CHAT_ROW_SEPARATOR + chatId);
          }
        }
      }
    }
    for (const id of Array.from(this.nodesById.keys())) {
      if (!live.has(id)) {
        this.nodesById.delete(id);
      }
    }
  }
}

// True when two member-id lists are element-wise equal (the buckets are produced
// in a deterministic order, so a positional compare is sufficient and cheap).
function sameMembers(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}
