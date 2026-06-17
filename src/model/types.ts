// Shared domain types for Claude Code Nest. These are pure data shapes with no
// dependency on the vscode module so they can be imported from both the
// extension host and the headless unit suite.

// One Claude Code chat transcript. sessionId equals the .jsonl filename with the
// extension stripped (verified ground truth: filename equals sessionId). title
// is resolved by the jsonlReader per the documented order; timestamp is the most
// recent user-or-assistant line timestamp in the transcript, as an epoch
// millisecond value, or null when no timestamped line was found.
export interface ChatRecord {
  sessionId: string;
  title: string;
  timestamp: number | null;
  filePath: string;
  // Slice 6 smart-group signals, carried on the ONE shared record so the smart
  // groups view can build a SmartSignalsInput without a second scan. These are
  // read-only, best-effort (except PR, which is solid), and null/empty when the
  // transcript carried no such signal.
  prNumber: number | null;
  prUrl: string | null;
  prRepository: string | null;
  gitBranch: string | null;
  leadingMessageUuids: string[];
}

// The intermediate result of scanning a single transcript file by line type.
// timestamp is epoch milliseconds (the latest user/assistant timestamp seen),
// or null when none was present. firstUserText is the truncated text of the
// first user message, used as the last-resort title fallback.
//
// Slice 6 (smart groups) adds the read-only signal fields, absorbed by the ONE
// existing reader rather than a second scanner:
//   prNumber/prUrl/prRepository  - from a type "pr-link" line (the clean signal)
//   gitBranch                     - from a user/assistant line (usually "HEAD")
//   leadingMessageUuids           - the leading sequence of user/assistant uuids
//                                   in transcript order, for the fork-lineage
//                                   shared-prefix signal
// All are null/empty when absent; a transcript with none of them simply
// contributes to no smart-group bucket (best-effort signals render empty).
export interface TranscriptScan {
  customTitle: string | null;
  aiTitle: string | null;
  slug: string | null;
  firstUserText: string | null;
  timestamp: number | null;
  // PR signal (solid): the pull-request number, url, and "owner/repo" from a
  // type "pr-link" line. null when the transcript has no pr-link.
  prNumber: number | null;
  prUrl: string | null;
  prRepository: string | null;
  // Branch signal (best-effort): the gitBranch carried on a user/assistant line.
  // Almost always "HEAD" in this data; null when no line carried one. The first
  // non-empty value wins (a session's branch rarely changes mid-transcript).
  gitBranch: string | null;
  // Fork-lineage signal (best-effort, often empty): the LEADING sequence of
  // user/assistant message uuids in transcript order. Two transcripts share a
  // fork lineage when their leading uuid sequences share a common prefix. Capped
  // so a long transcript does not retain every uuid; the leading run is what the
  // shared-prefix comparison needs.
  leadingMessageUuids: string[];
}

// The subset of signals the smart-group engine consumes for ONE chat, paired
// with the chat's sessionId. Built by the view layer from a ChatRecord plus its
// TranscriptScan; kept vscode-free so the engine and its tests stay headless.
export interface SmartSignalsInput {
  sessionId: string;
  prNumber: number | null;
  prUrl: string | null;
  prRepository: string | null;
  gitBranch: string | null;
  leadingMessageUuids: string[];
  // The resolved title, used only to derive a ticket-prefix best-effort signal.
  title: string;
}
