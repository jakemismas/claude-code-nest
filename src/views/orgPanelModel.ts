// orgPanelModel: the PURE, vscode-free assembler behind the primary org-panel
// webview (slice s2-org-panel-webview). Given the scanned chat records and the
// project's curation document (ProjectMeta), it builds the serializable section
// model the webview renders: Starred, Questions (the scan-time awaiting-reply
// heuristic), the folder hierarchy with per-folder color, and Unsorted.
//
// It imports no vscode types and touches no filesystem (ARCHITECTURE.md unit-gate
// rule; mirrors the dropReducer.ts / orgPanelModel split that keeps the unit test
// free of a transitive vscode require). The webview host (orgPanelWebview.ts)
// scans the records and reads the store, calls buildSections, and posts the plain
// result over postMessage; the model never reads the store or the disk itself.
//
// Binding rules honored:
// - The Questions section membership and the '?' badge are the SAME scan-time read-
//   state signal (slice s3a-row-anatomy; UI-SPEC.md line 51, design README line 43):
//   a chat is in Questions iff its status is 'question', i.e. its last genuine turn
//   is an UNREAD assistant turn whose text asks something. This REPLACES the prior
//   lastMessageRole==='user' heuristic. "Unread" is per-device: the last activity is
//   newer than the injected lastSeenAt for that chat (or the chat has never been
//   seen). Still a scan-time signal (not a live conversation state), so the webview
//   keeps the heuristic framing.
// - A chat counts ONCE in its single home folder (its ChatMeta.folderId, or the
//   synthetic Unsorted bucket when unfiled or the folder no longer resolves),
//   mirroring the Folders tree's single-home rule. Starred and Questions are
//   CROSS-CUTTING sections: a chat can appear in Starred and/or Questions AND in
//   its folder. This is intentional (the same chat is pinned, awaiting reply, and
//   filed); only the folder placement is single-home.
// - Per-folder color rides each folder section from Folder.color (slice 3),
//   absent when the user set none.
// - lastSeenAt is threaded in as a PLAIN Map<sessionId, epochMs> (the vscode-thin
//   readState.ts owns the Memento); this model imports no store and no vscode, so it
//   stays in the headless unit gate (ARCHITECTURE.md unit-gate rule).

import { ChatRecord } from '../model/types';
import { ProjectMeta, Folder } from '../store/schema';
import { asksSomething } from '../model/questionHeuristic';
// clampFolderDepth is a PURE, vscode-free helper (folderTree.ts imports only the
// vscode-free schema + idFactory), so importing it keeps this model in the headless
// unit gate. It applies the one-visible-sublevel render cap (issue #82 AC4) to the
// emitted section depth without ever touching the stored hierarchy.
import { clampFolderDepth } from '../model/folderTree';

// The synthetic catch-all bucket id for chats with no (or an unresolvable) home
// folder. Duplicated as a literal here rather than imported from folderTree.ts so
// this pure model stays free of any transitive import that might pull vscode in;
// the value is the binding contract and is asserted equal in the unit test. It
// matches the dropReducer's UNFILED sentinel so a drop onto the Unsorted section
// reduces to an unfile.
export const UNSORTED_FOLDER_ID = '__unfiled__';

// The per-row status slot (UI-SPEC.md "Chat row", design README line 51). It drives
// the left status affordance the panel renders:
//   'question' -> a blinking '?' badge (an UNREAD assistant turn that asks something)
//   'done'     -> a solid unread dot (an UNREAD assistant reply that is not a question)
//   'none'     -> an empty slot (seen, or the last turn is the user's)
// Both non-empty states are gated on the turn being UNREAD relative to the per-device
// lastSeenAt read state (UI-SPEC.md "Read state"; slice s3a-row-anatomy). See
// rowStatus below.
export type RowStatus = 'question' | 'done' | 'none';

