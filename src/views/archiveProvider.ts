import * as vscode from 'vscode';
import { ChatRecord } from '../model/types';
import { resolveDir, scanChats, ScannerOptions } from '../claude/chatScanner';
import { relativeTime } from './relativeTime';
import { MetadataStore } from '../store/metadataStore';
import { ScanPrimable } from '../commands/refreshScanCommands';
import { ProjectMeta } from '../store/schema';
import { OPEN_CHAT_COMMAND } from './flatProvider';

// The claudeNest.archive tree (Slice 4 s2-star-archive): a flat, read-mostly list
// of the chats the user has ARCHIVED. Archive and Restore are COMMANDS, not drops,
// so this view registers WITHOUT a dragAndDropController (matching the smartGroups
// read-only view registration shape).
//
// NAMING-COLLISION GUARD (slice patch, highest value): this view lists chats by
// the SYNCED curation flag ChatMeta.userArchived === true, read from
// store.getProjectMeta(projectKey).chats[id].userArchived. It MUST NEVER read the
// local-only orphan-reconcile LocalChatState.archived (schema.ts:125-129), which
// is a DIFFERENT, NON-synced flag on the separate nest.local.v1 document, driven by
// a chat going missing on disk (DECISIONS.md 2026-06-15). Conflating the two would
// either surface orphaned-on-disk chats here (wrong: those are not user choices) or
// fail to surface user-archived ones. The two flags are deliberately distinct
// (schema.ts:80-96): userArchived is a deliberate, synced curation choice;
// LocalChatState.archived is missing-on-disk machinery. This provider reads
// userArchived ONLY.
//
// SURVIVES CLEANUP: an archived chat's underlying transcript may be deleted out of
// band by Claude's cleanup (that is exactly why archive keeps a Nest-owned body
// copy). So this view lists the archived chatIds from the SYNCED meta, not from the
// scan: a chat whose transcript is gone still appears here. When the scan still has
// the record, the row shows its resolved title and ~time and an Open command; when
// the transcript is gone, the row falls back to the stored title (or the sessionId)
// with no Open command, since there is nothing left for Claude's URI handler to
// open. getChildren/getParent stay SYNCHRONOUS on the memoized snapshot (the
// binding rule), so the title fallback comes from an injected, async-populated map
// rather than an in-getChildren await.
//
// Binding rules honored (ARCHITECTURE.md "Tree and VSCode API binding rules"):
// - getChildren(undefined) returns [] (never throws) when there is no project; a
//   viewsWelcome entry shows the empty state.
// - Memoize node objects by id across refreshes so reveal/selection stay stable.
// - Resolve the project key ON DEMAND via resolveProjectKey (mirrors the other
//   providers) so the view recovers once Claude Code creates the project dir.

export class ArchivedChatItem extends vscode.TreeItem {
  constructor(
    // The shared ChatRecord when the transcript is still present, else undefined
    // (the transcript was cleaned up but the chat stays archived). Command handlers
    // recover the sessionId from .sessionId regardless.
    public readonly record: ChatRecord | undefined,
    public readonly sessionId: string,
    title: string,
    starred: boolean,
    present: boolean,
  ) {
    super(title, vscode.TreeItemCollapsibleState.None);
    this.id = sessionId;
    this.contextValue = 'claudeNest.archivedChat';
    // A star badge marks a chat exempt from the keep-window prune. A missing
    // transcript is marked muted so the user reads it as "archived copy only".
    this.iconPath = new vscode.ThemeIcon(starred ? 'star-full' : 'archive');
    this.description = archivedRowDescription(record, present);
    // Only offer Open when the transcript is still on disk; a cleaned-up chat has
    // nothing for Claude's URI handler to open, so the row is non-clickable.
    if (present && record !== undefined) {
      this.command = {
        command: OPEN_CHAT_COMMAND,
        title: 'Open Chat',
        arguments: [record.sessionId],
      };
    }
  }
}

export class ArchiveProvider implements vscode.TreeDataProvider<ArchivedChatItem>, ScanPrimable {
  private readonly emitter = new vscode.EventEmitter<ArchivedChatItem | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private scanOverlay: ScannerOptions | null = null;

  // Memoized node objects by sessionId (the row id), reused across refreshes so
  // VSCode's reference-keyed element cache keeps reveal/selection stable.
  private readonly nodesById = new Map<string, ArchivedChatItem>();
  private readonly reuseKeyById = new Map<string, string>();

  // The latest snapshot: the archived chatIds (with their starred flag) read from
  // the SYNCED meta, plus the scan records by id for title/time of present chats.
  // null until the first ensureSnapshot. recordsById only holds chats whose
  // transcript still exists; archivedById is the authoritative membership.
  private archivedById: Map<string, { starred: boolean }> | null = null;
  private recordsById = new Map<string, ChatRecord>();

  // Injected fallback titles for archived chats whose transcript is gone, keyed by
  // sessionId, populated asynchronously from the Nest-owned body copy's stored
  // title (archiveBodyStore) by the extension wiring. getChildren stays synchronous;
  // it reads this map (empty until the async populate completes), falling back to
  // the sessionId when no title is known yet. setFallbackTitles refreshes the view
  // once the titles are loaded so a missing-transcript row upgrades from the raw id.
  private fallbackTitles = new Map<string, string>();

  constructor(
    private readonly workspacePath: string | undefined,
    private readonly store: MetadataStore,
    private readonly options: ScannerOptions = {},
  ) {}

