// Unit tests for coercing the group-by mode and override values.

import * as assert from 'assert';
import {
  coerceGroupByMode,
  coerceGroupByOverride,
  coerceSettingsInbound,
  effectiveGroupBy,
} from '../../fleet/groupByOverride';

describe('groupByOverride', () => {
  it('accepts only the four known modes', () => {
    for (const m of ['auto', 'tickets', 'folders', 'date']) {
      assert.strictEqual(coerceGroupByMode(m), m);
    }
    for (const bad of ['Date', '', 'x', 3, null, undefined, {}]) {
      assert.strictEqual(coerceGroupByMode(bad), null);
    }
  });

  it('treats auto and unknown stored values as no override', () => {
    assert.strictEqual(coerceGroupByOverride('auto'), null);
    assert.strictEqual(coerceGroupByOverride('bogus'), null);
    assert.strictEqual(coerceGroupByOverride(undefined), null);
    assert.strictEqual(coerceGroupByOverride('date'), 'date');
  });

  it('lets the override win over the layout value', () => {
    assert.strictEqual(effectiveGroupBy('date', 'tickets'), 'date');
    assert.strictEqual(effectiveGroupBy('folders', 'auto'), 'folders');
  });

  it('falls back to the layout value when no override is set', () => {
    assert.strictEqual(effectiveGroupBy(undefined, 'tickets'), 'tickets');
    assert.strictEqual(effectiveGroupBy('auto', 'folders'), 'folders');
    assert.strictEqual(effectiveGroupBy('junk', 'date'), 'date');
  });

  it('passes valid setGroupBy messages', () => {
    assert.deepStrictEqual(coerceSettingsInbound({ type: 'setGroupBy', mode: 'date' }), {
      type: 'setGroupBy',
      mode: 'date',
    });
    assert.deepStrictEqual(coerceSettingsInbound({ type: 'setGroupBy', mode: 'auto' }), {
      type: 'setGroupBy',
      mode: 'auto',
    });
  });

  it('ignores setGroupBy with an unknown mode', () => {
    assert.strictEqual(coerceSettingsInbound({ type: 'setGroupBy', mode: 'weekly' }), null);
    assert.strictEqual(coerceSettingsInbound({ type: 'setGroupBy' }), null);
  });

  it('passes only boolean setRobinAnimations values', () => {
    assert.deepStrictEqual(coerceSettingsInbound({ type: 'setRobinAnimations', on: false }), {
      type: 'setRobinAnimations',
      on: false,
    });
    assert.strictEqual(coerceSettingsInbound({ type: 'setRobinAnimations', on: 'true' }), null);
    assert.strictEqual(coerceSettingsInbound({ type: 'setRobinAnimations', on: 1 }), null);
  });

  it('ignores non-objects and other types', () => {
    assert.strictEqual(coerceSettingsInbound(null), null);
    assert.strictEqual(coerceSettingsInbound('setGroupBy'), null);
    assert.strictEqual(coerceSettingsInbound({ type: 'other' }), null);
  });
});
