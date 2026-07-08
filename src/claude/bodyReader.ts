import * as fs from 'fs';
import { extractMessageText } from './jsonlReader';

// On-demand reader for a SINGLE chat's full message bodies. Strictly read-only:
// it reads one transcript file and returns the ordered user/assistant message
// bodies, then the caller discards them. NO provider holds the result, and the
// full bodies NEVER enter the scan snapshot (ARCHITECTURE.md tier-A rule: full
// message BODIES are never retained on the snapshot and are read on demand for
// one chat and discarded). This is the slice-1 lazy body reader; the tier-A
// summary (counts, token totals, last-message snippet) still rides the snapshot
// via jsonlReader.ts and is the cheap surface for rows and hovers.
//
// This module reads its OWN file (the single named transcript) rather than going
// through chatScanner.scanChats, because it needs the per-line message bodies the
// scanner deliberately discards. It stays a strict read: fs.readFileSync only, no
// write/rename/delete, matching readChat's read-only contract. It is otherwise
// vscode-free so the headless unit gate can cover it against a scratch fixture.

// One genuine user/assistant message body in transcript order. text is the
// extracted prose (the same shapes extractMessageText understands: a string body,
// {content:string}, or {content:[{type:'text',text}]}); it is null for a turn
// with no extractable text (a pure tool_use assistant turn or a tool_result-only
// user line). uuid is carried when present for stable ordering/identity, null
// otherwise. The reader returns EVERY user/assistant line in order, including
// tool_result-feedback user lines and textless assistant turns, so a consumer can
// reconstruct the turn sequence; it does not apply the tier-A awaiting-reply
// role-suppression (that is a snapshot heuristic, not a body-extraction concern).
export interface ChatMessageBody {
  role: 'user' | 'assistant';
  text: string | null;
  uuid: string | null;
}

// Read one transcript file's message bodies in transcript order. Returns [] when
// the file cannot be read at all or carries no user/assistant lines, and NEVER
// throws: a malformed individual line is skipped, an unreadable file yields [],
// mirroring readChat's tolerance. The result is meant to be consumed immediately
// and discarded; nothing here caches or retains it.
export function readTranscriptBodies(filePath: string): ChatMessageBody[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  return extractBodies(content);
}

// Extract the ordered user/assistant message bodies from already-read JSONL text.
// Split out from readTranscriptBodies so the headless suite can exercise the pure
// extraction over an in-memory string without a fixture file. Tolerant of
// malformed lines and unrelated types, exactly like scanTranscript.
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
      // Malformed line: tolerate and skip (never throw).
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

