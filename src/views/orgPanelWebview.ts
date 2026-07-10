import * as vscode from 'vscode';
import { ChatRecord } from '../model/types';
import { scanChats } from '../claude/chatScanner';
import { readTranscriptBodies } from '../claude/bodyReader';
import { MetadataStore } from '../store/metadataStore';
import { ProjectMeta, clampName, isSafeRecordId, isValidColor } from '../store/schema';
import { OPEN_CHAT_COMMAND } from '../launch/uriLauncher';
import { PREVIEW_ARCHIVED_CHAT_COMMAND } from '../commands/previewChatCommand';
import { tokenBadge } from './chatTooltip';
import { relativeTime, relativeTimeCompact } from './relativeTime';
import { buildSections, buildArchivedRows, OrgSections, isArchived } from './orgPanelModel';
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

// The PRIMARY org-panel WebviewView (slice s2-org-panel-webview), promoted from
// the chatsPreview proof-of-concept to the main organization surface. It renders
// the section model (Starred, Questions heuristic, the folder hierarchy with
// per-folder color, Unsorted), tag filter chips, sort and density controls,
// double-click folder rename, and webview drag-and-drop that REUSES the unchanged
// pure dropReducer through webviewDropAdapter (the DnD-shell-only contract).
// Since slice s3a-view-consolidation this panel is the SOLE browsing surface
// (UI-SPEC.md deviation 5): the native flat Chats and Smart Groups trees are
// retired like the Folders and Tags trees before them, and this panel's own
// keyboard + ARIA tree implementation is the accessibility story.
//
// Build contract honored:
// - CSP-locked, nonce-scripted, localResourceRoots pinned to the media dir; the
//   webview loads only its own nonce'd script and the cspSource stylesheet.
// - The section assembly is a PURE, vscode-free module (orgPanelModel.ts); this
//   host scans, reads the store, calls buildSections, and posts the plain result.
// - DnD interpretation stays in the unchanged reduceDrop via webviewDropAdapter;
//   this host only forwards the self-describing drop message. The cross-tree
//   dragContext stash is NOT consulted (a webview drag is fully in-process).
// - Content search reuses the durable host-side search machinery slice 2 built
//   (searchIndex + searchStore), the same two-phase warm-then-body upgrade the
//   POC used, so search keeps working on the primary surface.

export const ORG_PANEL_VIEW = 'claudeNest.orgPanel';

// The Settings command id. Since slice s3b-settings-overlay the Settings sub-page is
// an IN-PANEL overlay in this webview (not a separate WebviewPanel), so the command
// reveals the org panel and opens the overlay rather than creating a panel. The id is
// unchanged (package.json, activationEvents, the two view/title menu homes) so the
// gear command keeps working; only its behavior moved into the panel. Its former home
// (the retired src/settings/settingsWebview.ts) is deleted this slice.
export const OPEN_SETTINGS_COMMAND = 'claudeNest.openSettings';

// How many transcript bodies to read between yields to the host event loop during
// the phase-2 body-index build, so a large projects dir cannot freeze the UI.
const BODY_READ_CHUNK = 20;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// A search result row posted to the webview: the matched chat id, its title and
// relative time, the ~token badge, the matched snippet, and the 0-based rank.
interface SearchRow {
  sessionId: string;
  title: string;
  description: string;
  timestamp: number | null;
  tokens: string;
  snippet: string | null;
  rank: number;
}

