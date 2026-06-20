import { TokenTotals, TranscriptScan } from '../model/types';

// Tolerant, line-type-driven reader for a Claude Code transcript. The transcript
// is JSONL: one JSON object per line, each carrying a "type". Titles and
// timestamps are NOT top-level keys on arbitrary lines; they ride on dedicated
// line types (verified ground truth):
//   type "custom-title"  -> customTitle
//   type "ai-title"      -> aiTitle
//   type "pr-link"       -> prNumber, prUrl, prRepository  (slice 6)
//   type "user"/"assistant" -> timestamp, cwd, slug, message, gitBranch, uuid
// Unrelated types (queue-operation, hook_success, attachment,
// deferred_tools_delta, last-prompt, file-history-snapshot, system, ...) are
// tolerated and contribute nothing. A line that fails to parse is skipped, never
// thrown. This module never touches the filesystem; it operates on already-read
// text so the scanner owns the read-only contract.
//
// Slice 6 extends THIS one reader (not a second scanner) with the smart-group
// signal fields: the pr-link PR data, the user/assistant gitBranch, and the
// leading sequence of user/assistant message uuids for fork-lineage. The
// skip-unknown-types tolerance is preserved.

const MAX_TITLE_LENGTH = 80;

// Cap on the number of leading message uuids retained for the fork-lineage
// shared-prefix signal. A shared FORK is detectable from a short leading run;
// retaining the whole transcript's uuids would bloat the scan for no signal
// gain. The cap is generous enough that a genuine shared prefix (a forked
// session replays the parent's opening turns) is still observed.
const MAX_LEADING_UUIDS = 16;

// Cap on the number of distinct files-touched paths retained (Sprint 2 tier-A),
// matching MAX_LEADING_UUIDS' rationale: a chat that edits hundreds of files
// needs only a bounded, representative set for the files-touched count and
// preview. Distinct paths are retained in first-seen order up to the cap; later
// distinct paths are dropped.
const MAX_FILES_TOUCHED = 64;

// Truncation cap for the last-message snippet. Keeps the scan a bounded
// reduction (the full body is never retained); the snippet is enough for the
// awaiting-reply heuristic and the hover/preview surfaces of later slices.
const MAX_LAST_MESSAGE_LENGTH = 200;

// Title resolution order, applied after a scan:
//   1. customTitle  2. aiTitle  3. slug  4. truncated first user-message text
// Returns a non-empty string, or null when the transcript yields no usable
// title (the scanner then falls back to the sessionId).
export function resolveTitle(scan: TranscriptScan): string | null {
  if (isNonEmpty(scan.customTitle)) {
    return scan.customTitle as string;
  }
  if (isNonEmpty(scan.aiTitle)) {
    return scan.aiTitle as string;
  }
  if (isNonEmpty(scan.slug)) {
    return scan.slug as string;
  }
  if (isNonEmpty(scan.firstUserText)) {
    return truncate(scan.firstUserText as string, MAX_TITLE_LENGTH);
  }
  return null;
}

