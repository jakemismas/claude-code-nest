// Relative-time strings for chat rows. Pure with an injectable clock, no vscode import.

// Verbose form ("3 hours ago"). Each unit is rounded from the previous one, so a unit
// rolls over once its rounded value reaches the next threshold.
export function relativeTime(timestamp: number | null, now: number = Date.now()): string {
  if (timestamp === null) {
    return '';
  }
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) {
    return 'just now';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return plural(minutes, 'minute');
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return plural(hours, 'hour');
  }
  const days = Math.round(hours / 24);
  if (days < 7) {
    return plural(days, 'day');
  }
  const weeks = Math.round(days / 7);
  if (weeks < 5) {
    return plural(weeks, 'week');
  }
  const months = Math.round(days / 30);
  if (months < 12) {
    return plural(months, 'month');
  }
  const years = Math.round(days / 365);
  return plural(years, 'year');
}

function plural(value: number, unit: string): string {
  return value + ' ' + unit + (value === 1 ? '' : 's') + ' ago';
}

// Compact form ("3h"). Floors against a fixed base to match relative() in
// media/orgPanel.js, so host and webview agree on the same age. Months are 30 days.
export function relativeTimeCompact(timestamp: number | null, now: number = Date.now()): string {
  if (timestamp === null) {
    return '';
  }
  const diffMs = Math.max(0, now - timestamp);
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;
  const MONTH = 30 * DAY;
  const YEAR = 12 * MONTH;
  if (diffMs < MIN) {
    return 'now';
  }
  if (diffMs < HOUR) {
    return Math.floor(diffMs / MIN) + 'm';
  }
  if (diffMs < DAY) {
    return Math.floor(diffMs / HOUR) + 'h';
  }
  if (diffMs < WEEK) {
    return Math.floor(diffMs / DAY) + 'd';
  }
  if (diffMs < MONTH) {
    return Math.floor(diffMs / WEEK) + 'w';
  }
  if (diffMs < YEAR) {
    return Math.floor(diffMs / MONTH) + 'mo';
  }
  return Math.floor(diffMs / YEAR) + 'y';
}