// Messages the webview posts to the host. ready/refresh/open/search mirror the
// POC; drop carries an in-panel drag-and-drop (the adapter maps it to the reducer);
// renameFolder applies an in-place folder rename; setFolderColor sets/clears a
// folder color; setState persists the user's sort choice and collapsed set;
// newSession requests a best-effort new Claude Code chat; openArchive surfaces the
// interim Archive view. The Settings sub-page is an IN-PANEL overlay opened
// client-side (the gear) or by the palette command via openSettingsOverlay(), so the
// client no longer posts an 'openSettings' message; setAutoArchiveWindow and
// setSectionsVisible persist the overlay's controls on workspaceState (slice
// s3b-settings-overlay, issue #86). Density was removed in slice s3a-design-shell
// (the design has a single row density), so setState no longer carries it.
type Inbound =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'open'; sessionId: string }
  | { type: 'search'; query: string }
  | { type: 'drop'; sourceChatIds: string[]; targetKind: 'folder' | 'tag'; targetId: string | undefined }
  | { type: 'renameFolder'; folderId: string; name: string }
  | { type: 'setFolderColor'; folderId: string; color: string | null }
  | { type: 'deleteFolder'; folderId: string }
  | { type: 'createFolder'; name?: string }
  | { type: 'newSession' }
  // Open the in-panel Archive overlay (slice s3b-archive-overlay, issue #87). The host
  // answers by posting the current archived rows ('archivedRows'); the client renders the
  // overlay. Repointed from the interim tree focus (which this slice retires).
  | { type: 'openArchive' }
  // Restore an archived chat from the overlay's Restore button (issue #87 AC #3): clears
  // the synced userArchived flag (keeps the star). The host resolves the record from its
  // scan cache (real filePath when present, empty when the transcript was cleaned up) and
  // routes to the EXISTING restoreChat curation command.
  | { type: 'restoreChat'; sessionId: string }
  // Star-unarchive from the overlay (issue #87 AC #4): starring an archived chat also
  // un-archives it. Routes to setChatStarred(true) + setChatArchived(false) through the
  // existing star + restore seams, so no new write path is introduced.
  | { type: 'starUnarchive'; sessionId: string }
  // Preview an archived chat's Nest-owned body copy from the overlay row (issue #87 AC #6).
  // Routes to the EXISTING claudeNest.previewArchivedChat command (the archived-copy read
  // path), so a cleaned-up chat is still readable from the overlay. sessionId only.
  | { type: 'previewArchivedChat'; sessionId: string }
  | { type: 'toggleStar'; sessionId: string; starred: boolean }
  // The right-click context menu's tag toggle (slice s3b-context-menu, issue #85 AC #1):
  // set/clear a tag on a chat. `on` is the DESIRED next state; the host routes it to
  // store.addChatTag / removeChatTag. Both ids are validated as strings at coerce().
  | { type: 'toggleTag'; sessionId: string; tagId: string; on: boolean }
  // The context menu's in-panel create-tag-with-color flow (issue #85 AC #2): mint a new
  // tag with the typed label and a chosen swatch color, then apply it to the chat. The
  // color is a HANDOFF_PALETTE literal or null, re-validated via isValidColor at coerce()
  // exactly like setFolderColor before it can reach the store or a CSS sink.
  | { type: 'createTagWithColor'; sessionId: string; label: string; color: string | null }
  // The context menu's Export as Markdown / JSON entries (issue #85 AC #3). Carries ONLY
  // the sessionId; the host resolves the transcript filePath from its scan cache and
  // routes to the SAME exportChat pipeline (save dialog + exportIO chokepoint + guard).
  | { type: 'exportChat'; sessionId: string; format: 'markdown' | 'json' }
  // The context menu's Archive chat entry (issue #85 AC #4). Carries ONLY the sessionId;
  // the host resolves the filePath from its scan cache and routes to the SAME archiveChat
  // pipeline (synced flag + read-only Nest-owned body copy).
  | { type: 'archiveChat'; sessionId: string }
  // The Settings overlay's controls (slice s3b-settings-overlay, issue #86). The
  // auto-archive window (in DAYS; 0 = Never) and the four section-visibility toggles
  // persist on workspaceState through the EXISTING stateStore (new _KEY constants),
  // never on ProjectMeta and never synced (AC #7, Non-goals). Setting the window also
  // triggers a fresh auto-archive pass so a shortened window applies without a reload.
  | { type: 'setState'; sort?: string; collapsedFolders?: string[] }
  | { type: 'setAutoArchiveWindow'; days: number }
  | {
      type: 'setSectionsVisible';
      starred?: boolean;
      questions?: boolean;
      folders?: boolean;
      unsorted?: boolean;
    };

// The injectable command seams the org panel needs, wired in extension.ts to the
// existing store/command paths so the webview never couples to the command layer
// or re-implements a mutation. Each returns once the change is staged and the
// affected views are refreshed (the wiring closure flushes + refreshes + schedules
// the opt-in auto-export, exactly like the native command path).
export interface OrgPanelActions {
  renameFolder(folderId: string, name: string): Promise<void> | void;
  setFolderColor(folderId: string, color: string | null): Promise<void> | void;
  // Delete a folder. The implementation shows the real modal confirmation and
  // runs the store's deleteFolder cascade (which unfiles the folder's chats, never
  // deletes a chat), then refreshes. The webview only requests it.
  deleteFolder(folderId: string): Promise<void> | void;
  // Create a new folder. The design's FOLDERS header carries a + button that opens
  // an in-panel "New folder" popover (issue #82 AC3); the popover posts the typed
  // name, which arrives here so the create skips the native input box. When name is
  // omitted (a legacy/no-name path) the underlying command prompts as before. Either
  // way the shared refresh re-renders the panel. The webview only requests it.
  createFolder(name?: string): Promise<void> | void;
  // Launch a NEW Claude Code chat, best-effort (UI-SPEC.md data mapping, deviation
  // 6). The wiring routes this to the probed claude-vscode.newConversation
  // contributed command with a graceful fallback + toast; the webview only requests
  // it. See DECISIONS.md slice s3a-design-shell.
  newSession(): Promise<void> | void;
  // Load the stored body-copy titles for archived chats whose live transcript was
  // cleaned up out of band (slice s3b-archive-overlay, issue #87). Keyed by sessionId;
  // the wiring reads the Nest-owned body copies (readArchivedBody) so a missing-transcript
  // archived row shows its stored title instead of a raw UUID (patch item 3). Returns an
  // empty map when no copies are readable; the overlay falls back to the sessionId. The
  // present-chat rows do not need this (their title rides the scan). Async and best-effort.
  loadArchivedTitles(): Promise<Map<string, string>>;
  // Restore an archived chat from the overlay (issue #87 AC #3): clears the synced
  // userArchived flag, keeps the star, and (when the live transcript survives) deletes the
  // now-redundant body copy. Routes to the EXISTING restoreChat curation command via a
  // record resolved from the scan cache; a copy-only (gone-transcript) chat passes an empty
  // filePath so the command keeps the copy. The webview only requests it by sessionId.
  restoreArchivedChat(sessionId: string): Promise<void> | void;
  // Run one auto-archive pass now (slice s3b-settings-overlay, issue #86 AC #4). The
  // wiring routes this to the batched auto-archive engine over the current auto-archive
  // window and refreshes; the webview requests it after the user changes the window in
  // the Settings overlay so a shortened window applies without a window reload. A no-op
  // when auto-archiving is disabled (Never) or nothing is past the window.
  runAutoArchive(): Promise<void> | void;
  // Toggle a chat's synced ChatMeta.starred and persist immediately (AC: "Star click
  // persists immediately through the store"). The wiring routes this to the existing
  // star/unstar curation commands (store.setChatStarred + flush + refresh), so the
  // webview never invents a write path. `starred` is the DESIRED next state.
  setStarred(sessionId: string, starred: boolean): Promise<void> | void;
  // Set or clear a tag on a chat from the context menu (issue #85 AC #1). `on` is the
  // DESIRED next state; the wiring routes it to store.addChatTag / removeChatTag (which
  // coalesce into one pending write) + flush + refresh, mirroring setStarred, so the
  // webview never invents a mutation. Both ids are validated as strings at coerce().
  toggleChatTag(sessionId: string, tagId: string, on: boolean): Promise<void> | void;
  // Mint a NEW tag with a label and an optional color and apply it to the chat (issue
  // #85 AC #2). The existing createTag command opens a modal prompt and mints a COLORLESS
  // tag, so it cannot satisfy the in-panel name + swatch create-with-color flow. This
  // seam mints via mintTagId, upserts a Tag with an isValidColor-validated color, and
  // addChatTags it, then flushes and refreshes. color is a palette literal or null (the
  // host already re-validated it at coerce()). The webview only requests it.
  createTagWithColor(sessionId: string, label: string, color: string | null): Promise<void> | void;
  // Export ONE chat to Markdown or JSON from the context menu (issue #85 AC #3),
  // resolving the chat by its sessionId. The wiring resolves the transcript record and
  // routes to the EXISTING exportChat pipeline (save dialog + exportIO chokepoint +
  // projects-path guard), so the read-only invariant holds and the webview never touches
  // the filesystem. A missing/unresolvable id is a no-op.
  exportChat(sessionId: string, format: ExportFormat): Promise<void> | void;
  // Archive ONE chat from the context menu (issue #85 AC #4), resolving the chat by its
  // sessionId. The wiring routes to the EXISTING archiveChat pipeline (synced
  // userArchived flag + a read-only Nest-owned body copy). A missing/unresolvable id is a
  // no-op. The client only shows this entry when the chat is neither starred nor archived.
  archiveChat(sessionId: string): Promise<void> | void;
}

