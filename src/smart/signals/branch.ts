// Branch signal (best-effort): group chats by the gitBranch carried on their
// user/assistant lines. In this user's real data the branch is almost always
// "HEAD" (ARCHITECTURE.md "gitBranch is almost always HEAD"), so this signal
// typically yields a single large "HEAD" bucket and is of limited value; it is
// built best-effort and the noisy "HEAD" bucket is deliberately SUPPRESSED so the
// section is not dominated by a meaningless group. A chat with no branch, or only
// the "HEAD" branch, joins no bucket.
//
// This module is PURE and vscode-free (unit-gate rule): no vscode import, no fs.

import { SmartSignalsInput } from '../../model/types';
import { SmartBucket, sortMembersInput } from './bucket';

// The detached-HEAD sentinel branch value. It is not a meaningful grouping key
// (every transcript in a non-branch session reports it), so a chat whose only
// branch signal is "HEAD" is treated as having no usable branch.
const NON_GROUPING_BRANCH = 'HEAD';

// The usable branch grouping key for a chat, or null when the chat has no
// meaningful branch (absent, empty, or the non-grouping "HEAD" sentinel).
export function branchKey(row: SmartSignalsInput): string | null {
  const branch = row.gitBranch;
  if (branch === null || branch.length === 0) {
    return null;
  }
  if (branch === NON_GROUPING_BRANCH) {
    return null;
  }
  return branch;
}

// Group chats by their git branch, suppressing the non-grouping "HEAD" bucket and
// chats with no branch. Buckets sort by branch name; members sort by the shared
// deterministic order. Typically empty on this data, which must render cleanly.
export function branchBuckets(rows: SmartSignalsInput[]): SmartBucket[] {
  const byKey = new Map<string, SmartSignalsInput[]>();
  for (const row of rows) {
    const key = branchKey(row);
    if (key === null) {
      continue;
    }
    const list = byKey.get(key);
    if (list === undefined) {
      byKey.set(key, [row]);
    } else {
      list.push(row);
    }
  }

  const buckets: SmartBucket[] = [];
  for (const [key, members] of byKey) {
    buckets.push({
      key,
      label: key,
      memberChatIds: sortMembersInput(members).map((m) => m.sessionId),
    });
  }
  return buckets.sort((a, b) => a.label.localeCompare(b.label));
}
