// Shared bucket shape and member ordering for the smart-group signals. Pure, with no vscode or fs dependency.

import { SmartSignalsInput } from '../../model/types';

// key is unique within one signal; the engine namespaces it by signal id.
export interface SmartBucket {
  key: string;
  label: string;
  memberChatIds: string[];
}

// Sorts by sessionId because signal rows carry no timestamps; the view re-sorts members
// by scan time when it renders.
export function sortMembersInput(rows: SmartSignalsInput[]): SmartSignalsInput[] {
  return [...rows].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}