// The export format the context menu requests. Mirrors exportChatCommands.ExportFormat
// (markdown | json); named locally so the webview host does not import the command
// module's type surface for one union.
export type ExportFormat = 'markdown' | 'json';

// The persisted view-state keys (Memento) for the user's sort and density choice,
// so the panel reopens in the same mode. Stored on workspaceState by the wiring.
export interface OrgPanelStateStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

// The per-device read-state seam the panel needs (backed by readState.ts's
// ReadStateStore in the host). getMap feeds the pure buildSections; markSeen clears a
// chat's unread affordance on a clear trigger (open-via-Nest, matching-tab focus);
// seedIfFirstRun marks every chat present at the FIRST scan as already read (issue
// #123) so pre-existing chats do not all show unread. LOCAL and NEVER synced
// (UI-SPEC.md "Read state").
export interface OrgPanelReadState {
  getMap(): Map<string, number>;
  markSeen(sessionId: string, at?: number): void;
  seedIfFirstRun(records: ReadonlyArray<{ sessionId: string; timestamp: number | null }>): boolean;
}

const SORT_KEY = 'claudeNest.orgPanel.sort';
// The collapsed-folder set, persisted per workspace as a JSON-encoded string array
// of folder ids (issue #64). Workspace-local and NEVER synced, exactly like sort
// and density: it lives only on workspaceState through stateStore and is never
// added to setKeysForSync or the nest.meta.v1 sync surface.
const COLLAPSED_KEY = 'claudeNest.orgPanel.collapsedFolders';
// The auto-archive window in DAYS (slice s3b-settings-overlay, issue #86). Persisted
// per workspace on workspaceState through the same stateStore, NEVER on ProjectMeta
// and never synced (AC #7, Non-goals). Stored as the string form of the day count; 0
// is the Never sentinel. When unset the effective default is the Claude
// cleanupPeriodDays (30 when Claude itself is unset), resolved by the wiring.
const AUTO_ARCHIVE_WINDOW_KEY = 'claudeNest.orgPanel.autoArchiveWindowDays';
// The four section-visibility toggles (Starred, Questions, Folders, Unsorted), all ON
// by default (AC #3). Persisted per workspace as a JSON object of booleans on
// workspaceState, never on ProjectMeta and never synced. Disabling Unsorted only hides
// the SECTION; search and chips still reach every unfiled chat, so no chat is ever
// made unreachable (AC #3, enforced client-side).
const SECTIONS_VISIBLE_KEY = 'claudeNest.orgPanel.sectionsVisible';

// The section-visibility toggle set. Every toggle defaults to true (all sections ON).
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