// One chat row in the org panel, projected from a ChatRecord plus its curation
// state. Plain, JSON-serializable data (no vscode, no ChatRecord reference) so it
// crosses postMessage cleanly. tokens is the formatted ~token badge ('' when no
// usage). snippet is the tier-A last-message text (null when none). tags is the
// chat's full resolved tag-label set; tagIds is the parallel id set the DnD shell
// and chip filter key on. starred and awaitingReply drive the cross-cutting
// sections; status drives the per-row status slot (dot vs '?' badge). folderId is
// the chat's resolved single home (the Unsorted sentinel when unfiled), used only
// by the assembler.
export interface OrgChatRow {
  sessionId: string;
  title: string;
  timestamp: number | null;
  tokens: string;
  snippet: string | null;
  tags: string[];
  tagIds: string[];
  // Parallel to tags: each tag's color (#rrggbb) or null when the tag has none, so
  // the webview can render each tag pill in its handoff hue (design README line 98).
  // Same length and order as tags.
  tagColors: (string | null)[];
  starred: boolean;
  // awaitingReply is now an ALIAS of (status === 'question'): the chat is awaiting the
  // user's reply because an unread assistant turn asks something. It drives the
  // Questions section membership and the aria "awaiting your reply" phrasing. Kept as
  // a distinct field so the webview does not re-derive it. (Superseded the prior
  // lastMessageRole==='user' definition; slice s3a-row-anatomy.)
  awaitingReply: boolean;
  status: RowStatus;
  // The folder-path breadcrumb (e.g. "Work / Backend API"), rendered on the right of
  // a row ONLY in the Questions section and the flat search/filter results (design
  // README lines 54, 42). null when the chat is unfiled or its folder no longer
  // resolves (no breadcrumb to show).
  breadcrumb: string | null;
}

// One folder section: the folder's id, name, optional color (slice 3), nesting
// depth (0 for a root, deeper for a child), and its directly-homed chat rows in
// the assembler's sort order. The synthetic Unsorted bucket is a FolderSection too
// (synthetic: true), always last, so the webview renders every folder-homed group
// uniformly.
export interface FolderSection {
  folderId: string;
  name: string;
  color?: string;
  // The nesting depth used for rendering, CLAMPED to the one-visible-sublevel cap
  // (MAX_FOLDER_RENDER_DEPTH; issue #82 AC4). A deeper legacy folder renders at the
  // cap; its stored parentId chain is never modified. The webview's indent
  // (11 + depth * 18) and the aria-level read this clamped value.
  depth: number;
  // The TRUE stored nesting depth (uncapped), used ONLY by the webview's
  // collapse/hide bookkeeping (the pre-order "skip everything deeper than a
  // collapsed folder" scan). Two legacy folders that both clamp to render depth 2
  // still carry distinct treeDepths, so a collapsed clamped-deep folder correctly
  // hides its clamped-deep descendants. Never used for indentation. For a
  // within-cap folder treeDepth === depth.
  treeDepth: number;
  synthetic: boolean;
  // The rolled-up chat count for the folder header (issue #82 AC1, design README
  // line 66: "Top folder count = chats in it + its subfolders"): the folder's
  // directly-homed chats PLUS every descendant folder's directly-homed chats. It is
  // computed over the STORED hierarchy (real parentId), so it is a stable structural
  // count independent of the render clamp and of any active filter (folder headers
  // render only in the unfiltered tree; filtering swaps to the flat results list).
  // The synthetic Unsorted bucket has no rollup semantics (it has no descendants);
  // its count is just its own rows.
  rolledUpCount: number;
  rows: OrgChatRow[];
}

// One tag filter chip: the tag id, its label, and optional color, plus the count
// of chats carrying it. The webview renders these as clickable, combinable chips.
export interface TagChip {
  tagId: string;
  label: string;
  color?: string;
  count: number;
}

