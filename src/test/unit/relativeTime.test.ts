import * as assert from 'assert';
import { relativeTime, relativeTimeCompact } from '../../views/relativeTime';

// Unit tests for the relative-time formatter with an injected clock, covering every unit boundary.

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
    // A negative difference clamps to 0, so the result is "just now".
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
    // 31 days rounds to 4 weeks (under 5), so weeks win over 1 month.
    assert.strictEqual(relativeTime(NOW - 31 * DAY, NOW), '4 weeks ago');
  });

  it('switches to months once weeks reaches 5 (days/30 path)', () => {
    // 32 days rounds to 5 weeks, so the months branch runs and gives 1 month.
    assert.strictEqual(relativeTime(NOW - 32 * DAY, NOW), '1 month ago');
  });

  it('pluralizes months', () => {
    assert.strictEqual(relativeTime(NOW - 90 * DAY, NOW), '3 months ago');
  });

  it('reports late-year span still in months while months < 12', () => {
    assert.strictEqual(relativeTime(NOW - 320 * DAY, NOW), '11 months ago');
  });

  it('rolls over to years once months reaches 12', () => {
    // 360 days rounds to 12 months, so the years branch gives 1 year.
    assert.strictEqual(relativeTime(NOW - 360 * DAY, NOW), '1 year ago');
  });

  it('pluralizes years', () => {
    assert.strictEqual(relativeTime(NOW - 800 * DAY, NOW), '2 years ago');
  });

  it('defaults the clock to Date.now() when omitted', () => {
    // A far-past timestamp resolves to years ago, which exercises the default-clock path.
    const result = relativeTime(0);
    assert.ok(/years ago$/.test(result), 'expected a years-ago string, got: ' + result);
  });
});

describe('relativeTimeCompact (design row buckets, floor semantics)', () => {
  const MIN = 60 * SEC;

  it('returns empty string for a null timestamp', () => {
    assert.strictEqual(relativeTimeCompact(null, NOW), '');
  });

  it("reads sub-60s (and a future clamp) as 'now'", () => {
    assert.strictEqual(relativeTimeCompact(NOW, NOW), 'now');
    assert.strictEqual(relativeTimeCompact(NOW - 59 * SEC, NOW), 'now');
    assert.strictEqual(relativeTimeCompact(NOW + 10 * SEC, NOW), 'now', 'future clamps to now');
  });

  it('renders the design example buckets: 35m / 3h / 1d / 2w / 1mo', () => {
    assert.strictEqual(relativeTimeCompact(NOW - 35 * MIN, NOW), '35m');
    assert.strictEqual(relativeTimeCompact(NOW - 3 * HOUR, NOW), '3h');
    assert.strictEqual(relativeTimeCompact(NOW - 1 * DAY, NOW), '1d');
    assert.strictEqual(relativeTimeCompact(NOW - 14 * DAY, NOW), '2w');
    assert.strictEqual(relativeTimeCompact(NOW - 30 * DAY, NOW), '1mo');
  });

  it('floors within a unit (does not round up)', () => {
    assert.strictEqual(relativeTimeCompact(NOW - (59 * MIN + 59 * SEC), NOW), '59m');
    assert.strictEqual(relativeTimeCompact(NOW - (23 * HOUR + 59 * MIN), NOW), '23h');
  });

  it('rolls at each unit edge', () => {
    assert.strictEqual(relativeTimeCompact(NOW - 60 * SEC, NOW), '1m');
    assert.strictEqual(relativeTimeCompact(NOW - 60 * MIN, NOW), '1h');
    assert.strictEqual(relativeTimeCompact(NOW - 24 * HOUR, NOW), '1d');
    assert.strictEqual(relativeTimeCompact(NOW - 7 * DAY, NOW), '1w');
  });

  it("switches days->weeks at 7 days and holds weeks until 30 days", () => {
    assert.strictEqual(relativeTimeCompact(NOW - 6 * DAY, NOW), '6d');
    assert.strictEqual(relativeTimeCompact(NOW - 7 * DAY, NOW), '1w');
    assert.strictEqual(relativeTimeCompact(NOW - 29 * DAY, NOW), '4w');
  });

  it('switches weeks->months at 30 days and holds months until a year', () => {
    assert.strictEqual(relativeTimeCompact(NOW - 30 * DAY, NOW), '1mo');
    assert.strictEqual(relativeTimeCompact(NOW - 359 * DAY, NOW), '11mo');
  });

  it('rolls to years at 360 days (12 * 30-day months)', () => {
    assert.strictEqual(relativeTimeCompact(NOW - 360 * DAY, NOW), '1y');
    assert.strictEqual(relativeTimeCompact(NOW - 720 * DAY, NOW), '2y');
  });

  it('defaults the clock to Date.now() when omitted', () => {
    const result = relativeTimeCompact(0);
    assert.ok(/y$/.test(result), 'expected a compact years string, got: ' + result);
  });
});
