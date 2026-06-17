// smartGroupEngine: the PURE composition of the four read-only smart-group
// signals into the tree the Smart Groups view renders. It recomputes the buckets
// from the current SmartSignalsInput rows on every call (the view calls it on
// refresh); it NEVER mutates the store and NEVER auto-files a chat. Promotion to a
// folder/tag is an explicit, separate user command (promoteSmartGroup.ts).
//
// This module is PURE and vscode-free (unit-gate rule): no vscode import, no fs.
// It only orchestrates the four pure signal functions; the view turns the result
// into TreeItems and memoizes node objects.
//
// Group/bucket id grammar (ARCHITECTURE.md "Separator-namespace discipline" +
// "synthetic group rows keyed by separator-free reserved sentinels distinct from
// __unfiled__/__untagged__"): a signal-group row id is a reserved sentinel
// '__smart_<signal>__' (separator-free, no ':' '#' '>'); a bucket row id is
// '<groupId>::<bucketKey>' using '::' which contains none of the three reserved
// composite-id separators, so it can never be confused with a folder member id
// (`#`), a tag occurrence id (`:` single), or a linked-child id (`>`). The bucket
// key itself is signal-defined (a url, a ticket id, a branch, a uuid-prefix) and
// is treated as opaque; the view stores the bucket's memberChatIds directly
// rather than re-parsing the id.

import { SmartSignalsInput } from '../model/types';
import { SmartBucket } from './signals/bucket';
import { prBuckets } from './signals/pr';
import { ticketBuckets } from './signals/ticket';
import { branchBuckets } from './signals/branch';
import { forkLineageBuckets } from './signals/forkLineage';

// The four signal ids. Each is a separator-free reserved sentinel, distinct from
// '__unfiled__' (Folders) and '__untagged__' (Tags), so a smart-group row can
// never collide with a folder/tag row id or a real minted id.
export const SMART_GROUP_PR = '__smart_pr__';
export const SMART_GROUP_TICKET = '__smart_ticket__';
export const SMART_GROUP_BRANCH = '__smart_branch__';
export const SMART_GROUP_FORK = '__smart_fork__';

// The bucket-id separator. '::' is composed only of ':' pairs, but as a TWO-char
// token it is reserved here for the smart-group namespace and the view never
// splits a smart-group id with the single-':' tag-occurrence parser. It is kept
// distinct from the three single-char composite separators by living only under a
// '__smart_*__' group prefix that the other views never mint.
export const SMART_BUCKET_SEPARATOR = '::';

// All smart-group sentinel ids, exported so the id-factory / view can assert a
// minted id never collides with one (defense in depth alongside RESERVED_SENTINELS).
export const SMART_GROUP_IDS: readonly string[] = [
  SMART_GROUP_PR,
  SMART_GROUP_TICKET,
  SMART_GROUP_BRANCH,
  SMART_GROUP_FORK,
];

// One signal group in the assembled tree: its sentinel id, a human label, the
// signal's reliability note (so the view can mark best-effort groups), and the
// ordered buckets the signal produced (possibly empty).
export interface SmartGroupNode {
  id: string;
  label: string;
  // True for the solid PR signal; false for the three best-effort signals
  // (ticket, branch, fork-lineage) that may legitimately render empty.
  solid: boolean;
  buckets: SmartBucket[];
}

// The assembled smart-groups tree: the four signal groups in a fixed order (PR
// first as the solid signal, then the best-effort signals). Every group is always
// present even when it has zero buckets, so an empty best-effort group renders as
// an empty (childless) group row rather than vanishing.
export interface SmartGroupsTree {
  groups: SmartGroupNode[];
}

// Recompute the whole smart-groups tree from the current signal rows. Pure and
// total: an empty input yields four empty groups; no signal throws. Called on
// every view refresh (recomputed-on-refresh, never cached as authoritative).
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

// Build the tree-wide-unique id for a bucket row under a signal group:
// '<groupId>::<bucketKey>'. Used by the view as the TreeItem.id and by the prune
// to track live ids.
export function smartBucketNodeId(groupId: string, bucketKey: string): string {
  return groupId + SMART_BUCKET_SEPARATOR + bucketKey;
}

// True when an id names one of the four signal-group sentinels.
export function isSmartGroupId(id: string): boolean {
  return SMART_GROUP_IDS.includes(id);
}