// The full section model the webview renders. starred and questions are the
// cross-cutting sections (each a flat row list); folders is the single-home
// hierarchy (roots first in stored order, each followed by its descendants in a
// pre-order flattening, the synthetic Unsorted bucket last); tags are the filter
// chips. archivedCount is the number of scanned chats the user has archived
// (ChatMeta.userArchived === true), which drives the bottom "Archived (N)" row; it
// is a COUNT only, since archived chats are excluded from every visible section
// (design README lines 45-46: archived chats live in the Archive sub-page).
export interface OrgSections {
  starred: OrgChatRow[];
  questions: OrgChatRow[];
  folders: FolderSection[];
  tags: TagChip[];
  // The FULL project tag list (every tag in meta.tags, with id, label, color, and
  // its carrying-chat count over the scanned records). DISTINCT from `tags`, which is
  // the filter-chip row and OMITS zero-chat tags (an empty chip is filter noise).
  // The right-click context menu (slice s3b-context-menu, issue #85 AC #1) must list
  // ALL tags with a checkmark on the chat's current tags, INCLUDING tags no chat
  // carries yet, so it reads allTags rather than the chip set. Additive: buildTagChips
  // is unchanged. Sorted the same way (label case-insensitive, then id) for a stable
  // menu order.
  allTags: TagChip[];
  archivedCount: number;
}

// A token-badge formatter seam so the pure model stays free of the vscode-thin
// tokenBadge import chain. The host passes tokenBadge (from chatTooltip.ts, itself
// vscode-free) so the row's token seam (OrgChatRow.tokens, consumed by the search row
// and the s3b hover card, NOT the visible row) matches every other surface exactly.
export type TokenBadgeFn = (record: ChatRecord) => string;

// Build the org-panel section model from the scanned records and the project's
// curation document. Pure and total: a missing meta (project key not resolved yet)
// yields every chat unfiled, untagged, unstarred, with the read-state status still
// derived from the record's tier-A last-message fields against lastSeenAt. Never
// throws. lastSeenAt is a plain per-device Map<sessionId, epochMs> (default empty =
// nothing seen); the vscode-thin readState.ts owns the Memento behind it.
export function buildSections(
  records: readonly ChatRecord[],
  meta: ProjectMeta | undefined,
  tokenBadge: TokenBadgeFn,
  lastSeenAt: ReadonlyMap<string, number> = new Map(),
): OrgSections {
  // Archived chats (the SYNCED ChatMeta.userArchived flag, slice s2-star-archive)
  // are excluded from EVERY visible section and surfaced only as the bottom
  // "Archived (N)" row (design README lines 45-46; the Archive sub-page owns them,
  // which is the existing claudeNest.archive view until the s3b overlay ships). This
  // is the SYNCED curation flag, never the local orphan-reconcile flag (the model is
  // vscode-free and reads only the passed ProjectMeta). The count is over SCANNED
  // records only, matching the "N results" the Archive view lists for present chats;
  // an archived chat whose transcript was cleaned up out of band is not scanned and
  // shows only in the Archive view, exactly as before.
  const visibleRecords = records.filter((r) => !isArchived(r.sessionId, meta));
  const archivedCount = records.length - visibleRecords.length;

  // Precompute each folder's full breadcrumb path ("Work / Backend API") so every
  // row's breadcrumb is an O(1) lookup rather than a per-row ancestor walk.
  const folderPaths = buildFolderPaths(meta);

  const rows = visibleRecords.map((record) =>
    buildRow(record, meta, tokenBadge, lastSeenAt, folderPaths),
  );

  // Cross-cutting sections, each sorted newest-first to match the folder rows. The
  // Questions section is now the status==='question' rows (an unread assistant turn
  // that asks something), replacing the old lastMessageRole==='user' heuristic.
  const starred = sortNewestFirst(rows.filter((r) => r.starred));
  const questions = sortNewestFirst(rows.filter((r) => r.status === 'question'));

  // Single-home folder placement: group each row under its resolved home folder
  // id (the Unsorted sentinel when unfiled or the folder no longer resolves).
  const homeByChat = new Map<string, string>();
  for (const record of visibleRecords) {
    homeByChat.set(record.sessionId, resolveHomeFolderId(record.sessionId, meta));
  }
  const rowsByFolder = new Map<string, OrgChatRow[]>();
  for (const row of rows) {
    const home = homeByChat.get(row.sessionId) ?? UNSORTED_FOLDER_ID;
    const bucket = rowsByFolder.get(home);
    if (bucket === undefined) {
      rowsByFolder.set(home, [row]);
    } else {
      bucket.push(row);
    }
  }

  const folders = buildFolderSections(meta, rowsByFolder);
  const tags = buildTagChips(visibleRecords, meta);
  const allTags = buildAllTags(visibleRecords, meta);

  return { starred, questions, folders, tags, allTags, archivedCount };
}

