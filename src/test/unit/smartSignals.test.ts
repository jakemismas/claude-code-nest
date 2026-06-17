import * as assert from 'assert';
import { SmartSignalsInput } from '../../model/types';
import { prBuckets, prKey, prLabel } from '../../smart/signals/pr';
import { ticketBuckets, ticketKey } from '../../smart/signals/ticket';
import { branchBuckets, branchKey } from '../../smart/signals/branch';
import {
  forkLineageBuckets,
  longestCommonLeadingPrefix,
  MIN_SHARED_PREFIX,
} from '../../smart/signals/forkLineage';

// High-priority unit tests for the four PURE smart-group signal functions. Each
// signal is a pure function of plain SmartSignalsInput rows; none imports vscode
// or fs, so this suite runs headless (unit-gate rule). The fork-lineage signal is
// exercised on synthetic SHARED and DIVERGENT leading-uuid prefixes per the plan.

function row(partial: Partial<SmartSignalsInput> & { sessionId: string }): SmartSignalsInput {
  return {
    sessionId: partial.sessionId,
    prNumber: partial.prNumber ?? null,
    prUrl: partial.prUrl ?? null,
    prRepository: partial.prRepository ?? null,
    gitBranch: partial.gitBranch ?? null,
    leadingMessageUuids: partial.leadingMessageUuids ?? [],
    title: partial.title ?? '',
  };
}

describe('pr signal (the solid signal)', () => {
  it('groups chats by canonical PR identity and labels with number + repo', () => {
    const rows = [
      row({ sessionId: 'a', prNumber: 1, prUrl: 'u1', prRepository: 'o/r' }),
      row({ sessionId: 'b', prNumber: 1, prUrl: 'u1', prRepository: 'o/r' }),
      row({ sessionId: 'c', prNumber: 2, prUrl: 'u2', prRepository: 'o/r' }),
      row({ sessionId: 'd' }),
    ];
    const buckets = prBuckets(rows);
    assert.strictEqual(buckets.length, 2, 'two PRs, the no-PR chat is omitted');
    const pr1 = buckets.find((b) => b.label === 'PR #1 (o/r)');
    assert.ok(pr1, 'PR #1 bucket exists with the number+repo label');
    assert.deepStrictEqual(pr1!.memberChatIds.sort(), ['a', 'b']);
  });

  it('omits a chat with no PR signal entirely', () => {
    assert.strictEqual(prKey(row({ sessionId: 'x' })), null);
    assert.strictEqual(prBuckets([row({ sessionId: 'x' })]).length, 0);
  });

  it('keys by canonical repo#number, deriving repo+number from a GitHub url', () => {
    // Explicit repo+number win and produce the canonical key even when a
    // (non-standard) url is also present.
    assert.strictEqual(prKey(row({ sessionId: 'a', prUrl: 'U', prNumber: 5, prRepository: 'o/r' })), 'rn:o/r#5');
    assert.strictEqual(prKey(row({ sessionId: 'a', prNumber: 5, prRepository: 'o/r' })), 'rn:o/r#5');
    // A real GitHub PR url with NO explicit fields resolves to the same canonical
    // key by parsing owner/repo and the number out of the path.
    assert.strictEqual(prKey(row({ sessionId: 'a', prUrl: 'https://github.com/o/r/pull/5' })), 'rn:o/r#5');
    assert.strictEqual(prKey(row({ sessionId: 'a', prUrl: 'https://github.com/o/r/pull/5/files' })), 'rn:o/r#5');
    // Number with no derivable repo stays a bare #number (NOT merged into a
    // specific repo's PR of the same number, which could be a different PR).
    assert.strictEqual(prKey(row({ sessionId: 'a', prNumber: 5 })), 'n:#5');
    // A non-standard url that exposes no repo+number falls back to the raw url.
    assert.strictEqual(prKey(row({ sessionId: 'a', prUrl: 'https://x/pull/9' })), 'url:https://x/pull/9');
  });

  it('co-locates the SAME PR across mixed-completeness pr-link payloads', () => {
    // The regression the loop-until-dry review caught: one transcript's pr-link
    // carried only a url, another's carried only repo+number, for the SAME PR.
    // They must land in ONE bucket, not split, because PR is the solid signal.
    const rows = [
      row({ sessionId: 'a', prUrl: 'https://github.com/o/r/pull/5' }),
      row({ sessionId: 'b', prNumber: 5, prRepository: 'o/r' }),
      row({ sessionId: 'c', prUrl: 'https://github.com/o/r/pull/5/files#diff' }),
    ];
    const buckets = prBuckets(rows);
    assert.strictEqual(buckets.length, 1, 'one PR, one bucket across both payload shapes');
    assert.deepStrictEqual(buckets[0].memberChatIds.sort(), ['a', 'b', 'c']);
    assert.strictEqual(buckets[0].label, 'PR #5 (o/r)', 'canonical label regardless of which member is first');
  });

  it('labels a number-only PR and a url-only PR', () => {
    assert.strictEqual(prLabel(row({ sessionId: 'a', prNumber: 9 })), 'PR #9');
    // A url-only label routes through the canonical identity: a GitHub url renders
    // the parsed number+repo, a non-PR-shaped url renders the bare url.
    assert.strictEqual(prLabel(row({ sessionId: 'a', prUrl: 'https://github.com/o/r/pull/9' })), 'PR #9 (o/r)');
    assert.strictEqual(prLabel(row({ sessionId: 'a', prUrl: 'https://x/pull/9' })), 'https://x/pull/9');
  });
});

