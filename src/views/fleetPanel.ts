// Pure fleet panel message. Turns the group model's sections into the plain, display-ready
// shape the webview renders, including the ARIA fields, so the webview only draws. No
// vscode, no filesystem, no clock.
import { FleetGroup, FleetGroupKind, FleetRow, FleetSections, ResolvedGroupBy } from '../fleet/groupModel';
import { ChatStatus } from '../fleet/status';

export type StageFamily = 'teal' | 'orange' | 'blue' | 'green';

export const AGENT_TAG_KINDS = ['build', 'fix', 'qa', 'spike', 'review', 'capture'] as const;
export type AgentTagKind = (typeof AGENT_TAG_KINDS)[number];

export type PanelGroupKind = FleetGroupKind | 'unsorted';

export const UNSORTED_GROUP_ID = 'unsorted';
export const PAST_ORCHESTRATORS_ID = 'past-orchestrators';

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export const STATUS_LABELS: Readonly<Record<ChatStatus, string>> = {
  working: 'Working',
  needs: 'Needs you',
  queued: 'Queued',
  done: 'Done',
  idle: 'Idle',
};

// The layout file inputs that color a stage pill.
export interface StageStyleConfig {
  // Stage name to hex color, from the layout file's tags.
  readonly tags: { readonly [name: string]: string };
  readonly doneStages: readonly string[];
}

export const DEFAULT_STAGE_STYLE: StageStyleConfig = { tags: {}, doneStages: ['Done'] };

export interface PanelFleetRow {
  readonly sessionId: string;
  readonly title: string;
  readonly status: ChatStatus;
  readonly statusLabel: string;
  // A background session that is working or needs you can be opened in a terminal.
  readonly attachable: boolean;
  // The agent or role text, else empty.
  readonly agentTag: string;
  // A closed color key for the agent tag, or empty when there is no tag.
  readonly tagKind: AgentTagKind | '';
  readonly suffix: string;
  // A chat launched by the chat above it in the same group.
  readonly child: boolean;
  readonly ariaLevel: number;
  readonly ariaPosInSet: number;
  readonly ariaSetSize: number;
  readonly ariaLabel: string;
}

export interface PanelFleetGroup {
  readonly id: string;
  readonly kind: PanelGroupKind;
  readonly label: string;
  readonly ticket: string | null;
  readonly title: string;
  readonly stage: string;
  readonly stageFamily: StageFamily | '';
  // A validated #rrggbb from the layout file's tags, else null.
  readonly stageColor: string | null;
  readonly rollup: ChatStatus | null;
  readonly hasLive: boolean;
  // The Active projection forces this group open.
  readonly forceOpen: boolean;
  readonly count: number;
  readonly ariaLevel: number;
  readonly ariaPosInSet: number;
  readonly ariaSetSize: number;
  readonly ariaLabel: string;
  readonly rows: readonly PanelFleetRow[];
}

export interface PanelQueueRow {
  readonly position: number;
  readonly key: string;
  readonly title: string;
  readonly stage: string;
  readonly stageFamily: StageFamily | '';
  readonly stageColor: string | null;
  readonly live: boolean;
}

export interface FleetMessage {
  readonly type: 'fleet';
  readonly mode: ResolvedGroupBy;
  readonly active: boolean;
  readonly activeCount: number;
  readonly queueCount: number;
  readonly archivedCount: number;
  readonly orchestrator: PanelFleetRow | null;
  readonly pastOrchestrators: PanelFleetGroup | null;
  readonly groups: readonly PanelFleetGroup[];
  readonly userFolders: readonly PanelFleetGroup[];
  readonly unsorted: PanelFleetGroup | null;
  readonly queue: readonly PanelQueueRow[];
}