// One archived-chat row for the in-panel Archive overlay (slice s3b-archive-overlay,
// issue #87). Plain, JSON-serializable data (no vscode, no ChatRecord reference) so it
// crosses postMessage cleanly, mirroring OrgChatRow. Built from the SYNCED
// ChatMeta.userArchived membership, NOT the scan: an archived chat whose transcript was
// cleaned up out of band still lists here (present:false), matching the retired
// archiveProvider's membership rule. title falls back to the record title, else the
// stored body-copy title (fallbackTitles), else the sessionId. folder is the folder-path
// breadcrumb or 'Unsorted'. relativeTime is the compact age for a present chat, empty
// when the transcript is gone (no timestamp). starred rides the synced flag; present is
// whether the live transcript is still scanned.
export interface ArchivedRow {
  sessionId: string;
  title: string;
  folder: string;
  relativeTime: string;
  starred: boolean;
  present: boolean;
}

// A relative-time formatter seam so the pure builder stays free of the vscode-thin
// relativeTime import chain and of any clock. The host passes relativeTimeCompact (from
// relativeTime.ts, itself vscode-free) so the archive overlay's age matches the tree
// rows exactly. A null timestamp yields '' (a gone chat has no timestamp).
export type RelativeTimeFn = (timestamp: number | null) => string;

// Build the archived-chat rows for the in-panel Archive overlay (issue #87). Membership
// is the SYNCED ChatMeta.userArchived flag (NOT the local orphan-reconcile flag, and NOT
// the scan), matching the retired archiveProvider: a chat archived on another device or
// whose transcript Claude cleaned up still appears. For each archived chat id in meta:
// resolve its scanned record (present) for title/timestamp/breadcrumb; when the transcript
// is gone, fall back to the stored body-copy title from fallbackTitles, else the sessionId,
// with an empty age and the Unsorted-or-folder breadcrumb resolved from the synced meta.
// Sorted newest-first for present chats, gone chats after (no timestamp), then by sessionId
// for a stable order, mirroring the retired provider's sort. Pure and total: an absent meta
// yields []. Never throws.
export function buildArchivedRows(
  records: readonly ChatRecord[],
  meta: ProjectMeta | undefined,
  relativeTime: RelativeTimeFn,
  fallbackTitles: ReadonlyMap<string, string> = new Map(),
): ArchivedRow[] {
  if (meta === undefined) {
    return [];
  }
  const recordById = new Map<string, ChatRecord>();
  for (const record of records) {
    recordById.set(record.sessionId, record);
  }
  const folderPaths = buildFolderPaths(meta);
  const rows: ArchivedRow[] = [];
  for (const [chatId, chatMeta] of Object.entries(meta.chats)) {
    // SYNCED userArchived ONLY. LocalChatState.archived is never consulted here (the
    // model is vscode-free and reads only the passed ProjectMeta).
    if (chatMeta.userArchived !== true) {
      continue;
    }
    const record = recordById.get(chatId);
    const present = record !== undefined;
    const title = present
      ? record.title
      : fallbackTitles.get(chatId) ?? chatId;
    const home = resolveHomeFolderId(chatId, meta);
    const folder =
      home === UNSORTED_FOLDER_ID ? 'Unsorted' : folderPaths.get(home) ?? 'Unsorted';
    rows.push({
      sessionId: chatId,
      title,
      folder,
      relativeTime: present ? relativeTime(record.timestamp) : '',
      starred: chatMeta.starred === true,
      present,
    });
  }
  rows.sort((a, b) => {
    const ra = recordById.get(a.sessionId);
    const rb = recordById.get(b.sessionId);
    const ta = ra !== undefined ? ra.timestamp : null;
    const tb = rb !== undefined ? rb.timestamp : null;
    if (ta === null && tb === null) {
      return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
    }
    if (ta === null) {
      return 1;
    }
    if (tb === null) {
      return -1;
    }
    return tb - ta;
  });
  return rows;
}

