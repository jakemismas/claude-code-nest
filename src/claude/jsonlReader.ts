import { TokenTotals, TranscriptScan } from '../model/types';

// Tolerant reader for a Claude Code JSONL transcript: one JSON object per line, driven by its "type".
// Titles and PR data ride on dedicated line types, not on every line:
//   "custom-title" -> customTitle, "ai-title" -> aiTitle, "pr-link" -> prNumber/prUrl/prRepository,
//   "user"/"assistant" -> timestamp, cwd, slug, message, gitBranch, uuid
// Unrelated types are ignored and unparsable lines are skipped. The module works on
// already-read text, so the scanner owns all file access.

const MAX_TITLE_LENGTH = 80;

// A forked session replays the parent's opening turns, so a short leading run is enough
// for the fork-lineage signal; keeping every uuid would bloat the scan.
const MAX_LEADING_UUIDS = 16;

// Bounds the scan for chats that touch hundreds of files; paths keep first-seen order.
const MAX_FILES_TOUCHED = 64;

// The scan never retains full bodies; this snippet length is enough for the awaiting-reply
// heuristic and the previews.
const MAX_LAST_MESSAGE_LENGTH = 200;

// Title order: customTitle, aiTitle, slug, truncated first user text. Null means the
// scanner falls back to the session id.
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

// The latest user/assistant timestamp wins because line order is not assumed.
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
    cwd: null,
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

  // One assistant turn spans several lines sharing a message.id, each repeating the same
  // usage block, so summing per line over-counts 3-5x. Track ids to count each turn once.
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
      // Skip a malformed line.
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
        absorbCwd(scan, obj);
        absorbLeadingUuid(scan, obj);
        absorbMessageCount(scan);
        absorbFirstMessage(scan, obj, type);
        absorbLastMessage(scan, obj, type);
        if (type === 'user') {
          absorbFirstUserText(scan, obj);
        }
        if (type === 'assistant') {
          // Usage, model and tool_use blocks appear on assistant lines only.
          absorbUsage(scan, obj, seenUsageMessageIds);
          absorbModel(scan, obj);
          absorbFilesTouched(scan, obj);
        }
        break;
      default:
        // The slug can appear on other line types; no other field is read from them.
        absorbSlug(scan, obj);
        break;
    }
  }

  return scan;
}

// The first pr-link wins. Each field is taken only when well-typed, so a malformed field
// leaves the others intact.
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

// First-wins so a late, transient branch value cannot override the session's branch.
function absorbGitBranch(scan: TranscriptScan, obj: Record<string, unknown>): void {
  if (scan.gitBranch === null && typeof obj.gitBranch === 'string' && obj.gitBranch.length > 0) {
    scan.gitBranch = obj.gitBranch;
  }
}

function absorbCwd(scan: TranscriptScan, obj: Record<string, unknown>): void {
  if (scan.cwd === null && typeof obj.cwd === 'string' && obj.cwd.length > 0) {
    scan.cwd = obj.cwd;
  }
}

// Keeps the leading run of uuids for fork lineage. A line without a uuid is skipped, not a gap.
function absorbLeadingUuid(scan: TranscriptScan, obj: Record<string, unknown>): void {
  if (scan.leadingMessageUuids.length >= MAX_LEADING_UUIDS) {
    return;
  }
  if (typeof obj.uuid === 'string' && obj.uuid.length > 0) {
    scan.leadingMessageUuids.push(obj.uuid);
  }
}

// Counts user/assistant lines only, not every JSONL line.
function absorbMessageCount(scan: TranscriptScan): void {
  scan.messageCount++;
}

// Role and text stay coupled so the snippet never attributes one speaker's prose to another.
// A textless opener sets only a fallback role, which the first prose turn overwrites; after
// that both fields freeze. A tool_result-only user line is not a human turn and is skipped.
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
    scan.firstMessageRole = role;
    scan.firstMessageText = truncate((text as string).trim(), MAX_LAST_MESSAGE_LENGTH);
    return;
  }
  if (scan.firstMessageRole === null) {
    scan.firstMessageRole = role;
  }
}

// Last-wins. The awaiting-reply heuristic reads lastMessageRole === 'user' as "a human
// spoke last". Tool outputs are also stored as user lines (tool_result blocks), so they must
// not advance the role or the heuristic misfires on most chats. A textless turn keeps the
// prior snippet text.
function absorbLastMessage(
  scan: TranscriptScan,
  obj: Record<string, unknown>,
  role: 'user' | 'assistant',
): void {
  if (role === 'user' && isToolResultFeedback((obj as { message?: unknown }).message)) {
    return;
  }
  scan.lastMessageRole = role;
  const text = extractMessageText((obj as { message?: unknown }).message);
  if (isNonEmpty(text)) {
    scan.lastMessageText = truncate((text as string).trim(), MAX_LAST_MESSAGE_LENGTH);
  }
}

// True when every content block is a tool_result, which makes the line tool output rather
// than a human turn.
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

// Sums usage once per message.id; a line without an id cannot be deduped and always counts.
// Missing or non-numeric fields add 0, and only the four token counts are read.
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

// A session can switch models, so keep every distinct model in first-seen order.
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

// file_path appears on Read, Edit and Write blocks, so this counts files referenced,
// including read-only ones, not only files edited.
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

// Handles a string, { content: string } or { content: [{ type, text }] }. Exported so the
// body reader shares this one parser.
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