export class OrgPanelProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  // The in-memory content-search index, built lazily on the first content query
  // and cached until refresh(). Holds search TOKENS only (raw bodies read on
  // demand, indexed, discarded); never persisted here, never in the scan
  // snapshot. Advances two phases: a warm TIER-A index, then a body-indexed
  // upgrade. Always the BEST available index.
  private contentIndex: ReturnType<typeof buildIndex> | null = null;
  private tierAReady: Promise<ReturnType<typeof buildIndex> | null> | null = null;
  private bodyReady: Promise<ReturnType<typeof buildIndex> | null> | null = null;
  private bodyIndexReady = false;
  private indexedRecords: Map<string, ChatRecord> = new Map();
  private buildGeneration = 0;

  // The currently-open chat's sessionId, resolved best-effort by the host's tab-label
  // match (UI-SPEC.md deviation 4). Held here so it survives webview re-renders and is
  // re-posted on 'ready'; null when no active chat can be identified (then no row is
  // tinted). This is the ONLY row tint (starred rows are NOT tinted).
  private activeChatId: string | null = null;

  // Cached sessionId->filePath map from the MOST RECENT scan, so resolveRecord (the
  // context menu's export/archive path) can resolve a chat's transcript path WITHOUT a
  // fresh full-directory rescan+reparse per action. The scan that buildSectionModel/
  // scanRecords already performs on a discrete user action or refresh seeds this;
  // refresh() clears it (invalidateContentIndex) so a stale path is never served.
  // Holds ONLY the file path per session (no bodies): a transcript is still read ONCE
  // on demand and discarded (ARCHITECTURE.md tier-A rule). Empty until the first scan;
  // resolveRecord falls back to one scan only when it is empty.
  private previewPathBySession: Map<string, string> = new Map();

  // Set when openSettingsOverlay() is called before the webview has resolved and sent
  // 'ready' (the palette/view-title Settings command path: focusing the view is async,
  // so the open message would post to an unresolved webview and be dropped). The 'ready'
  // handler consumes this flag and opens the overlay once the client is listening.
  private pendingOpenSettings = false;

  // Set when openArchiveOverlay() is called before the webview has resolved (the
  // auto-archive toast's "Open Archive" path, issue #87). Focusing the view is async, so an
  // open message posted to an unresolved webview is dropped; the 'ready' handler consumes
  // this flag and opens the overlay once the client is listening. Mirrors pendingOpenSettings.
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
    // The effective DEFAULT auto-archive window in days when the user has not chosen
    // one (slice s3b-settings-overlay, issue #86 AC #2): the effective Claude
    // cleanupPeriodDays, 30 when Claude itself is unset. Injected so this vscode-thin
    // view does not read settings.json itself; the wiring passes a resolver over
    // readCleanupPeriodDays. Defaults to CLAUDE_DEFAULT (30) when not supplied.
    private readonly effectiveAutoArchiveDefault: () => number = () => 30,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
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
  }

  // Re-post the section model. Called by the wiring's refresh closure after any
  // store mutation (folder/tag/curation change, a drop) so the panel re-renders.
  refresh(): void {
    this.invalidateContentIndex();
    this.postSections();
  }

  private onMessage(msg: Inbound): void {
    if (msg.type === 'ready') {
      this.postState();
      this.postSettings();
      this.postSections();
      this.postActive();
      // A Settings-open requested while the webview was still resolving (the palette
      // command path) is honored now that the client is listening.
      if (this.pendingOpenSettings) {
        this.pendingOpenSettings = false;
        this.postOpenSettings();
      }
      // An Archive-open requested while the webview was still resolving (the auto-archive
      // toast path) is honored now that the client is listening.
      if (this.pendingOpenArchive) {
        this.pendingOpenArchive = false;
        void this.postArchivedRows();
        this.postOpenArchive();
      }
    } else if (msg.type === 'refresh') {
      this.refresh();
    } else if (msg.type === 'open') {
      void vscode.commands.executeCommand(OPEN_CHAT_COMMAND, msg.sessionId);
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
      // Preview the archived body copy from the overlay row (issue #87 AC #6). Route to the
      // existing command with the sessionId; a missing copy surfaces an info notice there.
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
    } else if (msg.type === 'setAutoArchiveWindow') {
      this.onSetAutoArchiveWindow(msg.days);
    } else if (msg.type === 'setSectionsVisible') {
      this.onSetSectionsVisible(msg);
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

  // Restore an archived chat from the overlay (issue #87 AC #3). Routes to the existing
  // restoreChat curation command, then re-posts the archived rows so the overlay drops the
  // restored chat immediately (the shared refresh also re-renders the tree, where the chat
  // reappears under its folder or Unsorted). An empty id is ignored.
  private async onRestoreChat(sessionId: string): Promise<void> {
    if (sessionId.length === 0) {
      return;
    }
    await this.actions.restoreArchivedChat(sessionId);
    await this.postArchivedRows();
  }

  // Star-unarchive from the overlay (issue #87 AC #4: starring an archived chat un-archives
  // it). Set the synced star, then restore (clear userArchived). Both route through the
  // existing coerced seams; the star is applied FIRST so the restore's copy handling reads
  // the current star, then the overlay rows are re-posted so the chat leaves the list. An
  // empty id is ignored.
  private async onStarUnarchive(sessionId: string): Promise<void> {
    if (sessionId.length === 0) {
      return;
    }
    await this.actions.setStarred(sessionId, true);
    await this.actions.restoreArchivedChat(sessionId);
    await this.postArchivedRows();
  }

  // Build and post the Archive overlay's rows (issue #87). Membership is the SYNCED
  // userArchived flag via the pure buildArchivedRows; present-chat titles/ages ride the
  // scan, and a missing-transcript archived chat's title falls back to its stored body-copy
  // title (loaded async via the wiring). Tolerant: no workspace/project posts an empty list
  // so the overlay renders its "Nothing archived." empty state rather than throwing.
  private async postArchivedRows(): Promise<void> {
    if (this.view === undefined) {
      return;
    }
    const records = this.scanRecords();
    const projectKey = this.getProjectKey();
    const meta: ProjectMeta | undefined =
      projectKey !== undefined ? this.store.getProjectMeta(projectKey) : undefined;
    // Load the stored copy titles ONLY when at least one archived chat is missing from the
    // scan (a gone transcript); a fully-present set needs no async copy read. buildArchivedRows
    // is pure and total, so a failed title load degrades to the sessionId fallback.
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

  // Apply an in-panel drop through the adapter (which runs the UNCHANGED reducer
  // and applies the intents as one coalesced write). The adapter's deps fire the
  // shared refresh closure, which calls this.refresh() among the other views, so
  // no extra re-post is needed here.
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

  // Persist the auto-archive window (in days) and run a fresh auto-archive pass so a
  // shortened window applies immediately (issue #86 AC #2/#4). The value is
  // re-validated through the pure coercer (allowed enum, else the effective default)
  // before it is stored, so a tampered webview value can never persist an arbitrary
  // window. Re-post the settings state so the overlay reflects the coerced value.
  private onSetAutoArchiveWindow(days: number): void {
    const coerced = coerceAutoArchiveWindowDays(days, this.effectiveAutoArchiveDefault());
    this.stateStore.set(AUTO_ARCHIVE_WINDOW_KEY, String(coerced));
    this.postSettings();
    // A shortened window may now sweep chats that were within the old window; run the
    // pass. runAutoArchive is a no-op when disabled (Never) or nothing is past-window.
    void this.actions.runAutoArchive();
  }

  // Persist the section-visibility toggles (issue #86 AC #3). Merges the supplied
  // partial over the current set so a single-toggle post does not clear the others.
  // Client-side render gates only: they never touch membership or the store, so an
  // unfiled chat stays reachable via search/chips even with Unsorted hidden.
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

  // The current auto-archive window in days: the persisted value coerced through the
  // pure coercer, falling back to the effective Claude cleanupPeriodDays default when
  // unset or invalid.
  private readAutoArchiveWindowDays(): number {
    return coerceAutoArchiveWindowDays(
      this.stateStore.get(AUTO_ARCHIVE_WINDOW_KEY),
      this.effectiveAutoArchiveDefault(),
    );
  }

  // The current auto-archive window in days, exposed for the wiring's engine pass so
  // the host and the overlay agree on the window without re-reading the memento in two
  // places.
  autoArchiveWindowDays(): number {
    return this.readAutoArchiveWindowDays();
  }

  // The current section-visibility set. Tolerant: a missing, malformed, or non-object
  // persisted value yields the all-ON default so a corrupt memento never hides a
  // section or throws. Each field falls back to true independently.
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

  // Read and parse the persisted collapsed-folder id set. Tolerant: a missing,
  // malformed, or non-array value yields an empty list (nothing collapsed) so a
  // corrupt memento never throws or seeds a bogus state.
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
  }

  // Post the Settings overlay's state (slice s3b-settings-overlay, issue #86): the
  // current auto-archive window in days and the four section-visibility toggles, so
  // the overlay's select and pill switches render the persisted values. Both ride
  // workspaceState; nothing here reads or widens the synced surface.
  private postSettings(): void {
    if (this.view === undefined) {
      return;
    }
    void this.view.webview.postMessage({
      type: 'settings',
      autoArchiveWindowDays: this.readAutoArchiveWindowDays(),
      sectionsVisible: this.readSectionsVisible(),
    });
  }

  // Tell the client to OPEN the Settings overlay (a client-side render). Sent when the
  // palette/view-title Settings command fires (openSettingsOverlay); the gear opens the
  // overlay client-side without this round-trip.
  private postOpenSettings(): void {
    if (this.view === undefined) {
      return;
    }
    void this.view.webview.postMessage({ type: 'openSettings' });
  }

  // Focus the org panel and open the Settings overlay. Wired to the retained
  // claudeNest.openSettings palette/view-title command: the Settings sub-page lives
  // INSIDE this webview (not a separate panel), so the command reveals the panel and
  // posts the open + fresh settings state. When the view has NOT resolved yet (the
  // panel was closed when the command fired; focusing it is async), the post messages
  // would be dropped, so we set pendingOpenSettings and let the 'ready' handler open
  // the overlay once the client is listening. When the view is already resolved this
  // posts immediately.
  openSettingsOverlay(): void {
    if (this.view === undefined) {
      this.pendingOpenSettings = true;
      return;
    }
    this.postSettings();
    this.postOpenSettings();
  }

  // Tell the client to OPEN the Archive overlay (a client-side render). Sent by the
  // auto-archive toast's "Open Archive" action via openArchiveOverlay.
  private postOpenArchive(): void {
    if (this.view === undefined) {
      return;
    }
    void this.view.webview.postMessage({ type: 'openArchive' });
  }

  // Reveal the org panel and open the Archive overlay (issue #87), for the auto-archive
  // toast's "Open Archive" action now that the Archive tree is retired. Posts the archived
  // rows and the open message; when the view has NOT resolved yet the messages would be
  // dropped, so pendingOpenArchive defers to the 'ready' handler, mirroring
  // openSettingsOverlay. The caller focuses the view first (executeCommand focus).
  openArchiveOverlay(): void {
    if (this.view === undefined) {
      this.pendingOpenArchive = true;
      return;
    }
    void this.postArchivedRows();
    this.postOpenArchive();
  }

  // Scan, read the store, and assemble the section model via the pure builder.
  // Tolerant: no workspace/project, or a failed scan, yields empty sections (the
  // webview renders its empty state) rather than throwing.
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
      records = scanChats(this.workspacePath);
    } catch {
      return empty;
    }
    this.cachePreviewPaths(records);
    // One-time read-state seed (issue #123): the first scan of this workspace marks
    // every existing chat as already read, so a fresh install does not light the
    // unread dot on months-old chats. No-op on every scan after the flag is set.
    this.readState.seedIfFirstRun(records);
    const projectKey = this.getProjectKey();
    const meta: ProjectMeta | undefined =
      projectKey !== undefined ? this.store.getProjectMeta(projectKey) : undefined;
    return buildSections(records, meta, tokenBadge, this.readState.getMap());
  }

  // Scan the current records and return them, tolerant of no workspace or a failed
  // scan (empty list). Used by the tab-focus clear trigger to resolve a focused
  // Claude tab's label to a chat by title without a second scan path.
  scanRecords(): ChatRecord[] {
    if (this.workspacePath === undefined) {
      return [];
    }
    try {
      const records = scanChats(this.workspacePath);
      this.cachePreviewPaths(records);
      return records;
    } catch {
      return [];
    }
  }

  // Refresh the sessionId->filePath cache from a completed scan. Called by every scan
  // site (buildSectionModel, scanRecords) so resolveRecord can resolve a transcript
  // path without its own full rescan. Overwrites wholesale so a deleted/renamed
  // transcript never lingers.
  private cachePreviewPaths(records: ChatRecord[]): void {
    this.previewPathBySession = new Map(records.map((r) => [r.sessionId, r.filePath]));
  }

  // Clear a chat's unread affordance (open-via-Nest and matching-tab-focus triggers,
  // UI-SPEC.md "Read state"). Stamps lastSeenAt for the chat and re-posts the section
  // model so the '?' badge / unread dot clears immediately. Best-effort: an empty id
  // is ignored by the store.
  markChatSeen(sessionId: string): void {
    this.readState.markSeen(sessionId);
    this.postSections();
  }

  // Set the currently-open chat (best-effort tab-label match, UI-SPEC.md deviation 4)
  // and post it so the webview tints exactly that row. null clears any tint. Returns
  // true when the value CHANGED (false when unchanged), so the caller can gate a
  // re-scan/mark-seen on an actual change and a tab-change storm does not thrash the
  // webview or trigger a scan per event.
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

  // Resolve a scanned ChatRecord by sessionId for the context menu's export/archive
  // actions (issue #85 AC #3/#4), which arrive from the webview with ONLY a sessionId.
  // The chat's real transcript filePath is REQUIRED downstream: exportChat reads the body
  // to render, and archiveChat reads the body to save the Nest-owned copy; a bare
  // sessionId (an empty filePath) would export a body-less document and archive with no
  // copy. Resolve from the cheap previewPathBySession cache (seeded by every scan, cleared
  // on invalidateContentIndex), falling back to ONE scan only when the cache lacks the id.
  // Never re-scans per action when the cache is warm; no new scan path is added. Returns
  // undefined for an empty/unknown id (the caller no-ops).
  resolveRecord(sessionId: string): ChatRecord | undefined {
    if (sessionId.length === 0) {
      return undefined;
    }
    if (this.previewPathBySession.has(sessionId) || this.previewPathBySession.size === 0) {
      return this.scanRecords().find((r) => r.sessionId === sessionId);
    }
    // The cache is warm but does not carry this id: the chat is not currently scanned
    // (e.g. its transcript was cleaned up), so there is no record to export/archive.
    return undefined;
  }

  // ---- Content search (reused from the POC; durable logic in src/search/*) ----

  private async postSearch(query: string): Promise<void> {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      this.postSearchResults('', []);
      return;
    }
    // Stamp this search with the build generation live at entry. Each result post
    // that runs after an await is gated on the generation still matching, mirroring
    // the build-phase guards (buildTierAIndex/upgradeToBodyIndex): if
    // invalidateContentIndex() runs during an await it bumps buildGeneration and
    // clears indexedRecords, so the awaited (now stale) index would rank to zero rows
    // and post an EMPTY result for the query still in the box, blanking valid hits
    // with no recovery. Skipping the post leaves the client's prior fresh results in
    // place; the refresh's postSections re-render keeps showing the real match.
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
      // Snippet ONLY on a body-only match: a chat whose TITLE contains the query
      // shows no snippet (issue #83 AC #1; the prototype's
      // `q && !c.title.toLowerCase().includes(q)` gate). A body-only match shows the
      // role-prefixed snippet buildRoleSnippet produced; a title match sends null so
      // the client renders no snippet row under it.
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
      records = scanChats(this.workspacePath);
    } catch {
      return null;
    }
    if (generation !== this.buildGeneration) {
      return null;
    }
    // Exclude user-archived chats from the content-search index by the SAME synced
    // predicate buildSections uses to drop them from the visible sections. Filtering
    // HERE (the sole feeder) sweeps every downstream search sink at once: the
    // MiniSearch index (tier-A and body), the persisted tier-A cache, the 50-hit
    // search() cap, and the rankRows join. Without it, archived chats are indexed and
    // rank into the top 50 on a common term, then the client silently drops them when
    // it joins hits to the archived-excluded rows, so genuine live matches ranked
    // beyond 50 never surface. Archiving leaves the transcript on disk (the Nest body
    // copy is what curationCommands cleans up), so archived chats remain scannable and
    // would otherwise keep getting indexed. Meta is read via the same
    // getProjectKey()+store.getProjectMeta idiom buildSectionModel uses.
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

  // Read one chat's message bodies and concatenate them into the role-labeled body
  // string docFromRecord splits into the index text and the snippet source. Each
  // genuine turn is PREFIXED with its role label ("You: " / "Claude: ") and turns
  // are joined with '\n'. docFromRecord then stores this labeled text verbatim as
  // the (never-indexed) snippet source AND indexes a label-STRIPPED copy, so the
  // label words never become searchable tokens (a search for "claude"/"you" must
  // not match every chat) while buildRoleSnippet can still re-emit the label on a
  // body-match snippet (issue #83 AC #1) without the host re-reading the body at
  // query time. Each message's OWN internal whitespace (newlines in a multi-line
  // message, tabs, runs of spaces) is collapsed to single spaces FIRST, so every
  // message is exactly ONE newline-free segment: buildRoleSnippet splits the body
  // on '\n' to find the matched message, so a message must not itself contain a
  // newline or a match on a wrapped continuation line would lose its role prefix.
  // Bodies are read on demand and discarded here (the returned string is handed
  // straight to docFromRecord and never retained), preserving the tier-A "full body
  // never persisted" invariant: this feeds the IN-MEMORY body index only; the
  // persisted index is tier-A-only (searchStore.tierADocs).
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
    // Drop the hover-resolve path cache too: refresh() runs postSections right after
    // this, which re-scans and re-seeds it, so the cleared window is momentary and no
    // stale (deleted/renamed) transcript path is ever served to a hover.
    this.previewPathBySession.clear();
  }

  private renderHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const nonce = makeNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'orgPanel.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'orgPanel.css'));
    const cspSource = webview.cspSource;
    const csp = [
      "default-src 'none'",
      `style-src ${cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${cspSource}`,
    ].join('; ');
    // The toolbar (New session, gear, sort), the search box, the chip rail, and the
    // tree container are static shells rebuilt to the design handoff (media/design/,
    // UI-SPEC.md; slice s3a-design-shell, issue #80). orgPanel.js renders the section
    // content into #list, the chips into #chips, drives the sort popover, and owns all
    // keyboard/ARIA wiring; role="tree" plus the roving-tabindex management live in the
    // script (ARIA tree semantics are an acceptance criterion, UI-SPEC.md deviation 5).
    // scripts/fidelity/harness.html keeps a byte-aligned copy of this exact shell; any
    // change here MUST be mirrored there or the fidelity harness wiring breaks.
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link href="${styleUri}" rel="stylesheet" />
</head>
<body>
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
  <div class="nest-search">
    <span class="nest-search-icon" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.6"/><line x1="10.8" y1="10.8" x2="14.5" y2="14.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></span>
    <input id="filter" class="nest-filter" type="text" placeholder="Search chats &amp; messages" aria-label="Search chats and messages" />
    <button id="searchClear" class="nest-search-clear" type="button" title="Clear search" aria-label="Clear search" hidden>&#215;</button>
  </div>
  <div id="chips" class="nest-chips" role="group" aria-label="Tag filters"></div>
  <div id="list" class="nest-tree" role="tree" aria-label="Organized chats" tabindex="0"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

