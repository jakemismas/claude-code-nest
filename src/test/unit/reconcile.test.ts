import * as assert from 'assert';
import {
  DEFAULT_RECONCILE_CONFIG,
  ReconcileConfig,
  phaseOf,
  reconcileOrphans,
  restore,
  tombstone,
} from '../../store/reconcile';
import { LocalChatState, LocalProjectMeta, emptyLocalProjectMeta } from '../../store/schema';

// Pure-logic unit tests for orphan reconcile: the zero-result / low-count circuit
// breaker, the grace-window soft archive, the never-hard-delete invariant, and
// the tombstone/restore lifecycle. No vscode import, no filesystem.

const GRACE = DEFAULT_RECONCILE_CONFIG.graceMs;
const CONFIG: ReconcileConfig = { graceMs: GRACE, lowCountFraction: 0.5 };

function localWith(chats: { [id: string]: LocalChatState }): LocalProjectMeta {
  return { schemaVersion: 1, chats };
}

describe('reconcile circuit breaker (never mass-archive on a suspect scan)', () => {
  it('SKIPS on a zero-result scan when the project previously had records', () => {
    const outcome = reconcileOrphans({
      observedChatIds: [],
      local: emptyLocalProjectMeta(),
      knownChatIds: ['a', 'b', 'c'],
      lastKnownCount: 3,
      now: 0,
      config: CONFIG,
    });
    assert.strictEqual(outcome.kind, 'skipped-suspect-scan');
    if (outcome.kind === 'skipped-suspect-scan') {
      assert.strictEqual(outcome.reason, 'zero-result');
      assert.strictEqual(outcome.observed, 0);
      assert.strictEqual(outcome.lastKnown, 3);
    }
  });

  it('SKIPS on a suspiciously low-count scan (under the fraction of last known)', () => {
    const outcome = reconcileOrphans({
      observedChatIds: ['a'], // 1 of a previously-known 10 is well under 0.5
      local: emptyLocalProjectMeta(),
      knownChatIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
      lastKnownCount: 10,
      now: 0,
      config: CONFIG,
    });
    assert.strictEqual(outcome.kind, 'skipped-suspect-scan');
    if (outcome.kind === 'skipped-suspect-scan') {
      assert.strictEqual(outcome.reason, 'low-count');
    }
  });

  it('does NOT skip when the observed count is at or above the fraction threshold', () => {
    const outcome = reconcileOrphans({
      observedChatIds: ['a', 'b', 'c', 'd', 'e'], // 5 of 10 == 0.5, not below
      local: emptyLocalProjectMeta(),
      knownChatIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
      lastKnownCount: 10,
      now: 0,
      config: CONFIG,
    });
    assert.strictEqual(outcome.kind, 'applied');
  });

  it('does NOT skip a zero-result for a project that never had records (lastKnownCount 0)', () => {
    const outcome = reconcileOrphans({
      observedChatIds: [],
      local: emptyLocalProjectMeta(),
      knownChatIds: [],
      lastKnownCount: 0,
      now: 0,
      config: CONFIG,
    });
    assert.strictEqual(outcome.kind, 'applied');
  });
});

