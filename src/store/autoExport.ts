// Auto-export retention policy. PURE and vscode-free (unit-gate rule): no
// filesystem, no vscode. The command module (exportImportCommands.ts) supplies
// the directory listing (via vscode.workspace.fs, keeping node fs out of the lint
// bank) and performs the deletes; this module decides the snapshot NAME and which
// names to PRUNE so the retention count is unit-testable headless.
//
// Retention rule (slice patch): keep the most recent N snapshots, prune older.

// How many auto-export snapshots to retain. Older snapshots beyond this are
// pruned. Defined here so it is unit-testable.
export const RETENTION_COUNT = 10;

// The filename prefix and extension for an auto-export snapshot. The name embeds
// the epoch ms so a lexicographic sort by name is also a chronological sort
// (fixed-width zero-padded ms), which is how computeRetentionPrune orders them.
const SNAPSHOT_PREFIX = 'nest-autoexport-';
const SNAPSHOT_SUFFIX = '.json';

// Zero-pad width for the epoch-ms stamp in a snapshot name. 14 digits covers
// epoch ms well past the year 5000, so the fixed width keeps lexicographic order
// equal to chronological order for the foreseeable lifetime of the extension.
const STAMP_WIDTH = 14;

// Build the snapshot filename for a given epoch-ms timestamp. The stamp is
// zero-padded to a fixed width so sorting names lexicographically sorts them by
// time, which the prune relies on.
export function retentionSnapshotName(now: number): string {
  const stamp = Math.max(0, Math.floor(now)).toString().padStart(STAMP_WIDTH, '0');
  return SNAPSHOT_PREFIX + stamp + SNAPSHOT_SUFFIX;
}

// True when a filename is one of our auto-export snapshots (so prune only ever
// considers our own files and never touches a foreign file that happens to share
// the directory).
export function isSnapshotName(name: string): boolean {
  return (
    name.startsWith(SNAPSHOT_PREFIX) &&
    name.endsWith(SNAPSHOT_SUFFIX) &&
    name.length > SNAPSHOT_PREFIX.length + SNAPSHOT_SUFFIX.length
  );
}

// Given the current directory listing (file names), return the names to DELETE so
// only the most recent RETENTION_COUNT snapshots remain. Non-snapshot files are
// ignored entirely (never returned for deletion). Snapshots are ordered newest
// first by name (fixed-width stamp => lexicographic order is chronological), the
// newest RETENTION_COUNT are kept, and the rest are returned for pruning.
export function computeRetentionPrune(
  names: string[],
  retentionCount: number = RETENTION_COUNT,
): string[] {
  const snapshots = names.filter(isSnapshotName);
  // Sort DESCENDING by name => newest first.
  snapshots.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  if (snapshots.length <= retentionCount) {
    return [];
  }
  return snapshots.slice(retentionCount);
}
