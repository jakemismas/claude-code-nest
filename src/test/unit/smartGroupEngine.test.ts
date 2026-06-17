import * as assert from 'assert';
import { SmartSignalsInput } from '../../model/types';
import {
  SMART_GROUP_PR,
  SMART_GROUP_TICKET,
  SMART_GROUP_BRANCH,
  SMART_GROUP_FORK,
  SMART_GROUP_IDS,
  computeSmartGroups,
  smartBucketNodeId,
  isSmartGroupId,
} from '../../smart/smartGroupEngine';
import { RESERVED_SENTINELS, isMintableId } from '../../model/idFactory';

// Unit tests for the PURE engine composition: it recomputes four signal groups,
// always renders all four even when empty, marks PR solid and the rest
// best-effort, and mints separator-free, non-colliding ids.

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

describe('computeSmartGroups', () => {
  it('always returns the four groups in fixed order, PR solid and the rest best-effort', () => {
    const tree = computeSmartGroups([]);
    assert.deepStrictEqual(
      tree.groups.map((g) => g.id),
      [SMART_GROUP_PR, SMART_GROUP_TICKET, SMART_GROUP_BRANCH, SMART_GROUP_FORK],
    );
    assert.strictEqual(tree.groups[0].solid, true, 'PR is solid');
    assert.strictEqual(tree.groups[1].solid, false, 'ticket is best-effort');
    assert.strictEqual(tree.groups[2].solid, false, 'branch is best-effort');
    assert.strictEqual(tree.groups[3].solid, false, 'fork is best-effort');
  });

  it('renders all four groups EMPTY (zero buckets) on empty input, without error', () => {
    const tree = computeSmartGroups([]);
    for (const group of tree.groups) {
      assert.strictEqual(group.buckets.length, 0, group.id + ' renders empty');
    }
  });

  it('routes each signal into its own group', () => {
    const rows = [
      row({ sessionId: 'a', prNumber: 1, prUrl: 'u', prRepository: 'o/r' }),
      row({ sessionId: 'b', prNumber: 1, prUrl: 'u', prRepository: 'o/r' }),
      row({ sessionId: 'c', title: 'ABC-1 ticketed', gitBranch: 'feature/x' }),
      row({ sessionId: 'd', title: 'ABC-1 also', gitBranch: 'feature/x' }),
    ];
    const tree = computeSmartGroups(rows);
    const byId = new Map(tree.groups.map((g) => [g.id, g]));
    assert.strictEqual(byId.get(SMART_GROUP_PR)!.buckets.length, 1);
    assert.strictEqual(byId.get(SMART_GROUP_TICKET)!.buckets.length, 1);
    assert.strictEqual(byId.get(SMART_GROUP_BRANCH)!.buckets.length, 1);
    assert.strictEqual(byId.get(SMART_GROUP_FORK)!.buckets.length, 0);
  });

  it('recomputes on each call (no hidden caching)', () => {
    const first = computeSmartGroups([row({ sessionId: 'a', prNumber: 1, prUrl: 'u' })]);
    const second = computeSmartGroups([]);
    assert.strictEqual(first.groups[0].buckets.length, 1);
    assert.strictEqual(second.groups[0].buckets.length, 0);
  });
});

describe('smart-group id grammar and collision-freedom', () => {
  it('every smart-group sentinel is separator-free and non-mintable', () => {
    for (const id of SMART_GROUP_IDS) {
      assert.strictEqual(isMintableId(id), false, id + ' must never be mintable');
      assert.ok(!id.includes(':') && !id.includes('#') && !id.includes('>'), id + ' is separator-free');
    }
  });

  it('the four sentinels are in RESERVED_SENTINELS and distinct from unfiled/untagged', () => {
    for (const id of SMART_GROUP_IDS) {
      assert.ok(RESERVED_SENTINELS.has(id), id + ' is reserved');
    }
    assert.ok(!SMART_GROUP_IDS.includes('__unfiled__'));
    assert.ok(!SMART_GROUP_IDS.includes('__untagged__'));
  });

  it('isSmartGroupId recognizes the sentinels and rejects others', () => {
    assert.strictEqual(isSmartGroupId(SMART_GROUP_PR), true);
    assert.strictEqual(isSmartGroupId('__unfiled__'), false);
    assert.strictEqual(isSmartGroupId('some-folder-id'), false);
  });

  it('builds a bucket node id under its group', () => {
    assert.strictEqual(smartBucketNodeId(SMART_GROUP_PR, 'url:u'), '__smart_pr__::url:u');
  });
});