// Whether a scanned chat is user-archived per the SYNCED ChatMeta.userArchived
// flag. Tolerant of an absent meta or chat entry (not archived). Never throws.
// Exported so the org-panel host filters its CONTENT-SEARCH index by the SAME
// archived predicate this model uses to exclude archived chats from the visible
// sections: the two paths must not drift, or archived chats would be host-indexed
// and ranked (consuming rank slots the client then drops when it joins hits to the
// archived-excluded rows), crowding genuine live matches out of the 50-hit cap.
export function isArchived(chatId: string, meta: ProjectMeta | undefined): boolean {
  return meta?.chats[chatId]?.userArchived === true;
}

// Project one record to its org-panel row, resolving its curation state from the
// meta. Tolerant of an absent meta or chat entry (defaults to unfiled/untagged/
// unstarred). The read-state status reads the record's tier-A last-message fields
// against the injected lastSeenAt map; it never consults a store.
function buildRow(
  record: ChatRecord,
  meta: ProjectMeta | undefined,
  tokenBadge: TokenBadgeFn,
  lastSeenAt: ReadonlyMap<string, number>,
  folderPaths: ReadonlyMap<string, string>,
): OrgChatRow {
  const chatMeta = meta?.chats[record.sessionId];
  const tagIds = Array.isArray(chatMeta?.tags) ? [...(chatMeta as { tags: string[] }).tags] : [];
  const resolved = resolveTagsFor(tagIds, meta);
  const status = rowStatus(record, lastSeenAt);
  return {
    sessionId: record.sessionId,
    title: record.title,
    timestamp: record.timestamp,
    tokens: tokenBadge(record),
    snippet: record.lastMessageText,
    tags: resolved.labels,
    tagIds,
    tagColors: resolved.colors,
    starred: chatMeta?.starred === true,
    // awaitingReply is now an alias of status==='question' (an unread assistant turn
    // that asks something), replacing the prior lastMessageRole==='user' heuristic.
    awaitingReply: status === 'question',
    status,
    breadcrumb: resolveBreadcrumb(record.sessionId, meta, folderPaths),
  };
}

// The scan-time status for a chat's status slot (UI-SPEC.md lines 51-52 and "Read
// state"; slice s3a-row-anatomy). Both non-empty states are gated on the last turn
// being an UNREAD assistant turn:
//   unread = lastMessageRole === 'assistant' && (timestamp === null || timestamp > lastSeenAt)
// then:
//   - 'question' when unread AND the assistant text asks something (asksSomething);
//   - 'done'     when unread AND it does not (a plain unread reply);
//   - 'none'     otherwise. A user-last chat is 'none' here: a newer USER message
//     supersedes the unread signal structurally (lastMessageRole !== 'assistant'),
//     which is the patch's "superseded by a newer user message" clause with no
//     transcript-watching write path. A SEEN assistant turn (timestamp <= lastSeenAt)
//     is also 'none'.
// timestamp===null (no timestamped line) is treated as unread so a brand-new chat
// with an assistant-last turn still surfaces until the user opens it.
function rowStatus(record: ChatRecord, lastSeenAt: ReadonlyMap<string, number>): RowStatus {
  if (record.lastMessageRole !== 'assistant') {
    return 'none';
  }
  const seenAt = lastSeenAt.get(record.sessionId);
  const unread = record.timestamp === null || seenAt === undefined || record.timestamp > seenAt;
  if (!unread) {
    return 'none';
  }
  return asksSomething(record.lastMessageText) ? 'question' : 'done';
}

