import * as assert from 'assert';
import {
  MS_PER_DAY,
  DEFAULT_KEEP_WINDOW_DAYS,
  coerceKeepWindowDays,
  decideRetention,
} from '../../store/archiveRetention';

// Pure-logic unit tests for the Slice 4 archive keep-window retention policy. The
// policy decides keep|prune purely from {archivedAt, starred, keepWindowDays, now}
// with no clock or config access, so every case here is deterministic (the boundary
// case in particular: age exactly == window). No vscode, no filesystem.

const NOW = 1_700_000_000_000;

describe('archiveRetention.decideRetention', () => {
  it('STARRED is always kept, even far past the window (exemption outranks the window)', () => {
    // Archived 365 days ago with a 7-day window: a non-starred copy would prune,
    // but starred is exempt.
    assert.strictEqual(
      decideRetention({
        archivedAt: NOW - 365 * MS_PER_DAY,
        starred: true,
        keepWindowDays: 7,
        now: NOW,
      }),
      'keep',
    );
  });

  it('never-window (keepWindowDays <= 0) keeps everything, no matter how old', () => {
    assert.strictEqual(
      decideRetention({
        archivedAt: NOW - 9999 * MS_PER_DAY,
        starred: false,
        keepWindowDays: 0,
        now: NOW,
      }),
      'keep',
    );
    // A negative day count fails safe toward keeping.
    assert.strictEqual(
      decideRetention({
        archivedAt: NOW - 9999 * MS_PER_DAY,
        starred: false,
        keepWindowDays: -5,
        now: NOW,
      }),
      'keep',
    );
  });

  it('7d prunes ONLY a past-window unstarred copy', () => {
    // 8 days old, unstarred, 7-day window: past the window -> prune.
    assert.strictEqual(
      decideRetention({
        archivedAt: NOW - 8 * MS_PER_DAY,
        starred: false,
        keepWindowDays: 7,
        now: NOW,
      }),
      'prune',
    );
    // 3 days old, unstarred, 7-day window: within the window -> keep.
    assert.strictEqual(
      decideRetention({
        archivedAt: NOW - 3 * MS_PER_DAY,
        starred: false,
        keepWindowDays: 7,
        now: NOW,
      }),
      'keep',
    );
  });

  it('boundary: an age EXACTLY equal to the window is kept (window is inclusive)', () => {
    // now - archivedAt == keepWindowDays * MS_PER_DAY exactly. Deterministic with no
    // clock access. The edge is kept; only a STRICTLY greater age prunes.
    const archivedAt = NOW - 7 * MS_PER_DAY;
    assert.strictEqual(
      decideRetention({ archivedAt, starred: false, keepWindowDays: 7, now: NOW }),
      'keep',
      'age exactly == window must keep, not prune',
    );
    // One millisecond past the edge prunes.
    assert.strictEqual(
      decideRetention({ archivedAt: archivedAt - 1, starred: false, keepWindowDays: 7, now: NOW }),
      'prune',
      'one ms past the window prunes',
    );
  });

  it('a copy with no archivedAt cannot be proven past-window: keep', () => {
    assert.strictEqual(
      decideRetention({ archivedAt: null, starred: false, keepWindowDays: 7, now: NOW }),
      'keep',
    );
  });

  it('starred outranks even a null window and a null archivedAt', () => {
    assert.strictEqual(
      decideRetention({ archivedAt: null, starred: true, keepWindowDays: 7, now: NOW }),
      'keep',
    );
  });
});

describe('archiveRetention.coerceKeepWindowDays', () => {
  it('passes a valid positive day count through (floored)', () => {
    assert.strictEqual(coerceKeepWindowDays(7), 7);
    assert.strictEqual(coerceKeepWindowDays(30), 30);
    assert.strictEqual(coerceKeepWindowDays(90), 90);
    assert.strictEqual(coerceKeepWindowDays(7.9), 7);
  });

  it('maps 0 and negatives to the never-prune sentinel (0)', () => {
    assert.strictEqual(coerceKeepWindowDays(0), 0);
    assert.strictEqual(coerceKeepWindowDays(-1), 0);
  });

  it('falls back to the default for a non-number or non-finite value', () => {
    assert.strictEqual(coerceKeepWindowDays(undefined), DEFAULT_KEEP_WINDOW_DAYS);
    assert.strictEqual(coerceKeepWindowDays(null), DEFAULT_KEEP_WINDOW_DAYS);
    assert.strictEqual(coerceKeepWindowDays('30'), DEFAULT_KEEP_WINDOW_DAYS);
    assert.strictEqual(coerceKeepWindowDays(Number.NaN), DEFAULT_KEEP_WINDOW_DAYS);
    assert.strictEqual(coerceKeepWindowDays(Number.POSITIVE_INFINITY), DEFAULT_KEEP_WINDOW_DAYS);
  });
});