// Scan raw JSONL text into a TranscriptScan. The latest user/assistant timestamp
// wins (transcripts are roughly chronological, but we do not assume ordering).
// The first user-message text encountered is captured for the title fallback.
export function scanTranscript(content: string): TranscriptScan {
  const scan: TranscriptScan = {
    customTitle: null,
    aiTitle: null,
    slug: null,
    firstUserText: null,
    timestamp: null,
    prNumber: null,
    prUrl: null,
    prRepository: null,
    gitBranch: null,
    leadingMessageUuids: [],
    messageCount: 0,
    firstMessageText: null,
    firstMessageRole: null,
    lastMessageText: null,
    lastMessageRole: null,
    tokenTotals: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    filesTouched: [],
    models: [],
  };

  // A single logical assistant turn is emitted as MULTIPLE assistant JSONL lines
  // that share one message.id (thinking / text / tool_use split across lines),
  // and the IDENTICAL message.usage block is repeated verbatim on each of those
  // lines (verified ground truth across real transcripts). Summing usage per line
  // therefore over-counts a turn 3-5x. This set tracks message.ids already
  // counted so each turn's usage is summed exactly once (first sighting wins). An
  // assistant line with no message.id cannot be deduped, so it is always counted.
  const seenUsageMessageIds = new Set<string>();

  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      // Malformed line: tolerate and skip.
      continue;
    }
    if (!isRecord(obj)) {
      continue;
    }
    const type = typeof obj.type === 'string' ? obj.type : '';

    switch (type) {
      case 'custom-title':
        if (scan.customTitle === null && typeof obj.customTitle === 'string') {
          scan.customTitle = obj.customTitle;
        }
        break;
      case 'ai-title':
        if (scan.aiTitle === null && typeof obj.aiTitle === 'string') {
          scan.aiTitle = obj.aiTitle;
        }
        break;
      case 'pr-link':
        absorbPrLink(scan, obj);
        break;
      case 'user':
      case 'assistant':
        absorbTimestamp(scan, obj);
        absorbSlug(scan, obj);
        absorbGitBranch(scan, obj);
        absorbLeadingUuid(scan, obj);
        absorbMessageCount(scan);
        absorbFirstMessage(scan, obj, type);
        absorbLastMessage(scan, obj, type);
        if (type === 'user') {
          absorbFirstUserText(scan, obj);
        }
        if (type === 'assistant') {
          // usage, model, and tool_use blocks ride assistant lines only
          // (verified ground truth), so the cost/model/files absorbers fire here.
          absorbUsage(scan, obj, seenUsageMessageIds);
          absorbModel(scan, obj);
          absorbFilesTouched(scan, obj);
        }
        break;
      default:
        // Slug can ride on other line types too; pick it up wherever it appears
        // without letting an unrelated type contribute a title or timestamp.
        absorbSlug(scan, obj);
        break;
    }
  }

  return scan;
}

// Absorb the PR signal from a type "pr-link" line. The FIRST pr-link wins (a
// transcript carries at most one in practice; first-wins is deterministic
// regardless). prNumber is a number, prUrl/prRepository are strings; each is
// taken only when well-typed so a malformed field leaves the others intact.
function absorbPrLink(scan: TranscriptScan, obj: Record<string, unknown>): void {
  if (scan.prNumber === null && typeof obj.prNumber === 'number') {
    scan.prNumber = obj.prNumber;
  }
  if (scan.prUrl === null && typeof obj.prUrl === 'string' && obj.prUrl.length > 0) {
    scan.prUrl = obj.prUrl;
  }
  if (
    scan.prRepository === null &&
    typeof obj.prRepository === 'string' &&
    obj.prRepository.length > 0
  ) {
    scan.prRepository = obj.prRepository;
  }
}

// Absorb the branch signal: the FIRST non-empty gitBranch on a user/assistant
// line. A session's branch is stable across its turns in this data (almost
// always "HEAD"), so first-wins is sufficient and avoids letting a late,
// transient value override the session's branch.
function absorbGitBranch(scan: TranscriptScan, obj: Record<string, unknown>): void {
  if (scan.gitBranch === null && typeof obj.gitBranch === 'string' && obj.gitBranch.length > 0) {
    scan.gitBranch = obj.gitBranch;
  }
}

// Absorb the leading message uuid sequence (in transcript order) for the
// fork-lineage shared-prefix signal, capped at MAX_LEADING_UUIDS. Only the
// LEADING run is retained: once the cap is hit, later uuids are ignored. The
// uuid must be a non-empty string; a line without one does not break the run
// (it simply contributes nothing), which keeps the captured sequence the ordered
// list of present uuids rather than a sparse array.
function absorbLeadingUuid(scan: TranscriptScan, obj: Record<string, unknown>): void {
  if (scan.leadingMessageUuids.length >= MAX_LEADING_UUIDS) {
    return;
  }
  if (typeof obj.uuid === 'string' && obj.uuid.length > 0) {
    scan.leadingMessageUuids.push(obj.uuid);
  }
}

// Count one user/assistant line. Tier-A messageCount is the number of
// user/assistant turns, not raw JSONL lines (unrelated types do not count).
function absorbMessageCount(scan: TranscriptScan): void {
  scan.messageCount++;
}