// Stage pill color family. Failing stages are orange, finished stages green, review-like
// stages teal and everything else blue.
export function stageFamily(stage: string, doneStages: readonly string[]): StageFamily | '' {
  const name = stage.trim();
  if (name.length === 0) {
    return '';
  }
  if (/fail/i.test(name)) {
    return 'orange';
  }
  const lower = name.toLowerCase();
  if (doneStages.some((d) => d.trim().toLowerCase() === lower)) {
    return 'green';
  }
  if (/uat|review|test/i.test(name)) {
    return 'teal';
  }
  return 'blue';
}

// The layout file's color for a stage name, matched ignoring case, else null.
export function stageColor(stage: string, tags: StageStyleConfig['tags']): string | null {
  const lower = stage.trim().toLowerCase();
  if (lower.length === 0) {
    return null;
  }
  for (const [name, color] of Object.entries(tags)) {
    if (name.trim().toLowerCase() === lower && HEX_COLOR_RE.test(color)) {
      return color;
    }
  }
  return null;
}

// Maps an agent or role word to one of the closed color keys; any other word uses the
// review colors.
export function agentTagKind(tag: string): AgentTagKind | '' {
  const lower = tag.trim().toLowerCase();
  if (lower.length === 0) {
    return '';
  }
  return (AGENT_TAG_KINDS as readonly string[]).includes(lower) ? (lower as AgentTagKind) : 'review';
}

function rowLabel(row: FleetRow, child: boolean): string {
  const parts: string[] = [];
  const text = row.suffix.length > 0 ? row.suffix : row.title;
  if (row.agentTag.length > 0) {
    parts.push(row.agentTag);
  }
  if (text.length > 0) {
    parts.push(text);
  }
  const base = parts.length > 0 ? parts.join(' ') : row.title;
  return `${base}. ${STATUS_LABELS[row.status]}.${child ? ' Launched by the chat above.' : ''}`;
}

function toPanelRow(
  row: FleetRow,
  child: boolean,
  baseLevel: number,
  pos: number,
  size: number,
): PanelFleetRow {
  return {
    sessionId: row.sessionId,
    title: row.title,
    status: row.status,
    statusLabel: STATUS_LABELS[row.status],
    attachable: row.attachable,
    agentTag: row.agentTag,
    tagKind: agentTagKind(row.agentTag),
    suffix: row.suffix,
    child,
    ariaLevel: child ? baseLevel + 1 : baseLevel,
    ariaPosInSet: pos,
    ariaSetSize: size,
    ariaLabel: rowLabel(row, child),
  };
}

// A parent row is followed by the chats it launched, in one flat list.
function flattenRows(rows: readonly FleetRow[], baseLevel: number): PanelFleetRow[] {
  const flat: { row: FleetRow; child: boolean }[] = [];
  for (const row of rows) {
    flat.push({ row, child: false });
    for (const kid of row.children) {
      flat.push({ row: kid, child: true });
    }
  }
  const out: PanelFleetRow[] = [];
  let pos = 0;
  const topCount = rows.length;
  for (const item of flat) {
    if (!item.child) {
      pos += 1;
    }
    out.push(toPanelRow(item.row, item.child, baseLevel, item.child ? 1 : pos, item.child ? 1 : topCount));
  }
  return out;
}

function groupLabel(kind: PanelGroupKind, label: string, ticket: string | null, title: string, stage: string, status: ChatStatus | null, count: number): string {
  const head = kind === 'ticket' && ticket !== null ? [ticket, title].filter((p) => p.length > 0).join(' ') : label;
  const parts = [head];
  if (stage.length > 0) {
    parts.push(`Stage ${stage}`);
  }
  if (status !== null) {
    parts.push(STATUS_LABELS[status]);
  }
  parts.push(count === 1 ? '1 chat' : `${count} chats`);
  return parts.join('. ');
}

type GroupSource = Omit<FleetGroup, 'kind'> & { readonly kind: PanelGroupKind };