describe('ticket signal (best-effort, usually empty)', () => {
  it('extracts a leading ABC-123 ticket prefix', () => {
    assert.strictEqual(ticketKey('ABC-123 do the thing'), 'ABC-123');
    assert.strictEqual(ticketKey('JIRA-42: fix it'), 'JIRA-42');
    assert.strictEqual(ticketKey('PROJ-7'), 'PROJ-7');
  });

  it('rejects a non-leading or malformed ticket', () => {
    assert.strictEqual(ticketKey('do ABC-123 later'), null, 'mid-title is not a signal');
    assert.strictEqual(ticketKey('abc-123 lowercase'), null);
    assert.strictEqual(ticketKey('A-1 too-short-prefix'), null);
    assert.strictEqual(ticketKey('ABCDEFGHIJK-1 too-long-prefix'), null);
    assert.strictEqual(ticketKey('ABC-12x glued'), null);
  });

  it('groups chats by ticket and renders empty on titles without tickets', () => {
    const rows = [
      row({ sessionId: 'a', title: 'ABC-1 thing' }),
      row({ sessionId: 'b', title: 'ABC-1 more' }),
      row({ sessionId: 'c', title: 'no ticket here' }),
    ];
    const buckets = ticketBuckets(rows);
    assert.strictEqual(buckets.length, 1);
    assert.strictEqual(buckets[0].label, 'ABC-1');
    assert.deepStrictEqual(buckets[0].memberChatIds.sort(), ['a', 'b']);

    assert.strictEqual(ticketBuckets([row({ sessionId: 'x', title: 'plain' })]).length, 0);
  });
});

describe('branch signal (best-effort, HEAD suppressed)', () => {
  it('suppresses the non-grouping HEAD branch and empty branches', () => {
    assert.strictEqual(branchKey(row({ sessionId: 'a', gitBranch: 'HEAD' })), null);
    assert.strictEqual(branchKey(row({ sessionId: 'a', gitBranch: null })), null);
    assert.strictEqual(branchKey(row({ sessionId: 'a', gitBranch: '' })), null);
    assert.strictEqual(branchKey(row({ sessionId: 'a', gitBranch: 'feature/x' })), 'feature/x');
  });

  it('groups by real branch and renders empty when every chat is on HEAD', () => {
    const rows = [
      row({ sessionId: 'a', gitBranch: 'feature/x' }),
      row({ sessionId: 'b', gitBranch: 'feature/x' }),
      row({ sessionId: 'c', gitBranch: 'HEAD' }),
    ];
    const buckets = branchBuckets(rows);
    assert.strictEqual(buckets.length, 1, 'only the real branch buckets; HEAD suppressed');
    assert.deepStrictEqual(buckets[0].memberChatIds.sort(), ['a', 'b']);

    const allHead = branchBuckets([
      row({ sessionId: 'a', gitBranch: 'HEAD' }),
      row({ sessionId: 'b', gitBranch: 'HEAD' }),
    ]);
    assert.strictEqual(allHead.length, 0, 'a HEAD-only library renders empty');
  });
});

