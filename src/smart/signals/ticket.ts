// Ticket signal (best-effort): groups chats whose title begins with a ticket-style prefix
// (e.g. "ABC-123", "PROJ-7: do the thing"). Often empty. Pure, with no vscode or fs dependency.

import { SmartSignalsInput } from '../../model/types';
import { SmartBucket, sortMembersInput } from './bucket';

// 2 to 10 uppercase letters, a hyphen and digits, ending at a word boundary so "ABCDEFGHIJKL-1"
// and "ABC-12x" do not match. Anchored at the start because an id mid-title is not a reliable key.
const TICKET_PREFIX = /^([A-Z]{2,10}-\d+)(?=$|[\s:.,)\]}-])/;

export function ticketKey(title: string): string | null {
  const match = TICKET_PREFIX.exec(title.trim());
  if (match === null) {
    return null;
  }
  return match[1].toUpperCase();
}

// A chat without a ticket prefix joins no bucket. Buckets sort by key.
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
