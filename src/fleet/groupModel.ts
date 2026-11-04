// Pure group model. Turns chats, fleet state, statuses, the queue and the layout mode into
// the sections the panel shows. No vscode, no filesystem, no clock: the caller passes now.
import * as path from 'path';
import { GroupBy } from './nestConfig';
import { QueueRow } from './queueTable';
import { ChatStatus, rollupStatus } from './status';
import { chatSuffix, removeTicket } from './suffix';
import { FleetEntry, FleetState } from './types';

export type ResolvedGroupBy = Exclude<GroupBy, 'auto'>;

// A chat with a transcript, as the host knows it.
export interface ModelChat {
  readonly sessionId: string;
  readonly title: string;
  readonly timestamp: number | null;
  // The working directory recorded in the transcript, when known.
  readonly cwd: string | null;
  // The user folder the chat was filed in by hand, else null.
  readonly handFiledFolderId: string | null;
  readonly archived: boolean;
}

export interface ModelUserFolder {
  readonly folderId: string;
  readonly name: string;
}

export interface GroupModelInput {
  readonly chats: readonly ModelChat[];
  readonly userFolders: readonly ModelUserFolder[];
  readonly fleet: FleetState;
  readonly statuses: ReadonlyMap<string, ChatStatus>;
  // Session ids of background sessions that can be opened in a terminal.
  readonly attachableIds: ReadonlySet<string>;
  readonly queueRows: readonly QueueRow[];
  readonly groupBy: GroupBy;
  readonly workspaceRoot: string | null;
  readonly now: number;
  // The Active projection: only working and needs chats, groups with one forced open.
  readonly active: boolean;
}

export interface FleetRow {
  readonly id: string;
  readonly sessionId: string;
  readonly title: string;
  readonly timestamp: number | null;
  readonly status: ChatStatus;
  // A background session is working or needs you, so Open in terminal applies.
  readonly attachable: boolean;
  // The agent, else the role, else empty.
  readonly agentTag: string;
  readonly suffix: string;
  readonly ticket: string | null;
  // Chats launched by this chat and placed in the same group.
  readonly children: readonly FleetRow[];
}

export type FleetGroupKind = 'ticket' | 'folder' | 'date' | 'user';

export interface FleetGroup {
  readonly id: string;
  readonly kind: FleetGroupKind;
  readonly label: string;
  // Ticket groups only.
  readonly ticket: string | null;
  readonly title: string;
  readonly stage: string;
  readonly rollup: ChatStatus | null;
  readonly hasLive: boolean;
  // True in the Active projection for a group that holds a live chat.
  readonly forceOpen: boolean;
  readonly rows: readonly FleetRow[];
}

export interface QueueEntry {
  readonly key: string;
  readonly title: string;
  readonly stage: string;
  // The ticket has a working or needs chat.
  readonly live: boolean;
}

export interface FleetSections {
  readonly mode: ResolvedGroupBy;
  readonly active: boolean;
  readonly orchestrator: FleetRow | null;
  readonly pastOrchestrators: readonly FleetRow[];
  readonly groups: readonly FleetGroup[];
  readonly userFolders: readonly FleetGroup[];
  readonly unsorted: readonly FleetRow[];
  readonly archivedCount: number;
  // Working and needs chats, orchestrator included, whatever the projection.
  readonly activeCount: number;
  readonly queue: readonly QueueEntry[];
}

export const DATE_GROUPS = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'Earlier this week' },
  { key: 'older', label: 'Older' },
] as const;

const ROOT_KEY = '';

// Group ids carry a kind prefix and never contain ':', '#' or '>', so they cannot collide
// with a reserved sentinel or split a composite id. Those characters and the escape
// character are percent-escaped, which keeps distinct keys on distinct ids.
export function groupId(kind: string, key: string): string {
  return `${kind}.${key.replace(/[%:#>]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))}`;
}

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Index into DATE_GROUPS. The local calendar week starts on Monday.
export function dateGroupIndex(timestamp: number | null, now: number): number {
  if (timestamp === null) {
    return 2;
  }
  const today = startOfLocalDay(now);
  if (timestamp >= today) {
    return 0;
  }
  const monday = new Date(today);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const mondayStart = monday.getTime();
  return timestamp >= mondayStart ? 1 : 2;
}

