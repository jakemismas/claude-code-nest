// Orphan reconcile: decide, from a fresh on-disk scan, how the LOCAL-ONLY orphan
// state for each chat should transition. Pure logic, no vscode and no
// filesystem; the caller supplies the observed sessionIds and the prior local
// state, and applies the returned plan via the store.
//
// Binding rules honored (ARCHITECTURE.md "Data integrity, read-only, and
// settings rules"):
// - NEVER hard-deletes on a scan. Permanent removal is user-gated, reversible
//   (a tombstone), and only after a grace window.
// - NEVER mass-archives on a transient zero-result or a suspect low scan: if a
//   scan returns zero (or far fewer than the last known count) for a project that
//   had records, the scan is treated as SUSPECT and the whole pass is skipped.
// - Orphan state is LOCAL ONLY; this module operates on LocalProjectMeta and
//   produces a LocalProjectMeta, and never touches the synced ProjectMeta.
//
// Transition model per chat:
//   present on disk         -> clear missingSince, keep archived/tombstone as is
//                              (re-appearance un-marks missingSince but does not
//                              auto-unarchive; un-archive is a user action).
//   absent, never marked    -> set missingSince = now (start the grace clock).
//   absent, within grace    -> keep missingSince, not yet archived.
//   absent, past grace      -> archived = true (soft archive; still recoverable).
//   tombstoned              -> left untouched by a scan; only a user clears it.

import { LocalChatState, LocalProjectMeta } from './schema';

// Tuning for the circuit breaker and the grace window.
export interface ReconcileConfig {
  // The grace window in ms between first-missing and soft-archive. Defaults to
  // 14 days. A chat absent longer than this becomes archived.
  graceMs: number;
  // The fraction of the last-known count below which a non-empty scan is deemed
  // suspect (a partial/failed scan), in [0,1]. Defaults to 0.5: a scan that
  // observes under half the previously known chats is skipped. A zero-result for
  // a project that had records is ALWAYS suspect regardless of this fraction.
  lowCountFraction: number;
}

export const DEFAULT_RECONCILE_CONFIG: ReconcileConfig = {
  graceMs: 14 * 24 * 60 * 60 * 1000,
  lowCountFraction: 0.5,
};

// Why a reconcile pass did or did not run, surfaced for diagnostics and tests.
export type ReconcileOutcome =
  | { kind: 'applied'; plan: LocalProjectMeta; transitions: Transition[] }
  | { kind: 'skipped-suspect-scan'; reason: 'zero-result' | 'low-count'; observed: number; lastKnown: number };

// A single chat's transition, for surfacing/logging. Not persisted.
export interface Transition {
  chatId: string;
  from: ChatPhase;
  to: ChatPhase;
}

export type ChatPhase = 'present' | 'missing-grace' | 'archived' | 'tombstoned';

// Inputs to one reconcile pass.
export interface ReconcileInput {
  // The sessionIds observed by the just-completed on-disk scan.
  observedChatIds: string[];
  // The prior LOCAL orphan state for the project.
  local: LocalProjectMeta;
  // The full set of chatIds the SYNCED store knows about for this project (folder
  // assignments, tags, links). These are the records that can go orphan. A chat
  // with no synced metadata is not tracked for orphaning (nothing to lose), but
  // an existing local entry is still evaluated.
  knownChatIds: string[];
  // The count from the last successful (non-suspect) scan, used as the low-count
  // baseline. When this project has never had a successful scan, pass 0; a
  // zero/low first scan is then NOT suspect (there is no prior count to fall
  // below).
  lastKnownCount: number;
  // Injected clock for deterministic stamps.
  now: number;
  config?: ReconcileConfig;
}

// Decide and produce the reconcile plan. Returns either an applied plan (the new
// LocalProjectMeta plus the per-chat transitions) or a skip outcome when the scan
// is suspect. The caller persists plan via MetadataStore.putLocalProjectMeta only
// on an 'applied' outcome.
export function reconcileOrphans(input: ReconcileInput): ReconcileOutcome {
  const config = input.config ?? DEFAULT_RECONCILE_CONFIG;
  const observed = new Set(input.observedChatIds);
  const observedCount = observed.size;

  // Circuit breaker. A project that previously had records but now scans zero is
  // the classic transient failure (a temp permission error, a moved drive, an
  // unmounted volume); never mass-archive on it. A non-empty but suspiciously low
  // scan (under the configured fraction of the last-known count) is likewise
  // treated as a partial/failed scan and skipped.
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

  // The scan is trusted. Evaluate every tracked chat: the union of the synced
  // known ids and any chat that already carries local orphan state.
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
    // Only persist a local entry when it carries state worth keeping (a missing
    // marker, an archive, or a tombstone). A clean present chat with no prior
    // state is not stored, so the local document stays sparse.
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
  // A tombstone is terminal under a scan; only a user clears it.
  if (prior.tombstone) {
    return { ...prior };
  }

  if (present) {
    // Re-appearance clears the missing marker. Archived stays archived (a
    // user un-archives), so a re-appeared-but-archived chat keeps archived=true
    // with missingSince cleared.
    return { missingSince: null, archived: prior.archived, tombstone: false };
  }

  // Absent.
  if (prior.archived) {
    return { ...prior };
  }
  if (prior.missingSince === null) {
    // First time observed missing: start the grace clock, do not archive yet.
    return { missingSince: now, archived: false, tombstone: false };
  }
  // Already missing: archive once past the grace window.
  if (now - prior.missingSince >= config.graceMs) {
    return { missingSince: prior.missingSince, archived: true, tombstone: false };
  }
  // Still within grace.
  return { ...prior };
}

// Map a local state to a coarse phase for transition reporting.
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

// Produce the user-gated, reversible tombstone for one chat (permanent-removal
// intent). Reversible: clearTombstone restores the chat. This is the ONLY path to
// a removal, and it is never reached by a scan; a command invokes it after the
// grace window and explicit user confirmation.
export function tombstone(state: LocalChatState): LocalChatState {
  return { missingSince: state.missingSince, archived: true, tombstone: true };
}

// Reverse a tombstone or an archive: restore the chat to active/present-eligible
// state. The next scan re-evaluates from a clean slate.
export function restore(): LocalChatState {
  return freshState();
}
