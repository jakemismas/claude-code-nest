import * as assert from 'assert';
import { TokenTotals } from '../../model/types';
import { ProjectMeta } from '../../store/schema';
import {
  RollupBucket,
  RollupInput,
  RollupResult,
  rollupByFolder,
  rollupByTag,
} from '../../rollup/tokenRollup';
import { renderRollupReport } from '../../rollup/rollupReport';

// Pure-logic unit tests for the Slice 5 token-cost rollup. No vscode, no filesystem:
// the reducer takes a plain {chatId -> TokenTotals} map plus a ProjectMeta and
// returns bucket rows. The pinned counting rule (slice patch "ROLLUP DOUBLE-COUNT
// RULE") is asserted here: a chat counts ONCE per its single folder and ONCE per EACH
// of its tags; unfiled/untagged buckets carry the leftovers; and a multi-tag chat's
// tokens add to every tag bucket so the by-tag totals can EXCEED the library total
// (intentional, not a bug).

const DEVICE = 'dev-rollup';
const NOW = 1_700_000_000_000;

// Sum the four counts to a known per-chat total for terse fixtures.
function tk(total: number): TokenTotals {
  return { input: total, output: 0, cacheCreation: 0, cacheRead: 0 };
}

function meta(partial: Partial<ProjectMeta> = {}): ProjectMeta {
  return {
    schemaVersion: 1,
    folders: {},
    tags: {},
    chats: {},
    updatedAt: NOW,
    deviceId: DEVICE,
    ...partial,
  };
}

function chat(
  folderId: string | null,
  tags: string[],
): { folderId: string | null; tags: string[]; links: []; updatedAt: number; deviceId: string } {
  return { folderId, tags, links: [], updatedAt: NOW, deviceId: DEVICE };
}

function bucket(result: RollupResult, label: string): RollupBucket | undefined {
  return result.buckets.find((b) => b.label === label);
}

describe('tokenRollup.rollupByFolder', () => {
  it('sums each chat ONCE in its single home folder; folders partition the library', () => {
    const m = meta({
      folders: {
        f1: { id: 'f1', name: 'Alpha', parentId: null, order: 0 },
        f2: { id: 'f2', name: 'Beta', parentId: null, order: 1 },
      },
      chats: {
        c1: chat('f1', []),
        c2: chat('f1', []),
        c3: chat('f2', []),
      },
    });
    const input: RollupInput = {
      chatIds: ['c1', 'c2', 'c3'],
      tokensByChat: new Map([
        ['c1', tk(100)],
        ['c2', tk(200)],
        ['c3', tk(50)],
      ]),
      meta: m,
    };
    const result = rollupByFolder(input);
    assert.strictEqual(bucket(result, 'Alpha')?.tokenTotal, 300, 'Alpha = c1+c2');
    assert.strictEqual(bucket(result, 'Alpha')?.chatCount, 2);
    assert.strictEqual(bucket(result, 'Beta')?.tokenTotal, 50);
    assert.strictEqual(result.libraryTokenTotal, 350);
    // Folders partition: the bucket totals sum to the library total.
    const folderSum = result.buckets.reduce((s, b) => s + b.tokenTotal, 0);
    assert.strictEqual(folderSum, result.libraryTokenTotal, 'folder buckets partition the library');
  });

  it('routes a chat with no folder (and a chat with a stale folderId) to the Unfiled bucket', () => {
    const m = meta({
      folders: { f1: { id: 'f1', name: 'Alpha', parentId: null, order: 0 } },
      chats: {
        c1: chat('f1', []),
        c2: chat(null, []), // no folder
        c3: chat('GONE', []), // folderId no longer resolves
      },
    });
    const result = rollupByFolder({
      chatIds: ['c1', 'c2', 'c3'],
      tokensByChat: new Map([['c1', tk(10)], ['c2', tk(20)], ['c3', tk(30)]]),
      meta: m,
    });
    const unfiled = bucket(result, 'Unfiled');
    assert.ok(unfiled !== undefined, 'Unfiled bucket exists');
    assert.strictEqual(unfiled.synthetic, true);
    assert.strictEqual(unfiled.tokenTotal, 50, 'c2 (no folder) + c3 (stale id)');
    assert.strictEqual(unfiled.chatCount, 2);
    // Still a partition.
    const sum = result.buckets.reduce((s, b) => s + b.tokenTotal, 0);
    assert.strictEqual(sum, result.libraryTokenTotal);
  });

  it('counts a member chat absent from the token map as 0 tokens but still a member', () => {
    const m = meta({
      folders: { f1: { id: 'f1', name: 'Alpha', parentId: null, order: 0 } },
      chats: { c1: chat('f1', []), c2: chat('f1', []) },
    });
    const result = rollupByFolder({
      chatIds: ['c1', 'c2'],
      tokensByChat: new Map([['c1', tk(40)]]), // c2 missing
      meta: m,
    });
    assert.strictEqual(bucket(result, 'Alpha')?.tokenTotal, 40);
    assert.strictEqual(bucket(result, 'Alpha')?.chatCount, 2, 'c2 still counted as a member');
  });
});

