// Fork-lineage signal (best-effort, often empty): groups transcripts that share a leading
// message-uuid prefix. A forked session replays the parent's opening turns, so fork families
// share their first uuids before diverging. Pure, with no vscode or fs dependency.

import { SmartSignalsInput } from '../../model/types';
import { SmartBucket, sortMembersInput } from './bucket';

// A single shared uuid can occur by coincidence between unrelated sessions, so require two.
export const MIN_SHARED_PREFIX = 2;

// Chats that share a leading prefix of at least MIN_SHARED_PREFIX uuids are unioned
// transitively (A with B, B with C gives one family); a family needs two or more members.
// The key is the shared prefix joined by '|'. The label carries no member count because
// promoting a group reuses its folder or tag by name, and a changing label would mint duplicates.
export function forkLineageBuckets(rows: SmartSignalsInput[]): SmartBucket[] {
  const eligible = rows.filter(
    (r) => r.leadingMessageUuids.length >= MIN_SHARED_PREFIX,
  );

  // Disjoint-set union keyed by sessionId.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) {
      root = parent.get(root) as string;
    }
    // Path-compress.
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur) as string;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      parent.set(ra, rb);
    }
  };

  for (const row of eligible) {
    parent.set(row.sessionId, row.sessionId);
  }

  // Indexing by the minimum-length prefix is enough: chats sharing a longer prefix share this one too.
  const byPrefix = new Map<string, string[]>();
  for (const row of eligible) {
    const prefix = row.leadingMessageUuids.slice(0, MIN_SHARED_PREFIX).join('|');
    const list = byPrefix.get(prefix);
    if (list === undefined) {
      byPrefix.set(prefix, [row.sessionId]);
    } else {
      list.push(row.sessionId);
    }
  }
  for (const members of byPrefix.values()) {
    for (let i = 1; i < members.length; i++) {
      union(members[0], members[i]);
    }
  }

  const familyByRoot = new Map<string, SmartSignalsInput[]>();
  const rowBySession = new Map<string, SmartSignalsInput>(
    eligible.map((r) => [r.sessionId, r]),
  );
  for (const sessionId of parent.keys()) {
    const root = find(sessionId);
    const row = rowBySession.get(sessionId);
    if (row === undefined) {
      continue;
    }
    const list = familyByRoot.get(root);
    if (list === undefined) {
      familyByRoot.set(root, [row]);
    } else {
      list.push(row);
    }
  }

  const buckets: SmartBucket[] = [];
  for (const members of familyByRoot.values()) {
    if (members.length < 2) {
      continue;
    }
    // The key uses only the guaranteed-shared MIN_SHARED_PREFIX uuids.
    const sorted = sortMembersInput(members);
    const sharedPrefix = longestCommonLeadingPrefix(
      members.map((m) => m.leadingMessageUuids),
    );
    const key = sharedPrefix.slice(0, MIN_SHARED_PREFIX).join('|');
    buckets.push({
      key,
      label: forkLabel(sharedPrefix),
      memberChatIds: sorted.map((m) => m.sessionId),
    });
  }
  return buckets.sort((a, b) => a.key.localeCompare(b.key));
}

export function longestCommonLeadingPrefix(sequences: string[][]): string[] {
  if (sequences.length === 0) {
    return [];
  }
  const first = sequences[0];
  const result: string[] = [];
  for (let i = 0; i < first.length; i++) {
    const candidate = first[i];
    let allMatch = true;
    for (const seq of sequences) {
      if (i >= seq.length || seq[i] !== candidate) {
        allMatch = false;
        break;
      }
    }
    if (!allMatch) {
      break;
    }
    result.push(candidate);
  }
  return result;
}

// The first shared uuid's first 8 characters, e.g. "Fork lineage 0f16803a".
function forkLabel(sharedPrefix: string[]): string {
  const head = sharedPrefix.length > 0 ? sharedPrefix[0].slice(0, 8) : '(none)';
  return 'Fork lineage ' + head;
}
