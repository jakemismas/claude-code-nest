// Shared shape and helpers for the smart-group signals. A SmartBucket is the
// PURE output of one signal: a stable key (the signal's identity for that
// bucket), a human-facing label, and the ordered member chat sessionIds. The
// engine wraps each bucket under its signal's group; the view renders them.
//
// This module is PURE and vscode-free (unit-gate rule): no vscode import, no fs.

import { SmartSignalsInput } from '../../model/types';

// One read-only smart-group bucket from a single signal. key is unique WITHIN a
// signal (the engine namespaces it by signal id for the tree). memberChatIds are
// the sessionIds of the chats in the bucket, pre-sorted by the signal.
export interface SmartBucket {
  key: string;
  label: string;
  memberChatIds: string[];
}

// Sort signal rows newest-first using a caller-supplied timestamp map, falling
// back to a stable sessionId tiebreak so the order is deterministic even when two
// chats share a timestamp or neither has one. The signals themselves do NOT carry
// timestamps (SmartSignalsInput is signal data only), so the SIGNAL sorts by
// sessionId for a stable, content-independent order; the VIEW re-sorts member
// rows by the real scan timestamp when it renders. Keeping the signal's own order
// deterministic (sessionId) makes the pure unit tests assertable without
// threading timestamps through every signal.
export function sortMembersInput(rows: SmartSignalsInput[]): SmartSignalsInput[] {
  return [...rows].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}
