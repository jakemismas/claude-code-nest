import * as assert from 'assert';
import {
  MS_PER_DAY,
  AUTO_ARCHIVE_WINDOW_DAYS,
  decideAutoArchive,
  coerceAutoArchiveWindowDays,
} from '../../store/autoArchivePolicy';

// Pure-logic unit tests for the slice s3b-settings-overlay auto-archive policy. The
// policy decides archive|copy|none purely from {lastActivity, starred, archived,
// hasCopy, keepWindowDays, now} with no clock/config/fs access, so every case is
// deterministic (the boundary case in particular: age exactly == window). No vscode.

const NOW = 1_700_000_000_000;

function input(overrides: Partial<Parameters<typeof decideAutoArchive>[0]> = {}) {
  return {
    lastActivity: NOW - 100 * MS_PER_DAY,
    starred: false,
    archived: false,
    hasCopy: false,
    archiveWindowDays: 30,
    protectiveWindowDays: 30,
    now: NOW,
    ...overrides,
  };
}

describe('autoArchivePolicy.decideAutoArchive', () => {
  it('archives an unstarred chat whose age strictly exceeds the archive window', () => {
    assert.strictEqual(
      decideAutoArchive(input({ lastActivity: NOW - 31 * MS_PER_DAY, archiveWindowDays: 30 })),
      'archive',
    );
  });

  it('keeps (none) at the inclusive boundary: age exactly == archive window', () => {
    assert.strictEqual(
      decideAutoArchive(input({ lastActivity: NOW - 30 * MS_PER_DAY, archiveWindowDays: 30 })),
      'none',
    );
  });

  it('keeps (none) an unstarred chat within the archive window', () => {
    assert.strictEqual(
      decideAutoArchive(input({ lastActivity: NOW - 5 * MS_PER_DAY, archiveWindowDays: 30 })),
      'none',
    );
  });

  it('never auto-archives a starred chat: past-protective-window starred with no copy yields copy', () => {
    assert.strictEqual(
      decideAutoArchive(
        input({ starred: true, hasCopy: false, lastActivity: NOW - 90 * MS_PER_DAY, protectiveWindowDays: 30 }),
      ),
      'copy',
    );
  });

  it('starred past-protective-window with an existing copy is idempotent (none)', () => {
    assert.strictEqual(
      decideAutoArchive(
        input({ starred: true, hasCopy: true, lastActivity: NOW - 90 * MS_PER_DAY, protectiveWindowDays: 30 }),
      ),
      'none',
    );
  });

  it('starred WITHIN the protective window gets nothing (no protective copy until past)', () => {
    assert.strictEqual(
      decideAutoArchive(
        input({ starred: true, hasCopy: false, lastActivity: NOW - 5 * MS_PER_DAY, protectiveWindowDays: 30 }),
      ),
      'none',
    );
  });

  it('AC #5: a starred chat STILL gets a protective copy when auto-archive is Never (archiveWindowDays=0)', () => {
    // The user disabled auto-archiving, but the starred chat is past the effective
    // Claude cleanup age (protectiveWindowDays). The protective copy must still be
    // written so the chat survives Claude cleanup, independent of the archive window.
    assert.strictEqual(
      decideAutoArchive(
        input({
          starred: true,
          hasCopy: false,
          lastActivity: NOW - 90 * MS_PER_DAY,
          archiveWindowDays: 0,
          protectiveWindowDays: 30,
        }),
      ),
      'copy',
    );
  });

  it('Never sentinel (archiveWindowDays <= 0) never auto-archives an unstarred chat', () => {
    assert.strictEqual(
      decideAutoArchive(input({ lastActivity: NOW - 10000 * MS_PER_DAY, archiveWindowDays: 0 })),
      'none',
    );
    assert.strictEqual(
      decideAutoArchive(input({ lastActivity: NOW - 10000 * MS_PER_DAY, archiveWindowDays: -5 })),
      'none',
    );
  });

  it('a starred chat with a non-positive protective window gets no copy (protective disabled)', () => {
    assert.strictEqual(
      decideAutoArchive(
        input({ starred: true, hasCopy: false, lastActivity: NOW - 999 * MS_PER_DAY, protectiveWindowDays: 0 }),
      ),
      'none',
    );
  });

  it('an already-archived chat is left alone (none), never re-archived', () => {
    assert.strictEqual(
      decideAutoArchive(input({ archived: true, lastActivity: NOW - 999 * MS_PER_DAY })),
      'none',
    );
  });

  it('a null lastActivity cannot be proven past either window: none', () => {
    assert.strictEqual(
      decideAutoArchive(input({ lastActivity: null, archiveWindowDays: 30 })),
      'none',
    );
    assert.strictEqual(
      decideAutoArchive(input({ lastActivity: null, starred: true, protectiveWindowDays: 30 })),
      'none',
    );
  });
});

describe('autoArchivePolicy.coerceAutoArchiveWindowDays', () => {
  it('accepts every allowed enum value (including the 0 Never sentinel)', () => {
    for (const days of AUTO_ARCHIVE_WINDOW_DAYS) {
      assert.strictEqual(coerceAutoArchiveWindowDays(days, 30), days);
    }
  });

  it('accepts a numeric string of an allowed value', () => {
    assert.strictEqual(coerceAutoArchiveWindowDays('14', 30), 14);
    assert.strictEqual(coerceAutoArchiveWindowDays('0', 30), 0);
  });

  it('falls back to the effective default for an out-of-range or non-numeric value', () => {
    assert.strictEqual(coerceAutoArchiveWindowDays(13, 30), 30);
    assert.strictEqual(coerceAutoArchiveWindowDays('abc', 45), 45);
    assert.strictEqual(coerceAutoArchiveWindowDays(undefined, 90), 90);
    assert.strictEqual(coerceAutoArchiveWindowDays(null, 7), 7);
  });

  it('a non-positive effective default fails safe to the Never sentinel (0)', () => {
    assert.strictEqual(coerceAutoArchiveWindowDays('nope', 0), 0);
    assert.strictEqual(coerceAutoArchiveWindowDays(undefined, -1), 0);
  });
});