function parseTime(at: string | null): number | null {
  if (at === null) {
    return null;
  }
  const t = Date.parse(at);
  return Number.isFinite(t) ? t : null;
}

interface Item {
  readonly sessionId: string;
  readonly name: string;
  readonly timestamp: number | null;
  readonly cwd: string | null;
  readonly handFiledFolderId: string | null;
  readonly archived: boolean;
  readonly entry: FleetEntry | null;
  readonly status: ChatStatus;
  readonly attachable: boolean;
}

// Working subfolder key relative to the workspace root, '/' separated. null when unknown or
// outside the root.
function subfolderKey(item: Item, root: string | null): string | null {
  const cwd = item.entry !== null && item.entry.cwd.length > 0 ? item.entry.cwd : item.cwd;
  if (root === null || cwd === null || cwd.length === 0) {
    return null;
  }
  const rel = path.relative(root, cwd);
  if (rel === '') {
    return ROOT_KEY;
  }
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  return rel.split(path.sep).join('/');
}

export function resolveGroupBy(groupBy: GroupBy, items: readonly Item[], root: string | null): ResolvedGroupBy {
  if (groupBy !== 'auto') {
    return groupBy;
  }
  if (items.some((i) => i.entry !== null && i.entry.ticket !== null && i.entry.ticket.length > 0)) {
    return 'tickets';
  }
  const keys = new Set<string>();
  for (const item of items) {
    const key = subfolderKey(item, root);
    if (key !== null) {
      keys.add(key);
    }
  }
  return keys.size > 1 ? 'folders' : 'date';
}

function isLive(status: ChatStatus): boolean {
  return status === 'working' || status === 'needs';
}

function sortNewest(items: readonly Item[]): Item[] {
  return [...items].sort((a, b) => (b.timestamp ?? -1) - (a.timestamp ?? -1));
}

function itemTime(chat: ModelChat | null, entry: FleetEntry | null): number | null {
  if (chat !== null && chat.timestamp !== null) {
    return chat.timestamp;
  }
  return entry === null ? null : parseTime(entry.lastAt) ?? parseTime(entry.firstAt);
}

function buildItems(input: GroupModelInput): Item[] {
  const entryById = new Map(input.fleet.entries.map((e) => [e.sessionId, e]));
  const items: Item[] = [];
  const seen = new Set<string>();
  for (const chat of input.chats) {
    const entry = entryById.get(chat.sessionId) ?? null;
    seen.add(chat.sessionId);
    items.push({
      sessionId: chat.sessionId,
      name: entry !== null && entry.name.length > 0 ? entry.name : chat.title,
      timestamp: itemTime(chat, entry),
      cwd: chat.cwd,
      handFiledFolderId: chat.handFiledFolderId,
      archived: chat.archived,
      entry,
      status: input.statuses.get(chat.sessionId) ?? 'idle',
      attachable: input.attachableIds.has(chat.sessionId),
    });
  }
  // A fleet entry with no transcript yet is a queued chat.
  for (const entry of input.fleet.entries) {
    if (seen.has(entry.sessionId)) {
      continue;
    }
    items.push({
      sessionId: entry.sessionId,
      name: entry.name,
      timestamp: itemTime(null, entry),
      cwd: null,
      handFiledFolderId: null,
      archived: false,
      entry,
      status: input.statuses.get(entry.sessionId) ?? 'idle',
      attachable: input.attachableIds.has(entry.sessionId),
    });
  }
  return items;
}

function queueFor(rows: readonly QueueRow[], ticket: string | null): QueueRow | null {
  if (ticket === null) {
    return null;
  }
  const wanted = ticket.toLowerCase();
  return rows.find((r) => r.key.toLowerCase() === wanted) ?? null;
}

function ticketTitle(items: readonly Item[], queueRow: QueueRow | null, ticket: string): string {
  if (queueRow !== null && queueRow.title !== null && queueRow.title.length > 0) {
    return queueRow.title;
  }
  const newest = sortNewest(items)[0];
  return newest === undefined ? '' : removeTicket(newest.name, ticket);
}

function ticketStage(items: readonly Item[], queueRow: QueueRow | null): string {
  if (queueRow !== null && queueRow.stage.length > 0) {
    return queueRow.stage;
  }
  const staged = sortNewest(items.filter((i) => i.entry !== null && i.entry.stage !== null && i.entry.stage.length > 0));
  return staged.length === 0 || staged[0].entry === null ? '' : (staged[0].entry.stage ?? '');
}