  resolveProjectKey(): string | undefined {
    if (this.workspacePath === undefined) {
      return undefined;
    }
    return resolveDir(this.workspacePath, this.options) ?? undefined;
  }

  refresh(): void {
    this.archivedById = null;
    this.emitter.fire();
  }

  // Supply fallback titles for missing-transcript archived chats (from the body
  // copies). Merged into the map and a refresh fired so the rows upgrade from the
  // bare sessionId. Tolerant: an empty map is a no-op refresh.
  setFallbackTitles(titles: Map<string, string>): void {
    this.fallbackTitles = new Map(titles);
    this.refresh();
  }

  // The set of currently-archived sessionIds (for the wiring to know which body
  // copies' titles to load). Ensures a snapshot first. Returns a NEW array.
  archivedSessionIds(): string[] {
    this.ensureSnapshot();
    return this.archivedById === null ? [] : Array.from(this.archivedById.keys());
  }

  primeSnapshot(scanOptions: ScannerOptions): void {
    this.scanOverlay = scanOptions;
    this.archivedById = null;
    try {
      this.ensureSnapshot();
    } finally {
      this.scanOverlay = null;
    }
    this.emitter.fire();
  }

  getTreeItem(element: ArchivedChatItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ArchivedChatItem): ArchivedChatItem[] {
    // Flat list: a child has no children, and the top level is the archived chats.
    if (element !== undefined) {
      return [];
    }
    this.ensureSnapshot();
    if (this.archivedById === null) {
      return [];
    }
    const ids = Array.from(this.archivedById.keys());
    // Newest-first when a record is present (by timestamp); a missing-transcript
    // chat (no record) sorts after the present ones, then by sessionId for a stable
    // order.
    ids.sort((a, b) => {
      const ta = this.recordsById.get(a)?.timestamp ?? null;
      const tb = this.recordsById.get(b)?.timestamp ?? null;
      if (ta === null && tb === null) {
        return a < b ? -1 : a > b ? 1 : 0;
      }
      if (ta === null) {
        return 1;
      }
      if (tb === null) {
        return -1;
      }
      return tb - ta;
    });
    return ids.map((id) => this.itemFor(id));
  }

  // A flat view: every archived chat's single parent is the root, so getParent
  // returns undefined (reveal targets the root list).
  getParent(): ArchivedChatItem | undefined {
    return undefined;
  }

  // Resolve a sessionId to its memoized archived-chat node, for reveal.
  itemForSession(sessionId: string): ArchivedChatItem | undefined {
    this.ensureSnapshot();
    if (this.archivedById === null || !this.archivedById.has(sessionId)) {
      return undefined;
    }
    return this.itemFor(sessionId);
  }

  // Build (or reuse) the snapshot: scan the chats (read-only) for titles/times of
  // present chats, read the SYNCED meta ONCE, and collect every chat whose
  // userArchived === true (the NAMING-COLLISION GUARD: synced flag, NOT the orphan
  // flag). Returns silently with an empty snapshot when there is no project. Never
  // throws.
  private ensureSnapshot(): void {
    if (this.archivedById !== null) {
      return;
    }
    const projectKey = this.resolveProjectKey();
    if (this.workspacePath === undefined || projectKey === undefined) {
      this.archivedById = new Map();
      this.recordsById = new Map();
      return;
    }
    let records: ChatRecord[];
    try {
      records = scanChats(this.workspacePath, { ...this.options, ...this.scanOverlay });
    } catch {
      records = [];
    }
    this.recordsById = new Map(records.map((r) => [r.sessionId, r]));

    const meta: ProjectMeta = this.store.getProjectMeta(projectKey);
    const archived = new Map<string, { starred: boolean }>();
    for (const [chatId, chatMeta] of Object.entries(meta.chats)) {
      // SYNCED userArchived ONLY. LocalChatState.archived is never consulted here.
      if (chatMeta.userArchived === true) {
        archived.set(chatId, { starred: chatMeta.starred === true });
      }
    }
    this.archivedById = archived;
    this.pruneMemoized(archived);
  }

  private itemFor(sessionId: string): ArchivedChatItem {
    const record = this.recordsById.get(sessionId);
    const present = record !== undefined;
    const starred = this.archivedById?.get(sessionId)?.starred === true;
    const title = record !== undefined
      ? record.title
      : this.fallbackTitles.get(sessionId) ?? sessionId;
    const reuseKey = [
      title,
      String(record?.timestamp ?? 'gone'),
      present ? '1' : '0',
      starred ? 's' : '-',
    ].join(' ');
    const existing = this.nodesById.get(sessionId);
    if (existing !== undefined && this.reuseKeyById.get(sessionId) === reuseKey) {
      return existing;
    }
    const item = new ArchivedChatItem(record, sessionId, title, starred, present);
    this.nodesById.set(sessionId, item);
    this.reuseKeyById.set(sessionId, reuseKey);
    return item;
  }

  private pruneMemoized(archived: Map<string, { starred: boolean }>): void {
    for (const id of Array.from(this.nodesById.keys())) {
      if (!archived.has(id)) {
        this.nodesById.delete(id);
        this.reuseKeyById.delete(id);
      }
    }
  }
}

// An archived row's description: relative time when the transcript is present, or a
// "copy only" marker when the transcript has been cleaned up (so the user reads the
// row as backed only by the Nest-owned copy).
function archivedRowDescription(record: ChatRecord | undefined, present: boolean): string {
  if (!present || record === undefined) {
    return 'copy only';
  }
  return relativeTime(record.timestamp);
}