// The transient search query cap. The query only feeds the host-side in-memory
// index (never persisted, never a store or CSS sink), so the cap is generous; it
// exists so a tampered message cannot make the tokenizer chew a multi-megabyte
// string per keystroke.
const MAX_SEARCH_QUERY_LENGTH = 512;

// The collapsed-folders persistence cap: entries must be safe record ids (<= 64
// chars, the shape every minted folder id has) and the array is bounded so a
// tampered message cannot persist an unbounded blob to workspaceState.
const MAX_COLLAPSED_FOLDERS = 5000;

// The closed sort vocabulary (matches the sort popover's data-sort values). A
// tampered setState message must not persist an arbitrary string to the
// workspaceState sort key.
const SORT_VALUES = new Set(['newest', 'oldest', 'name']);

// The drop-payload id cap. Each dropped id flows through reduceDrop into
// store.setChatFolder/addChatTag, whose ensureChat CREATES a ChatMeta record for
// any safe-shaped id it does not know, and every minted record lands in the
// SYNCED globalState document. A tampered webview message carrying an unbounded
// sourceChatIds array could therefore mint an unbounded number of phantom
// records into Settings Sync in one coalesced write. A legitimate drag selects
// visible rows, so the bound is generous; entries are also filtered to the safe
// record-id shape (<= 64 chars, the shape every real sessionId has), the same
// arrival-time defense collapsedFolders uses.
const MAX_DROP_IDS = 512;