// Absorb the FIRST genuine user/assistant turn's snippet. Mirrors
// absorbLastMessage's genuineness rule: a tool_result-only user line is harness
// feedback inside an assistant loop, not a human turn, so it does not seed the
// first snippet.
//
// Role and text are COUPLED so the snippet never attributes one speaker's prose
// to another. The text-bearing turn is authoritative: when prose first arrives,
// firstMessageRole is (re)set to THAT turn's role together with firstMessageText,
// and both freeze. A textless genuine opener (a pure tool_use turn) only records
// its role as a FALLBACK so a transcript with no extractable prose still reports
// who spoke first; a later prose turn of a different role overwrites that
// fallback role along with the text it carries. Once firstMessageText is set,
// nothing overwrites either field. Powers the preview card's "First:" line
// alongside lastMessageText's "Last:".
function absorbFirstMessage(
  scan: TranscriptScan,
  obj: Record<string, unknown>,
  role: 'user' | 'assistant',
): void {
  if (role === 'user' && isToolResultFeedback((obj as { message?: unknown }).message)) {
    return;
  }
  if (scan.firstMessageText !== null) {
    return;
  }
  const text = extractMessageText((obj as { message?: unknown }).message);
  if (isNonEmpty(text)) {
    // Prose turn: it owns both fields. Overwrites any fallback role left by a
    // textless opener so role and text always describe the same speaker.
    scan.firstMessageRole = role;
    scan.firstMessageText = truncate((text as string).trim(), MAX_LAST_MESSAGE_LENGTH);
    return;
  }
  // Textless genuine opener: record the role only as a fallback (first such turn
  // wins) until a prose turn supplies the authoritative role+text.
  if (scan.firstMessageRole === null) {
    scan.firstMessageRole = role;
  }
}

// Absorb the LAST user/assistant turn's text and role (LAST-wins, overwritten
// on each qualifying turn). Reuses the existing extractMessageText, so the SAME
// message shapes the title fallback understands (string body, {content:string},
// {content:[{type:'text',text}]}) feed the snippet.
//
// Role semantics serve the slice-6 awaiting-reply ("Questions") heuristic, which
// reads lastMessageRole === 'user' as "a human spoke last and awaits a reply".
// The harness records tool outputs as type:'user' lines whose content is a
// tool_result block (the DOMINANT real user-line shape: ~13 of 16 on real
// transcripts). Those are machine-fed feedback inside an assistant tool loop, NOT
// a human turn, so they must NOT advance the role to 'user' or the heuristic
// misfires on the majority of chats. An assistant turn is always a real assistant
// action (even a pure tool_use turn), so it always advances the role to
// 'assistant'. A textless turn leaves the prior snippet text intact.
function absorbLastMessage(
  scan: TranscriptScan,
  obj: Record<string, unknown>,
  role: 'user' | 'assistant',
): void {
  if (role === 'user' && isToolResultFeedback((obj as { message?: unknown }).message)) {
    // A tool_result-only user line is harness feedback, not a human turn: it
    // neither advances the role nor overwrites the snippet.
    return;
  }
  scan.lastMessageRole = role;
  const text = extractMessageText((obj as { message?: unknown }).message);
  if (isNonEmpty(text)) {
    scan.lastMessageText = truncate((text as string).trim(), MAX_LAST_MESSAGE_LENGTH);
  }
}

// True when a user message is purely tool_result feedback: its content is an
// array of one or more blocks, ALL of which are tool_result. Such a line is the
// harness feeding a tool output back into an assistant loop, not a human prose
// turn. A string body, a {content:string}, or any array containing a text/string
// block is a genuine human turn and returns false.
function isToolResultFeedback(message: unknown): boolean {
  if (!isRecord(message)) {
    return false;
  }
  const content = message.content;
  if (!Array.isArray(content) || content.length === 0) {
    return false;
  }
  return content.every((block) => isRecord(block) && block.type === 'tool_result');
}

