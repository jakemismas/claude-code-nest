import * as vscode from 'vscode';
import { ChatRecord } from '../model/types';
import { scanChats } from '../claude/chatScanner';
import { readTranscriptBodies } from '../claude/bodyReader';
import { relativeTime } from './relativeTime';
import { OPEN_CHAT_COMMAND } from './flatProvider';
import { tokenBadge } from './chatTooltip';
import {
  SearchDoc,
  buildIndex,
  docFromRecord,
  search as searchIndex,
} from '../search/searchIndex';
import { persistTierAIndex, loadOrRebuildTierAIndex } from '../search/searchStore';

// PROOF-OF-CONCEPT (Tier 2 webview demo): the same chat list as claudeNest.flat,
// but rendered as a WebviewView instead of a native TreeView. It exists to show
// what visual control a webview unlocks (arbitrary colors, an inline filter box,
// recency group headers, card rows) that the TreeDataProvider API cannot express.
//
// It is intentionally additive: the native Chats tree is untouched, so the two
// render side by side in the same Activity Bar container for comparison. Data
// comes from the SAME scanChats path and opens through the SAME OPEN_CHAT_COMMAND,
// so this only swaps the rendering layer, nothing about the model.
//
// Slice s2-fulltext-search adds a CONTENT-SEARCH mode. The durable search logic
// lives in the vscode-free src/search/searchIndex.ts (build + rank + snippet) and
// src/search/searchStore.ts (persist/load tier-A index to globalStorage). This
// webview is the throwaway POC surface slice 6 replaces with orgPanelWebview, so
// it invests minimally: it owns only the message wiring and rendering.
//
// The content index is built ASYNCHRONOUSLY so the first content search never
// blocks the extension-host main thread (the prior synchronous full-body read
// loop could freeze the UI for seconds on a large ~/.claude/projects). Two phases:
//
//   1. WARM START: load the persisted TIER-A index from globalStorage via
//      searchStore.loadOrRebuildTierAIndex (the read side of the warm-start
//      serialization, so the file persistTierAIndex writes is actually consumed).
//      This gives a searchable index immediately, with no body read, so the first
//      query answers fast on tier-A text (title, last message, files).
//   2. BODY UPGRADE: read each chat's body ON DEMAND via bodyReader in a YIELDING
//      loop (awaiting the event loop every BODY_READ_CHUNK files) so the host
//      stays responsive, build the full body-indexed index, swap it in, and
//      re-post results for the still-active query. The raw bodies are DISCARDED
//      once indexed; the index holds tokens, never the body snapshot.
//
// The index is cached for the session and rebuilt on refresh. A best-effort
// persist of the freshly scanned tier-A index runs after the upgrade so the next
// session starts warm from current transcripts.

export const CHATS_PREVIEW_VIEW = 'claudeNest.chatsPreview';

// How many transcript bodies to read between yields to the host event loop during
// the phase-2 body-index build. Small enough that a large projects dir cannot
// monopolize the single JS thread for long, large enough that the per-yield
// overhead stays negligible.
const BODY_READ_CHUNK = 20;

// Yield control back to the host event loop so a long body-read pass cannot freeze
// the UI. setImmediate (a macrotask) lets queued I/O and UI work run between chunks.
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface PreviewRow {
  sessionId: string;
  title: string;
  description: string;
  timestamp: number | null;
  // Slice 1 summary line: the ~token badge (empty when no usage was recorded) and
  // the tier-A last-message snippet (null when none). Both ride the scan snapshot;
  // no body is read here. The webview renders them under the title as a preview.
  tokens: string;
  snippet: string | null;
}

// A content-search result row: the same card fields plus the matched snippet and
// the relevance rank (0-based), so the webview can render results in score order
// with the matched context shown under the title.
interface SearchRow extends PreviewRow {
  rank: number;
}

// Messages the webview posts to the host.
type Inbound =
  | { type: 'ready' }
  | { type: 'open'; sessionId: string }
  | { type: 'refresh' }
  | { type: 'search'; query: string };

