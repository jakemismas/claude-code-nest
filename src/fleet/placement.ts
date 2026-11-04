// Pure placement resolver. Decides which panel group a chat belongs to. Precedence,
// highest first: the folder a user filed by hand, the folder a fleet organize record
// names, a matching rule (none until rules ship), then the auto grouping chosen by
// groupBy. vscode-free and clock-free: the caller passes the current time.
import { GroupBy } from './nestConfig';

export interface PlacementInput {
  // A hand-filed folder that still exists in the metadata store, else null.
  readonly handFiledFolderId: string | null;
  // The folder name from the newest fleet organize record, else null.
  readonly fleetFolder: string | null;
  // A group name from a matching rule, else null. Always null until rules ship.
  readonly ruleGroup?: string | null;
  readonly ticket: string | null;
  // The name of the folder the chat was scanned from.
  readonly sourceFolder: string | null;
  readonly timestamp: number | null;
}

export type Placement =
  | { readonly kind: 'folder'; readonly folderId: string }
  | { readonly kind: 'group'; readonly key: string; readonly label: string; readonly order: number }
  | { readonly kind: 'unsorted' };

export const AUTO_GROUP_PREFIX = '__auto__:';

const DAY_MS = 24 * 60 * 60 * 1000;

// Date buckets, newest first. The order field sorts the groups.
const DATE_BUCKETS = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: 'Last 7 days' },
  { key: 'month', label: 'Last 30 days' },
  { key: 'older', label: 'Older' },
] as const;

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function dateBucketIndex(timestamp: number | null, now: number): number {
  if (timestamp === null) {
    return DATE_BUCKETS.length - 1;
  }
  const today = startOfLocalDay(now);
  if (timestamp >= today) {
    return 0;
  }
  if (timestamp >= today - DAY_MS) {
    return 1;
  }
  if (timestamp >= today - 6 * DAY_MS) {
    return 2;
  }
  if (timestamp >= today - 29 * DAY_MS) {
    return 3;
  }
  return 4;
}

function group(key: string, label: string, order: number): Placement {
  return { kind: 'group', key: AUTO_GROUP_PREFIX + key, label, order };
}

export function resolvePlacement(input: PlacementInput, groupBy: GroupBy, now: number): Placement {
  if (input.handFiledFolderId !== null) {
    return { kind: 'folder', folderId: input.handFiledFolderId };
  }
  if (input.fleetFolder !== null && input.fleetFolder.length > 0) {
    return group(`folder:${input.fleetFolder}`, input.fleetFolder, 0);
  }
  if (input.ruleGroup !== undefined && input.ruleGroup !== null && input.ruleGroup.length > 0) {
    return group(`rule:${input.ruleGroup}`, input.ruleGroup, 0);
  }
  switch (groupBy) {
    case 'tickets':
      return input.ticket !== null && input.ticket.length > 0
        ? group(`ticket:${input.ticket}`, input.ticket, 0)
        : { kind: 'unsorted' };
    case 'folders':
      return input.sourceFolder !== null && input.sourceFolder.length > 0
        ? group(`source:${input.sourceFolder}`, input.sourceFolder, 0)
        : { kind: 'unsorted' };
    case 'date': {
      const idx = dateBucketIndex(input.timestamp, now);
      return group(`date:${DATE_BUCKETS[idx].key}`, DATE_BUCKETS[idx].label, idx);
    }
    case 'auto':
    default:
      return { kind: 'unsorted' };
  }
}
