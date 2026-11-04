// Pure composition of the four smart-group signals into the tree the Smart Groups view renders.
// It recomputes buckets from the current rows on every call and never mutates the store or
// files a chat; promoting a group to a folder or tag is a separate user command.
// Group ids are reserved sentinels '__smart_<signal>__'; bucket ids are '<groupId>::<bucketKey>'.
// '::' avoids the folder member (`#`), tag occurrence (`:`) and linked-child (`>`) id separators.
// The bucket key is opaque, so the view keeps memberChatIds instead of parsing the id.

import { SmartSignalsInput } from '../model/types';
import { SmartBucket } from './signals/bucket';
import { prBuckets } from './signals/pr';
import { ticketBuckets } from './signals/ticket';
import { branchBuckets } from './signals/branch';
import { forkLineageBuckets } from './signals/forkLineage';

// Reserved sentinels, distinct from '__unfiled__' (Folders) and '__untagged__' (Tags), so a
// smart-group row id never collides with a folder or tag row id.
export const SMART_GROUP_PR = '__smart_pr__';
export const SMART_GROUP_TICKET = '__smart_ticket__';
export const SMART_GROUP_BRANCH = '__smart_branch__';
export const SMART_GROUP_FORK = '__smart_fork__';

// Two characters, so the single-':' tag-occurrence parser never splits a smart-group id.
export const SMART_BUCKET_SEPARATOR = '::';

// Exported so id minting can assert it never produces a smart-group sentinel.
export const SMART_GROUP_IDS: readonly string[] = [
  SMART_GROUP_PR,
  SMART_GROUP_TICKET,
  SMART_GROUP_BRANCH,
  SMART_GROUP_FORK,
];

export interface SmartGroupNode {
  id: string;
  label: string;
  // False for the best-effort signals (ticket, branch, fork lineage), which may render empty.
  solid: boolean;
  buckets: SmartBucket[];
}

// Every group is always present, even with zero buckets, so an empty group renders as a childless row.
export interface SmartGroupsTree {
  groups: SmartGroupNode[];
}

// An empty input yields four empty groups.
export function computeSmartGroups(rows: SmartSignalsInput[]): SmartGroupsTree {
  return {
    groups: [
      {
        id: SMART_GROUP_PR,
        label: 'By Pull Request',
        solid: true,
        buckets: prBuckets(rows),
      },
      {
        id: SMART_GROUP_TICKET,
        label: 'By Ticket Prefix',
        solid: false,
        buckets: ticketBuckets(rows),
      },
      {
        id: SMART_GROUP_BRANCH,
        label: 'By Git Branch',
        solid: false,
        buckets: branchBuckets(rows),
      },
      {
        id: SMART_GROUP_FORK,
        label: 'By Fork Lineage',
        solid: false,
        buckets: forkLineageBuckets(rows),
      },
    ],
  };
}

// The tree-wide unique TreeItem id for a bucket row.
export function smartBucketNodeId(groupId: string, bucketKey: string): string {
  return groupId + SMART_BUCKET_SEPARATOR + bucketKey;
}

export function isSmartGroupId(id: string): boolean {
  return SMART_GROUP_IDS.includes(id);
}
