import * as vscode from 'vscode';
import { ChatRecord } from '../model/types';
import { foldersToScan, mergeFolderScans, scanChats } from '../claude/chatScanner';
import type { AgentSession } from '../claude/agentsCli';
import { ChatStatus, attachableSessionIds, computeStatuses } from '../fleet/status';
import { FleetSections, buildFleetSections } from '../fleet/groupModel';
import type { QueueRow } from '../fleet/queueTable';
import { GroupBy } from '../fleet/nestConfig';
import { OPEN_LAYOUT_FILE_COMMAND } from '../commands/openLayoutFile';
import type { OrganizeReport } from '../commands/organizeCommands';
import { GROUP_BY_OVERRIDE_KEY, coerceGroupByOverride, coerceSettingsInbound } from '../fleet/groupByOverride';
import { EMPTY_FLEET_STATE, FleetState } from '../fleet/types';
import { RuleSubject, buildRuleSubjects } from '../fleet/rules';
import { INITIAL_ROBIN_MEMORY, RobinMemory, RobinOutput, buildRobinMessage, buildRobinSignals, stepRobin } from '../fleet/robinState';
import { DEFAULT_STAGE_STYLE, StageStyleConfig, buildFleetMessage, coerceSetActive } from './fleetPanel';
import { readTranscriptBodies } from '../claude/bodyReader';
import { MetadataStore } from '../store/metadataStore';
import { ProjectMeta, clampName, isSafeRecordId, isValidColor } from '../store/schema';
import { OPEN_IN_TERMINAL_COMMAND } from '../launch/attachLauncher';
import { OPEN_CHAT_COMMAND, isOpenableSessionId } from '../launch/uriLauncher';
import { PREVIEW_ARCHIVED_CHAT_COMMAND } from '../commands/previewChatCommand';
import { tokenBadge } from './chatTooltip';
import { relativeTime, relativeTimeCompact } from './relativeTime';
import { buildSections, buildArchivedRows, OrgSections, isArchived, PlacementContext, rowStatus, fleetModelChats, fleetModelFolders } from './orgPanelModel';
import { coerceAutoArchiveWindowDays } from '../store/autoArchivePolicy';
import {
  SearchDoc,
  buildIndex,
  docFromRecord,
  search as searchIndex,
  ROLE_LABEL_USER,
  ROLE_LABEL_ASSISTANT,
} from '../search/searchIndex';
import { persistTierAIndex, loadOrRebuildTierAIndex } from '../search/searchStore';
import { handleWebviewDrop, WebviewDropDeps } from '../dnd/webviewDropAdapter';

// The org panel WebviewView, the main browsing surface: section model, tag chips, sort,
// folder rename and drag-and-drop through dropReducer. The webview loads only its nonce'd
// script and the cspSource stylesheet.

export const ORG_PANEL_VIEW = 'claudeNest.orgPanel';

// Settings is an in-panel overlay, so this command reveals the panel and opens it.
export const OPEN_SETTINGS_COMMAND = 'claudeNest.openSettings';

// Bodies read between event-loop yields during the index build, so a large projects dir cannot freeze the UI.
const BODY_READ_CHUNK = 20;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface SearchRow {
  sessionId: string;
  title: string;
  description: string;
  timestamp: number | null;
  tokens: string;
  snippet: string | null;
  rank: number;
}

// Messages the webview posts to the host. Settings opens client-side as an overlay, so there is no openSettings message.
type Inbound =
  | { type: 'ready' }
  | { type: 'open'; sessionId: string }
  // Falls back to a plain open when the live session is not attachable.
  | { type: 'openInTerminal'; sessionId: string; explicit?: boolean }
  | { type: 'search'; query: string }
  | { type: 'drop'; sourceChatIds: string[]; targetKind: 'folder' | 'tag'; targetId: string | undefined }
  | { type: 'renameFolder'; folderId: string; name: string }
  | { type: 'setFolderColor'; folderId: string; color: string | null }
  | { type: 'deleteFolder'; folderId: string }
  | { type: 'createFolder'; name?: string }
  | { type: 'newSession' }
  // The host replies with 'archivedRows'; the client renders the overlay.
  | { type: 'openArchive' }
  // Clears the synced archived flag and keeps the star. Uses the existing restoreChat command, with an empty filePath when the transcript is gone.
  | { type: 'restoreChat'; sessionId: string }
  // Starring an archived chat also unarchives it, through the existing star and restore paths.
  | { type: 'starUnarchive'; sessionId: string }
  // Reads the Nest-owned body copy so a cleaned-up chat is still previewable.
  | { type: 'previewArchivedChat'; sessionId: string }
  | { type: 'toggleStar'; sessionId: string; starred: boolean }
  // `on` is the desired next state.
  | { type: 'toggleTag'; sessionId: string; tagId: string; on: boolean }
  // Creates a tag with the label and swatch color, then applies it. The color is revalidated at coerce before it reaches the store or a CSS sink.
  | { type: 'createTagWithColor'; sessionId: string; label: string; color: string | null }
  // Carries only the sessionId; the host resolves the file path from its scan cache.
  | { type: 'exportChat'; sessionId: string; format: 'markdown' | 'json' }
  // Carries only the sessionId; the host resolves the file path from its scan cache.
  | { type: 'archiveChat'; sessionId: string }
  // Persisted on workspaceState, never synced. Changing the window triggers an auto-archive pass so it applies without a reload.
  | { type: 'setState'; sort?: string; collapsedFolders?: string[] }
  // The host recomputes the fleet sections with the Active projection; nothing is persisted.
  | { type: 'setActive'; active: boolean }
  | { type: 'setAutoArchiveWindow'; days: number }
  // Group-by override (enum-checked at coerce; auto clears it) and the robin animations toggle.
  | { type: 'setGroupBy'; mode: GroupBy }
  | { type: 'setRobinAnimations'; on: boolean }
  | { type: 'openLayoutFile' }
  // No payload; the host recomputes the moves from the layout rules and curation state.
  | { type: 'organizePreview' }
  | { type: 'organizeApply' }
  | { type: 'organizeUndo' }
  | {
      type: 'setSectionsVisible';
      starred?: boolean;
      questions?: boolean;
      folders?: boolean;
      unsorted?: boolean;
    };

// Command seams wired in extension.ts to the existing store and command paths, so the webview never re-implements a mutation. Each resolves once the change is staged and views are refreshed.
export interface OrgPanelActions {
  renameFolder(folderId: string, name: string): Promise<void> | void;
  setFolderColor(folderId: string, color: string | null): Promise<void> | void;
  // Shows the modal confirmation, then runs the deleteFolder cascade, which unfiles the folder's chats.
  deleteFolder(folderId: string): Promise<void> | void;
  // With no name (legacy path) the underlying command prompts for one.
  createFolder(name?: string): Promise<void> | void;
  // Best-effort, with a fallback and toast when the contributed command is missing.
  newSession(): Promise<void> | void;
  // Stored body-copy titles for archived chats whose transcript is gone, so the overlay shows a title rather than a UUID. Empty when no copies are readable.
  loadArchivedTitles(): Promise<Map<string, string>>;
  // Clears the synced archived flag and keeps the star. Deletes the redundant body copy only when the live transcript survives (an empty filePath keeps it).
  restoreArchivedChat(sessionId: string): Promise<void> | void;
  // Runs one pass over the current window so a shortened window applies without a reload. No-op when set to Never.
  runAutoArchive(): Promise<void> | void;
  // `starred` is the desired next state; persists immediately through the star commands.
  setStarred(sessionId: string, starred: boolean): Promise<void> | void;
  // `on` is the desired next state; routes to addChatTag or removeChatTag.
  toggleChatTag(sessionId: string, tagId: string, on: boolean): Promise<void> | void;
  // Mints a tag with an optional validated color and applies it. The existing createTag command prompts modally and mints colorless tags, so it cannot serve this flow.
  createTagWithColor(sessionId: string, label: string, color: string | null): Promise<void> | void;
  // Reuses the existing export pipeline and its read-only guard. An unresolvable id is a no-op.
  exportChat(sessionId: string, format: ExportFormat): Promise<void> | void;
  // Reuses the existing archive pipeline. An unresolvable id is a no-op; the client offers this only for chats that are neither starred nor archived.
  archiveChat(sessionId: string): Promise<void> | void;
}

