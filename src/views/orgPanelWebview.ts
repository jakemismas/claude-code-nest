import * as vscode from 'vscode';
import { ChatRecord } from '../model/types';
import { scanChats } from '../claude/chatScanner';
import { readTranscriptBodies } from '../claude/bodyReader';
import { MetadataStore } from '../store/metadataStore';
import { ProjectMeta } from '../store/schema';
import { OPEN_CHAT_COMMAND } from './flatProvider';
import { tokenBadge } from './chatTooltip';
import { relativeTime } from './relativeTime';
import { buildSections, OrgSections } from './orgPanelModel';
import {
  SearchDoc,
  buildIndex,
  docFromRecord,
  search as searchIndex,
} from '../search/searchIndex';
import { persistTierAIndex, loadOrRebuildTierAIndex } from '../search/searchStore';
import { handleWebviewDrop, WebviewDropDeps } from '../dnd/webviewDropAdapter';

// The PRIMARY org-panel WebviewView (slice s2-org-panel-webview), promoted from
// the chatsPreview proof-of-concept to the main organization surface. It renders
// the section model (Starred, Questions heuristic, the folder hierarchy with
// per-folder color, Unsorted), tag filter chips, sort and density controls,
// double-click folder rename, and webview drag-and-drop that REUSES the unchanged
// pure dropReducer through webviewDropAdapter (the DnD-shell-only contract). The
// native flat Chats TreeView is kept as the accessible fallback; the native
// Folders and Tags trees are retired (extension.ts no longer creates them).
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
// folder color; setState persists the user's sort + density choice.
type Inbound =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'open'; sessionId: string }
  | { type: 'search'; query: string }
  | { type: 'drop'; sourceChatIds: string[]; targetKind: 'folder' | 'tag'; targetId: string | undefined }
  | { type: 'renameFolder'; folderId: string; name: string }
  | { type: 'setFolderColor'; folderId: string; color: string | null }
  | { type: 'deleteFolder'; folderId: string }
  | { type: 'setState'; sort?: string; density?: string };

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
}

// The persisted view-state keys (Memento) for the user's sort and density choice,
// so the panel reopens in the same mode. Stored on workspaceState by the wiring.
export interface OrgPanelStateStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

const SORT_KEY = 'claudeNest.orgPanel.sort';
const DENSITY_KEY = 'claudeNest.orgPanel.density';

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

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workspacePath: string | undefined,
    private readonly store: MetadataStore,
    private readonly getProjectKey: () => string | undefined,
    private readonly actions: OrgPanelActions,
    private readonly dropDeps: WebviewDropDeps,
    private readonly stateStore: OrgPanelStateStore,
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
    } else if (msg.type === 'setState') {
      this.onSetState(msg.sort, msg.density);
    }
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

  private onSetState(sort: string | undefined, density: string | undefined): void {
    if (sort !== undefined) {
      this.stateStore.set(SORT_KEY, sort);
    }
    if (density !== undefined) {
      this.stateStore.set(DENSITY_KEY, density);
    }
  }

  private postState(): void {
    if (this.view === undefined) {
      return;
    }
    void this.view.webview.postMessage({
      type: 'state',
      sort: this.stateStore.get(SORT_KEY) ?? 'newest',
      density: this.stateStore.get(DENSITY_KEY) ?? 'comfortable',
    });
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
    const empty: OrgSections = { starred: [], questions: [], folders: [], tags: [] };
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
    return buildSections(records, meta, tokenBadge);
  }

  // ---- Content search (reused from the POC; durable logic in src/search/*) ----

  private async postSearch(query: string): Promise<void> {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      this.postSearchResults('', []);
      return;
    }
    this.ensureContentIndexBuilding();
    if (this.bodyIndexReady) {
      this.postSearchResults(trimmed, this.rankRows(this.contentIndex, trimmed));
      return;
    }
    const tierA = this.tierAReady === null ? this.contentIndex : await this.tierAReady;
    this.postSearchResults(trimmed, this.rankRows(tierA, trimmed));
    if (!this.bodyIndexReady && this.bodyReady !== null) {
      const body = await this.bodyReady;
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
    const rows: SearchRow[] = [];
    hits.forEach((hit, i) => {
      const record = this.indexedRecords.get(hit.sessionId);
      if (record === undefined) {
        return;
      }
      rows.push({
        rank: i,
        sessionId: record.sessionId,
        title: record.title,
        description: relativeTime(record.timestamp),
        timestamp: record.timestamp,
        tokens: tokenBadge(record),
        snippet: hit.snippet.length > 0 ? hit.snippet : record.lastMessageText,
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
    this.indexedRecords.clear();
    for (const record of records) {
      this.indexedRecords.set(record.sessionId, record);
    }
    return records;
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

  private async readBodyText(record: ChatRecord): Promise<string> {
    try {
      const bodies = readTranscriptBodies(record.filePath);
      return bodies
        .map((b) => (b.text === null ? '' : b.text))
        .filter((t) => t.length > 0)
        .join('\n');
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
    // The toolbar (search, sort, density), the chip rail, and the tree container
    // are static shells; orgPanel.js renders the section content into #list and the
    // chips into #chips, and owns all keyboard/ARIA wiring. role="tree" plus the
    // roving-tabindex management live in the script (ARIA tree semantics are an
    // acceptance criterion).
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link href="${styleUri}" rel="stylesheet" />
</head>
<body>
  <div class="nest-toolbar">
    <input id="filter" class="nest-filter" type="text" placeholder="Search chats..." aria-label="Search chats" />
    <button id="refresh" class="nest-icon-btn" title="Refresh" aria-label="Refresh">Refresh</button>
  </div>
  <div class="nest-toolbar nest-toolbar-controls">
    <label class="nest-control">
      <span>Sort</span>
      <select id="sort" aria-label="Sort chats">
        <option value="newest">Newest first</option>
        <option value="oldest">Oldest first</option>
        <option value="name">Name (A-Z)</option>
      </select>
    </label>
    <label class="nest-control">
      <span>Density</span>
      <select id="density" aria-label="Row density">
        <option value="comfortable">Comfortable</option>
        <option value="compact">Compact</option>
      </select>
    </label>
    <label class="nest-mode nest-control">
      <input id="contentMode" type="checkbox" />
      <span>Search content</span>
    </label>
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
    density?: unknown;
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
    const color = typeof obj.color === 'string' && obj.color.length > 0 ? obj.color : null;
    return { type: 'setFolderColor', folderId: obj.folderId, color };
  }
  if (obj.type === 'deleteFolder' && typeof obj.folderId === 'string') {
    return { type: 'deleteFolder', folderId: obj.folderId };
  }
  if (obj.type === 'setState') {
    return {
      type: 'setState',
      sort: typeof obj.sort === 'string' ? obj.sort : undefined,
      density: typeof obj.density === 'string' ? obj.density : undefined,
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
