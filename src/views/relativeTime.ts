// A compact relative-time string for a chat row description. Pure and
// deterministic: no vscode dependency and an injectable clock, so the headless
// unit gate can cover the boundary rounding (the null branch, the negative
// clamp, the 'just now' floor, and each unit rollover). The flat view imports
// this; keeping it vscode-free keeps it in the unit suite.
//
// Rollover boundaries (each computed against the same base, not chained):
//   < 60s            -> 'just now'
//   < 60 min         -> N minute(s) ago        (minutes = round(seconds/60))
//   < 24 hours       -> N hour(s) ago          (hours   = round(minutes/60))
//   < 7 days         -> N day(s) ago           (days    = round(hours/24))
//   weeks < 5        -> N week(s) ago          (weeks   = round(days/7))
//   months < 12      -> N month(s) ago         (months  = round(days/30))
//   otherwise        -> N year(s) ago          (years   = round(days/365))
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
