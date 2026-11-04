// Pure matcher that resolves a focused Claude Code chat tab to a scanned chat by label,
// so the host can clear that chat's unread state. The tab's session id is not exposed by
// any API, so the label (equal to the title for a named chat) is the only handle.

// The minimal record shape the matcher needs: a sessionId and its resolved title.
export interface TitledRecord {
  sessionId: string;
  title: string;
}

// Resolve a tab label to the one chat whose trimmed title equals it exactly, else null.
// Unnamed tabs all share one label and duplicate titles collide, so an ambiguous label
// resolves to null rather than clearing the wrong chat.
export function matchTabLabelToChat(
  label: string | null | undefined,
  records: readonly TitledRecord[],
): string | null {
  if (typeof label !== 'string') {
    return null;
  }
  const target = label.trim();
  if (target.length === 0) {
    return null;
  }
  let match: string | null = null;
  for (const record of records) {
    if (typeof record.title === 'string' && record.title.trim() === target) {
      if (match !== null) {
        return null;
      }
      match = record.sessionId;
    }
  }
  return match;
}

// The Tabs API reports the viewType with a host prefix ("mainThreadWebview-claudeVSCodePanel"),
// so match by substring. Undocumented: a rename silently disables the trigger.
const CLAUDE_CHAT_VIEWTYPE = 'claudeVSCodePanel';

export function isClaudeChatViewType(viewType: string | null | undefined): boolean {
  return typeof viewType === 'string' && viewType.indexOf(CLAUDE_CHAT_VIEWTYPE) !== -1;
}
