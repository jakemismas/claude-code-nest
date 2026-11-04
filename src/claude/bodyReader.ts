import * as fs from 'fs';
import { extractMessageText } from './jsonlReader';

// Read-only, on-demand reader for one chat's full message bodies.
// The scan snapshot keeps only a compact summary, so callers read bodies here and discard them.

// text is null for a turn with no extractable prose (a pure tool_use turn or a tool_result-only
// user line). The reader returns every user/assistant line, so callers can rebuild the turn
// sequence; it does not apply the scanner's awaiting-reply role suppression.
export interface ChatMessageBody {
  role: 'user' | 'assistant';
  text: string | null;
  uuid: string | null;
}

// Returns [] for an unreadable file or one with no user/assistant lines. Never throws.
export function readTranscriptBodies(filePath: string): ChatMessageBody[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  return extractBodies(content);
}

// Pure extraction over already-read JSONL text. Skips malformed lines and unrelated types.
export function extractBodies(content: string): ChatMessageBody[] {
  const bodies: ChatMessageBody[] = [];
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
    if (obj.type !== 'user' && obj.type !== 'assistant') {
      continue;
    }
    const role: 'user' | 'assistant' = obj.type;
    const text = extractMessageText((obj as { message?: unknown }).message);
    const uuid = typeof obj.uuid === 'string' && obj.uuid.length > 0 ? obj.uuid : null;
    bodies.push({
      role,
      text: text !== null && text.trim().length > 0 ? text.trim() : null,
      uuid,
    });
  }
  return bodies;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