interface RowContext {
  readonly ticket: string | null;
  readonly title: string;
  readonly nest: boolean;
}

function toRow(item: Item, ctx: RowContext, children: readonly FleetRow[]): FleetRow {
  const entry = item.entry;
  const agentTag = entry === null ? '' : entry.agent.length > 0 ? entry.agent : entry.role ?? '';
  const ticket = entry === null ? null : entry.ticket;
  return {
    id: item.sessionId,
    sessionId: item.sessionId,
    title: item.name,
    timestamp: item.timestamp,
    status: item.status,
    attachable: item.attachable,
    agentTag,
    suffix: ctx.ticket === null ? '' : chatSuffix(item.name, ctx.ticket, ctx.title, agentTag),
    ticket,
    children,
  };
}

// Nests a chat under the chat that launched it, one level, when both sit in this group.
function buildRows(items: readonly Item[], ctx: RowContext): FleetRow[] {
  const sorted = sortNewest(items);
  if (!ctx.nest) {
    return sorted.map((i) => toRow(i, ctx, []));
  }
  const inGroup = new Map(sorted.map((i) => [i.sessionId, i]));
  const topLauncherOf = (item: Item): string | null => {
    const seenIds = new Set<string>([item.sessionId]);
    let current = item;
    let top: string | null = null;
    for (;;) {
      const by = current.entry === null ? '' : current.entry.launchedBy;
      const parent = inGroup.get(by);
      if (by.length === 0 || parent === undefined) {
        return top;
      }
      // A launch cycle has no top; leave its members unnested.
      if (seenIds.has(by)) {
        return null;
      }
      seenIds.add(by);
      top = by;
      current = parent;
    }
  };
  const kids = new Map<string, Item[]>();
  const roots: Item[] = [];
  for (const item of sorted) {
    const parent = topLauncherOf(item);
    if (parent === null) {
      roots.push(item);
    } else {
      const list = kids.get(parent) ?? [];
      list.push(item);
      kids.set(parent, list);
    }
  }
  return roots.map((r) =>
    toRow(
      r,
      ctx,
      (kids.get(r.sessionId) ?? []).map((k) => toRow(k, ctx, [])),
    ),
  );
}

function liveRows(rows: readonly FleetRow[]): FleetRow[] {
  const out: FleetRow[] = [];
  for (const row of rows) {
    const children = row.children.filter((c) => isLive(c.status));
    if (isLive(row.status) || children.length > 0) {
      out.push({ ...row, children });
    }
  }
  return out;
}

function flatten(rows: readonly FleetRow[]): FleetRow[] {
  return rows.flatMap((r) => [r, ...r.children]);
}

interface GroupSpec {
  readonly id: string;
  readonly kind: FleetGroupKind;
  readonly label: string;
  readonly ticket: string | null;
  readonly order: number;
  readonly items: Item[];
}

function finishGroup(spec: GroupSpec, input: GroupModelInput, nest: boolean): FleetGroup {
  const queueRow = queueFor(input.queueRows, spec.ticket);
  const title = spec.ticket === null ? '' : ticketTitle(spec.items, queueRow, spec.ticket);
  const stage = spec.ticket === null ? '' : ticketStage(spec.items, queueRow);
  const rows = buildRows(spec.items, { ticket: spec.ticket, title, nest });
  const flat = flatten(rows);
  const hasLive = flat.some((r) => isLive(r.status));
  return {
    id: spec.id,
    kind: spec.kind,
    label: spec.label,
    ticket: spec.ticket,
    title,
    stage,
    rollup: rollupStatus(flat.map((r) => r.status)),
    hasLive,
    forceOpen: input.active && hasLive,
    rows: input.active ? liveRows(rows) : rows,
  };
}