describe('reconcile transitions (grace window, soft archive, never hard-delete)', () => {
  it('marks a newly-absent chat missingSince (starts the grace clock), not archived', () => {
    const outcome = reconcileOrphans({
      observedChatIds: ['a'], // b is absent
      local: emptyLocalProjectMeta(),
      knownChatIds: ['a', 'b'],
      lastKnownCount: 2,
      now: 5000,
      config: CONFIG,
    });
    assert.strictEqual(outcome.kind, 'applied');
    if (outcome.kind !== 'applied') {
      return;
    }
    // The chat record still EXISTS in the plan (never hard-deleted), soft-marked.
    assert.strictEqual(outcome.plan.chats.b.missingSince, 5000);
    assert.strictEqual(outcome.plan.chats.b.archived, false);
    assert.strictEqual(outcome.plan.chats.b.tombstone, false);
    // Transition surfaced.
    assert.deepStrictEqual(outcome.transitions, [
      { chatId: 'b', from: 'present', to: 'missing-grace' },
    ]);
  });

  it('keeps a chat in grace while within the window, then soft-archives past it', () => {
    const within = reconcileOrphans({
      observedChatIds: ['a'],
      local: localWith({ b: { missingSince: 1000, archived: false, tombstone: false } }),
      knownChatIds: ['a', 'b'],
      lastKnownCount: 2,
      now: 1000 + GRACE - 1,
      config: CONFIG,
    });
    assert.strictEqual(within.kind, 'applied');
    if (within.kind === 'applied') {
      assert.strictEqual(within.plan.chats.b.archived, false);
      assert.strictEqual(within.plan.chats.b.missingSince, 1000);
    }

    const past = reconcileOrphans({
      observedChatIds: ['a'],
      local: localWith({ b: { missingSince: 1000, archived: false, tombstone: false } }),
      knownChatIds: ['a', 'b'],
      lastKnownCount: 2,
      now: 1000 + GRACE,
      config: CONFIG,
    });
    assert.strictEqual(past.kind, 'applied');
    if (past.kind === 'applied') {
      // Soft-archived, NEVER removed.
      assert.strictEqual(past.plan.chats.b.archived, true);
      assert.strictEqual(past.plan.chats.b.tombstone, false);
      assert.deepStrictEqual(past.transitions, [
        { chatId: 'b', from: 'missing-grace', to: 'archived' },
      ]);
    }
  });

  it('clears missingSince when an absent chat reappears (does NOT auto-unarchive)', () => {
    const outcome = reconcileOrphans({
      observedChatIds: ['a', 'b'],
      local: localWith({
        b: { missingSince: 1000, archived: true, tombstone: false },
      }),
      knownChatIds: ['a', 'b'],
      lastKnownCount: 2,
      now: 9999,
      config: CONFIG,
    });
    assert.strictEqual(outcome.kind, 'applied');
    if (outcome.kind === 'applied') {
      // missingSince cleared on reappearance; archived stays until a user acts.
      assert.strictEqual(outcome.plan.chats.b.missingSince, null);
      assert.strictEqual(outcome.plan.chats.b.archived, true);
    }
  });

  it('drops a clean re-present chat from the sparse local document', () => {
    const outcome = reconcileOrphans({
      observedChatIds: ['a', 'b'],
      local: localWith({ b: { missingSince: 2000, archived: false, tombstone: false } }),
      knownChatIds: ['a', 'b'],
      lastKnownCount: 2,
      now: 3000,
      config: CONFIG,
    });
    assert.strictEqual(outcome.kind, 'applied');
    if (outcome.kind === 'applied') {
      // b is clean-present again, so it is NOT stored (sparse local doc).
      assert.ok(!('b' in outcome.plan.chats));
      assert.ok(!('a' in outcome.plan.chats));
    }
  });

  it('leaves a tombstoned chat untouched on a scan (only a user clears it)', () => {
    const tomb: LocalChatState = { missingSince: 1, archived: true, tombstone: true };
    const absent = reconcileOrphans({
      observedChatIds: [],
      local: localWith({ b: tomb }),
      knownChatIds: [],
      lastKnownCount: 0, // not suspect: no prior known count
      now: 5_000_000_000,
      config: CONFIG,
    });
    assert.strictEqual(absent.kind, 'applied');
    if (absent.kind === 'applied') {
      assert.deepStrictEqual(absent.plan.chats.b, tomb);
    }

    const present = reconcileOrphans({
      observedChatIds: ['b'],
      local: localWith({ b: tomb }),
      knownChatIds: ['b'],
      lastKnownCount: 1,
      now: 5_000_000_000,
      config: CONFIG,
    });
    assert.strictEqual(present.kind, 'applied');
    if (present.kind === 'applied') {
      assert.deepStrictEqual(present.plan.chats.b, tomb);
    }
  });
});

describe('reconcile tombstone / restore lifecycle (user-gated, reversible)', () => {
  it('tombstone marks archived + tombstone, preserving missingSince', () => {
    const t = tombstone({ missingSince: 42, archived: true, tombstone: false });
    assert.deepStrictEqual(t, { missingSince: 42, archived: true, tombstone: true });
  });

  it('restore returns a clean state (reversible removal)', () => {
    assert.deepStrictEqual(restore(), {
      missingSince: null,
      archived: false,
      tombstone: false,
    });
  });
});

describe('reconcile phaseOf', () => {
  it('maps each state to its phase, tombstone winning over archived', () => {
    assert.strictEqual(phaseOf({ missingSince: null, archived: false, tombstone: false }), 'present');
    assert.strictEqual(phaseOf({ missingSince: 1, archived: false, tombstone: false }), 'missing-grace');
    assert.strictEqual(phaseOf({ missingSince: 1, archived: true, tombstone: false }), 'archived');
    assert.strictEqual(phaseOf({ missingSince: 1, archived: true, tombstone: true }), 'tombstoned');
  });
});
