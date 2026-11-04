// Pure per-chat status and the per-group rollup. No vscode, no filesystem, no process.
import type { AgentSession } from '../claude/agentsCli';
import { FleetEntry } from './types';

export type ChatStatus = 'working' | 'needs' | 'queued' | 'done' | 'idle';

// Most urgent first.
export const STATUS_ORDER: readonly ChatStatus[] = ['needs', 'working', 'queued', 'done', 'idle'];

const BACKGROUND_WORKING = new Set(['running', 'working', 'busy']);
const BACKGROUND_NEEDS = new Set(['blocked', 'waiting', 'needs-input', 'needs_input']);
const BACKGROUND_DONE = new Set(['done', 'stopped']);

export interface StatusInput {
  // The chat has a transcript on disk.
  readonly hasTranscript: boolean;
  // The last turn is an unread assistant question (from the question heuristic).
  readonly questionPending: boolean;
  readonly fleet: Pick<FleetEntry, 'ended' | 'outcome'> | null;
  readonly agent: Pick<AgentSession, 'kind' | 'state' | 'status'> | null;
}

function norm(value: string | null): string {
  return (value ?? '').trim().toLowerCase();
}

function agentWorking(agent: StatusInput['agent']): boolean {
  if (agent === null) {
    return false;
  }
  if (norm(agent.kind) === 'background') {
    return BACKGROUND_WORKING.has(norm(agent.state));
  }
  return norm(agent.kind) === 'interactive' && norm(agent.status) === 'busy';
}

function agentNeeds(agent: StatusInput['agent']): boolean {
  return agent !== null && norm(agent.kind) === 'background' && BACKGROUND_NEEDS.has(norm(agent.state));
}

function agentDone(agent: StatusInput['agent']): boolean {
  return agent !== null && norm(agent.kind) === 'background' && BACKGROUND_DONE.has(norm(agent.state));
}

export function mapStatus(input: StatusInput): ChatStatus {
  if (agentWorking(input.agent)) {
    return 'working';
  }
  if (agentNeeds(input.agent)) {
    return 'needs';
  }
  if (agentDone(input.agent) || input.fleet?.ended === true) {
    return 'done';
  }
  if (input.questionPending) {
    return 'needs';
  }
  if (input.fleet !== null && input.agent === null && !input.hasTranscript) {
    return 'queued';
  }
  return 'idle';
}

// The most urgent status of a group, or null for an empty group.
export function rollupStatus(statuses: Iterable<ChatStatus>): ChatStatus | null {
  let best = -1;
  for (const status of statuses) {
    const rank = STATUS_ORDER.indexOf(status);
    if (best === -1 || rank < best) {
      best = rank;
    }
  }
  return best === -1 ? null : STATUS_ORDER[best];
}

export interface StatusChat {
  readonly sessionId: string;
  readonly questionPending: boolean;
}

// One status per chat in the panel, plus one per fleet entry that has no transcript yet
// (those are the queued ones). A live session whose id matches neither is ignored.
export function computeStatuses(
  chats: readonly StatusChat[],
  fleetEntries: readonly FleetEntry[],
  sessions: readonly AgentSession[],
): Map<string, ChatStatus> {
  const fleetById = new Map(fleetEntries.map((entry) => [entry.sessionId, entry]));
  const agentById = new Map(sessions.map((session) => [session.sessionId, session]));
  const statuses = new Map<string, ChatStatus>();
  for (const chat of chats) {
    statuses.set(
      chat.sessionId,
      mapStatus({
        hasTranscript: true,
        questionPending: chat.questionPending,
        fleet: fleetById.get(chat.sessionId) ?? null,
        agent: agentById.get(chat.sessionId) ?? null,
      }),
    );
  }
  for (const entry of fleetEntries) {
    if (!statuses.has(entry.sessionId)) {
      statuses.set(
        entry.sessionId,
        mapStatus({
          hasTranscript: false,
          questionPending: false,
          fleet: entry,
          agent: agentById.get(entry.sessionId) ?? null,
        }),
      );
    }
  }
  return statuses;
}
