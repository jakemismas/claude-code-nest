import * as assert from 'assert';
import { AUTO_GROUP_PREFIX, PlacementInput, dateBucketIndex, resolvePlacement } from '../../fleet/placement';

const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

function input(over: Partial<PlacementInput> = {}): PlacementInput {
  return { handFiledFolderId: null, fleetFolder: null, ticket: null, sourceFolder: null, timestamp: NOW, ...over };
}

describe('resolvePlacement precedence', () => {
  it('hand-filed beats fleet organize, rules and auto grouping', () => {
    const p = resolvePlacement(
      input({ handFiledFolderId: 'f1', fleetFolder: 'Fleet', ruleGroup: 'Rule', ticket: 'T-1' }),
      'tickets',
      NOW,
    );
    assert.deepStrictEqual(p, { kind: 'folder', folderId: 'f1' });
  });

  it('fleet organize beats rules and auto grouping', () => {
    const p = resolvePlacement(input({ fleetFolder: 'Fleet', ruleGroup: 'Rule', ticket: 'T-1' }), 'tickets', NOW);
    assert.strictEqual(p.kind === 'group' && p.label, 'Fleet');
  });

  it('rules beat auto grouping', () => {
    const p = resolvePlacement(input({ ruleGroup: 'Rule', ticket: 'T-1' }), 'tickets', NOW);
    assert.strictEqual(p.kind === 'group' && p.label, 'Rule');
  });

  it('falls to auto grouping last', () => {
    const p = resolvePlacement(input({ ticket: 'T-1' }), 'tickets', NOW);
    assert.strictEqual(p.kind === 'group' && p.label, 'T-1');
    assert.ok(p.kind === 'group' && p.key.startsWith(AUTO_GROUP_PREFIX));
  });
});

describe('resolvePlacement auto grouping', () => {
  it('auto leaves chats unsorted', () => {
    assert.deepStrictEqual(resolvePlacement(input({ ticket: 'T-1' }), 'auto', NOW), { kind: 'unsorted' });
  });

  it('tickets leaves a chat without a ticket unsorted', () => {
    assert.deepStrictEqual(resolvePlacement(input(), 'tickets', NOW), { kind: 'unsorted' });
  });

  it('folders groups by source folder', () => {
    const p = resolvePlacement(input({ sourceFolder: 'proj' }), 'folders', NOW);
    assert.strictEqual(p.kind === 'group' && p.label, 'proj');
    assert.deepStrictEqual(resolvePlacement(input(), 'folders', NOW), { kind: 'unsorted' });
  });

  it('date buckets by local day', () => {
    assert.strictEqual(dateBucketIndex(NOW, NOW), 0);
    assert.strictEqual(dateBucketIndex(NOW - DAY, NOW), 1);
    assert.strictEqual(dateBucketIndex(NOW - 3 * DAY, NOW), 2);
    assert.strictEqual(dateBucketIndex(NOW - 20 * DAY, NOW), 3);
    assert.strictEqual(dateBucketIndex(NOW - 90 * DAY, NOW), 4);
    assert.strictEqual(dateBucketIndex(null, NOW), 4);
    const p = resolvePlacement(input({ timestamp: NOW - DAY }), 'date', NOW);
    assert.strictEqual(p.kind === 'group' && p.label, 'Yesterday');
  });
});