// The breadcrumb path for a chat's single home folder, or null when unfiled or the
// folder no longer resolves (routes to Unsorted, which has no breadcrumb).
function resolveBreadcrumb(
  chatId: string,
  meta: ProjectMeta | undefined,
  folderPaths: ReadonlyMap<string, string>,
): string | null {
  const home = resolveHomeFolderId(chatId, meta);
  if (home === UNSORTED_FOLDER_ID) {
    return null;
  }
  return folderPaths.get(home) ?? null;
}

// Build each real folder's full breadcrumb path ("Parent / Child"), walking parentId
// with a visited guard so a corrupt parent cycle terminates. A folder whose ancestor
// chain is broken falls back to its own name.
function buildFolderPaths(meta: ProjectMeta | undefined): Map<string, string> {
  const paths = new Map<string, string>();
  const folders = meta?.folders;
  if (folders === undefined) {
    return paths;
  }
  for (const folder of Object.values(folders)) {
    const segments: string[] = [];
    const visited = new Set<string>();
    let current: Folder | undefined = folder;
    while (current !== undefined && !visited.has(current.id)) {
      visited.add(current.id);
      segments.unshift(current.name);
      const parentId: string | null = current.parentId ?? null;
      current = parentId !== null ? folders[parentId] : undefined;
    }
    paths.set(folder.id, segments.join(' / '));
  }
  return paths;
}

// Resolve a chat's single home folder id: its ChatMeta.folderId when it points to
// a folder that still exists, else the synthetic Unsorted sentinel. A stale
// folderId (the folder was deleted) routes to Unsorted, matching the Folders
// tree's single-home rule and the rollup's counting rule.
function resolveHomeFolderId(chatId: string, meta: ProjectMeta | undefined): string {
  if (meta === undefined) {
    return UNSORTED_FOLDER_ID;
  }
  const chatMeta = meta.chats[chatId];
  const folderId = chatMeta ? chatMeta.folderId : null;
  if (folderId === null || folderId === undefined) {
    return UNSORTED_FOLDER_ID;
  }
  return meta.folders[folderId] !== undefined ? folderId : UNSORTED_FOLDER_ID;
}

// Resolve a chat's tag-id list to its full label AND color sets, in stored order,
// dropping ids that no longer resolve and blank labels. The two arrays stay aligned
// (same length and order) so the webview can pair each pill's label with its color.
// Mirrors chatMeta.resolveTagLabels but operates on the already-extracted id list
// (the row keeps both id and label sets: the id set for the chip filter and DnD, the
// labels + colors for display).
function resolveTagsFor(
  tagIds: readonly string[],
  meta: ProjectMeta | undefined,
): { labels: string[]; colors: (string | null)[] } {
  const labels: string[] = [];
  const colors: (string | null)[] = [];
  if (meta === undefined) {
    return { labels, colors };
  }
  for (const tagId of tagIds) {
    const tag = meta.tags[tagId];
    if (tag !== undefined && typeof tag.label === 'string' && tag.label.length > 0) {
      labels.push(tag.label);
      colors.push(typeof tag.color === 'string' && tag.color.length > 0 ? tag.color : null);
    }
  }
  return { labels, colors };
}