describe('tokenRollup.rollupByTag', () => {
  it('counts a chat ONCE per EACH of its tags; a multi-tag chat adds to every tag bucket', () => {
    const m = meta({
      tags: {
        t1: { id: 't1', label: 'bug' },
        t2: { id: 't2', label: 'urgent' },
      },
      chats: {
        c1: chat(null, ['t1', 't2']), // multi-tag
        c2: chat(null, ['t1']),
      },
    });
    const result = rollupByTag({
      chatIds: ['c1', 'c2'],
      tokensByChat: new Map([['c1', tk(100)], ['c2', tk(30)]]),
      meta: m,
    });
    // c1 (100) adds to BOTH bug and urgent; c2 (30) adds only to bug.
    assert.strictEqual(bucket(result, 'bug')?.tokenTotal, 130, 'bug = c1+c2');
    assert.strictEqual(bucket(result, 'urgent')?.tokenTotal, 100, 'urgent = c1');
    assert.strictEqual(result.libraryTokenTotal, 130, 'library counts each chat once: 100+30');
    // The by-tag totals INTENTIONALLY exceed the library total (multi-tag chat).
    const tagSum = result.buckets.reduce((s, b) => s + b.tokenTotal, 0);
    assert.ok(
      tagSum > result.libraryTokenTotal,
      'by-tag buckets (' + tagSum + ') exceed the library total (' +
        result.libraryTokenTotal + ') because of the multi-tag chat (by design)',
    );
    assert.strictEqual(tagSum, 230, 'bug 130 + urgent 100');
  });

  it('routes an untagged chat to the Untagged bucket; the untagged bucket never double-counts', () => {
    const m = meta({
      tags: { t1: { id: 't1', label: 'bug' } },
      chats: {
        c1: chat(null, ['t1']),
        c2: chat(null, []), // untagged
        c3: chat(null, []), // untagged
      },
    });
    const result = rollupByTag({
      chatIds: ['c1', 'c2', 'c3'],
      tokensByChat: new Map([['c1', tk(10)], ['c2', tk(20)], ['c3', tk(5)]]),
      meta: m,
    });
    const untagged = bucket(result, 'Untagged');
    assert.ok(untagged !== undefined);
    assert.strictEqual(untagged.synthetic, true);
    assert.strictEqual(untagged.tokenTotal, 25, 'c2+c3');
    assert.strictEqual(untagged.chatCount, 2);
    assert.strictEqual(bucket(result, 'bug')?.tokenTotal, 10);
  });

  it('a duplicate tag id on one chat is counted once in that bucket', () => {
    const m = meta({
      tags: { t1: { id: 't1', label: 'bug' } },
      chats: { c1: chat(null, ['t1', 't1']) }, // malformed double tag
    });
    const result = rollupByTag({
      chatIds: ['c1'],
      tokensByChat: new Map([['c1', tk(100)]]),
      meta: m,
    });
    assert.strictEqual(bucket(result, 'bug')?.tokenTotal, 100, 'not double-counted within one bucket');
    assert.strictEqual(bucket(result, 'bug')?.chatCount, 1);
  });

  it('a chat whose only tag id no longer resolves contributes to no tag bucket', () => {
    const m = meta({
      tags: { t1: { id: 't1', label: 'bug' } },
      chats: { c1: chat(null, ['GONE']) },
    });
    const result = rollupByTag({
      chatIds: ['c1'],
      tokensByChat: new Map([['c1', tk(100)]]),
      meta: m,
    });
    assert.strictEqual(result.libraryTokenTotal, 100, 'still counted in the library total');
    assert.strictEqual(result.buckets.length, 0, 'but in no tag bucket (the id did not resolve)');
  });
});

describe('rollupReport.renderRollupReport', () => {
  it('renders both sections and the multi-tag exceed-library note', () => {
    const m = meta({
      folders: { f1: { id: 'f1', name: 'Alpha', parentId: null, order: 0 } },
      tags: { t1: { id: 't1', label: 'bug' }, t2: { id: 't2', label: 'urgent' } },
      chats: { c1: chat('f1', ['t1', 't2']) },
    });
    const input: RollupInput = {
      chatIds: ['c1'],
      tokensByChat: new Map([['c1', tk(1234)]]),
      meta: m,
    };
    const report = renderRollupReport(rollupByFolder(input), rollupByTag(input));
    assert.ok(report.includes('By folder'), 'by-folder section');
    assert.ok(report.includes('By tag'), 'by-tag section');
    assert.ok(report.includes('1,234 tokens'), 'thousands-formatted total');
    assert.ok(report.includes('Alpha'), 'folder bucket label');
    assert.ok(report.includes('bug') && report.includes('urgent'), 'tag bucket labels');
    // The note that keeps the tag rollup from reading as a double-count bug.
    assert.ok(
      report.includes('can exceed the library total') && report.includes('by design'),
      'multi-tag exceed-library note present',
    );
  });

  it('renders an empty-bucket placeholder rather than a blank section', () => {
    const input: RollupInput = { chatIds: [], tokensByChat: new Map(), meta: meta() };
    const report = renderRollupReport(rollupByFolder(input), rollupByTag(input));
    assert.ok(report.includes('(no chats)'), 'empty placeholder');
  });
});
