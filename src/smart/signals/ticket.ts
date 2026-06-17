// Ticket signal (best-effort): group chats whose resolved title begins with a
// ticket-style prefix (e.g. "ABC-123", "JIRA-42", "PROJ-7: do the thing"). This
// signal is essentially absent in this user's real data (ARCHITECTURE.md
// "Ticket-prefixed titles are essentially absent"), so it is expected to produce
// zero buckets and must render empty cleanly.
//
// This module is PURE and vscode-free (unit-gate rule): no vscode import, no fs.

import { SmartSignalsInput } from '../../model/types';
import { SmartBucket, sortMembersInput } from './bucket';

// A ticket prefix at the START of a title: 2-to-10 uppercase letters, a hyphen,
// and one-or-more digits, as a leading token. The token must be followed by a
// word boundary (end, whitespace, ':', or punctuation) so "ABCDEFGHIJKL-1" past
// the letter cap and "ABC-12x" mid-word do not match. Anchored at ^ so only a
// LEADING ticket is a signal (a ticket id buried mid-title is not a reliable
// grouping key).
const TICKET_PREFIX = /^([A-Z]{2,10}-\d+)(?=$|[\s:.,)\]}-])/;

// Extract the normalized ticket key from a title, or null when the title has no
// leading ticket prefix. The returned key is the matched "ABC-123" token,
// uppercased for a stable identity (the regex already requires uppercase letters,
// so this is a no-op guard that also documents the canonical form).
export function ticketKey(title: string): string | null {
  const match = TICKET_PREFIX.exec(title.trim());
  if (match === null) {
    return null;
  }
  return match[1].toUpperCase();
}

// Group chats by their leading ticket prefix. A chat whose title has no ticket
// prefix carries no ticket signal and joins no bucket. Buckets sort by key
// (ticket ids sort naturally); members sort by the shared deterministic order.
export function ticketBuckets(rows: SmartSignalsInput[]): SmartBucket[] {
  const byKey = new Map<string, SmartSignalsInput[]>();
  for (const row of rows) {
    const key = ticketKey(row.title);
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
