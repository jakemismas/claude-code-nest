// Pure, vscode-free assembler from scanned chat records and the project's curation
// document to the serializable section model the org panel webview renders: Starred,
// Questions, the folder hierarchy and Unsorted.
//
// A chat is in Questions when its last turn is an unread assistant turn that asks something;
// unread is per-device, from the injected lastSeenAt map. A chat sits in one home folder (or
// Unsorted when unfiled or the folder is gone), but Starred and Questions are cross-cutting,
// so a chat can also appear there.

import { ChatRecord } from '../model/types';
import { ProjectMeta, Folder } from '../store/schema';
import { asksSomething } from '../model/questionHeuristic';
import { clampFolderDepth } from '../model/folderTree';
import { GroupBy } from '../fleet/nestConfig';
import { Placement, resolvePlacement } from '../fleet/placement';
import type { ModelChat, ModelUserFolder } from '../fleet/groupModel';

// Duplicated from folderTree.ts so this pure model pulls in no vscode import; the unit test
// asserts the values match. Equals dropReducer's UNFILED sentinel, so a drop on Unsorted
// unfiles.
export const UNSORTED_FOLDER_ID = '__unfiled__';

// The left status slot: 'question' is a blinking '?' (unread assistant turn that asks),
// 'done' a solid dot (unread assistant reply), 'none' empty. See rowStatus.
export type RowStatus = 'question' | 'done' | 'none';

// One chat row, as plain JSON-safe data so it crosses postMessage. tokens is '' when no
// usage. tagIds is parallel to tags for the drag-and-drop shell and chip filter. folderId
// is not carried; only the assembler resolves it.
export interface OrgChatRow {
  sessionId: string;
  title: string;
  timestamp: number | null;
  tokens: string;
  snippet: string | null;
  tags: string[];
  tagIds: string[];
  // Parallel to tags; null when the tag has no color.
  tagColors: (string | null)[];
  starred: boolean;
  // Equals status === 'question'; kept so the webview does not re-derive it.
  awaitingReply: boolean;
  status: RowStatus;
  // Folder path such as "Work / Backend API", shown only in Questions and flat results.
  breadcrumb: string | null;
}

// One folder section with its directly-homed rows in sort order. The synthetic Unsorted
// bucket is a section too, always last.
export interface FolderSection {
  folderId: string;
  name: string;
  color?: string;
  // Render depth, clamped to the visible sublevel cap; the stored parentId chain is not changed.
  depth: number;
  // Uncapped stored depth, for collapse bookkeeping only: folders that clamp to the same
  // render depth still hide their own descendants. Equals depth within the cap.
  treeDepth: number;
  synthetic: boolean;
  // Own chats plus every descendant's, over the stored hierarchy, so it ignores the render
  // clamp and filters.
  rolledUpCount: number;
  // A computed group (fleet folder, ticket, source folder or date bucket): not a drop target.
  auto?: boolean;
  rows: OrgChatRow[];
}

export interface TagChip {
  tagId: string;
  label: string;
  color?: string;
  count: number;
}

// folders are in pre-order (roots in stored order, each followed by descendants) with
// Unsorted last. archivedCount counts scanned archived chats, which are excluded from every
// visible section.
export interface OrgSections {
  starred: OrgChatRow[];
  questions: OrgChatRow[];
  folders: FolderSection[];
  tags: TagChip[];
  // Every project tag, including zero-chat ones that `tags` omits, for the context menu.
  allTags: TagChip[];
  archivedCount: number;
}

// Injected so this pure model avoids the vscode-thin import chain; the host passes the
// same tokenBadge the other surfaces use.
export type TokenBadgeFn = (record: ChatRecord) => string;

// Without it every unfiled chat lands in Unsorted.
export interface PlacementContext {
  groupBy: GroupBy;
  now: number;
  // Per chat: the newest fleet organize folder and the fleet ticket, when known.
  fleetByChat: ReadonlyMap<string, { folder: string | null; ticket: string | null }>;
  // Per chat: the name of the folder the transcript was scanned from.
  sourceByChat: ReadonlyMap<string, string>;
}