function coerce(raw: unknown): Inbound | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const obj = raw as {
    type?: unknown;
    sessionId?: unknown;
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
  };
  if (obj.type === 'ready') {
    return { type: 'ready' };
  }
  if (obj.type === 'refresh') {
    return { type: 'refresh' };
  }
  if (obj.type === 'open' && isSafeRecordId(obj.sessionId)) {
    // The open id is the ONE webview-controlled id that reaches a PERSISTENCE
    // sink (OPEN_CHAT_COMMAND marks the chat seen, and ReadStateStore.markSeen
    // persists the id into the workspaceState lastSeenAt map), so it gets the
    // same arrival-time defense as drop ids and collapsedFolders: only the safe
    // record-id shape (<= 64 chars, the shape every real sessionId has) passes.
    // A tampered message carrying a multi-megabyte or garbage id is dropped
    // here, before it can grow the memento without bound.
    return { type: 'open', sessionId: obj.sessionId };
  }
  if (obj.type === 'search' && typeof obj.query === 'string') {
    // Cap the transient query so a tampered message cannot feed the tokenizer a
    // multi-megabyte string per keystroke (never persisted; host index only).
    return { type: 'search', query: obj.query.slice(0, MAX_SEARCH_QUERY_LENGTH) };
  }
  if (obj.type === 'drop' && Array.isArray(obj.sourceChatIds)) {
    const kind = obj.targetKind === 'tag' ? 'tag' : 'folder';
    // Accept only safe-record-id-shaped entries and bound the array (MAX_DROP_IDS):
    // every id reaching reduceDrop can mint a synced ChatMeta record via ensureChat,
    // so an unbounded/garbage array must be stopped at arrival, exactly the
    // collapsedFolders pattern.
    const ids = obj.sourceChatIds
      .filter((v): v is string => isSafeRecordId(v))
      .slice(0, MAX_DROP_IDS);
    const targetId = typeof obj.targetId === 'string' ? obj.targetId : undefined;
    return { type: 'drop', sourceChatIds: ids, targetKind: kind, targetId };
  }
  if (obj.type === 'renameFolder' && typeof obj.folderId === 'string' && typeof obj.name === 'string') {
    // The name is free text persisted to the SYNCED store; truncate to the shared
    // cap (schema.MAX_NAME_LENGTH) at arrival so an unbounded string (giant paste
    // or tampered message) never rides further. The store sink clamps again
    // (defense in depth) with the same constant.
    return { type: 'renameFolder', folderId: obj.folderId, name: clampName(obj.name) };
  }
  if (obj.type === 'setFolderColor' && typeof obj.folderId === 'string') {
    // Accept only a strict #rrggbb color (isValidColor); anything else (including
    // a CSS token like url(...) a tampered webview message could carry) falls to
    // null, which the store treats as a clear. This mirrors the normalizeFolder
    // boundary so a color can never reach the --chip-color CSS sink unvalidated.
    const color = isValidColor(obj.color) ? obj.color : null;
    return { type: 'setFolderColor', folderId: obj.folderId, color };
  }
  if (obj.type === 'deleteFolder' && typeof obj.folderId === 'string') {
    return { type: 'deleteFolder', folderId: obj.folderId };
  }
  if (obj.type === 'createFolder') {
    // The popover's typed name is untrusted webview input: accept it only as a
    // non-empty trimmed string, else fall to undefined so the command prompts (and
    // the store/expansion still validate it downstream). The name is never used as a
    // CSS/HTML sink; it becomes a Folder.name through the same store path the native
    // command uses.
    // Truncated to the shared synced-store free-text cap like renameFolder.
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
    // sessionId is a record-id reference (used only to find a chat, never a CSS/HTML
    // sink); accept it as a plain string. The handler no-ops on an empty id.
    return { type: 'restoreChat', sessionId: obj.sessionId };
  }
  if (obj.type === 'starUnarchive' && typeof obj.sessionId === 'string') {
    return { type: 'starUnarchive', sessionId: obj.sessionId };
  }
  if (obj.type === 'previewArchivedChat' && typeof obj.sessionId === 'string') {
    // sessionId is a record-id reference handed to the archived-copy reader command,
    // never a CSS/HTML sink; accept it as a plain string.
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
    // sessionId and tagId are record- id references (used only to find a chat and a
    // tag, never a CSS/HTML sink); accept them as plain strings. `on` is the desired
    // next state, coerced to a strict boolean.
    return { type: 'toggleTag', sessionId: obj.sessionId, tagId: obj.tagId, on: obj.on === true };
  }
  if (
    obj.type === 'createTagWithColor' &&
    typeof obj.sessionId === 'string' &&
    typeof obj.label === 'string'
  ) {
    // The tag color is untrusted webview input: accept ONLY a strict #rrggbb color
    // (isValidColor); anything else (a CSS token like url(...) a tampered message could
    // carry, or an absent color) falls to null, exactly the setFolderColor boundary, so a
    // color can never reach a --tag-color CSS sink unvalidated. The label is trimmed and
    // length-checked at the handler; it becomes a Tag.label through the store path and is
    // rendered only as textContent.
    const color = isValidColor(obj.color) ? obj.color : null;
    // The label is free text persisted to the SYNCED store; truncate to the shared
    // cap at arrival (the store's upsertTag clamps again with the same constant).
    return {
      type: 'createTagWithColor',
      sessionId: obj.sessionId,
      label: clampName(obj.label),
      color,
    };
  }
  if (obj.type === 'exportChat' && typeof obj.sessionId === 'string') {
    // format is a closed union; anything but 'json' defaults to 'markdown' so a tampered
    // value cannot pick an unknown formatter.
    const format: 'markdown' | 'json' = obj.format === 'json' ? 'json' : 'markdown';
    return { type: 'exportChat', sessionId: obj.sessionId, format };
  }
  if (obj.type === 'archiveChat' && typeof obj.sessionId === 'string') {
    return { type: 'archiveChat', sessionId: obj.sessionId };
  }
  if (obj.type === 'setAutoArchiveWindow') {
    // The window arrives as a number (or numeric string) of days; accept it as a
    // finite number here and let onSetAutoArchiveWindow re-validate it through the
    // pure coercer (allowed enum, else the effective default) before it persists. A
    // non-numeric value is dropped to NaN, which the coercer maps to the default.
    const days =
      typeof obj.days === 'number'
        ? obj.days
        : typeof obj.days === 'string' && /^\d+$/.test(obj.days.trim())
          ? Number(obj.days.trim())
          : NaN;
    return { type: 'setAutoArchiveWindow', days };
  }
  if (obj.type === 'setSectionsVisible') {
    // Each toggle is accepted only as a strict boolean; a missing/other value stays
    // undefined so the handler merges it over the current set rather than clearing it.
    // These are render gates, never a store or CSS sink.
    const asBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
    return {
      type: 'setSectionsVisible',
      starred: asBool(obj.starred),
      questions: asBool(obj.questions),
      folders: asBool(obj.folders),
      unsorted: asBool(obj.unsorted),
    };
  }
  if (obj.type === 'setState') {
    // collapsedFolders entries are FOLDER IDS persisted to workspaceState: accept
    // only values in the safe record-id shape (<= 64 chars, the shape every minted
    // folder id has; a non-id or oversized string is untrusted garbage) and bound
    // the array, so a tampered message cannot persist an unbounded blob.
    const collapsedFolders = Array.isArray(obj.collapsedFolders)
      ? obj.collapsedFolders
          .filter((v): v is string => isSafeRecordId(v))
          .slice(0, MAX_COLLAPSED_FOLDERS)
      : undefined;
    // sort is a CLOSED vocabulary (the popover's three values); an arbitrary
    // string must not be persisted to the workspaceState sort key.
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