// Mirrors exportChatCommands.ExportFormat without importing the command module.
export type ExportFormat = 'markdown' | 'json';

// Wired to the organize commands so the webview never writes to the store.
export interface OrganizeActions {
  idle(): OrganizeReport;
  preview(): OrganizeReport;
  apply(): Promise<OrganizeReport>;
  undo(): Promise<OrganizeReport>;
}

// The most moves one organize message lists; the rest are counted.
const MAX_ORGANIZE_MOVES_POSTED = 500;

// Memento for the sort choice, so the panel reopens in the same mode.
export interface OrgPanelStateStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

// Per-device read-state seam backed by ReadStateStore. markSeen runs on open via Nest and on matching-tab focus; seedIfFirstRun marks chats present at the first scan as read.
export interface OrgPanelReadState {
  getMap(): Map<string, number>;
  markSeen(sessionId: string, at?: number): void;
  seedIfFirstRun(records: ReadonlyArray<{ sessionId: string; timestamp: number | null }>): boolean;
}

const SORT_KEY = 'claudeNest.orgPanel.sort';
// Collapsed folder ids as a JSON string array on workspaceState; never synced.
const COLLAPSED_KEY = 'claudeNest.orgPanel.collapsedFolders';
// Auto-archive window in days as a string; 0 means Never. When unset the wiring resolves the default from Claude's cleanupPeriodDays (30 if unset). Never synced.
const AUTO_ARCHIVE_WINDOW_KEY = 'claudeNest.orgPanel.autoArchiveWindowDays';
// Starred, Questions, Folders and Unsorted toggles as a JSON object on workspaceState, all on by default. Hiding Unsorted hides only the section; search and chips still reach unfiled chats.
const SECTIONS_VISIBLE_KEY = 'claudeNest.orgPanel.sectionsVisible';

export interface SectionsVisible {
  starred: boolean;
  questions: boolean;
  folders: boolean;
  unsorted: boolean;
}

const DEFAULT_SECTIONS_VISIBLE: SectionsVisible = {
  starred: true,
  questions: true,
  folders: true,
  unsorted: true,
};

// Writes where the effective value comes from, so a workspace value does not mask the switch.
export function robinConfigTarget(
  inspected: { workspaceFolderValue?: unknown; workspaceValue?: unknown } | undefined,
): vscode.ConfigurationTarget {
  if (inspected?.workspaceFolderValue !== undefined) {
    return vscode.ConfigurationTarget.WorkspaceFolder;
  }
  if (inspected?.workspaceValue !== undefined) {
    return vscode.ConfigurationTarget.Workspace;
  }
  return vscode.ConfigurationTarget.Global;
}

export interface VisibilityMessage {
  readonly type: 'visibility';
  readonly visible: boolean;
}

export function buildVisibilityMessage(visible: boolean): VisibilityMessage {
  return { type: 'visibility', visible: visible === true };
}