// Build the folder sections in pre-order (each root followed by its descendants),
// carrying per-folder color and depth, then the synthetic Unsorted bucket last.
// A folder with no directly-homed chats still renders (an empty section), so the
// hierarchy is visible and a drop target exists for every folder. The Unsorted
// bucket is ALWAYS present (UI-SPEC: "always present"), even when empty.
function buildFolderSections(
  meta: ProjectMeta | undefined,
  rowsByFolder: Map<string, OrgChatRow[]>,
): FolderSection[] {
  const sections: FolderSection[] = [];
  const folders = meta?.folders ?? {};

  // Group folders by parent so we can walk roots-then-children deterministically.
  const childrenByParent = new Map<string | null, Folder[]>();
  for (const folder of Object.values(folders)) {
    const parent = folder.parentId ?? null;
    const list = childrenByParent.get(parent);
    if (list === undefined) {
      childrenByParent.set(parent, [folder]);
    } else {
      list.push(folder);
    }
  }
  // Sort each sibling group by the folder's order hint, then name, then id, so the
  // ordering is stable and deterministic regardless of object-key iteration order.
  for (const list of childrenByParent.values()) {
    list.sort(compareFolders);
  }

  // Precompute each folder's rolled-up chat count (its own directly-homed chats
  // plus every descendant's), over the STORED hierarchy. This is the header count
  // (AC1, README line 66) and is independent of the render clamp below.
  const rollup = computeRolledUpCounts(folders, childrenByParent, rowsByFolder);

  // Pre-order walk from the roots (parentId null). A visited set guards against a
  // corrupt store that produced a parent cycle, so the walk always terminates. The
  // emitted depth is CLAMPED to the one-visible-sublevel render cap (AC4); the walk
  // still recurses on the true depth so descendants keep their real ordering.
  const visited = new Set<string>();
  const walk = (parentId: string | null, depth: number): void => {
    const siblings = childrenByParent.get(parentId) ?? [];
    for (const folder of siblings) {
      if (visited.has(folder.id)) {
        continue;
      }
      visited.add(folder.id);
      sections.push({
        folderId: folder.id,
        name: folder.name,
        color: folder.color,
        depth: clampFolderDepth(depth),
        treeDepth: depth,
        synthetic: false,
        rolledUpCount: rollup.get(folder.id) ?? 0,
        rows: sortNewestFirst(rowsByFolder.get(folder.id) ?? []),
      });
      walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);

  // Any folder whose parentId points at a non-existent parent (a dangling
  // hierarchy after a delete that the store somehow left) is not reached by the
  // root walk; surface it at depth 0 so its chats are not lost. Deterministic
  // order via the same comparator.
  const orphans = Object.values(folders).filter((f) => !visited.has(f.id));
  orphans.sort(compareFolders);
  for (const folder of orphans) {
    visited.add(folder.id);
    sections.push({
      folderId: folder.id,
      name: folder.name,
      color: folder.color,
      depth: 0,
      treeDepth: 0,
      synthetic: false,
      rolledUpCount: rollup.get(folder.id) ?? 0,
      rows: sortNewestFirst(rowsByFolder.get(folder.id) ?? []),
    });
  }

  // The synthetic Unsorted bucket, always last and always present. It has no
  // descendants, so its rolled-up count is just its own directly-homed rows.
  const unsortedRows = sortNewestFirst(rowsByFolder.get(UNSORTED_FOLDER_ID) ?? []);
  sections.push({
    folderId: UNSORTED_FOLDER_ID,
    name: 'Unsorted',
    depth: 0,
    treeDepth: 0,
    synthetic: true,
    rolledUpCount: unsortedRows.length,
    rows: unsortedRows,
  });

  return sections;
}

// Compute each real folder's rolled-up chat count: its own directly-homed chats
// plus the sum over all descendant folders. Walks children with a visited guard so
// a corrupt parent cycle terminates (a cycle contributes each folder's direct count
// once). Returns a map keyed by folder id; the synthetic Unsorted bucket is not
// included (it has no descendants and is counted at the call site).
function computeRolledUpCounts(
  folders: { [id: string]: Folder },
  childrenByParent: Map<string | null, Folder[]>,
  rowsByFolder: Map<string, OrgChatRow[]>,
): Map<string, number> {
  const directCount = (id: string): number => (rowsByFolder.get(id) ?? []).length;
  const memo = new Map<string, number>();
  const rollupFor = (id: string, seen: Set<string>): number => {
    const cached = memo.get(id);
    if (cached !== undefined) {
      return cached;
    }
    if (seen.has(id)) {
      // A cycle: count this node's own chats but do not recurse back into it.
      return directCount(id);
    }
    seen.add(id);
    let total = directCount(id);
    for (const child of childrenByParent.get(id) ?? []) {
      total += rollupFor(child.id, seen);
    }
    seen.delete(id);
    memo.set(id, total);
    return total;
  };
  for (const id of Object.keys(folders)) {
    if (!memo.has(id)) {
      rollupFor(id, new Set<string>());
    }
  }
  return memo;
}

// Build the tag filter chips: one per tag that at least one scanned chat carries,
// with its resolved label, optional color, and the count of carrying chats. A tag
// with zero carrying chats is omitted (an empty chip is noise). Sorted by label
// (case-insensitive) then id for a stable, readable chip row.
function buildTagChips(
  records: readonly ChatRecord[],
  meta: ProjectMeta | undefined,
): TagChip[] {
  if (meta === undefined) {
    return [];
  }
  const counts = new Map<string, number>();
  const scanned = new Set(records.map((r) => r.sessionId));
  for (const [chatId, chatMeta] of Object.entries(meta.chats)) {
    if (!scanned.has(chatId) || !Array.isArray(chatMeta.tags)) {
      continue;
    }
    for (const tagId of chatMeta.tags) {
      counts.set(tagId, (counts.get(tagId) ?? 0) + 1);
    }
  }
  const chips: TagChip[] = [];
  for (const [tagId, count] of counts) {
    const tag = meta.tags[tagId];
    if (tag === undefined || typeof tag.label !== 'string' || tag.label.length === 0) {
      continue;
    }
    chips.push({ tagId, label: tag.label, color: tag.color, count });
  }
  chips.sort((a, b) => {
    const byLabel = a.label.toLowerCase().localeCompare(b.label.toLowerCase());
    return byLabel !== 0 ? byLabel : a.tagId.localeCompare(b.tagId);
  });
  return chips;
}

// Build the FULL project tag list for the right-click context menu (issue #85 AC #1):
// EVERY tag in meta.tags with its id, label, optional color, and the count of SCANNED
// (visible, non-archived) chats carrying it. Unlike buildTagChips this KEEPS a
// zero-chat tag (count 0), so the menu can list and check tags no chat carries yet; a
// blank-label tag is still dropped (a menu row with no label is unusable). Sorted by
// label (case-insensitive) then id, matching the chip order, so the menu is stable and
// readable. Pure and tolerant: an absent meta yields [].
function buildAllTags(
  records: readonly ChatRecord[],
  meta: ProjectMeta | undefined,
): TagChip[] {
  if (meta === undefined) {
    return [];
  }
  const counts = new Map<string, number>();
  const scanned = new Set(records.map((r) => r.sessionId));
  for (const [chatId, chatMeta] of Object.entries(meta.chats)) {
    if (!scanned.has(chatId) || !Array.isArray(chatMeta.tags)) {
      continue;
    }
    for (const tagId of chatMeta.tags) {
      counts.set(tagId, (counts.get(tagId) ?? 0) + 1);
    }
  }
  const all: TagChip[] = [];
  for (const [tagId, tag] of Object.entries(meta.tags)) {
    if (typeof tag.label !== 'string' || tag.label.length === 0) {
      continue;
    }
    all.push({ tagId, label: tag.label, color: tag.color, count: counts.get(tagId) ?? 0 });
  }
  all.sort((a, b) => {
    const byLabel = a.label.toLowerCase().localeCompare(b.label.toLowerCase());
    return byLabel !== 0 ? byLabel : a.tagId.localeCompare(b.tagId);
  });
  return all;
}

// Sort a row list newest-first (no timestamp sorts last), matching the flat and
// folder views. Returns a NEW array so the caller's bucket is not mutated in place
// in a way that surprises a later reader.
function sortNewestFirst(rows: readonly OrgChatRow[]): OrgChatRow[] {
  return [...rows].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

// Deterministic sibling order: by the order hint, then name (case-insensitive),
// then id. Stable across object-key iteration order so the rendered hierarchy is
// reproducible.
function compareFolders(a: Folder, b: Folder): number {
  if (a.order !== b.order) {
    return a.order - b.order;
  }
  const byName = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  return byName !== 0 ? byName : a.id.localeCompare(b.id);
}
