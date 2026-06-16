import * as assert from 'assert';
import { relativeTime } from '../../views/relativeTime';

// Pure-logic unit tests for the relative-time formatter. No vscode import and an
// injected clock, so every boundary the flat-view smoke depends on is covered by
// the headless gate rather than deferred to a manual smoke. NOW is a fixed clock.

const NOW = 1_700_000_000_000;
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('relativeTime', () => {
  it('returns empty string for a null timestamp', () => {
    assert.strictEqual(relativeTime(null, NOW), '');
  });

  it('clamps a future timestamp to just now (no negative ago)', () => {
    // now - timestamp is negative; Math.max(0, ...) clamps to 0 -> just now.
    assert.strictEqual(relativeTime(NOW + 10 * SEC, NOW), 'just now');
  });

  it("reads exactly now as 'just now'", () => {
    assert.strictEqual(relativeTime(NOW, NOW), 'just now');
  });

  it("treats sub-60s as 'just now'", () => {
    assert.strictEqual(relativeTime(NOW - 59 * SEC, NOW), 'just now');
  });

  it('rolls over to minutes at 60s', () => {
    assert.strictEqual(relativeTime(NOW - 60 * SEC, NOW), '1 minute ago');
  });

  it('pluralizes minutes', () => {
    assert.strictEqual(relativeTime(NOW - 2 * MIN, NOW), '2 minutes ago');
  });

  it('reports just under an hour in minutes', () => {
    // 59.4 minutes rounds to 59 (< 60), so it stays in minutes.
    assert.strictEqual(relativeTime(NOW - (59 * MIN + 20 * SEC), NOW), '59 minutes ago');
  });

  it('rolls over to hours at 60 minutes', () => {
    assert.strictEqual(relativeTime(NOW - 60 * MIN, NOW), '1 hour ago');
  });

  it('pluralizes hours', () => {
    assert.strictEqual(relativeTime(NOW - 5 * HOUR, NOW), '5 hours ago');
  });

  it('reports 23 hours in hours, not yet a day', () => {
    assert.strictEqual(relativeTime(NOW - 23 * HOUR, NOW), '23 hours ago');
  });

  it('rolls over to days at 24 hours', () => {
    assert.strictEqual(relativeTime(NOW - 24 * HOUR, NOW), '1 day ago');
  });

  it('pluralizes days', () => {
    assert.strictEqual(relativeTime(NOW - 3 * DAY, NOW), '3 days ago');
  });

  it('reports 6 days in days, not yet a week', () => {
    assert.strictEqual(relativeTime(NOW - 6 * DAY, NOW), '6 days ago');
  });

  it('rolls over to weeks at 7 days', () => {
    assert.strictEqual(relativeTime(NOW - 7 * DAY, NOW), '1 week ago');
  });

  it('pluralizes weeks', () => {
    assert.strictEqual(relativeTime(NOW - 21 * DAY, NOW), '3 weeks ago');
  });

  it('stays in weeks while weeks < 5 (round(days/7) drives the branch)', () => {
    // 31 days -> round(31/7) = 4 weeks (< 5), so it is reported in weeks even
    // though round(31/30) = 1 month. The weeks<5 guard wins this boundary.
    assert.strictEqual(relativeTime(NOW - 31 * DAY, NOW), '4 weeks ago');
  });

  it('switches to months once weeks reaches 5 (days/30 path)', () => {
    // 32 days -> round(32/7) = 5 weeks (not < 5), so the months branch runs:
    // round(32/30) = 1 month.
    assert.strictEqual(relativeTime(NOW - 32 * DAY, NOW), '1 month ago');
  });

  it('pluralizes months', () => {
    assert.strictEqual(relativeTime(NOW - 90 * DAY, NOW), '3 months ago');
  });

  it('reports late-year span still in months while months < 12', () => {
    // 320 days -> round(320/30) = 11 months (< 12).
    assert.strictEqual(relativeTime(NOW - 320 * DAY, NOW), '11 months ago');
  });

  it('rolls over to years once months reaches 12', () => {
    // 360 days -> round(360/30) = 12 months (not < 12) -> years branch:
    // round(360/365) = 1 year.
    assert.strictEqual(relativeTime(NOW - 360 * DAY, NOW), '1 year ago');
  });

  it('pluralizes years', () => {
    assert.strictEqual(relativeTime(NOW - 800 * DAY, NOW), '2 years ago');
  });

  it('defaults the clock to Date.now() when omitted', () => {
    // A timestamp far in the past resolves to a years-ago string regardless of
    // the exact wall clock, proving the default-arg path is exercised.
    const result = relativeTime(0);
    assert.ok(/years ago$/.test(result), 'expected a years-ago string, got: ' + result);
  });
});