export class OrgPanelProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  // Built lazily on the first content query and cached until refresh(). Holds search tokens
  // only, never raw bodies. Advances from a warm title index to a body-indexed upgrade.
  private contentIndex: ReturnType<typeof buildIndex> | null = null;
  private tierAReady: Promise<ReturnType<typeof buildIndex> | null> | null = null;
  private bodyReady: Promise<ReturnType<typeof buildIndex> | null> | null = null;
  private bodyIndexReady = false;
  private indexedRecords: Map<string, ChatRecord> = new Map();
  private buildGeneration = 0;

  // The open chat's sessionId from the tab-label match, re-posted on 'ready'; null when no
  // chat can be identified. It is the only row tint.
  private activeChatId: string | null = null;

  // sessionId to filePath from the latest scan, so export and archive resolve a path without
  // a rescan. Cleared on refresh so a stale path is never served; resolveRecord rescans only
  // when it is empty.
  private previewPathBySession: Map<string, string> = new Map();

  // Set when the Settings command arrives before the webview sends 'ready' (focusing the
  // view is async and an early post is dropped); the 'ready' handler then opens the overlay.
  private pendingOpenSettings = false;

  // Same as pendingOpenSettings, for the auto-archive toast's Open Archive path.
  private pendingOpenArchive = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workspacePath: string | undefined,
    private readonly store: MetadataStore,
    private readonly getProjectKey: () => string | undefined,
    private readonly actions: OrgPanelActions,
    private readonly dropDeps: WebviewDropDeps,
    private readonly stateStore: OrgPanelStateStore,
    private readonly readState: OrgPanelReadState,
    private readonly globalStorageUri?: vscode.Uri,
    // Default window in days when the user has not chosen one; injected so this view does
    // not read settings.json. Falls back to 30.
    private readonly effectiveAutoArchiveDefault: () => number = () => 30,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.robinViewReady = false;
    this.lastRobinJson = '';
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    };

    webviewView.webview.onDidReceiveMessage((raw: unknown) => {
      const msg = coerce(raw);
      if (msg === null) {
        return;
      }
      this.onMessage(msg);
    });

    webviewView.webview.html = this.renderHtml(webviewView.webview, mediaRoot);

    // Tell the live-status poller whether the panel is on screen.
    this.visibilityListener?.(webviewView.visible);
    // Clears the hidden flag an earlier dispose set.
    this.onRobinVisibility(webviewView.visible);
    webviewView.onDidChangeVisibility(() => {
      this.visibilityListener?.(webviewView.visible);
      this.onRobinVisibility(webviewView.visible);
      this.postVisibility();
    });
    webviewView.onDidDispose(() => {
      this.visibilityListener?.(false);
      this.onRobinVisibility(false);
    });
  }

  private visibilityListener: ((visible: boolean) => void) | undefined;

  // Registers the single listener that hears when the panel becomes visible or hidden.
  onVisibilityChange(listener: (visible: boolean) => void): void {
    this.visibilityListener = listener;
    listener(this.view?.visible === true);
  }

  // Live status inputs. They feed the fleet message the panel renders.
  private agentSessions: readonly AgentSession[] = [];
  private lastRecords: readonly ChatRecord[] = [];
  private statusByChat: ReadonlyMap<string, ChatStatus> = new Map();
  private queueRows: readonly QueueRow[] = [];

  setAgentSessions(sessions: readonly AgentSession[]): void {
    this.agentSessions = sessions;
    this.agentsLoaded = true;
    this.recomputeStatuses();
    this.postFleet();
    this.stepRobin();
  }

  setQueueRows(rows: readonly QueueRow[]): void {
    this.queueRows = rows;
    this.queueLoaded = true;
    this.postFleet();
    this.stepRobin();
  }

  // The layout file's stage colors and finished stages, used to color stage pills.
  setStageStyle(style: StageStyleConfig): void {
    this.stageStyle = style;
    this.postFleet();
    this.stepRobin();
  }

  // The robin's per-device inputs. The animations getter reads the setting; the hatched
  // store keeps the one-time egg per device and is never synced.
  private robinAnimations: () => boolean = () => true;
  private robinHatched: { get: () => boolean; set: () => void } = { get: () => true, set: () => undefined };
  private robinMemory: RobinMemory = INITIAL_ROBIN_MEMORY;
  private robinOutput: RobinOutput | undefined;
  private robinTimer: ReturnType<typeof setTimeout> | undefined;
  private robinGrace: ReturnType<typeof setTimeout> | undefined;
  private robinVisible = true;
  private robinDisposed = false;
  private robinFleetLoaded = false;
  private agentsLoaded = false;
  private queueLoaded = false;
  private robinGraceOver = false;
  private lastRobinJson = '';
  // False until the webview of the current view says it is ready; earlier posts are dropped.
  private robinViewReady = false;

  setRobinOptions(options: {
    animations: () => boolean;
    hatched: { get: () => boolean; set: () => void };
  }): void {
    this.robinAnimations = options.animations;
    this.robinHatched = options.hatched;
    // The live session poll may never answer (untrusted workspace); stop waiting for it.
    this.robinGrace ??= setTimeout(() => {
      this.robinGraceOver = true;
      this.stepRobin();
    }, 4000);
  }

  // Re-post the robin when the animations setting changes.
  refreshRobin(): void {
    if (this.robinDisposed) {
      return;
    }
    this.lastRobinJson = '';
    this.postRobin();
    this.postSettings();
  }

  disposeRobin(): void {
    this.robinDisposed = true;
    clearTimeout(this.robinTimer);
    clearTimeout(this.robinGrace);
    this.robinTimer = undefined;
  }

  // Tells the webview whether the view is on screen; a collapsed sidebar view does not flip
  // document.hidden, so the webview cannot learn this on its own.
  private postVisibility(): void {
    if (this.robinDisposed || !this.robinViewReady || this.view === undefined) {
      return;
    }
    void this.view.webview.postMessage(buildVisibilityMessage(this.robinVisible));
  }

  private onRobinVisibility(visible: boolean): void {
    this.robinVisible = visible;
    if (visible) {
      this.lastRobinJson = '';
      this.stepRobin();
    } else {
      clearTimeout(this.robinTimer);
      this.robinTimer = undefined;
    }
  }

  // Step the machine once the first real inputs are in, so existing history seeds the
  // seen sets instead of replaying as transient states.
  private stepRobin(): void {
    if (this.robinDisposed || !this.robinFleetLoaded || !this.queueLoaded || !(this.agentsLoaded || this.robinGraceOver)) {
      return;
    }
    const now = Date.now();
    const signals = buildRobinSignals({
      fleet: this.fleetState,
      statuses: this.statusByChat,
      sessions: this.agentSessions,
      queueRows: this.queueRows,
      doneStages: this.stageStyle.doneStages,
      hatchEligible: !this.robinHatched.get(),
    });
    const { memory, output } = stepRobin(this.robinMemory, signals, now, Math.random);
    this.robinMemory = memory;
    this.robinOutput = output;
    clearTimeout(this.robinTimer);
    this.robinTimer = undefined;
    if (output.nextCheckAt !== null && this.robinVisible) {
      const delay = Math.min(Math.max(output.nextCheckAt - now, 50), 2 ** 31 - 1);
      this.robinTimer = setTimeout(() => this.stepRobin(), delay);
    }
    this.postRobin();
  }

  private postRobin(): void {
    if (this.robinDisposed || !this.robinViewReady || this.view === undefined || this.robinOutput === undefined) {
      return;
    }
    const animations = this.robinAnimations();
    const message = buildRobinMessage(this.robinOutput, animations);
    const json = JSON.stringify(message);
    if (json === this.lastRobinJson) {
      return;
    }
    this.lastRobinJson = json;
    void this.view.webview.postMessage(message);
    // The egg counts as hatched only once a ready, visible panel with animations on has been sent it.
    if (message.state === 'hatch' && animations && this.robinVisible) {
      this.robinHatched.set();
    }
  }

  // True when the live session list holds this chat as a working or needs background session.
  isAttachable(sessionId: string): boolean {
    return attachableSessionIds(this.agentSessions).has(sessionId);
  }

  // The chat's display name for a terminal title, or empty when unknown.
  getChatName(sessionId: string): string {
    const record = this.lastRecords.find((r) => r.sessionId === sessionId);
    if (record !== undefined && typeof record.title === 'string' && record.title.length > 0) {
      return record.title;
    }
    return this.fleetState.entries.find((e) => e.sessionId === sessionId)?.name ?? '';
  }

  getQueueRows(): readonly QueueRow[] {
    return this.queueRows;
  }

  private stageStyle: StageStyleConfig = DEFAULT_STAGE_STYLE;
  // The Active projection is per window and not persisted.
  private fleetActive = false;
  // The last fleet message as text, so an unchanged poll does not re-render the panel.
  private lastFleetJson = '';

  // Post the fleet sections to the panel when they changed since the last post.
  private postFleet(force = false): void {
    if (this.view === undefined) {
      return;
    }
    const message = buildFleetMessage(this.getFleetSections(this.fleetActive), this.stageStyle);
    const json = JSON.stringify(message);
    if (!force && json === this.lastFleetJson) {
      return;
    }
    this.lastFleetJson = json;
    void this.view.webview.postMessage(message);
  }

  // The fleet sections for the current records, fleet state, statuses and queue.
  getFleetSections(active: boolean): FleetSections {
    const projectKey = this.getProjectKey();
    const meta: ProjectMeta | undefined =
      projectKey !== undefined ? this.store.getProjectMeta(projectKey) : undefined;
    const cwdByChat = new Map<string, string>();
    for (const session of this.agentSessions) {
      if (session.cwd !== null) {
        cwdByChat.set(session.sessionId, session.cwd);
      }
    }
    const unsortedByHand = projectKey !== undefined ? this.store.getUnsortedByHand(projectKey) : new Set<string>();
    return buildFleetSections({
      chats: fleetModelChats(this.lastRecords, meta, cwdByChat, unsortedByHand),
      userFolders: fleetModelFolders(meta),
      fleet: this.fleetState,
      statuses: this.statusByChat,
      attachableIds: attachableSessionIds(this.agentSessions),
      queueRows: this.queueRows,
      groupBy: this.groupBy,
      workspaceRoot: this.workspacePath ?? null,
      now: Date.now(),
      active,
    });
  }

  // Every unarchived chat as a rule subject, joined with its fleet record. Scans once
  // when the panel has not scanned yet. Read-only.
  getOrganizeSubjects(): RuleSubject[] {
    if (this.lastRecords.length === 0 && this.workspacePath !== undefined) {
      try {
        this.scanAll(this.workspacePath);
      } catch {
        return [];
      }
    }
    const projectKey = this.getProjectKey();
    const meta: ProjectMeta | undefined =
      projectKey !== undefined ? this.store.getProjectMeta(projectKey) : undefined;
    const cwdByChat = new Map<string, string>();
    for (const session of this.agentSessions) {
      if (session.cwd !== null) {
        cwdByChat.set(session.sessionId, session.cwd);
      }
    }
    const chats = fleetModelChats(this.lastRecords, meta, cwdByChat).filter((c) => !c.archived);
    return buildRuleSubjects(chats, this.fleetState.entries, this.workspacePath ?? null);
  }

  getStatuses(): ReadonlyMap<string, ChatStatus> {
    return this.statusByChat;
  }

  private recomputeStatuses(): void {
    const seen = this.readState.getMap();
    this.statusByChat = computeStatuses(
      this.lastRecords.map((r) => ({ sessionId: r.sessionId, questionPending: rowStatus(r, seen) === 'question' })),
      this.fleetState.entries,
      this.agentSessions,
    );
  }

  // The layout file's effect on the panel: linked folders to scan, the auto grouping,
  // and the fleet state. All read-only input; the host swaps it in on a reload.
  private linkedFolders: readonly string[] = [];
  private groupBy: GroupBy = 'auto';
  private fleetState: FleetState = EMPTY_FLEET_STATE;
  private sourceByChat: ReadonlyMap<string, string> = new Map();

  private groupByOverrideListener: (() => void) | undefined;

  // The host re-applies the layout when the per-workspace override changes.
  onGroupByOverrideChange(listener: () => void): void {
    this.groupByOverrideListener = listener;
  }

  setLayout(layout: { linkedFolders: readonly string[]; groupBy: GroupBy; fleet: FleetState }): void {
    this.linkedFolders = layout.linkedFolders;
    this.groupBy = layout.groupBy;
    this.fleetState = layout.fleet;
    this.robinFleetLoaded = true;
    this.recomputeStatuses();
    this.stepRobin();
  }

  // One scan of the workspace plus linked folders. Throws like scanChats did.
  private scanAll(workspacePath: string): ChatRecord[] {
    // The workspace scan is unguarded so a failure surfaces to the caller as before;
    // a failing linked folder is skipped.
    const [first, ...rest] = foldersToScan(workspacePath, this.linkedFolders);
    const parts = [{ folder: first, records: scanChats(first) }];
    for (const folder of rest) {
      try {
        parts.push({ folder, records: scanChats(folder) });
      } catch {
        // A linked folder that cannot be read contributes nothing.
      }
    }
    const scan = mergeFolderScans(parts);
    this.sourceByChat = scan.sourceByChat;
    this.lastRecords = scan.records;
    this.recomputeStatuses();
    this.stepRobin();
    return scan.records;
  }

  private placementContext(): PlacementContext {
    const fleetByChat = new Map<string, { folder: string | null; ticket: string | null }>();
    for (const entry of this.fleetState.entries) {
      fleetByChat.set(entry.sessionId, { folder: entry.folder, ticket: entry.ticket });
    }
    const projectKey = this.getProjectKey();
    const unsortedByHand = projectKey !== undefined ? this.store.getUnsortedByHand(projectKey) : new Set<string>();
    return { groupBy: this.groupBy, now: Date.now(), fleetByChat, sourceByChat: this.sourceByChat, unsortedByHand };
  }

  // Called after any store mutation so the panel re-renders.
  refresh(): void {
    this.invalidateContentIndex();
    this.postSections();
  }

  private onMessage(msg: Inbound): void {
    if (msg.type === 'ready') {
      this.robinViewReady = true;
      this.lastRobinJson = '';
      this.postVisibility();
      this.postState();
      this.postSettings();
      this.postSections();
      this.postActive();
      // Honors a Settings-open requested before the webview was resolved.
      if (this.pendingOpenSettings) {
        this.pendingOpenSettings = false;
        this.postOpenSettings();
      }
      // Honors an Archive-open requested before the webview was resolved.
      if (this.pendingOpenArchive) {
        this.pendingOpenArchive = false;
        void this.postArchivedRows();
        this.postOpenArchive();
      }
    } else if (msg.type === 'open') {
      void vscode.commands.executeCommand(OPEN_CHAT_COMMAND, msg.sessionId);
    } else if (msg.type === 'openInTerminal') {
      void vscode.commands.executeCommand(OPEN_IN_TERMINAL_COMMAND, msg.sessionId, msg.explicit === true);
    } else if (msg.type === 'search') {
      void this.postSearch(msg.query);
    } else if (msg.type === 'drop') {
      void this.onDrop(msg.sourceChatIds, msg.targetKind, msg.targetId);
    } else if (msg.type === 'renameFolder') {
      void this.onRenameFolder(msg.folderId, msg.name);
    } else if (msg.type === 'setFolderColor') {
      void this.onSetFolderColor(msg.folderId, msg.color);
    } else if (msg.type === 'deleteFolder') {
      void this.onDeleteFolder(msg.folderId);
    } else if (msg.type === 'createFolder') {
      void this.actions.createFolder(msg.name);
    } else if (msg.type === 'newSession') {
      void this.actions.newSession();
    } else if (msg.type === 'openArchive') {
      void this.postArchivedRows();
    } else if (msg.type === 'restoreChat') {
      void this.onRestoreChat(msg.sessionId);
    } else if (msg.type === 'starUnarchive') {
      void this.onStarUnarchive(msg.sessionId);
    } else if (msg.type === 'previewArchivedChat') {
      // A missing copy surfaces an info notice in the command.
      if (msg.sessionId.length > 0) {
        void vscode.commands.executeCommand(PREVIEW_ARCHIVED_CHAT_COMMAND, msg.sessionId);
      }
    } else if (msg.type === 'toggleStar') {
      void this.onToggleStar(msg.sessionId, msg.starred);
    } else if (msg.type === 'toggleTag') {
      void this.onToggleTag(msg.sessionId, msg.tagId, msg.on);
    } else if (msg.type === 'createTagWithColor') {
      void this.onCreateTagWithColor(msg.sessionId, msg.label, msg.color);
    } else if (msg.type === 'exportChat') {
      void this.actions.exportChat(msg.sessionId, msg.format);
    } else if (msg.type === 'archiveChat') {
      void this.onArchiveChat(msg.sessionId);
    } else if (msg.type === 'setState') {
      this.onSetState(msg.sort, msg.collapsedFolders);
    } else if (msg.type === 'setActive') {
      this.fleetActive = msg.active;
      this.postFleet();
    } else if (msg.type === 'setAutoArchiveWindow') {
      this.onSetAutoArchiveWindow(msg.days);
    } else if (msg.type === 'setSectionsVisible') {
      this.onSetSectionsVisible(msg);
    } else if (msg.type === 'setGroupBy') {
      this.stateStore.set(GROUP_BY_OVERRIDE_KEY, msg.mode);
      this.postSettings();
      this.groupByOverrideListener?.();
    } else if (msg.type === 'openLayoutFile') {
      void vscode.commands.executeCommand(OPEN_LAYOUT_FILE_COMMAND);
    } else if (msg.type === 'organizePreview') {
      void this.runOrganize('preview');
    } else if (msg.type === 'organizeApply') {
      void this.runOrganize('apply');
    } else if (msg.type === 'organizeUndo') {
      void this.runOrganize('undo');
    } else if (msg.type === 'setRobinAnimations') {
      // The configuration listener in the host re-posts the robin and the settings state.
      const config = vscode.workspace.getConfiguration('claudeNest');
      void config.update('robin.animations', msg.on, robinConfigTarget(config.inspect<boolean>('robin.animations')));
    }
  }

  private async onToggleStar(sessionId: string, starred: boolean): Promise<void> {
    if (sessionId.length === 0) {
      return;
    }
    await this.actions.setStarred(sessionId, starred);
  }

  private async onToggleTag(sessionId: string, tagId: string, on: boolean): Promise<void> {
    if (sessionId.length === 0 || tagId.length === 0) {
      return;
    }
    await this.actions.toggleChatTag(sessionId, tagId, on);
  }

  private async onCreateTagWithColor(
    sessionId: string,
    label: string,
    color: string | null,
  ): Promise<void> {
    const trimmed = label.trim();
    if (sessionId.length === 0 || trimmed.length === 0) {
      return;
    }
    await this.actions.createTagWithColor(sessionId, trimmed, color);
  }

  private async onArchiveChat(sessionId: string): Promise<void> {
    if (sessionId.length === 0) {
      return;
    }
    await this.actions.archiveChat(sessionId);
  }

  // Re-posts the archived rows so the overlay drops the restored chat at once. An empty id is ignored.
  private async onRestoreChat(sessionId: string): Promise<void> {
    if (sessionId.length === 0) {
      return;
    }
    await this.actions.restoreArchivedChat(sessionId);
    await this.postArchivedRows();
  }

  // The star is applied first so the restore's copy handling reads the current star. An empty id is ignored.
  private async onStarUnarchive(sessionId: string): Promise<void> {
    if (sessionId.length === 0) {
      return;
    }
    await this.actions.setStarred(sessionId, true);
    await this.actions.restoreArchivedChat(sessionId);
    await this.postArchivedRows();
  }

  // Present chats take title and age from the scan; a gone transcript falls back to its stored copy title. With no workspace it posts an empty list.
  private async postArchivedRows(): Promise<void> {
    if (this.view === undefined) {
      return;
    }
    const records = this.scanRecords();
    const projectKey = this.getProjectKey();
    const meta: ProjectMeta | undefined =
      projectKey !== undefined ? this.store.getProjectMeta(projectKey) : undefined;
    // Copy titles are loaded only when an archived chat is missing from the scan; a failed load degrades to the sessionId.
    let fallbackTitles = new Map<string, string>();
    const anyGone =
      meta !== undefined &&
      Object.entries(meta.chats).some(
        ([id, m]) => m.userArchived === true && !records.some((r) => r.sessionId === id),
      );
    if (anyGone) {
      try {
        fallbackTitles = await this.actions.loadArchivedTitles();
      } catch {
        fallbackTitles = new Map();
      }
      // The webview may have been disposed during the async load.
      if (this.view === undefined) {
        return;
      }
    }
    const rows = buildArchivedRows(records, meta, relativeTimeCompact, fallbackTitles);
    void this.view.webview.postMessage({ type: 'archivedRows', rows });
  }

  // The adapter's deps fire the shared refresh, which calls this.refresh(), so no re-post is needed here.
  private async onDrop(
    sourceChatIds: string[],
    targetKind: 'folder' | 'tag',
    targetId: string | undefined,
  ): Promise<void> {
    await handleWebviewDrop(this.dropDeps, { sourceChatIds, targetKind, targetId });
  }

  private async onRenameFolder(folderId: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (folderId.length === 0 || trimmed.length === 0) {
      return;
    }
    await this.actions.renameFolder(folderId, trimmed);
  }

  private async onSetFolderColor(folderId: string, color: string | null): Promise<void> {
    if (folderId.length === 0) {
      return;
    }
    await this.actions.setFolderColor(folderId, color);
  }

  private async onDeleteFolder(folderId: string): Promise<void> {
    if (folderId.length === 0) {
      return;
    }
    await this.actions.deleteFolder(folderId);
  }

  private onSetState(
    sort: string | undefined,
    collapsedFolders: string[] | undefined,
  ): void {
    if (sort !== undefined) {
      this.stateStore.set(SORT_KEY, sort);
    }
    if (collapsedFolders !== undefined) {
      this.stateStore.set(COLLAPSED_KEY, JSON.stringify(collapsedFolders));
    }
  }

  // The value is revalidated through the coercer so a tampered webview value cannot persist an arbitrary window.
  private onSetAutoArchiveWindow(days: number): void {
    const coerced = coerceAutoArchiveWindowDays(days, this.effectiveAutoArchiveDefault());
    this.stateStore.set(AUTO_ARCHIVE_WINDOW_KEY, String(coerced));
    this.postSettings();
    // A shortened window may now sweep chats; runAutoArchive is a no-op when disabled or nothing is past the window.
    void this.actions.runAutoArchive();
  }

  // Merges over the current set so a single-toggle post does not clear the others. These gate rendering only, so unfiled chats stay reachable by search.
  private onSetSectionsVisible(next: {
    starred?: boolean;
    questions?: boolean;
    folders?: boolean;
    unsorted?: boolean;
  }): void {
    const current = this.readSectionsVisible();
    const merged: SectionsVisible = {
      starred: next.starred ?? current.starred,
      questions: next.questions ?? current.questions,
      folders: next.folders ?? current.folders,
      unsorted: next.unsorted ?? current.unsorted,
    };
    this.stateStore.set(SECTIONS_VISIBLE_KEY, JSON.stringify(merged));
    this.postSettings();
  }

  // Falls back to the default when the persisted value is unset or invalid.
  private readAutoArchiveWindowDays(): number {
    return coerceAutoArchiveWindowDays(
      this.stateStore.get(AUTO_ARCHIVE_WINDOW_KEY),
      this.effectiveAutoArchiveDefault(),
    );
  }

  // Exposed so the engine pass and the overlay agree on the window.
  autoArchiveWindowDays(): number {
    return this.readAutoArchiveWindowDays();
  }

  // Each field falls back to true independently, so a corrupt memento never hides a section.
  private readSectionsVisible(): SectionsVisible {
    const raw = this.stateStore.get(SECTIONS_VISIBLE_KEY);
    if (raw === undefined) {
      return { ...DEFAULT_SECTIONS_VISIBLE };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ...DEFAULT_SECTIONS_VISIBLE };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ...DEFAULT_SECTIONS_VISIBLE };
    }
    const obj = parsed as Record<string, unknown>;
    const bool = (v: unknown): boolean => (typeof v === 'boolean' ? v : true);
    return {
      starred: bool(obj.starred),
      questions: bool(obj.questions),
      folders: bool(obj.folders),
      unsorted: bool(obj.unsorted),
    };
  }

  private postState(): void {
    if (this.view === undefined) {
      return;
    }
    void this.view.webview.postMessage({
      type: 'state',
      sort: this.stateStore.get(SORT_KEY) ?? 'newest',
      collapsedFolders: this.readCollapsedFolders(),
    });
  }

  // A missing or malformed value yields an empty list, so a corrupt memento never throws.
  private readCollapsedFolders(): string[] {
    const raw = this.stateStore.get(COLLAPSED_KEY);
    if (raw === undefined) {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((v): v is string => typeof v === 'string');
  }

  private postSections(): void {
    if (this.view === undefined) {
      return;
    }
    void this.view.webview.postMessage({ type: 'sections', sections: this.buildSectionModel() });
    this.postFleet(true);
    this.postRobin();
  }

  // Posts the auto-archive window and section toggles so the overlay renders the persisted values.
  private postSettings(): void {
    if (this.view === undefined) {
      return;
    }
    void this.view.webview.postMessage({
      type: 'settings',
      autoArchiveWindowDays: this.readAutoArchiveWindowDays(),
      sectionsVisible: this.readSectionsVisible(),
      groupByOverride: coerceGroupByOverride(this.stateStore.get(GROUP_BY_OVERRIDE_KEY)) ?? 'auto',
      robinAnimations: this.robinAnimations(),
    });
    this.postOrganizeState();
  }

  private organizeActions: OrganizeActions | undefined;
  private lastOrganize: OrganizeReport | undefined;

  setOrganizeActions(actions: OrganizeActions): void {
    this.organizeActions = actions;
  }

  // Post an organize report to the Settings overlay's Organize section.
  postOrganize(report: OrganizeReport): void {
    this.lastOrganize = report;
    if (this.view === undefined) {
      return;
    }
    const moves = report.moves.slice(0, MAX_ORGANIZE_MOVES_POSTED).map((m) => ({
      sessionId: m.sessionId,
      title: m.title,
      from: m.fromFolder,
      to: m.toFolder,
      createsFolder: m.createsFolder,
      tags: m.tagsAdded,
      pin: m.pin,
    }));
    void this.view.webview.postMessage({
      type: 'organize',
      kind: report.kind,
      message: report.message,
      moves,
      moreMoves: Math.max(0, report.moves.length - moves.length),
      matched: report.matched,
      skippedHandFiled: report.skippedHandFiled,
      rulesActive: report.rulesActive,
      problems: report.problems.slice(0, 20),
      canUndo: report.canUndo,
      undoCount: report.undoCount,
      skippedOnUndo: report.skippedOnUndo,
    });
  }

  // Run one organize action and post its report. A failure is reported, never thrown.
  async runOrganize(action: 'preview' | 'apply' | 'undo'): Promise<OrganizeReport | undefined> {
    const actions = this.organizeActions;
    if (actions === undefined) {
      return undefined;
    }
    try {
      const report =
        action === 'preview' ? actions.preview() : action === 'apply' ? await actions.apply() : await actions.undo();
      this.postOrganize(report);
      return report;
    } catch (err) {
      const base = actions.idle();
      const message = err instanceof Error ? err.message : 'Organize failed.';
      const failed: OrganizeReport = { ...base, kind: 'error', message };
      this.postOrganize(failed);
      return failed;
    }
  }

  // The report the Organize section shows when the Settings overlay opens.
  private postOrganizeState(): void {
    if (this.organizeActions === undefined) {
      return;
    }
    const idle = this.organizeActions.idle();
    // Keep a Preview list on screen across settings re-posts; refresh the Undo state.
    const last = this.lastOrganize;
    this.postOrganize(last !== undefined && last.kind === 'preview' ? { ...last, canUndo: idle.canUndo, undoCount: idle.undoCount } : idle);
  }

  // Sent when the Settings command fires; the gear opens the overlay client-side without this.
  private postOpenSettings(): void {
    if (this.view === undefined) {
      return;
    }
    void this.view.webview.postMessage({ type: 'openSettings' });
  }

  // The Settings sub-page lives inside this webview. When the view has not resolved yet, the
  // post would be dropped, so pendingOpenSettings defers to the 'ready' handler.
  openSettingsOverlay(): void {
    if (this.view === undefined) {
      this.pendingOpenSettings = true;
      return;
    }
    this.postSettings();
    this.postOpenSettings();
  }

  // Sent by the auto-archive toast's Open Archive action.
  private postOpenArchive(): void {
    if (this.view === undefined) {
      return;
    }
    void this.view.webview.postMessage({ type: 'openArchive' });
  }

  // Posts the archived rows and the open message. When the view has not resolved yet,
  // pendingOpenArchive defers to 'ready'. The caller focuses the view first.
  openArchiveOverlay(): void {
    if (this.view === undefined) {
      this.pendingOpenArchive = true;
      return;
    }
    void this.postArchivedRows();
    this.postOpenArchive();
  }

  // A missing workspace or failed scan yields empty sections rather than throwing.
  private buildSectionModel(): OrgSections {
    const empty: OrgSections = {
      starred: [],
      questions: [],
      folders: [],
      tags: [],
      allTags: [],
      archivedCount: 0,
    };
    if (this.workspacePath === undefined) {
      return empty;
    }
    let records: ChatRecord[];
    try {
      records = this.scanAll(this.workspacePath);
    } catch {
      return empty;
    }
    this.cachePreviewPaths(records);
    // The first scan marks existing chats read so months-old chats do not light the unread dot.
    this.readState.seedIfFirstRun(records);
    const projectKey = this.getProjectKey();
    const meta: ProjectMeta | undefined =
      projectKey !== undefined ? this.store.getProjectMeta(projectKey) : undefined;
    return buildSections(records, meta, tokenBadge, this.readState.getMap(), this.placementContext());
  }

  // Empty on no workspace or a failed scan. Lets the tab-focus trigger match a label to a title without a second scan path.
  scanRecords(): ChatRecord[] {
    if (this.workspacePath === undefined) {
      return [];
    }
    try {
      const records = this.scanAll(this.workspacePath);
      this.cachePreviewPaths(records);
      return records;
    } catch {
      return [];
    }
  }

  // Overwrites wholesale so a deleted or renamed transcript never lingers.
  private cachePreviewPaths(records: ChatRecord[]): void {
    this.previewPathBySession = new Map(records.map((r) => [r.sessionId, r.filePath]));
  }

  // Stamps lastSeenAt and re-posts so the badge or dot clears at once.
  markChatSeen(sessionId: string): void {
    this.readState.markSeen(sessionId);
    this.postSections();
  }

  // Returns true only when the value changed, so a tab-change storm does not trigger a scan per event.
  setActiveChat(sessionId: string | null): boolean {
    if (this.activeChatId === sessionId) {
      return false;
    }
    this.activeChatId = sessionId;
    this.postActive();
    return true;
  }

  private postActive(): void {
    if (this.view === undefined) {
      return;
    }
    void this.view.webview.postMessage({ type: 'active', sessionId: this.activeChatId });
  }

  // Export and archive need the real transcript filePath (a bare sessionId would export a
  // body-less document and archive with no copy). Uses the scan cache, rescanning once only
  // when the cache lacks the id. Undefined for an unknown id.
  resolveRecord(sessionId: string): ChatRecord | undefined {
    if (sessionId.length === 0) {
      return undefined;
    }
    if (this.previewPathBySession.has(sessionId) || this.previewPathBySession.size === 0) {
      return this.scanRecords().find((r) => r.sessionId === sessionId);
    }
    // The cache is warm but lacks this id, so the chat is not scanned (e.g. transcript cleaned up).
    return undefined;
  }

  private async postSearch(query: string): Promise<void> {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      this.postSearchResults('', []);
      return;
    }
    // Result posts after an await are gated on this generation: if invalidateContentIndex()
    // runs mid-await, the stale index would rank to zero and blank valid hits with an empty
    // post. Skipping the post keeps the prior results.
    const generation = this.buildGeneration;
    this.ensureContentIndexBuilding();
    if (this.bodyIndexReady) {
      this.postSearchResults(trimmed, this.rankRows(this.contentIndex, trimmed));
      return;
    }
    const tierA = this.tierAReady === null ? this.contentIndex : await this.tierAReady;
    if (generation !== this.buildGeneration) {
      return;
    }
    this.postSearchResults(trimmed, this.rankRows(tierA, trimmed));
    if (!this.bodyIndexReady && this.bodyReady !== null) {
      const body = await this.bodyReady;
      if (generation !== this.buildGeneration) {
        return;
      }
      this.postSearchResults(trimmed, this.rankRows(body, trimmed));
    }
  }

  private postSearchResults(query: string, rows: SearchRow[]): void {
    if (this.view === undefined) {
      return;
    }
    void this.view.webview.postMessage({ type: 'searchResults', query, rows });
  }

  private rankRows(index: ReturnType<typeof buildIndex> | null, query: string): SearchRow[] {
    if (index === null) {
      return [];
    }
    let hits;
    try {
      hits = searchIndex(index, query);
    } catch {
      return [];
    }
    const needle = query.trim().toLowerCase();
    const rows: SearchRow[] = [];
    hits.forEach((hit, i) => {
      const record = this.indexedRecords.get(hit.sessionId);
      if (record === undefined) {
        return;
      }
      // A title match sends null so the client renders no snippet row; only a body-only match gets one.
      const titleHit =
        needle.length > 0 && (record.title ?? '').toLowerCase().indexOf(needle) >= 0;
      rows.push({
        rank: i,
        sessionId: record.sessionId,
        title: record.title,
        description: relativeTime(record.timestamp),
        timestamp: record.timestamp,
        tokens: tokenBadge(record),
        snippet: titleHit ? null : hit.snippet.length > 0 ? hit.snippet : null,
      });
    });
    return rows;
  }

  private ensureContentIndexBuilding(): void {
    if (this.bodyIndexReady || this.tierAReady !== null) {
      return;
    }
    const generation = this.buildGeneration;
    const scanned = this.scanForIndex(generation);
    this.tierAReady = scanned.then((records) => {
      if (records === null) {
        return null;
      }
      return this.buildTierAIndex(records, generation);
    });
    this.bodyReady = this.tierAReady.then(async (tierAIndex) => {
      const records = await scanned;
      if (records === null || tierAIndex === null) {
        return tierAIndex;
      }
      return this.upgradeToBodyIndex(records, generation);
    });
  }

  private async scanForIndex(generation: number): Promise<ChatRecord[] | null> {
    if (this.workspacePath === undefined) {
      return null;
    }
    let records: ChatRecord[];
    try {
      records = this.scanAll(this.workspacePath);
    } catch {
      return null;
    }
    if (generation !== this.buildGeneration) {
      return null;
    }
    // Archived chats are excluded here, the sole feeder, by the same predicate buildSections
    // uses. Otherwise they rank into the 50-hit cap and the client then drops them, hiding
    // live matches. Archiving leaves the transcript on disk, so they stay scannable.
    const projectKey = this.getProjectKey();
    const meta: ProjectMeta | undefined =
      projectKey !== undefined ? this.store.getProjectMeta(projectKey) : undefined;
    const visible = records.filter((r) => !isArchived(r.sessionId, meta));
    this.indexedRecords.clear();
    for (const record of visible) {
      this.indexedRecords.set(record.sessionId, record);
    }
    return visible;
  }

  private async buildTierAIndex(
    records: ChatRecord[],
    generation: number,
  ): Promise<ReturnType<typeof buildIndex>> {
    let tierAIndex: ReturnType<typeof buildIndex>;
    try {
      tierAIndex =
        this.globalStorageUri !== undefined
          ? await loadOrRebuildTierAIndex(this.globalStorageUri, records)
          : buildIndex(records.map((r) => docFromRecord(r)));
    } catch {
      tierAIndex = buildIndex(records.map((r) => docFromRecord(r)));
    }
    if (generation === this.buildGeneration) {
      this.contentIndex = tierAIndex;
    }
    return tierAIndex;
  }

  private async upgradeToBodyIndex(
    records: ChatRecord[],
    generation: number,
  ): Promise<ReturnType<typeof buildIndex>> {
    const docs: SearchDoc[] = [];
    let sinceYield = 0;
    for (const record of records) {
      const bodyText = await this.readBodyText(record);
      docs.push(docFromRecord(record, bodyText));
      sinceYield += 1;
      if (sinceYield >= BODY_READ_CHUNK) {
        sinceYield = 0;
        await yieldToEventLoop();
      }
    }
    const bodyIndex = buildIndex(docs);
    if (generation !== this.buildGeneration) {
      return bodyIndex;
    }
    this.contentIndex = bodyIndex;
    this.bodyIndexReady = true;
    if (this.globalStorageUri !== undefined) {
      void persistTierAIndex(this.globalStorageUri, records);
    }
    return bodyIndex;
  }

  // Each turn is prefixed with its role label ("You: " / "Claude: "). docFromRecord indexes a
  // label-stripped copy so "claude" or "you" do not match every chat, and keeps this text as
  // the snippet source. Whitespace inside a message is collapsed so each message is one line:
  // buildRoleSnippet splits on '\n' to find the matched message. Used for the in-memory body
  // index only; the persisted index is summary-only.
  private async readBodyText(record: ChatRecord): Promise<string> {
    try {
      const bodies = readTranscriptBodies(record.filePath);
      const lines: string[] = [];
      for (const b of bodies) {
        if (b.text === null || b.text.length === 0) {
          continue;
        }
        const oneLine = b.text.replace(/\s+/g, ' ').trim();
        if (oneLine.length === 0) {
          continue;
        }
        const label = b.role === 'user' ? ROLE_LABEL_USER : ROLE_LABEL_ASSISTANT;
        lines.push(label + oneLine);
      }
      return lines.join('\n');
    } catch {
      return '';
    }
  }

  private invalidateContentIndex(): void {
    this.buildGeneration += 1;
    this.contentIndex = null;
    this.bodyIndexReady = false;
    this.tierAReady = null;
    this.bodyReady = null;
    this.indexedRecords.clear();
    // refresh() re-scans and re-seeds this right after, so the cleared window is momentary.
    this.previewPathBySession.clear();
  }

  private renderHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const nonce = makeNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'orgPanel.js'));
    const mascotUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'mascot.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'orgPanel.css'));
    const cspSource = webview.cspSource;
    const csp = [
      "default-src 'none'",
      `style-src ${cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${cspSource}`,
    ].join('; ');
    // Static shells; orgPanel.js renders the content and owns keyboard and ARIA wiring.
    // scripts/fidelity/harness.html keeps a copy of this shell that must be updated with it.
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link href="${styleUri}" rel="stylesheet" />
</head>
<body>
  <header class="nest-header"><span id="robinSlot" class="nest-robin-slot" aria-hidden="true"></span><span class="nest-wordmark">Nest</span><span id="robinLive" class="nest-sr-only" role="status" aria-live="polite"></span></header>
  <div class="nest-toolbar">
    <button id="newSession" class="nest-new-session" type="button" title="New session" aria-label="New session"><span class="nest-new-session-plus" aria-hidden="true">+</span>New session</button>
    <span class="nest-spacer"></span>
    <button id="settings" class="nest-icon-btn" type="button" title="Settings" aria-label="Settings" aria-haspopup="dialog">&#9881;</button>
    <span class="nest-sort-wrap">
      <button id="sortBtn" class="nest-icon-btn" type="button" title="Sort" aria-label="Sort chats" aria-haspopup="menu" aria-expanded="false">&#8645;</button>
      <div id="sortPopover" class="nest-popover" role="menu" aria-label="Sort chats" hidden>
        <div class="nest-popover-title">SORT BY</div>
        <button class="nest-popover-item" type="button" role="menuitemradio" data-sort="newest" aria-checked="true"><span>Newest first</span><span class="nest-popover-check" aria-hidden="true">&#10003;</span></button>
        <button class="nest-popover-item" type="button" role="menuitemradio" data-sort="oldest" aria-checked="false"><span>Oldest first</span><span class="nest-popover-check" aria-hidden="true">&#10003;</span></button>
        <button class="nest-popover-item" type="button" role="menuitemradio" data-sort="name" aria-checked="false"><span>Name (A-Z)</span><span class="nest-popover-check" aria-hidden="true">&#10003;</span></button>
      </div>
    </span>
  </div>
  <div class="nest-controls">
    <div class="nest-search">
      <span class="nest-search-icon" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.6"/><line x1="10.8" y1="10.8" x2="14.5" y2="14.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></span>
      <input id="filter" class="nest-filter" type="text" placeholder="Search" aria-label="Search chats and messages" />
      <button id="searchClear" class="nest-search-clear" type="button" title="Clear search" aria-label="Clear search" hidden>&#215;</button>
    </div>

    <button id="activeBtn" class="nest-fleet-btn nest-fleet-btn-active" type="button" aria-pressed="false" hidden><span class="nest-fleet-btn-dot nest-dot-working" aria-hidden="true"></span><span id="activeLabel">Active 0</span></button>
    <button id="queueBtn" class="nest-fleet-btn nest-fleet-btn-queue" type="button" aria-pressed="false" aria-controls="queueList" hidden><span class="nest-fleet-btn-dot nest-dot-queued" aria-hidden="true"></span><span id="queueLabel">Queue 0</span></button>
  </div>
  <div id="queueList" class="nest-queue" role="list" aria-label="Queue" hidden></div>
  <div id="chips" class="nest-chips" role="group" aria-label="Tag filters"></div>
  <div id="list" class="nest-tree" role="tree" aria-label="Organized chats" tabindex="0"></div>
  <script nonce="${nonce}" src="${mascotUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

