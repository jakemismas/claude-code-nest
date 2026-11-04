// Shared domain data shapes. No vscode dependency, so the extension host and the
// headless unit suite can both import them.

// Token usage summed once per assistant turn, deduped by message.id: one turn spans
// several JSONL lines that repeat the same usage block, so a per-line sum over-counts 3-5x.
export interface TokenTotals {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

// One Claude Code chat transcript. sessionId is the .jsonl filename without the
// extension; timestamp is the latest user or assistant line time in epoch ms, or null.
export interface ChatRecord {
  sessionId: string;
  title: string;
  timestamp: number | null;
  filePath: string;
  // Carried on the shared record so the smart groups view needs no second scan.
  prNumber: number | null;
  prUrl: string | null;
  prRepository: string | null;
  gitBranch: string | null;
  // Working directory recorded in the transcript; absent or null when none was recorded.
  cwd?: string | null;
  leadingMessageUuids: string[];
  // Compact summary on the shared record so token badge, hover preview, search and
  // the awaiting-reply check read it without re-parsing the transcript. Defaults to
  // 0, null or [].
  messageCount: number;
  firstMessageText: string | null;
  firstMessageRole: 'user' | 'assistant' | null;
  lastMessageText: string | null;
  lastMessageRole: 'user' | 'assistant' | null;
  tokenTotals: TokenTotals;
  filesTouched: string[];
  models: string[];
}

// Intermediate result of scanning one transcript file by line type. firstUserText is
// the last-resort title fallback. Signal fields stay null or empty when absent.
export interface TranscriptScan {
  customTitle: string | null;
  aiTitle: string | null;
  slug: string | null;
  firstUserText: string | null;
  timestamp: number | null;
  // From a type "pr-link" line; null when the transcript has none.
  prNumber: number | null;
  prUrl: string | null;
  prRepository: string | null;
  // From a user or assistant line, usually "HEAD". The first non-empty value wins.
  gitBranch: string | null;
  // First non-empty cwd on a user or assistant line.
  cwd?: string | null;
  // Leading user and assistant uuids in order; transcripts sharing a prefix share a fork
  // lineage. Capped because only the leading run is compared.
  leadingMessageUuids: string[];
  // Bounded reductions; full message bodies are never retained.
  // First and last message fields skip tool_result-only user lines: those are tool
  // feedback, not human turns, so the preview and the awaiting-reply check reflect
  // human intent. tokenTotals is deduped by message.id; filesTouched is deduped and capped.
  messageCount: number;
  firstMessageText: string | null;
  firstMessageRole: 'user' | 'assistant' | null;
  lastMessageText: string | null;
  lastMessageRole: 'user' | 'assistant' | null;
  tokenTotals: TokenTotals;
  filesTouched: string[];
  models: string[];
}

// The signals the smart-group engine consumes for one chat.
export interface SmartSignalsInput {
  sessionId: string;
  prNumber: number | null;
  prUrl: string | null;
  prRepository: string | null;
  gitBranch: string | null;
  leadingMessageUuids: string[];
  // Only used to derive a ticket-prefix signal.
  title: string;
}
