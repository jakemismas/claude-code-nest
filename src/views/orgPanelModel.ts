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
// - The Questions section is a SCAN-TIME HEURISTIC, not a live signal: a chat is
//   "awaiting your reply" only when its tier-A lastMessageRole === 'user' (the
//   last genuine human turn was the user's, with no assistant turn after it). It
//   is LABELLED a heuristic in the webview; the model just sets the flag. See
//   ARCHITECTURE.md "org-panel-as-primary".
// - A chat counts ONCE in its single home folder (its ChatMeta.folderId, or the
//   synthetic Unsorted bucket when unfiled or the folder no longer resolves),
//   mirroring the Folders tree's single-home rule. Starred and Questions are
//   CROSS-CUTTING sections: a chat can appear in Starred and/or Questions AND in
//   its folder. This is intentional (the same chat is pinned, awaiting reply, and
//   filed); only the folder placement is single-home.
// - Per-folder color rides each folder section from Folder.color (slice 3),
//   absent when the user set none.

import { ChatRecord } from '../model/types';
import { ProjectMeta, Folder } from '../store/schema';

// The synthetic catch-all bucket id for chats with no (or an unresolvable) home
// folder. Duplicated as a literal here rather than imported from folderTree.ts so
// this pure model stays free of any transitive import that might pull vscode in;
// the value is the binding contract and is asserted equal in the unit test. It
// matches the dropReducer's UNFILED sentinel so a drop onto the Unsorted section
// reduces to an unfile.
export const UNSORTED_FOLDER_ID = '__unfiled__';

// The per-row status slot (UI-SPEC.md "Chat row", design README line 51). It drives
// the left status affordance the panel renders:
//   'question' -> a blinking '?' badge (an assistant turn that asks something)
//   'done'     -> a solid unread dot (an unread assistant reply that is not a question)
//   'none'     -> an empty slot (the user has seen it, or the last turn is the user's)
// The FULLY-gated live semantics ("unread" relative to the per-device lastSeenAt read
// state, UI-SPEC.md "Read state") land with the read-state slice; today the pure model
// derives only the SCAN-TIME approximation it can honestly compute from the tier-A
// snapshot (lastMessageRole/lastMessageText). See rowStatus below.
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
  awaitingReply: boolean;
  status: RowStatus;
}

// One folder section: the folder's id, name, optional color (slice 3), nesting
// depth (0 for a root, deeper for a child), and its directly-homed chat rows in
// the assembler's sort order. childFolderIds lets the webview render the nesting
// without re-deriving the hierarchy. The synthetic Unsorted bucket is a
// FolderSection too (synthetic: true), always last, so the webview renders every
// folder-homed group uniformly.
export interface FolderSection {
  folderId: string;
  name: string;
  color?: string;
  depth: number;
  synthetic: boolean;
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
  archivedCount: number;
}

// A token-badge formatter seam so the pure model stays free of the vscode-thin
// tokenBadge import chain. The host passes tokenBadge (from chatTooltip.ts, itself
// vscode-free) so the row badge matches every other surface exactly.
export type TokenBadgeFn = (record: ChatRecord) => string;

// Build the org-panel section model from the scanned records and the project's
// curation document. Pure and total: a missing meta (project key not resolved
// yet) yields every chat unfiled, untagged, unstarred, with the heuristic still
// applied from the record's tier-A lastMessageRole. Never throws.
export function buildSections(
  records: readonly ChatRecord[],
  meta: ProjectMeta | undefined,
  tokenBadge: TokenBadgeFn,
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

  const rows = visibleRecords.map((record) => buildRow(record, meta, tokenBadge));

  // Cross-cutting sections, each sorted newest-first to match the folder rows.
  const starred = sortNewestFirst(rows.filter((r) => r.starred));
  const questions = sortNewestFirst(rows.filter((r) => r.awaitingReply));

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

  return { starred, questions, folders, tags, archivedCount };
}

// Whether a scanned chat is user-archived per the SYNCED ChatMeta.userArchived
// flag. Tolerant of an absent meta or chat entry (not archived). Never throws.
function isArchived(chatId: string, meta: ProjectMeta | undefined): boolean {
  return meta?.chats[chatId]?.userArchived === true;
}

// Project one record to its org-panel row, resolving its curation state from the
// meta. Tolerant of an absent meta or chat entry (defaults to unfiled/untagged/
// unstarred). The awaiting-reply heuristic reads ONLY the record's tier-A
// lastMessageRole; it never consults the store.
function buildRow(
  record: ChatRecord,
  meta: ProjectMeta | undefined,
  tokenBadge: TokenBadgeFn,
): OrgChatRow {
  const chatMeta = meta?.chats[record.sessionId];
  const tagIds = Array.isArray(chatMeta?.tags) ? [...(chatMeta as { tags: string[] }).tags] : [];
  const resolved = resolveTagsFor(tagIds, meta);
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
    // The scan-time awaiting-reply heuristic (slice 0 tier-A): the last GENUINE
    // turn was the user's, so Claude has not replied. NOT a live conversation
    // state; the webview labels the section as a heuristic.
    awaitingReply: record.lastMessageRole === 'user',
    status: rowStatus(record),
  };
}

// The scan-time status for a chat's status slot. The BINDING live definition
// (UI-SPEC.md lines 51-52 and "Read state") gates both non-empty states on the last
// message being an UNREAD assistant turn, i.e. newer than the per-device lastSeenAt.
// That read-state store is a later slice; until it lands the pure model returns the
// most it can honestly compute from the tier-A snapshot without inventing a signal:
//   - 'question' when the last genuine turn is an ASSISTANT turn whose text asks
//     something (endsWithQuestion), matching the 'question' badge's message shape;
//   - 'none' otherwise. The 'done' dot is intentionally NOT emitted yet because it
//     requires the unread (lastSeenAt) gate that does not exist on the snapshot;
//     emitting a dot for every assistant-last chat would fabricate an unread signal
//     for chats the user has already read. The read-state slice will re-derive both
//     states through lastSeenAt and turn this into the full mapping.
// A user-last chat is 'none' here (it is surfaced as awaitingReply / the Questions
// section instead, not as a status dot).
function rowStatus(record: ChatRecord): RowStatus {
  if (record.lastMessageRole === 'assistant' && endsWithQuestion(record.lastMessageText)) {
    return 'question';
  }
  return 'none';
}

// Whether a message's (truncated) tier-A text reads as a question: it ends with a
// question mark (after trailing whitespace), matching the design's "asks something"
// question-badge trigger. Total and null-safe.
function endsWithQuestion(text: string | null): boolean {
  if (text === null) {
    return false;
  }
  return /\?\s*$/.test(text);
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

  // Pre-order walk from the roots (parentId null). A visited set guards against a
  // corrupt store that produced a parent cycle, so the walk always terminates.
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
        depth,
        synthetic: false,
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
      synthetic: false,
      rows: sortNewestFirst(rowsByFolder.get(folder.id) ?? []),
    });
  }

  // The synthetic Unsorted bucket, always last and always present.
  sections.push({
    folderId: UNSORTED_FOLDER_ID,
    name: 'Unsorted',
    depth: 0,
    synthetic: true,
    rows: sortNewestFirst(rowsByFolder.get(UNSORTED_FOLDER_ID) ?? []),
  });

  return sections;
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
