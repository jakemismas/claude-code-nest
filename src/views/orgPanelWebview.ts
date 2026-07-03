import * as vscode from 'vscode';
import { ChatRecord } from '../model/types';
import { scanChats } from '../claude/chatScanner';
import { readTranscriptBodies } from '../claude/bodyReader';
import { MetadataStore } from '../store/metadataStore';
import { ProjectMeta, isValidColor } from '../store/schema';
import { OPEN_CHAT_COMMAND } from '../launch/uriLauncher';
import { tokenBadge } from './chatTooltip';
import { relativeTime } from './relativeTime';
import { buildSections, OrgSections, isArchived } from './orgPanelModel';
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
// newSession requests a best-effort new Claude Code chat; openArchive and
// openSettings surface the interim Archive view and Settings entry until the
// in-panel overlays ship (s3b). Density was removed in slice s3a-design-shell
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
  | { type: 'openArchive' }
  | { type: 'openSettings' }
  | { type: 'toggleStar'; sessionId: string; starred: boolean }
  | { type: 'setState'; sort?: string; collapsedFolders?: string[] };

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
  // Surface the interim Archive view. The design puts an Archived (N) row at the
  // bottom of the list that opens a full-panel Archive overlay; the overlay lands in
  // s3b, so until then this reveals the existing claudeNest.archive tree view. The
  // webview only requests it.
  openArchive(): Promise<void> | void;
  // Surface the interim Settings entry (the gear). The Settings overlay lands in
  // s3b; until then this runs the existing claudeNest.openSettings command.
  openSettings(): Promise<void> | void;
  // Toggle a chat's synced ChatMeta.starred and persist immediately (AC: "Star click
  // persists immediately through the store"). The wiring routes this to the existing
  // star/unstar curation commands (store.setChatStarred + flush + refresh), so the
  // webview never invents a write path. `starred` is the DESIRED next state.
  setStarred(sessionId: string, starred: boolean): Promise<void> | void;
}

// The persisted view-state keys (Memento) for the user's sort and density choice,
// so the panel reopens in the same mode. Stored on workspaceState by the wiring.
export interface OrgPanelStateStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

// The per-device read-state seam the panel needs (backed by readState.ts's
// ReadStateStore in the host). getMap feeds the pure buildSections; markSeen clears a
// chat's unread affordance on a clear trigger (open-via-Nest, matching-tab focus).
// LOCAL and NEVER synced (UI-SPEC.md "Read state").
export interface OrgPanelReadState {
  getMap(): Map<string, number>;
  markSeen(sessionId: string, at?: number): void;
}

const SORT_KEY = 'claudeNest.orgPanel.sort';
// The collapsed-folder set, persisted per workspace as a JSON-encoded string array
// of folder ids (issue #64). Workspace-local and NEVER synced, exactly like sort
// and density: it lives only on workspaceState through stateStore and is never
// added to setKeysForSync or the nest.meta.v1 sync surface.
const COLLAPSED_KEY = 'claudeNest.orgPanel.collapsedFolders';

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
      this.postSections();
      this.postActive();
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
      void this.actions.openArchive();
    } else if (msg.type === 'openSettings') {
      void this.actions.openSettings();
    } else if (msg.type === 'toggleStar') {
      void this.onToggleStar(msg.sessionId, msg.starred);
    } else if (msg.type === 'setState') {
      this.onSetState(msg.sort, msg.collapsedFolders);
    }
  }

  private async onToggleStar(sessionId: string, starred: boolean): Promise<void> {
    if (sessionId.length === 0) {
      return;
    }
    await this.actions.setStarred(sessionId, starred);
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

  // Scan, read the store, and assemble the section model via the pure builder.
  // Tolerant: no workspace/project, or a failed scan, yields empty sections (the
  // webview renders its empty state) rather than throwing.
  private buildSectionModel(): OrgSections {
    const empty: OrgSections = {
      starred: [],
      questions: [],
      folders: [],
      tags: [],
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
      return scanChats(this.workspacePath);
    } catch {
      return [];
    }
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
    <span class="nest-search-icon" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5" stroke="#A6A294" stroke-width="1.6"/><line x1="10.8" y1="10.8" x2="14.5" y2="14.5" stroke="#A6A294" stroke-width="1.6" stroke-linecap="round"/></svg></span>
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
  };
  if (obj.type === 'ready') {
    return { type: 'ready' };
  }
  if (obj.type === 'refresh') {
    return { type: 'refresh' };
  }
  if (obj.type === 'open' && typeof obj.sessionId === 'string') {
    return { type: 'open', sessionId: obj.sessionId };
  }
  if (obj.type === 'search' && typeof obj.query === 'string') {
    return { type: 'search', query: obj.query };
  }
  if (obj.type === 'drop' && Array.isArray(obj.sourceChatIds)) {
    const kind = obj.targetKind === 'tag' ? 'tag' : 'folder';
    const ids = obj.sourceChatIds.filter((v): v is string => typeof v === 'string');
    const targetId = typeof obj.targetId === 'string' ? obj.targetId : undefined;
    return { type: 'drop', sourceChatIds: ids, targetKind: kind, targetId };
  }
  if (obj.type === 'renameFolder' && typeof obj.folderId === 'string' && typeof obj.name === 'string') {
    return { type: 'renameFolder', folderId: obj.folderId, name: obj.name };
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
    const name =
      typeof obj.name === 'string' && obj.name.trim().length > 0 ? obj.name.trim() : undefined;
    return { type: 'createFolder', name };
  }
  if (obj.type === 'newSession') {
    return { type: 'newSession' };
  }
  if (obj.type === 'openArchive') {
    return { type: 'openArchive' };
  }
  if (obj.type === 'openSettings') {
    return { type: 'openSettings' };
  }
  if (obj.type === 'toggleStar' && typeof obj.sessionId === 'string') {
    return { type: 'toggleStar', sessionId: obj.sessionId, starred: obj.starred === true };
  }
  if (obj.type === 'setState') {
    // collapsedFolders is accepted only as an array of strings; anything else
    // (including a tampered webview message carrying non-strings) is dropped to
    // undefined so the persisted value is always a clean string-id array.
    const collapsedFolders = Array.isArray(obj.collapsedFolders)
      ? obj.collapsedFolders.filter((v): v is string => typeof v === 'string')
      : undefined;
    return {
      type: 'setState',
      sort: typeof obj.sort === 'string' ? obj.sort : undefined,
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