interface AutoGroup {
  key: string;
  label: string;
  order: number;
  rows: OrgChatRow[];
}

// Total: a missing meta leaves every chat unfiled, untagged and unstarred. Never throws.
// lastSeenAt defaults to empty, meaning nothing seen.
export function buildSections(
  records: readonly ChatRecord[],
  meta: ProjectMeta | undefined,
  tokenBadge: TokenBadgeFn,
  lastSeenAt: ReadonlyMap<string, number> = new Map(),
  placement?: PlacementContext,
): OrgSections {
  // Archived is the synced userArchived flag, not the local orphan flag. The count covers
  // scanned records only; an archived chat with no transcript shows only in the Archive view.
  const visibleRecords = records.filter((r) => !isArchived(r.sessionId, meta));
  const archivedCount = records.length - visibleRecords.length;

  const folderPaths = buildFolderPaths(meta);

  const rows = visibleRecords.map((record) =>
    buildRow(record, meta, tokenBadge, lastSeenAt, folderPaths),
  );

  const starred = sortNewestFirst(rows.filter((r) => r.starred));
  const questions = sortNewestFirst(rows.filter((r) => r.status === 'question'));

  const homeByChat = new Map<string, string>();
  const autoByChat = new Map<string, Placement & { kind: 'group' }>();
  for (const record of visibleRecords) {
    const home = resolveHomeFolderId(record.sessionId, meta);
    homeByChat.set(record.sessionId, home);
    if (placement !== undefined && home === UNSORTED_FOLDER_ID) {
      const fleet = placement.fleetByChat.get(record.sessionId);
      const placed = resolvePlacement(
        {
          handFiledFolderId: null,
          fleetFolder: fleet?.folder ?? null,
          ticket: fleet?.ticket ?? null,
          sourceFolder: placement.sourceByChat.get(record.sessionId) ?? null,
          timestamp: record.timestamp,
        },
        placement.groupBy,
        placement.now,
      );
      if (placed.kind === 'group') {
        autoByChat.set(record.sessionId, placed);
      }
    }
  }
  const rowsByFolder = new Map<string, OrgChatRow[]>();
  const autoGroups = new Map<string, AutoGroup>();
  for (const row of rows) {
    const auto = autoByChat.get(row.sessionId);
    if (auto !== undefined) {
      const existing = autoGroups.get(auto.key);
      if (existing === undefined) {
        autoGroups.set(auto.key, { key: auto.key, label: auto.label, order: auto.order, rows: [row] });
      } else {
        existing.rows.push(row);
      }
      continue;
    }
    const home = homeByChat.get(row.sessionId) ?? UNSORTED_FOLDER_ID;
    const bucket = rowsByFolder.get(home);
    if (bucket === undefined) {
      rowsByFolder.set(home, [row]);
    } else {
      bucket.push(row);
    }
  }

  const folders = buildFolderSections(meta, rowsByFolder, [...autoGroups.values()]);
  const tags = buildTagChips(visibleRecords, meta);
  const allTags = buildAllTags(visibleRecords, meta);

  return { starred, questions, folders, tags, allTags, archivedCount };
}

// One row of the Archive overlay, built from the synced userArchived flag rather than the
// scan, so an archived chat whose transcript is gone still lists (present: false). folder is
// the breadcrumb or 'Unsorted'; relativeTime is empty when the transcript is gone.
export interface ArchivedRow {
  sessionId: string;
  title: string;
  folder: string;
  relativeTime: string;
  starred: boolean;
  present: boolean;
}

// Injected so this pure builder needs no clock; the host passes relativeTimeCompact.
export type RelativeTimeFn = (timestamp: number | null) => string;

// Membership is the synced userArchived flag, so chats archived on another device or cleaned
// up by Claude still appear. A gone chat falls back to the stored body-copy title, then the
// sessionId. Present chats sort newest first, then gone chats by sessionId. Absent meta
// yields [].
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

// Shared with the host's content-search index so archived chats are not ranked and then
// dropped by the client join, which would crowd live matches out of the 50-hit cap.
export function isArchived(chatId: string, meta: ProjectMeta | undefined): boolean {
  return meta?.chats[chatId]?.userArchived === true;
}