function toPanelGroup(group: GroupSource, style: StageStyleConfig, pos: number, size: number): PanelFleetGroup {
  const rows = flattenRows(group.rows, 2);
  const count = rows.length;
  return {
    id: group.id,
    kind: group.kind,
    label: group.label,
    ticket: group.ticket,
    title: group.title,
    stage: group.stage,
    stageFamily: stageFamily(group.stage, style.doneStages),
    stageColor: stageColor(group.stage, style.tags),
    rollup: group.rollup,
    hasLive: group.hasLive,
    forceOpen: group.forceOpen,
    count,
    ariaLevel: 1,
    ariaPosInSet: pos,
    ariaSetSize: size,
    ariaLabel: groupLabel(group.kind, group.label, group.ticket, group.title, group.stage, group.rollup, count),
    rows,
  };
}

function toPanelGroups(groups: readonly FleetGroup[], style: StageStyleConfig, offset: number, size: number): PanelFleetGroup[] {
  return groups.map((g, i) => toPanelGroup(g, style, offset + i + 1, size));
}

// The one place a FleetSections value becomes a panel message.
export function buildFleetMessage(sections: FleetSections, style: StageStyleConfig = DEFAULT_STAGE_STYLE): FleetMessage {
  const topLevel =
    (sections.orchestrator === null ? 0 : 1) +
    (sections.pastOrchestrators.length > 0 ? 1 : 0) +
    sections.groups.length +
    sections.userFolders.length +
    (sections.unsorted.length > 0 ? 1 : 0);

  let pos = 0;
  const orchestrator =
    sections.orchestrator === null ? null : toPanelRow(sections.orchestrator, false, 1, (pos += 1), topLevel);

  let past: PanelFleetGroup | null = null;
  if (sections.pastOrchestrators.length > 0) {
    pos += 1;
    past = toPanelGroup(
      {
        id: PAST_ORCHESTRATORS_ID,
        kind: 'user',
        label: 'Past orchestrators',
        rows: sections.pastOrchestrators,
        rollup: null,
        hasLive: sections.pastOrchestrators.some((r) => r.status === 'working' || r.status === 'needs'),
        forceOpen: sections.active,
        ticket: null,
        title: '',
        stage: '',
      },
      style,
      pos,
      topLevel,
    );
  }

  const groups = toPanelGroups(sections.groups, style, pos, topLevel);
  pos += groups.length;
  const userFolders = toPanelGroups(sections.userFolders, style, pos, topLevel);
  pos += userFolders.length;

  let unsorted: PanelFleetGroup | null = null;
  if (sections.unsorted.length > 0) {
    pos += 1;
    unsorted = toPanelGroup(
      {
        id: UNSORTED_GROUP_ID,
        kind: 'unsorted',
        label: 'Unsorted',
        rows: sections.unsorted,
        rollup: null,
        hasLive: sections.unsorted.some((r) => r.status === 'working' || r.status === 'needs'),
        forceOpen: sections.active,
        ticket: null,
        title: '',
        stage: '',
      },
      style,
      pos,
      topLevel,
    );
  }

  const queue: PanelQueueRow[] = sections.queue.map((q, i) => ({
    position: i + 1,
    key: q.key,
    title: q.title,
    stage: q.stage,
    stageFamily: stageFamily(q.stage, style.doneStages),
    stageColor: stageColor(q.stage, style.tags),
    live: q.live,
  }));

  return {
    type: 'fleet',
    mode: sections.mode,
    active: sections.active,
    activeCount: sections.activeCount,
    queueCount: queue.length,
    archivedCount: sections.archivedCount,
    orchestrator,
    pastOrchestrators: past,
    groups,
    userFolders,
    unsorted,
    queue,
  };
}

// The webview posts the Active button's pressed state. Anything but a strict boolean is
// dropped.
export function coerceSetActive(raw: { type?: unknown; active?: unknown }): { type: 'setActive'; active: boolean } | null {
  if (raw.type !== 'setActive' || typeof raw.active !== 'boolean') {
    return null;
  }
  return { type: 'setActive', active: raw.active };
}
