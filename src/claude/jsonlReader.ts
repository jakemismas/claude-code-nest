import { TranscriptScan } from '../model/types';

// Tolerant, line-type-driven reader for a Claude Code transcript. The transcript
// is JSONL: one JSON object per line, each carrying a "type". Titles and
// timestamps are NOT top-level keys on arbitrary lines; they ride on dedicated
// line types (verified ground truth):
//   type "custom-title"  -> customTitle
//   type "ai-title"      -> aiTitle
//   type "user"/"assistant" -> timestamp, cwd, slug, message
// Unrelated types (queue-operation, hook_success, attachment,
// deferred_tools_delta, last-prompt, file-history-snapshot, system, ...) are
// tolerated and contribute nothing. A line that fails to parse is skipped, never
// thrown. This module never touches the filesystem; it operates on already-read
// text so the scanner owns the read-only contract.

const MAX_TITLE_LENGTH = 80;

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
  };

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
      case 'user':
      case 'assistant':
        absorbTimestamp(scan, obj);
        absorbSlug(scan, obj);
        if (type === 'user') {
          absorbFirstUserText(scan, obj);
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
// { content: Array<{ type, text }> }. Extract the first text content.
function extractMessageText(message: unknown): string | null {
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