// Tolerant of an absent meta or chat entry.
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
    awaitingReply: status === 'question',
    status,
    breadcrumb: resolveBreadcrumb(record.sessionId, meta, folderPaths),
  };
}

// Unread means the last turn is an assistant turn newer than lastSeenAt. A newer user
// message makes the chat 'none' because the last role is no longer assistant. A null
// timestamp counts as unread so a brand-new chat surfaces until opened.
export function rowStatus(record: ChatRecord, lastSeenAt: ReadonlyMap<string, number>): RowStatus {
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

// Null for Unsorted, which has no breadcrumb.
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

// The visited guard ends a corrupt parent cycle; a broken ancestor chain falls back to the
// folder's own name.
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

// A stale folderId (deleted folder) routes to Unsorted, as in the Folders tree and rollup.
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

// Labels and colors stay aligned so the webview can pair each pill with its color.
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

// Empty folders still render so every folder is a drop target; Unsorted is always present.
function buildFolderSections(
  meta: ProjectMeta | undefined,
  rowsByFolder: Map<string, OrgChatRow[]>,
  autoGroups: readonly AutoGroup[] = [],
): FolderSection[] {
  const sections: FolderSection[] = [];
  const folders = meta?.folders ?? {};

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
  for (const list of childrenByParent.values()) {
    list.sort(compareFolders);
  }

  const rollup = computeRolledUpCounts(folders, childrenByParent, rowsByFolder);

  // The visited set ends a corrupt parent cycle. Emitted depth is clamped; the walk keeps
  // the true depth.
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

  // A folder with a dangling parentId is not reached by the walk; show it at depth 0 so its
  // chats are not lost.
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

  const orderedGroups = [...autoGroups].sort(
    (a, b) => a.order - b.order || a.label.localeCompare(b.label) || a.key.localeCompare(b.key),
  );
  for (const g of orderedGroups) {
    sections.push({
      folderId: g.key,
      name: g.label,
      depth: 0,
      treeDepth: 0,
      synthetic: true,
      auto: true,
      rolledUpCount: g.rows.length,
      rows: sortNewestFirst(g.rows),
    });
  }

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

// A visited guard ends a corrupt parent cycle, counting each folder's own chats once.
// Unsorted is not included; the caller counts it.
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

// One chip per tag that a scanned chat carries; zero-chat tags are omitted as noise.
// Sorted by label case-insensitively, then id.
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

// Unlike buildTagChips this keeps zero-chat tags so the menu can check tags no chat carries
// yet. Blank labels are dropped because the menu row would be unusable. Same sort order.
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

// Newest first, no timestamp last. Returns a new array.
function sortNewestFirst(rows: readonly OrgChatRow[]): OrgChatRow[] {
  return [...rows].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

// Order hint, then name case-insensitively, then id, independent of object-key order.
function compareFolders(a: Folder, b: Folder): number {
  if (a.order !== b.order) {
    return a.order - b.order;
  }
  const byName = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  return byName !== 0 ? byName : a.id.localeCompare(b.id);
}

// Chats for the fleet group model: the hand-filed folder (only while it exists), the archived
// flag, and a working directory (live session first, else the transcript's).
export function fleetModelChats(
  records: readonly ChatRecord[],
  meta: ProjectMeta | undefined,
  cwdByChat: ReadonlyMap<string, string>,
): ModelChat[] {
  return records.map((r) => {
    const home = resolveHomeFolderId(r.sessionId, meta);
    return {
      sessionId: r.sessionId,
      title: r.title,
      timestamp: r.timestamp,
      cwd: cwdByChat.get(r.sessionId) ?? r.cwd ?? null,
      handFiledFolderId: home === UNSORTED_FOLDER_ID ? null : home,
      archived: isArchived(r.sessionId, meta),
    };
  });
}

export function fleetModelFolders(meta: ProjectMeta | undefined): ModelUserFolder[] {
  if (meta === undefined) {
    return [];
  }
  return Object.values(meta.folders)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .map((f) => ({ folderId: f.id, name: f.name }));
}