// Sum the message.usage token counts onto the running totals, ONCE per logical
// assistant turn. A turn spans multiple JSONL lines that share one message.id and
// repeat the identical usage block verbatim; counting per line over-counts 3-5x
// (verified ground truth), so usage is summed only on the FIRST line bearing a
// given message.id. Lines without a string message.id cannot be deduped and are
// always counted. Tolerant of a missing usage block, a non-object usage, and
// individually-missing or non-numeric fields (each absent/garbage field
// contributes 0). The many other usage keys Claude writes are ignored; only the
// four trusted counts are summed.
function absorbUsage(
  scan: TranscriptScan,
  obj: Record<string, unknown>,
  seenUsageMessageIds: Set<string>,
): void {
  const message = (obj as { message?: unknown }).message;
  if (!isRecord(message)) {
    return;
  }
  const usage = message.usage;
  if (!isRecord(usage)) {
    return;
  }
  const id = message.id;
  if (typeof id === 'string' && id.length > 0) {
    if (seenUsageMessageIds.has(id)) {
      return;
    }
    seenUsageMessageIds.add(id);
  }
  addUsageField(scan.tokenTotals, 'input', usage.input_tokens);
  addUsageField(scan.tokenTotals, 'output', usage.output_tokens);
  addUsageField(scan.tokenTotals, 'cacheCreation', usage.cache_creation_input_tokens);
  addUsageField(scan.tokenTotals, 'cacheRead', usage.cache_read_input_tokens);
}

function addUsageField(totals: TokenTotals, key: keyof TokenTotals, value: unknown): void {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    totals[key] += value;
  }
}

// Absorb the distinct message.model into the models list (first-seen order, no
// duplicates). Almost always one model per transcript, but a session can switch
// models, so distinct values are retained.
function absorbModel(scan: TranscriptScan, obj: Record<string, unknown>): void {
  const message = (obj as { message?: unknown }).message;
  if (!isRecord(message)) {
    return;
  }
  const model = message.model;
  if (typeof model === 'string' && model.length > 0 && !scan.models.includes(model)) {
    scan.models.push(model);
  }
}

// Absorb the distinct file_path values from tool_use blocks in message.content,
// deduped and capped at MAX_FILES_TOUCHED. file_path appears on Read, Edit, and
// Write tool_use blocks (verified ground truth), so this is "files referenced"
// (including read-only Reads), not strictly "files edited"; that matches the
// plan's literal spec. Once the cap is hit, later distinct paths are dropped.
function absorbFilesTouched(scan: TranscriptScan, obj: Record<string, unknown>): void {
  const message = (obj as { message?: unknown }).message;
  if (!isRecord(message)) {
    return;
  }
  const content = message.content;
  if (!Array.isArray(content)) {
    return;
  }
  for (const block of content) {
    if (scan.filesTouched.length >= MAX_FILES_TOUCHED) {
      return;
    }
    if (!isRecord(block) || block.type !== 'tool_use') {
      continue;
    }
    const input = block.input;
    if (!isRecord(input)) {
      continue;
    }
    const filePath = input.file_path;
    if (typeof filePath === 'string' && filePath.length > 0 && !scan.filesTouched.includes(filePath)) {
      scan.filesTouched.push(filePath);
    }
  }
}

function absorbTimestamp(scan: TranscriptScan, obj: Record<string, unknown>): void {
  if (typeof obj.timestamp !== 'string') {
    return;
  }
  const parsed = Date.parse(obj.timestamp);
  if (Number.isNaN(parsed)) {
    return;
  }
  if (scan.timestamp === null || parsed > scan.timestamp) {
    scan.timestamp = parsed;
  }
}

function absorbSlug(scan: TranscriptScan, obj: Record<string, unknown>): void {
  if (scan.slug === null && typeof obj.slug === 'string' && obj.slug.length > 0) {
    scan.slug = obj.slug;
  }
}

function absorbFirstUserText(scan: TranscriptScan, obj: Record<string, unknown>): void {
  if (scan.firstUserText !== null) {
    return;
  }
  const text = extractMessageText(obj.message);
  if (isNonEmpty(text)) {
    scan.firstUserText = (text as string).trim();
  }
}

// A Claude message can be a string, or { content: string }, or
// { content: Array<{ type, text }> }. Extract the first text content. Exported so
// the on-demand body reader (src/claude/bodyReader.ts) shares the SAME message
// shape understanding the title/snippet absorbers use, keeping one parser for the
// message-body grammar rather than a divergent second one.
export function extractMessageText(message: unknown): string | null {
  if (typeof message === 'string') {
    return message;
  }
  if (!isRecord(message)) {
    return null;
  }
  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
        return block.text;
      }
      if (typeof block === 'string') {
        return block;
      }
    }
  }
  return null;
}

function truncate(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return trimmed.slice(0, max - 3).trimEnd() + '...';
}

function isNonEmpty(value: string | null): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
