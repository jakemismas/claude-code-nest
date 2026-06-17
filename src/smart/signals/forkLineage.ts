// Fork-lineage signal (best-effort, OFTEN EMPTY): group transcripts that share a
// leading message-UUID prefix. When a session is forked/branched in Claude Code,
// the fork replays the parent's opening turns, so the two transcripts share the
// SAME leading sequence of message uuids before diverging. Grouping by the
// longest shared leading uuid prefix surfaces those fork families.
//
// In this user's real data no two transcripts shared a leading message-UUID
// sequence in the sample (ARCHITECTURE.md "no two transcripts shared a leading
// message-UUID prefix"), so this signal is expected to produce zero buckets and
// MUST render empty cleanly. It is built best-effort against the captured leading
// uuid sequences.
//
// This module is PURE and vscode-free (unit-gate rule): no vscode import, no fs.

import { SmartSignalsInput } from '../../model/types';
import { SmartBucket, sortMembersInput } from './bucket';

// The minimum shared leading-uuid prefix length for two transcripts to count as a
// fork family. A single shared uuid (length 1) is the trivial/noise case (two
// unrelated sessions could coincidentally open against the same first turn id);
// requiring at least 2 shared leading uuids keeps the signal to genuine forks
// while staying lenient enough to catch a short replay.
export const MIN_SHARED_PREFIX = 2;

// Group chats into fork families by their longest shared leading uuid prefix. The
// algorithm:
//   1. Drop chats whose leading uuid sequence is shorter than MIN_SHARED_PREFIX
//      (they cannot anchor a fork family).
//   2. Union chats that share a leading prefix of at least MIN_SHARED_PREFIX
//      uuids, transitively (A shares with B, B shares with C => one family),
//      using a disjoint-set union over a prefix-key index.
//   3. Keep only families with TWO OR MORE members (a lone chat is not a fork).
//
// The family KEY is the shared leading prefix joined by '|' (a uuid never
// contains '|'); the LABEL is a short, human-facing "Fork lineage <first-uuid
// short>" so the row is readable without exposing the full uuid chain. The label
// is STABLE (count-free) because promote-to-folder/tag uses it verbatim as the
// target name and relies on idempotency-on-name to reuse rather than mint a
// duplicate (promoteSmartGroup.ts): embedding the live member count would change
// the label as a family grows and break that reuse. Buckets sort by key; members
// sort by the shared deterministic order.
export function forkLineageBuckets(rows: SmartSignalsInput[]): SmartBucket[] {
  const eligible = rows.filter(
    (r) => r.leadingMessageUuids.length >= MIN_SHARED_PREFIX,
  );

  // Disjoint-set union keyed by sessionId. Two chats are unioned when they share
  // a leading prefix of at least MIN_SHARED_PREFIX uuids. Rather than compare
  // every pair (O(n^2) on the prefix), index each chat under the prefix key of
  // each of its leading positions >= MIN_SHARED_PREFIX, and union all chats that
  // landed under the same key. This unions any two chats that agree on a leading
  // prefix of that length (their first k uuids are identical).
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

  // prefix-key (the first k uuids joined) -> the chats whose leading prefix of
  // length k equals it. Only k == MIN_SHARED_PREFIX is needed to seed the union:
  // any two chats sharing a longer prefix necessarily share the length-k prefix
  // too, so they are unioned at k and transitively merged. Using exactly the
  // minimum length keeps the index small and the union total.
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

  // Collect families by root, then keep only multi-member families (a fork needs
  // at least two transcripts).
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
    // The family's shared leading prefix is the longest common leading uuid
    // sequence across its members; the key uses MIN_SHARED_PREFIX uuids (the
    // guaranteed-shared length), and the label derives from the first uuid.
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

// The longest common LEADING prefix across a set of uuid sequences. Returns the
// shared head; empty when there is no shared first element. Total.
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

// A short, human-facing label for a fork-lineage family: the first shared uuid's
// leading 8 chars, e.g. "Fork lineage 0f16803a". STABLE by design (no member
// count) so the promote path can reuse the existing folder/tag by name as the
// family grows instead of minting a duplicate; see the module header.
function forkLabel(sharedPrefix: string[]): string {
  const head = sharedPrefix.length > 0 ? sharedPrefix[0].slice(0, 8) : '(none)';
  return 'Fork lineage ' + head;
}
