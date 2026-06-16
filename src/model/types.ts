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
}

// The intermediate result of scanning a single transcript file by line type.
// timestamp is epoch milliseconds (the latest user/assistant timestamp seen),
// or null when none was present. firstUserText is the truncated text of the
// first user message, used as the last-resort title fallback.
export interface TranscriptScan {
  customTitle: string | null;
  aiTitle: string | null;
  slug: string | null;
  firstUserText: string | null;
  timestamp: number | null;
}