export class ChatsPreviewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  // The in-memory content-search index, built lazily on the first content query
  // and cached until refresh(). It holds search TOKENS only (raw bodies are read
  // on demand, fed to the index, and discarded); it is never persisted here and
  // never enters the scan snapshot. It advances through two phases: first a TIER-A
  // index (warm-loaded from globalStorage or rebuilt), then UPGRADED to a
  // body-indexed index once bodies are read. null until the first build or after a
  // refresh invalidates it. Always the BEST available index (body once ready).
  private contentIndex: ReturnType<typeof buildIndex> | null = null;
  // The in-flight build's two phase promises, so concurrent content queries share
  // ONE build instead of each launching its own scan + body-read pass. tierAReady
  // resolves with the warm tier-A index (fast path); bodyReady resolves with the
  // full body index. Both null when no build is running (and after refresh).
  private tierAReady: Promise<ReturnType<typeof buildIndex> | null> | null = null;
  private bodyReady: Promise<ReturnType<typeof buildIndex> | null> | null = null;
  // True once contentIndex has been upgraded to include body tokens. While false,
  // a content query that resolved on the tier-A index should await bodyReady and
  // re-post once the body upgrade lands.
  private bodyIndexReady = false;
  // The records snapshot the content index was built from, so a search result row
  // can be rebuilt (title, timestamp, token badge) without a rescan.
  private indexedRecords: Map<string, ChatRecord> = new Map();
  // Generation token for the in-flight build. ensureContentIndexBuilding captures
  // this value when it launches the two detached phase promises; each phase only
  // writes back to shared state (contentIndex, bodyIndexReady, indexedRecords, and
  // the warm-start persist) while its captured generation still equals this one.
  // invalidateContentIndex bumps it, so any build invalidated by a refresh
  // mid-flight discards its writebacks instead of resurrecting a stale index or
  // flipping bodyIndexReady back on. Monotonic; never reset.
  private buildGeneration = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workspacePath: string | undefined,
    // The extension globalStorage Uri, where the tier-A warm-start index is
    // persisted (via searchStore -> exportIO). Optional so a test or a degraded
    // host without storage simply skips persistence; search still works from the
    // in-memory index.
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
      if (msg.type === 'ready') {
        this.postRows();
      } else if (msg.type === 'refresh') {
        // A refresh invalidates the cached content index so the next content
        // query re-reads bodies against the current transcripts.
        this.invalidateContentIndex();
        this.postRows();
      } else if (msg.type === 'open') {
        void vscode.commands.executeCommand(OPEN_CHAT_COMMAND, msg.sessionId);
      } else if (msg.type === 'search') {
        void this.postSearch(msg.query);
      }
    });

    webviewView.webview.html = this.renderHtml(webviewView.webview, mediaRoot);
  }

  private postRows(): void {
    if (this.view === undefined) {
      return;
    }
    void this.view.webview.postMessage({ type: 'rows', rows: this.buildRows() });
  }

  // Answer a content-search query: build (or reuse) the content index, rank
  // matches, and post ranked SearchRows back. An empty query posts an empty
  // result set so the webview can restore the full list. The build is ASYNC and
  // two-phase: a tier-A index answers first, then a body upgrade re-posts richer
  // results for the same query. The webview ignores a response whose query no
  // longer matches the box, so a late re-post for a stale query is harmless.
  private async postSearch(query: string): Promise<void> {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      this.postSearchResults('', []);
      return;
    }
    // Kick off (or join) the build. When the body index is already cached, answer
    // straight off it. Otherwise answer on the warm TIER-A index as soon as it is
    // ready so the first query returns fast.
    this.ensureContentIndexBuilding();
    if (this.bodyIndexReady) {
      this.postSearchResults(trimmed, this.rankRows(this.contentIndex, trimmed));
      return;
    }
    const tierA = this.tierAReady === null ? this.contentIndex : await this.tierAReady;
    this.postSearchResults(trimmed, this.rankRows(tierA, trimmed));
    // If the body upgrade has not landed yet, wait for it and re-post the richer
    // (body-snippet) results for the same query. The webview ignores a re-post
    // whose query no longer matches the box, so a stale upgrade is harmless.
    if (!this.bodyIndexReady && this.bodyReady !== null) {
      const body = await this.bodyReady;
      this.postSearchResults(trimmed, this.rankRows(body, trimmed));
    }
  }

  // Post a searchResults message if the view is live. Centralized so every
  // post path (immediate empty, phase 1, phase 2) goes through one guard.
  private postSearchResults(query: string, rows: SearchRow[]): void {
    if (this.view === undefined) {
      return;
    }
    void this.view.webview.postMessage({ type: 'searchResults', query, rows });
  }

  // Rank an index against a query into SearchRows. Tolerant: a null index or a
  // search failure yields []. Never throws out of the message handler.
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
        // The matched-context snippet from the search hit (built over the body
        // when one was indexed, else the tier-A last message), shown under the
        // title in place of the default last-message snippet.
        snippet: hit.snippet.length > 0 ? hit.snippet : record.lastMessageText,
      });
    });
    return rows;
  }

  // Start the two-phase content-index build if one is not already cached or in
  // flight. Idempotent: a build already running (tierAReady set) or already
  // complete (contentIndex set with bodyIndexReady) is left alone, so concurrent
  // content queries share ONE build. The phases run as detached promises that
  // settle into this.tierAReady / this.bodyReady; callers await those.
  private ensureContentIndexBuilding(): void {
    if (this.bodyIndexReady || this.tierAReady !== null) {
      return;
    }
    // Stamp this build so its detached phases can detect an invalidation (refresh)
    // that lands while they run, and refuse to write back stale results.
    const generation = this.buildGeneration;
    // Resolve the scan + tier-A and the body upgrade as two chained promises so a
    // query can answer on tier-A WITHOUT waiting for the body read to finish.
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

  // Scan transcripts into records and refresh indexedRecords. Returns null when
  // there is no workspace or the scan fails. NEVER throws. Writes indexedRecords
  // only while generation is still current, so a refresh that invalidated this
  // build mid-scan does not repopulate (or wipe and leave stale) the lookup map.
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

  // Phase 1 (warm start): READ the persisted TIER-A index from globalStorage (the
  // consumer of persistTierAIndex's write), falling back to an in-memory tier-A
  // rebuild when no valid file is present. Published as contentIndex immediately
  // so a query answers fast on tier-A text while bodies are still being read.
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
    // Publish only when this build is still the current one. A refresh that landed
    // during the (awaited) tier-A load bumped the generation; assigning here would
    // resurrect a stale index that a fresh build will have to overwrite. The built
    // index is still returned so the awaiting query can rank against it; rankRows
    // tolerates the cleared indexedRecords by dropping rows for that stale post.
    if (generation === this.buildGeneration) {
      this.contentIndex = tierAIndex;
    }
    return tierAIndex;
  }

  // Phase 2 (body upgrade): read each chat's body ON DEMAND via bodyReader in a
  // YIELDING loop so the host stays responsive on a large projects dir, build the
  // full body-indexed index, swap it in, and persist a fresh tier-A index for the
  // next session. Bodies are DISCARDED once indexed (only tokens are retained, in
  // memory). NEVER throws.
  private async upgradeToBodyIndex(
    records: ChatRecord[],
    generation: number,
  ): Promise<ReturnType<typeof buildIndex>> {
    const docs: SearchDoc[] = [];
    let sinceYield = 0;
    for (const record of records) {
      const bodyText = await this.readBodyText(record);
      docs.push(docFromRecord(record, bodyText));
      // bodyText goes out of scope here; only the built index (tokens) survives.
      sinceYield += 1;
      if (sinceYield >= BODY_READ_CHUNK) {
        sinceYield = 0;
        await yieldToEventLoop();
      }
    }
    const bodyIndex = buildIndex(docs);
    // The yielding body-read loop above spans the window where a refresh is most
    // likely to land. Publish (and flip bodyIndexReady, and persist) only when this
    // build is still current. Otherwise these writes would resurrect a stale index,
    // flip bodyIndexReady back to true so a query short-circuits on it, and persist
    // a stale warm-start file -- exactly the refresh-during-build race. The index is
    // still returned for the awaiting query to rank against.
    if (generation !== this.buildGeneration) {
      return bodyIndex;
    }
    this.contentIndex = bodyIndex;
    this.bodyIndexReady = true;

    // Best-effort warm-start persist: write a TIER-A-ONLY index (no bodies) to
    // globalStorage so the NEXT session's phase 1 starts warm from current
    // transcripts. Fire-and-forget; a failure is swallowed inside searchStore and
    // never affects the live in-memory search. The persisted index deliberately
    // omits body text (DECISIONS.md fold-in 3): only the in-memory index carries
    // body tokens.
    if (this.globalStorageUri !== undefined) {
      void persistTierAIndex(this.globalStorageUri, records);
    }
    return bodyIndex;
  }

  // Read and join one chat's body message texts for indexing. Read-only and
  // tolerant: an unreadable transcript yields ''. Async so the caller can yield to
  // the event loop between reads; the synchronous fs read is wrapped so a throw
  // degrades to '' rather than rejecting. The returned string is fed to the index
  // and then discarded by the caller.
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
    // Bump first so any build promise still in flight (a yielding body read can
    // span seconds) sees a generation mismatch and discards its writebacks instead
    // of resurrecting this now-stale index after we clear it.
    this.buildGeneration += 1;
    this.contentIndex = null;
    this.bodyIndexReady = false;
    this.tierAReady = null;
    this.bodyReady = null;
    this.indexedRecords.clear();
  }

  private buildRows(): PreviewRow[] {
    if (this.workspacePath === undefined) {
      return [];
    }
    let records;
    try {
      records = scanChats(this.workspacePath);
    } catch {
      return [];
    }
    return records.map((r) => ({
      sessionId: r.sessionId,
      title: r.title,
      description: relativeTime(r.timestamp),
      timestamp: r.timestamp,
      tokens: tokenBadge(r),
      snippet: r.lastMessageText,
    }));
  }

  private renderHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const nonce = makeNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'chatsPreview.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'chatsPreview.css'));
    const cspSource = webview.cspSource;
    const csp = [
      "default-src 'none'",
      `style-src ${cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${cspSource}`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link href="${styleUri}" rel="stylesheet" />
</head>
<body>
  <div class="nest-toolbar">
    <input id="filter" class="nest-filter" type="text" placeholder="Filter chats..." />
    <button id="refresh" class="nest-refresh" title="Refresh">Refresh</button>
  </div>
  <div class="nest-toolbar nest-toolbar-mode">
    <label class="nest-mode">
      <input id="contentMode" type="checkbox" />
      Search chat content
    </label>
  </div>
  <div id="list" class="nest-list"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function coerce(raw: unknown): Inbound | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const obj = raw as { type?: unknown; sessionId?: unknown; query?: unknown };
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