export function buildFleetSections(input: GroupModelInput): FleetSections {
  const all = buildItems(input);
  const archivedCount = all.filter((i) => i.archived).length;
  const items = all.filter((i) => !i.archived);
  const mode = resolveGroupBy(input.groupBy, items, input.workspaceRoot);

  const folderIds = new Set(input.userFolders.map((f) => f.folderId));
  const userBuckets = new Map<string, Item[]>();
  const specs = new Map<string, GroupSpec>();
  const unsorted: Item[] = [];
  const orchestrators: Item[] = [];

  const add = (id: string, kind: FleetGroupKind, label: string, ticket: string | null, order: number, item: Item) => {
    const existing = specs.get(id);
    if (existing === undefined) {
      specs.set(id, { id, kind, label, ticket, order, items: [item] });
    } else {
      existing.items.push(item);
    }
  };

  for (const item of items) {
    const entry = item.entry;
    // A hand-filed chat stays in its folder in every mode.
    if (item.handFiledFolderId !== null && folderIds.has(item.handFiledFolderId)) {
      const list = userBuckets.get(item.handFiledFolderId) ?? [];
      list.push(item);
      userBuckets.set(item.handFiledFolderId, list);
      continue;
    }
    if (mode === 'tickets' && entry !== null && entry.role === 'orchestrator') {
      orchestrators.push(item);
      continue;
    }
    // A fleet organize folder is a virtual group; it never writes to the store.
    if (entry !== null && entry.folder !== null && entry.folder.length > 0) {
      add(groupId('folder', entry.folder), 'folder', entry.folder, null, 0, item);
      continue;
    }
    if (mode === 'tickets') {
      if (entry !== null && entry.ticket !== null && entry.ticket.length > 0) {
        add(groupId('ticket', entry.ticket.toLowerCase()), 'ticket', entry.ticket, entry.ticket, 0, item);
      } else {
        unsorted.push(item);
      }
    } else if (mode === 'folders') {
      const key = subfolderKey(item, input.workspaceRoot);
      if (key === null) {
        unsorted.push(item);
      } else {
        add(groupId('dir', key === ROOT_KEY ? '.' : key), 'folder', key === ROOT_KEY ? 'Workspace root' : key, null, 0, item);
      }
    } else {
      const idx = dateGroupIndex(item.timestamp, input.now);
      add(groupId('date', DATE_GROUPS[idx].key), 'date', DATE_GROUPS[idx].label, null, idx, item);
    }
  }

  const nest = mode === 'folders';
  const newest = (spec: GroupSpec): number => Math.max(-1, ...spec.items.map((i) => i.timestamp ?? -1));
  const ordered = [...specs.values()].sort((a, b) =>
    mode === 'date' ? a.order - b.order : newest(b) - newest(a),
  );
  let groups = ordered.map((s) => finishGroup(s, input, nest));
  let userGroups = input.userFolders.map((f) =>
    finishGroup(
      { id: f.folderId, kind: 'user', label: f.name, ticket: null, order: 0, items: userBuckets.get(f.folderId) ?? [] },
      input,
      false,
    ),
  );

  const orchestratorItems = sortNewest(orchestrators);
  const currentId = input.fleet.currentOrchestrator?.sessionId ?? null;
  const current = orchestratorItems.find((i) => i.sessionId === currentId) ?? null;
  const past = orchestratorItems.filter((i) => i !== current);
  const plain: RowContext = { ticket: null, title: '', nest: false };
  const orchestratorRow = current === null ? null : toRow(current, plain, []);
  let pastRows = past.map((i) => toRow(i, plain, []));

  const activeCount = items.filter((i) => isLive(i.status)).length;
  let unsortedRows = sortNewest(unsorted).map((i) => toRow(i, plain, []));
  let pinned = orchestratorRow;
  if (input.active) {
    groups = groups.filter((g) => g.hasLive);
    userGroups = userGroups.filter((g) => g.hasLive);
    unsortedRows = unsortedRows.filter((r) => isLive(r.status));
    pastRows = pastRows.filter((r) => isLive(r.status));
    pinned = pinned !== null && isLive(pinned.status) ? pinned : null;
  }

  const live = new Set<string>();
  for (const item of items) {
    if (isLive(item.status) && item.entry !== null && item.entry.ticket !== null) {
      live.add(item.entry.ticket.toLowerCase());
    }
  }
  const queue = input.queueRows.map((r) => ({
    key: r.key,
    title: r.title ?? '',
    stage: r.stage,
    live: live.has(r.key.toLowerCase()),
  }));

  return {
    mode,
    active: input.active,
    orchestrator: pinned,
    pastOrchestrators: pastRows,
    groups,
    userFolders: userGroups,
    unsorted: unsortedRows,
    archivedCount,
    activeCount,
    queue,
  };
}
