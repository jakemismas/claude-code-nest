// Auto-export snapshot naming and retention. Pure: the caller supplies the directory
// listing and performs the deletes, so the logic runs without vscode or a filesystem.

// Number of newest auto-export snapshots to keep.
export const RETENTION_COUNT = 10;

const SNAPSHOT_PREFIX = 'nest-autoexport-';
const SNAPSHOT_SUFFIX = '.json';

// Fixed stamp width keeps lexicographic name order equal to chronological order.
const STAMP_WIDTH = 14;

// Build the snapshot filename for an epoch-ms timestamp.
export function retentionSnapshotName(now: number): string {
  const stamp = Math.max(0, Math.floor(now)).toString().padStart(STAMP_WIDTH, '0');
  return SNAPSHOT_PREFIX + stamp + SNAPSHOT_SUFFIX;
}

// Lets prune ignore foreign files that share the directory.
export function isSnapshotName(name: string): boolean {
  return (
    name.startsWith(SNAPSHOT_PREFIX) &&
    name.endsWith(SNAPSHOT_SUFFIX) &&
    name.length > SNAPSHOT_PREFIX.length + SNAPSHOT_SUFFIX.length
  );
}

// Return the snapshot names to delete so only the newest retentionCount remain.
export function computeRetentionPrune(
  names: string[],
  retentionCount: number = RETENTION_COUNT,
): string[] {
  const snapshots = names.filter(isSnapshotName);
  // Newest first.
  snapshots.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  if (snapshots.length <= retentionCount) {
    return [];
  }
  return snapshots.slice(retentionCount);
}