// Bounds the tokenizer work a tampered message can force per keystroke.
const MAX_SEARCH_QUERY_LENGTH = 512;

// Entries must be safe record ids and the array is bounded, so a tampered message cannot persist an unbounded blob.
const MAX_COLLAPSED_FOLDERS = 5000;

// Closed set matching the sort popover, so a tampered message cannot persist an arbitrary sort.
const SORT_VALUES = new Set(['newest', 'oldest', 'name']);

// Each dropped id can mint a synced ChatMeta record via ensureChat, so an unbounded array
// could mint phantom records into Settings Sync. Ids are also filtered to the safe record-id shape.
const MAX_DROP_IDS = 512;

function coerce(raw: unknown): Inbound | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const settingsMsg = coerceSettingsInbound(raw);
  if (settingsMsg !== null) {
    return settingsMsg;
  }
  const obj = raw as {
    type?: unknown;
    sessionId?: unknown;
    explicit?: unknown;
    query?: unknown;
    sourceChatIds?: unknown;
    targetKind?: unknown;
    targetId?: unknown;
    folderId?: unknown;
    name?: unknown;
    color?: unknown;
    sort?: unknown;
    collapsedFolders?: unknown;
    starred?: unknown;
    tagId?: unknown;
    on?: unknown;
    label?: unknown;
    format?: unknown;
    days?: unknown;
    questions?: unknown;
    folders?: unknown;
    unsorted?: unknown;
    active?: unknown;
  };
  if (obj.type === 'ready') {
    return { type: 'ready' };
  }
  if (obj.type === 'openLayoutFile') {
    return { type: 'openLayoutFile' };
  }
  if (obj.type === 'organizePreview') {
    return { type: 'organizePreview' };
  }
  if (obj.type === 'organizeApply') {
    return { type: 'organizeApply' };
  }
  if (obj.type === 'organizeUndo') {
    return { type: 'organizeUndo' };
  }
  if (obj.type === 'open' && isSafeRecordId(obj.sessionId) && isOpenableSessionId(obj.sessionId)) {
    // The only webview id that reaches a persistence sink (markSeen writes it into
    // workspaceState), so it gets the safe record-id check here, before it can grow the memento.
    return { type: 'open', sessionId: obj.sessionId };
  }
  if (obj.type === 'openInTerminal' && isSafeRecordId(obj.sessionId) && isOpenableSessionId(obj.sessionId)) {
    return obj.explicit === true
      ? { type: 'openInTerminal', sessionId: obj.sessionId, explicit: true }
      : { type: 'openInTerminal', sessionId: obj.sessionId };
  }
  if (obj.type === 'search' && typeof obj.query === 'string') {
    // Cap the query so a tampered message cannot feed the tokenizer a huge string.
    return { type: 'search', query: obj.query.slice(0, MAX_SEARCH_QUERY_LENGTH) };
  }
  if (obj.type === 'drop' && Array.isArray(obj.sourceChatIds)) {
    const kind = obj.targetKind === 'tag' ? 'tag' : 'folder';
    // Safe-record-id entries only, bounded: each id reaching reduceDrop can mint a synced record.
    const ids = obj.sourceChatIds
      .filter((v): v is string => isSafeRecordId(v))
      .slice(0, MAX_DROP_IDS);
    const targetId = typeof obj.targetId === 'string' ? obj.targetId : undefined;
    return { type: 'drop', sourceChatIds: ids, targetKind: kind, targetId };
  }
  if (obj.type === 'renameFolder' && typeof obj.folderId === 'string' && typeof obj.name === 'string') {
    // Free text persisted to the synced store, truncated at arrival; the store clamps again.
    return { type: 'renameFolder', folderId: obj.folderId, name: clampName(obj.name) };
  }
  if (obj.type === 'setFolderColor' && typeof obj.folderId === 'string') {
    // Strict #rrggbb only; anything else (such as a CSS url(...) token) becomes null, so a
    // color never reaches the --chip-color CSS sink unvalidated.
    const color = isValidColor(obj.color) ? obj.color : null;
    return { type: 'setFolderColor', folderId: obj.folderId, color };
  }
  if (obj.type === 'deleteFolder' && typeof obj.folderId === 'string') {
    return { type: 'deleteFolder', folderId: obj.folderId };
  }
  if (obj.type === 'createFolder') {
    // Untrusted input: a non-empty trimmed string, else undefined so the command prompts.
    // Truncated to the shared free-text cap like renameFolder.
    const name =
      typeof obj.name === 'string' && obj.name.trim().length > 0
        ? clampName(obj.name.trim())
        : undefined;
    return { type: 'createFolder', name };
  }
  if (obj.type === 'newSession') {
    return { type: 'newSession' };
  }
  if (obj.type === 'openArchive') {
    return { type: 'openArchive' };
  }
  if (obj.type === 'restoreChat' && typeof obj.sessionId === 'string') {
    // A plain string reference; the handler no-ops on an empty id.
    return { type: 'restoreChat', sessionId: obj.sessionId };
  }
  if (obj.type === 'starUnarchive' && typeof obj.sessionId === 'string') {
    return { type: 'starUnarchive', sessionId: obj.sessionId };
  }
  if (obj.type === 'previewArchivedChat' && typeof obj.sessionId === 'string') {
    // A plain string reference for the archived-copy reader.
    return { type: 'previewArchivedChat', sessionId: obj.sessionId };
  }
  if (obj.type === 'toggleStar' && typeof obj.sessionId === 'string') {
    return { type: 'toggleStar', sessionId: obj.sessionId, starred: obj.starred === true };
  }
  if (
    obj.type === 'toggleTag' &&
    typeof obj.sessionId === 'string' &&
    typeof obj.tagId === 'string'
  ) {
    // Plain string references; `on` is coerced to a strict boolean.
    return { type: 'toggleTag', sessionId: obj.sessionId, tagId: obj.tagId, on: obj.on === true };
  }
  if (
    obj.type === 'createTagWithColor' &&
    typeof obj.sessionId === 'string' &&
    typeof obj.label === 'string'
  ) {
    // Strict #rrggbb only, so a color never reaches the --tag-color CSS sink unvalidated. The
    // label is rendered only as textContent.
    const color = isValidColor(obj.color) ? obj.color : null;
    // Free text persisted to the synced store, truncated at arrival; upsertTag clamps again.
    return {
      type: 'createTagWithColor',
      sessionId: obj.sessionId,
      label: clampName(obj.label),
      color,
    };
  }
  if (obj.type === 'exportChat' && typeof obj.sessionId === 'string') {
    // Anything but 'json' becomes 'markdown', so a tampered value cannot pick an unknown formatter.
    const format: 'markdown' | 'json' = obj.format === 'json' ? 'json' : 'markdown';
    return { type: 'exportChat', sessionId: obj.sessionId, format };
  }
  if (obj.type === 'archiveChat' && typeof obj.sessionId === 'string') {
    return { type: 'archiveChat', sessionId: obj.sessionId };
  }
  if (obj.type === 'setAutoArchiveWindow') {
    // Accepted as a finite number; onSetAutoArchiveWindow revalidates it, and NaN maps to the default.
    const days =
      typeof obj.days === 'number'
        ? obj.days
        : typeof obj.days === 'string' && /^\d+$/.test(obj.days.trim())
          ? Number(obj.days.trim())
          : NaN;
    return { type: 'setAutoArchiveWindow', days };
  }
  if (obj.type === 'setSectionsVisible') {
    // Strict booleans only; a missing value stays undefined so the handler merges rather than clears.
    const asBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
    return {
      type: 'setSectionsVisible',
      starred: asBool(obj.starred),
      questions: asBool(obj.questions),
      folders: asBool(obj.folders),
      unsorted: asBool(obj.unsorted),
    };
  }
  if (obj.type === 'setActive') {
    return coerceSetActive(obj);
  }
  if (obj.type === 'setState') {
    // Safe record-id entries only, bounded, so a tampered message cannot persist an unbounded blob.
    const collapsedFolders = Array.isArray(obj.collapsedFolders)
      ? obj.collapsedFolders
          .filter((v): v is string => isSafeRecordId(v))
          .slice(0, MAX_COLLAPSED_FOLDERS)
      : undefined;
    // Closed vocabulary, so an arbitrary string is never persisted.
    const sort =
      typeof obj.sort === 'string' && SORT_VALUES.has(obj.sort) ? obj.sort : undefined;
    return {
      type: 'setState',
      sort,
      collapsedFolders,
    };
  }
  return null;
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