describe('fork-lineage signal (best-effort, often empty)', () => {
  it('groups two transcripts that share a leading uuid prefix', () => {
    const rows = [
      row({ sessionId: 'parent', leadingMessageUuids: ['u1', 'u2', 'u3'] }),
      row({ sessionId: 'fork', leadingMessageUuids: ['u1', 'u2', 'x9'] }),
      row({ sessionId: 'unrelated', leadingMessageUuids: ['z1', 'z2', 'z3'] }),
    ];
    const buckets = forkLineageBuckets(rows);
    assert.strictEqual(buckets.length, 1, 'one fork family from the shared u1,u2 prefix');
    assert.deepStrictEqual(buckets[0].memberChatIds.sort(), ['fork', 'parent']);
  });

  it('does NOT group divergent prefixes (only the first uuid shared)', () => {
    const rows = [
      row({ sessionId: 'a', leadingMessageUuids: ['u1', 'x2', 'x3'] }),
      row({ sessionId: 'b', leadingMessageUuids: ['u1', 'y2', 'y3'] }),
    ];
    // Sharing only ONE leading uuid is below MIN_SHARED_PREFIX (2), so no family.
    assert.strictEqual(MIN_SHARED_PREFIX, 2);
    assert.strictEqual(forkLineageBuckets(rows).length, 0);
  });

  it('renders empty when no two transcripts share a leading prefix (the real data case)', () => {
    const rows = [
      row({ sessionId: 'a', leadingMessageUuids: ['a1', 'a2', 'a3'] }),
      row({ sessionId: 'b', leadingMessageUuids: ['b1', 'b2', 'b3'] }),
      row({ sessionId: 'c', leadingMessageUuids: [] }),
    ];
    assert.strictEqual(forkLineageBuckets(rows).length, 0);
  });

  it('drops a lone chat with a long prefix (a fork needs two members)', () => {
    const rows = [row({ sessionId: 'solo', leadingMessageUuids: ['u1', 'u2', 'u3'] })];
    assert.strictEqual(forkLineageBuckets(rows).length, 0);
  });

  it('unions transitively across three transcripts of one fork family', () => {
    const rows = [
      row({ sessionId: 'a', leadingMessageUuids: ['u1', 'u2', 'u3', 'u4'] }),
      row({ sessionId: 'b', leadingMessageUuids: ['u1', 'u2', 'u3', 'x4'] }),
      row({ sessionId: 'c', leadingMessageUuids: ['u1', 'u2', 'y3'] }),
    ];
    const buckets = forkLineageBuckets(rows);
    assert.strictEqual(buckets.length, 1);
    assert.deepStrictEqual(buckets[0].memberChatIds.sort(), ['a', 'b', 'c']);
  });

  it('ignores a chat whose leading sequence is shorter than the minimum', () => {
    const rows = [
      row({ sessionId: 'a', leadingMessageUuids: ['u1'] }),
      row({ sessionId: 'b', leadingMessageUuids: ['u1'] }),
    ];
    assert.strictEqual(forkLineageBuckets(rows).length, 0, 'one-uuid sequences cannot anchor a family');
  });

  it('labels a family with a count-free head so the promote name is stable', () => {
    const head = '0f16803a';
    const buckets = forkLineageBuckets([
      row({ sessionId: 'parent', leadingMessageUuids: [head + 'xx', 'u2', 'u3'] }),
      row({ sessionId: 'fork', leadingMessageUuids: [head + 'xx', 'u2', 'x9'] }),
    ]);
    assert.strictEqual(buckets.length, 1);
    assert.strictEqual(buckets[0].label, 'Fork lineage ' + head);
  });

  it('keeps the SAME label when the fork family grows (idempotency-on-name)', () => {
    // The label feeds promote-to-folder/tag verbatim as the target name; if it
    // changed as the family grew, re-promoting would mint a duplicate folder/tag
    // (promoteSmartGroup idempotency-on-name reuse keys on the label). So the
    // label MUST NOT vary with member count.
    const head = '0f16803a';
    const three = forkLineageBuckets([
      row({ sessionId: 'a', leadingMessageUuids: [head + 'xx', 'u2', 'a3'] }),
      row({ sessionId: 'b', leadingMessageUuids: [head + 'xx', 'u2', 'b3'] }),
      row({ sessionId: 'c', leadingMessageUuids: [head + 'xx', 'u2', 'c3'] }),
    ]);
    const four = forkLineageBuckets([
      row({ sessionId: 'a', leadingMessageUuids: [head + 'xx', 'u2', 'a3'] }),
      row({ sessionId: 'b', leadingMessageUuids: [head + 'xx', 'u2', 'b3'] }),
      row({ sessionId: 'c', leadingMessageUuids: [head + 'xx', 'u2', 'c3'] }),
      row({ sessionId: 'd', leadingMessageUuids: [head + 'xx', 'u2', 'd3'] }),
    ]);
    assert.strictEqual(three.length, 1);
    assert.strictEqual(four.length, 1);
    assert.strictEqual(three[0].memberChatIds.length, 3);
    assert.strictEqual(four[0].memberChatIds.length, 4);
    assert.strictEqual(
      three[0].label,
      four[0].label,
      'fork-lineage label must be count-free so promote reuses the same target',
    );
  });
});

describe('longestCommonLeadingPrefix', () => {
  it('returns the shared head and stops at the first divergence', () => {
    assert.deepStrictEqual(
      longestCommonLeadingPrefix([['a', 'b', 'c'], ['a', 'b', 'z'], ['a', 'b']]),
      ['a', 'b'],
    );
  });
  it('returns empty when the first element differs', () => {
    assert.deepStrictEqual(longestCommonLeadingPrefix([['a'], ['b']]), []);
  });
  it('handles the empty input', () => {
    assert.deepStrictEqual(longestCommonLeadingPrefix([]), []);
  });
});
