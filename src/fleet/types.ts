// Fleet record types (version 1). vscode-free; the fleet files are read-only input.

export const FLEET_RECORD_VERSION = 1;

// A session id reaches a terminal or URI only after matching this grammar.
export const SESSION_ID_RE = /^[0-9a-fA-F-]{8,64}$/;

export const MAX_NAME_LEN = 200;
export const MAX_FOLDER_LEN = 200;
export const MAX_TAG_LEN = 40;
export const MAX_TAGS = 20;
export const MAX_PATH_LEN = 1024;
export const MAX_FIELD_LEN = 200;

export const FLEET_EVENTS = ['launch', 'rename', 'rotate', 'end', 'backfill', 'organize'] as const;
export type FleetEvent = (typeof FLEET_EVENTS)[number];

export const FLEET_ROLES = [
  'orchestrator',
  'build',
  'fix',
  'qa',
  'spike',
  'capture',
  'review',
  'intake',
  'draft',
] as const;
export type FleetRole = (typeof FLEET_ROLES)[number];

export type FleetOutcome = 'done' | 'failed';

// One validated, coerced line. Optional fields are absent when the line did not
// carry a usable value, so the fold can tell "not carried" from "carried".
export interface FleetRecord {
  readonly event: FleetEvent;
  readonly at: string | null;
  readonly sessionId: string;
  readonly agent?: string;
  readonly name?: string;
  readonly client?: string;
  readonly ticket?: string | null;
  readonly role?: FleetRole;
  readonly launchedBy?: string;
  readonly cwd?: string;
  readonly previous?: string;
  readonly next?: string;
  readonly folder?: string;
  readonly tags?: readonly string[];
  readonly stage?: string;
  readonly outcome?: FleetOutcome;
}

export interface FleetEntry {
  readonly sessionId: string;
  readonly name: string;
  readonly ticket: string | null;
  readonly role: FleetRole | null;
  readonly agent: string;
  readonly launchedBy: string;
  readonly cwd: string;
  readonly client: string;
  readonly folder: string | null;
  readonly tags: readonly string[];
  readonly stage: string | null;
  readonly ended: boolean;
  readonly outcome: FleetOutcome | null;
  readonly firstAt: string | null;
  readonly lastAt: string | null;
  // True when the entry was first created by a backfill record: never a new pickup.
  readonly isBackfill: boolean;
}

export interface FleetState {
  // Every session, newest first by firstAt then record order.
  readonly entries: readonly FleetEntry[];
  // The live orchestrator at the head of the rotate chain, or null.
  readonly currentOrchestrator: FleetEntry | null;
  // Every other orchestrator, newest first.
  readonly pastOrchestrators: readonly FleetEntry[];
}

export const EMPTY_FLEET_STATE: FleetState = {
  entries: [],
  currentOrchestrator: null,
  pastOrchestrators: [],
};
