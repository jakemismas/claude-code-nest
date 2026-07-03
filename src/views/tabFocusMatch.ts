// tabFocusMatch: the PURE, vscode-free matcher behind the "named-tab focus" read-
// state clear trigger (UI-SPEC.md "Read state"; slice s3a-row-anatomy). When a Claude
// Code chat tab gains focus, the host resolves WHICH chat it is by matching the tab's
// LABEL to a scanned chat title, then clears that chat's unread affordance.
//
// This is the identity-by-label heuristic V2-RESEARCH.md section 4 spike-verified as
// the only available handle: Claude's chat is a WebviewPanel (viewType
// claudeVSCodePanel) whose real session id is never exposed to any API, but the Tabs
// API surfaces the active tab's LABEL, which for a NAMED chat equals its title. Unnamed
// tabs all show "Claude Code" and duplicate titles collide, so this matcher only
// resolves a chat when EXACTLY ONE scanned record's title matches the label. An
// ambiguous or unnamed label yields null (the known accepted gap: reading an unnamed
// chat directly in Claude's UI does not clear it).
//
// Kept vscode-free so the match rule is unit-tested headlessly; the host listener that
// feature-detects window.tabGroups and reads the label is the thin vscode-bound part.

// The minimal record shape the matcher needs: a sessionId and its resolved title.
export interface TitledRecord {
  sessionId: string;
  title: string;
}

// Resolve a focused tab label to the unique scanned chat it names, or null. Matching
// is exact after trimming, case-sensitive on the visible title (titles are shown
// verbatim). Returns null when the label is empty, when NO record matches, or when
// MORE THAN ONE record matches (ambiguous: do not risk clearing the wrong chat).
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
        // A second match: the label is ambiguous, so refuse to resolve it.
        return null;
      }
      match = record.sessionId;
    }
  }
  return match;
}

// Whether a tab's viewType names Claude Code's chat webview. The public Tabs API
// reports the viewType prefixed as "mainThreadWebview-claudeVSCodePanel" while the
// bare id is "claudeVSCodePanel" (V2-RESEARCH.md section 4), so match by SUFFIX/
// substring rather than equality to tolerate the host's prefixing. Undocumented and
// best-effort: an Anthropic rename silently disables the trigger (low blast radius,
// UI-SPEC.md deviation 6).
const CLAUDE_CHAT_VIEWTYPE = 'claudeVSCodePanel';

export function isClaudeChatViewType(viewType: string | null | undefined): boolean {
  return typeof viewType === 'string' && viewType.indexOf(CLAUDE_CHAT_VIEWTYPE) !== -1;
}
