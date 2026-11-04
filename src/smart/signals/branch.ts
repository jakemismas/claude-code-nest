// Branch signal (best-effort): groups chats by the gitBranch on their user/assistant lines.
// Most transcripts report "HEAD", so that bucket is suppressed; a chat with no branch or only
// "HEAD" joins no bucket. Pure, with no vscode or fs dependency.

import { SmartSignalsInput } from '../../model/types';
import { SmartBucket, sortMembersInput } from './bucket';

// Not a meaningful grouping key: sessions without a named branch all report it.
const NON_GROUPING_BRANCH = 'HEAD';

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

// Buckets sort by branch name. The result is often empty, and the view renders that cleanly.
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
