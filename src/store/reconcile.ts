// Orphan reconcile: turns an on-disk scan into the next local-only orphan state per chat.
// A scan never hard-deletes, and a suspect scan (zero or far fewer chats) is skipped.
// Present clears missingSince; absent starts a grace clock, then archives; only users change tombstones.

import { LocalChatState, LocalProjectMeta } from './schema';

export interface ReconcileConfig {
  // Time between first seen missing and soft-archive.
  graceMs: number;
  // A non-empty scan below this fraction of the last known count is suspect. A zero
  // result is suspect regardless when the project had records.
  lowCountFraction: number;
}

export const DEFAULT_RECONCILE_CONFIG: ReconcileConfig = {
  graceMs: 14 * 24 * 60 * 60 * 1000,
  lowCountFraction: 0.5,
};

export type ReconcileOutcome =
  | { kind: 'applied'; plan: LocalProjectMeta; transitions: Transition[] }
  | { kind: 'skipped-suspect-scan'; reason: 'zero-result' | 'low-count'; observed: number; lastKnown: number };

// One chat's phase change; reported, not persisted.
export interface Transition {
  chatId: string;
  from: ChatPhase;
  to: ChatPhase;
}

export type ChatPhase = 'present' | 'missing-grace' | 'archived' | 'tombstoned';

export interface ReconcileInput {
  observedChatIds: string[];
  local: LocalProjectMeta;
  // Chats with synced metadata (folders, tags, links); only these can orphan. Chats
  // that already have local state are evaluated too.
  knownChatIds: string[];
  // Count from the last trusted scan. Pass 0 when none exists, so a first scan is never suspect.
  lastKnownCount: number;
  now: number;
  config?: ReconcileConfig;
}

// Persist the plan only on an 'applied' outcome.
export function reconcileOrphans(input: ReconcileInput): ReconcileOutcome {
  const config = input.config ?? DEFAULT_RECONCILE_CONFIG;
  const observed = new Set(input.observedChatIds);
  const observedCount = observed.size;

  // Zero or very low results usually mean a transient failure (permissions, unmounted
  // drive), so skip instead of mass-archiving.
  if (input.lastKnownCount > 0) {
    if (observedCount === 0) {
      return {
        kind: 'skipped-suspect-scan',
        reason: 'zero-result',
        observed: observedCount,
        lastKnown: input.lastKnownCount,
      };
    }
    if (observedCount < input.lastKnownCount * config.lowCountFraction) {
      return {
        kind: 'skipped-suspect-scan',
        reason: 'low-count',
        observed: observedCount,
        lastKnown: input.lastKnownCount,
      };
    }
  }

  const tracked = new Set<string>(input.knownChatIds);
  for (const chatId of Object.keys(input.local.chats)) {
    tracked.add(chatId);
  }

  const nextChats: { [chatId: string]: LocalChatState } = {};
  const transitions: Transition[] = [];

  for (const chatId of tracked) {
    const prior = input.local.chats[chatId] ?? freshState();
    const fromPhase = phaseOf(prior);
    const next = transitionFor(prior, observed.has(chatId), input.now, config);
    const toPhase = phaseOf(next);
    // Keeps the local document sparse.
    if (!isCleanPresent(next)) {
      nextChats[chatId] = next;
    }
    if (fromPhase !== toPhase) {
      transitions.push({ chatId, from: fromPhase, to: toPhase });
    }
  }

  return {
    kind: 'applied',
    plan: { schemaVersion: input.local.schemaVersion, chats: nextChats },
    transitions,
  };
}

function transitionFor(
  prior: LocalChatState,
  present: boolean,
  now: number,
  config: ReconcileConfig,
): LocalChatState {
  if (prior.tombstone) {
    return { ...prior };
  }

  if (present) {
    // Archived stays archived on re-appearance; only the user un-archives.
    return { missingSince: null, archived: prior.archived, tombstone: false };
  }

  if (prior.archived) {
    return { ...prior };
  }
  if (prior.missingSince === null) {
    return { missingSince: now, archived: false, tombstone: false };
  }
  if (now - prior.missingSince >= config.graceMs) {
    return { missingSince: prior.missingSince, archived: true, tombstone: false };
  }
  return { ...prior };
}

export function phaseOf(state: LocalChatState): ChatPhase {
  if (state.tombstone) {
    return 'tombstoned';
  }
  if (state.archived) {
    return 'archived';
  }
  if (state.missingSince !== null) {
    return 'missing-grace';
  }
  return 'present';
}

function isCleanPresent(state: LocalChatState): boolean {
  return state.missingSince === null && !state.archived && !state.tombstone;
}

function freshState(): LocalChatState {
  return { missingSince: null, archived: false, tombstone: false };
}

// The only path to removal: reversible, and invoked by a command after user confirmation, never by a scan.
export function tombstone(state: LocalChatState): LocalChatState {
  return { missingSince: state.missingSince, archived: true, tombstone: true };
}

// Reset a chat to clean state; the next scan re-evaluates it.
export function restore(): LocalChatState {
  return freshState();
}
