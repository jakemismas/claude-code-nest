import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// The write chokepoint: the only module in src allowed to make a write-capable fs call (the eslint ban carves out this file). Every write under ~/.claude goes through writeCleanupPeriodDays, which asserts the target is the one settings.json path.
// The edit is surgical: a single-key jsonc byte-range replacement or insertion that preserves sibling keys, comments, whitespace and EOL style. A pre-write mtime re-stat (float ms) aborts if the file changed since the read.
// This module is vscode-free, so the edit, path assertion and mtime guard run in tests against scratch fixtures.

// The key this module reads and writes: Claude Code's cleanup period for transcript retention. Absent by default.
export const CLEANUP_PERIOD_DAYS_KEY = 'cleanupPeriodDays';

// Claude Code's default retention window when the key is absent, shown as the effective value.
export const CLAUDE_DEFAULT_CLEANUP_PERIOD_DAYS = 30;

export class SettingsIoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsIoError';
  }
}

// --- Webview message protocol (pure, vscode-free) ---
// A pure function drives the webview and host messages so tests use a fake messenger; the caller owns the vscode wiring.

// Messages the webview posts to the host.
export type InboundMessage =
  | { type: 'ready' } // webview loaded; host replies with the current state
  | { type: 'save'; value: unknown }; // user submitted a value to persist

// Messages the host posts back to the webview.
export type OutboundMessage =
  | {
      type: 'state';
      value: number | null;
      usingDefault: boolean;
      defaultValue: number;
    }
  | { type: 'saved'; value: number }
  | { type: 'error'; error: string };

// The IO seam the protocol uses, injected so tests supply fakes: read returns the effective value, write persists a validated integer through the chokepoint.
export interface SettingsIo {
  read(): CleanupPeriodRead;
  write(value: number): void;
}

// Handle one inbound message and return the outbound messages. Pure: IO goes through SettingsIo and validation through validateCleanupPeriodDays.
// 'ready' yields the current state; 'save' validates, writes, then replies 'saved' plus a fresh 'state', or 'error' on failure.
export function handleSettingsMessage(
  io: SettingsIo,
  message: InboundMessage,
): OutboundMessage[] {
  if (message.type === 'ready') {
    return [stateMessage(io)];
  }
  if (message.type === 'save') {
    const validated = validateCleanupPeriodDays(message.value);
    if (!validated.ok) {
      return [{ type: 'error', error: validated.error }];
    }
    try {
      io.write(validated.value);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return [{ type: 'error', error: reason }];
    }
    return [{ type: 'saved', value: validated.value }, stateMessage(io)];
  }
  return [];
}

function stateMessage(io: SettingsIo): OutboundMessage {
  const read = io.read();
  return {
    type: 'state',
    value: read.value,
    usingDefault: read.usingDefault,
    defaultValue: CLAUDE_DEFAULT_CLEANUP_PERIOD_DAYS,
  };
}

// The single allowed write target, anchored on os.homedir() like chatScanner.defaultProjectsRoot so both agree on where ~/.claude is.
export function settingsJsonPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

// Canonicalize an absolute path for comparison without realpath, which throws on a missing target (create-when-missing). Normalize and resolve lexically, and lowercase only the win32 drive letter, as projectKeyResolver.encodeProjectKey does.
// The rest stays case-sensitive: the allowed path derives from the same os.homedir(), so a case difference elsewhere is a genuinely different path.
function canonicalizeTarget(absPath: string): string {
  let resolved = path.resolve(absPath);
  resolved = path.normalize(resolved);
  if (process.platform === 'win32' && /^[A-Za-z]:/.test(resolved)) {
    resolved = resolved[0].toLowerCase() + resolved.slice(1);
  }
  return resolved;
}

// Hard-assert the target is the one allowed settings.json path, else throw SettingsIoError, so no caller can redirect the write elsewhere, in particular under ~/.claude/projects/.
export function assertAllowedTarget(targetPath: string): void {
  const allowed = canonicalizeTarget(settingsJsonPath());
  const candidate = canonicalizeTarget(targetPath);
  if (candidate !== allowed) {
    throw new SettingsIoError(
      'Refusing to write outside the one allowed Claude settings.json path. ' +
        'Allowed: ' +
        allowed +
        ' Requested: ' +
        candidate,
    );
  }
}

// Validate cleanupPeriodDays: a finite, non-negative integer, given as a number or numeric string (the webview posts a string). Returns the integer or an error message.
export function validateCleanupPeriodDays(
  raw: unknown,
): { ok: true; value: number } | { ok: false; error: string } {
  let n: number;
  if (typeof raw === 'number') {
    n = raw;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return { ok: false, error: 'Enter a whole number of days.' };
    }
    // Require a plain base-10 integer literal: Number() would accept '0x10', '1e3', '  12  ' and '12.0'.
    if (!/^[+-]?\d+$/.test(trimmed)) {
      return { ok: false, error: 'Enter a whole number (integer), not a decimal or expression.' };
    }
    n = Number(trimmed);
  } else {
    return { ok: false, error: 'Enter a whole number of days.' };
  }
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, error: 'Enter a whole number (integer), not a decimal.' };
  }
  if (n < 0) {
    return { ok: false, error: 'Days cannot be negative.' };
  }
  return { ok: true, value: n };
}

// The current effective read result for the webview.
export interface CleanupPeriodRead {
  // The stored value when the key is present and an integer; null when absent.
  value: number | null;
  // True when the key is absent or the file is missing, so the webview shows Claude's default as the effective value.
  usingDefault: boolean;
}

// Read the current cleanupPeriodDays, read-only with a tolerant jsonc parse. A missing file, absent key or non-integer value yields usingDefault: true.
export function readCleanupPeriodDays(targetPath: string = settingsJsonPath()): CleanupPeriodRead {
  let content: string;
  try {
    content = fs.readFileSync(targetPath, 'utf8');
  } catch {
    return { value: null, usingDefault: true };
  }
  const found = findTopLevelNumberValue(content, CLEANUP_PERIOD_DAYS_KEY);
  if (found === null || !Number.isInteger(found)) {
    return { value: null, usingDefault: true };
  }
  return { value: found, usingDefault: false };
}

// Optional injection seam: a test injects a moving mtime reader to exercise the concurrent-edit abort, since fs.statSync is non-configurable and cannot be patched.
export interface WriteOptions {
  // Read the target's mtime in float milliseconds, called after the content read and again before the write. Defaults to fs.statSync(p).mtimeMs.
  statMtimeMs?: (targetPath: string) => number;
}

// Write cleanupPeriodDays surgically; the only write entry point. It asserts the target path, reads the bytes and mtime, computes a single-key edit,
// re-stats and aborts if mtimeMs changed, then writes atomically via a temp file and rename. A missing file is created with a minimal document holding just the key;
// realpath is not used so a nonexistent target does not throw.
export function writeCleanupPeriodDays(
  value: number,
  targetPath: string = settingsJsonPath(),
  options: WriteOptions = {},
): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new SettingsIoError('cleanupPeriodDays must be a non-negative integer.');
  }
  assertAllowedTarget(targetPath);

  const statMtimeMs = options.statMtimeMs ?? ((p: string) => fs.statSync(p).mtimeMs);

  let original: string | null;
  let mtimeBefore: number | null;
  try {
    original = fs.readFileSync(targetPath, 'utf8');
    mtimeBefore = statMtimeMs(targetPath);
  } catch {
    original = null;
    mtimeBefore = null;
  }

  if (original === null) {
    // Create-when-missing: write a minimal document. The directory is assumed to exist (~/.claude); if not, the write throws, which is the correct failure.
    const eol = '\n';
    const created = '{' + eol + '  "' + CLEANUP_PERIOD_DAYS_KEY + '": ' + String(value) + eol + '}' + eol;
    atomicWrite(targetPath, created);
    return;
  }

  const eol = detectEol(original);
  const edit = computeCleanupPeriodEdit(original, value, eol);

  // Abort if the file changed since the read; compare float mtimeMs so a same-second edit is still caught.
  const mtimeNow = statMtimeMs(targetPath);
  if (mtimeBefore === null || mtimeNow !== mtimeBefore) {
    throw new SettingsIoError(
      'settings.json changed on disk between read and write; aborting to avoid clobbering a concurrent edit.',
    );
  }

  if (edit.unchanged) {
    return;
  }
  const next = edit.before + edit.replacement + edit.after;
  atomicWrite(targetPath, next);
}

// The computed single-key edit: the replaced or inserted bytes plus the surrounding bytes left verbatim. Exposed for tests without touching the filesystem.
export interface CleanupPeriodEdit {
  before: string;
  replacement: string;
  after: string;
  // True when the existing value already equals the requested integer, so no write is needed.
  unchanged: boolean;
  // Whether the key existed (replacement) or was inserted into an existing document.
  existed: boolean;
}

// Compute the surgical single-key edit over an existing document's text. Pure. Replaces the value of a top-level cleanupPeriodDays, or inserts the key as the first member when absent.
export function computeCleanupPeriodEdit(
  text: string,
  value: number,
  eol: string = detectEol(text),
): CleanupPeriodEdit {
  const valueRange = findTopLevelValueRange(text, CLEANUP_PERIOD_DAYS_KEY);
  const valueLiteral = String(value);

  if (valueRange !== null) {
    const existingLiteral = text.slice(valueRange.start, valueRange.end);
    if (existingLiteral.trim() === valueLiteral) {
      return {
        before: text.slice(0, valueRange.start),
        replacement: text.slice(valueRange.start, valueRange.end),
        after: text.slice(valueRange.end),
        unchanged: true,
        existed: true,
      };
    }
    return {
      before: text.slice(0, valueRange.start),
      replacement: valueLiteral,
      after: text.slice(valueRange.end),
      unchanged: false,
      existed: true,
    };
  }

  // Key absent: insert it right after the opening brace as the first member, keeping every existing member byte-for-byte. An empty object gets no trailing comma.
  const insertion = computeInsertion(text, valueLiteral, eol);
  return {
    before: insertion.before,
    replacement: insertion.replacement,
    after: insertion.after,
    unchanged: false,
    existed: false,
  };
}

function computeInsertion(
  text: string,
  valueLiteral: string,
  eol: string,
): { before: string; replacement: string; after: string } {
  const braceIdx = indexOfTopLevelOpenBrace(text);
  if (braceIdx === -1) {
    // Defensive fallback for an unrecognizable object: produce a clean minimal document.
    const created = '{' + eol + '  "' + CLEANUP_PERIOD_DAYS_KEY + '": ' + valueLiteral + eol + '}' + eol;
    return { before: '', replacement: created, after: text };
  }
  const afterBrace = braceIdx + 1;
  const isEmpty = isEmptyObjectAfter(text, afterBrace);
  const indent = '  ';
  if (isEmpty) {
    // For {} insert the sole member and drop inner whitespace by anchoring at the closing brace.
    const closeIdx = text.indexOf('}', afterBrace);
    const before = text.slice(0, afterBrace);
    const replacement = eol + indent + '"' + CLEANUP_PERIOD_DAYS_KEY + '": ' + valueLiteral + eol;
    const after = text.slice(closeIdx);
    return { before, replacement, after };
  }
  // Non-empty object: insert as the first member, followed by a comma, right after the opening brace.
  const before = text.slice(0, afterBrace);
  const replacement = eol + indent + '"' + CLEANUP_PERIOD_DAYS_KEY + '": ' + valueLiteral + ',';
  const after = text.slice(afterBrace);
  return { before, replacement, after };
}

// EOL detection: preserve CRLF if the document has any, else LF.
export function detectEol(text: string): string {
  return /\r\n/.test(text) ? '\r\n' : '\n';
}

// --- Minimal jsonc scanning (top-level only, comment- and string-aware) ---

// Find the byte index of the top-level object's opening brace, skipping leading
// whitespace and // line and /* block */ comments. Returns -1 if none.
function indexOfTopLevelOpenBrace(text: string): number {
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      i = skipLineComment(text, i);
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i = skipBlockComment(text, i);
      continue;
    }
    if (c === '{') {
      return i;
    }
    return -1;
  }
  return -1;
}

// True when the object starting just after its opening brace (idx points at the
// first byte after '{') contains only whitespace/comments before its closing '}'.
function isEmptyObjectAfter(text: string, idx: number): boolean {
  let i = idx;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      i = skipLineComment(text, i);
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i = skipBlockComment(text, i);
      continue;
    }
    return c === '}';
  }
  return false;
}

interface ValueRange {
  start: number;
  end: number;
}

// Find the byte range [start, end) of the value of a top-level key (depth 1 only), skipping comments and string contents. Returns null if the key is not a direct member.
// The range ends before the following comma, closing brace, or comment or newline.
function findTopLevelValueRange(text: string, key: string): ValueRange | null {
  const braceIdx = indexOfTopLevelOpenBrace(text);
  if (braceIdx === -1) {
    return null;
  }
  let i = braceIdx + 1;
  let depth = 1;
  while (i < text.length && depth >= 1) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === ',') {
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      i = skipLineComment(text, i);
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i = skipBlockComment(text, i);
      continue;
    }
    if (c === '}') {
      depth--;
      i++;
      continue;
    }
    if (c === '"') {
      // A top-level key string: read it, then expect a colon and a value.
      const keyStr = readString(text, i);
      if (keyStr === null) {
        return null;
      }
      const matched = keyStr.value === key;
      i = keyStr.end;
      i = skipWsAndComments(text, i);
      if (text[i] !== ':') {
        // Malformed; bail rather than guess.
        return null;
      }
      i++; // past ':'
      const valStart = skipWsAndComments(text, i);
      const valEnd = endOfValue(text, valStart);
      if (matched && depthAt(text, braceIdx, valStart) === 1) {
        return { start: valStart, end: valEnd };
      }
      i = valEnd;
      continue;
    }
    i++;
  }
  return null;
}

// Find a top-level numeric value (used by the read path), or null.
function findTopLevelNumberValue(text: string, key: string): number | null {
  const range = findTopLevelValueRange(text, key);
  if (range === null) {
    return null;
  }
  const literal = text.slice(range.start, range.end).trim();
  if (!/^[+-]?\d+$/.test(literal)) {
    // Only a plain integer literal is a clean read; a quoted/float/expression
    // value is treated as absent for display purposes.
    const asNum = Number(literal);
    return Number.isFinite(asNum) ? asNum : null;
  }
  return Number(literal);
}

// Confirm the value start sits at object depth 1, guarding against matching a nested key with the same name.
function depthAt(text: string, braceIdx: number, target: number): number {
  let i = braceIdx;
  let depth = 0;
  while (i < target && i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      i = skipLineComment(text, i);
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i = skipBlockComment(text, i);
      continue;
    }
    if (c === '"') {
      const s = readString(text, i);
      i = s === null ? i + 1 : s.end;
      continue;
    }
    if (c === '{' || c === '[') {
      depth++;
    } else if (c === '}' || c === ']') {
      depth--;
    }
    i++;
  }
  return depth;
}

// The exclusive end index of a value starting at start: a string, object, array or scalar literal. Objects and arrays balance brackets (string-aware); scalars end at the next structural terminator.
function endOfValue(text: string, start: number): number {
  const c = text[start];
  if (c === '"') {
    const s = readString(text, start);
    return s === null ? text.length : s.end;
  }
  if (c === '{' || c === '[') {
    return endOfBracketed(text, start);
  }
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (
      ch === ',' ||
      ch === '}' ||
      ch === ']' ||
      ch === '\r' ||
      ch === '\n' ||
      (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*'))
    ) {
      break;
    }
    i++;
  }
  // Trim trailing inline whitespace so the range covers just the literal.
  while (i > start && (text[i - 1] === ' ' || text[i - 1] === '\t')) {
    i--;
  }
  return i;
}

function endOfBracketed(text: string, start: number): number {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      i = skipLineComment(text, i);
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i = skipBlockComment(text, i);
      continue;
    }
    if (c === '"') {
      const s = readString(text, i);
      i = s === null ? i + 1 : s.end;
      continue;
    }
    if (c === open) {
      depth++;
    } else if (c === close) {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
    }
    i++;
  }
  return text.length;
}

interface ReadString {
  value: string;
  end: number;
}

// Read a JSON string at the opening quote at idx. Returns the value and the index past the closing quote, or null if unterminated. The value is approximate (only \" and \\ are handled), which suffices for top-level key comparison.
function readString(text: string, idx: number): ReadString | null {
  let i = idx + 1;
  let value = '';
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      const next = text[i + 1];
      if (next === '"') {
        value += '"';
      } else if (next === '\\') {
        value += '\\';
      } else {
        value += next;
      }
      i += 2;
      continue;
    }
    if (c === '"') {
      return { value, end: i + 1 };
    }
    value += c;
    i++;
  }
  return null;
}

function skipWsAndComments(text: string, idx: number): number {
  let i = idx;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      i = skipLineComment(text, i);
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i = skipBlockComment(text, i);
      continue;
    }
    break;
  }
  return i;
}

function skipLineComment(text: string, idx: number): number {
  let i = idx + 2;
  while (i < text.length && text[i] !== '\n') {
    i++;
  }
  return i;
}

function skipBlockComment(text: string, idx: number): number {
  let i = idx + 2;
  while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
    i++;
  }
  return Math.min(i + 2, text.length);
}

// Atomic write via a temp file in the same directory and a rename, so a crash never leaves a truncated settings.json.
function atomicWrite(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  const tmp = path.join(dir, '.nest-settings-' + process.pid + '-' + Date.now() + '.tmp');
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, targetPath);
  } catch (err) {
    // Clean up the temp file on a failed rename so we do not litter ~/.claude.
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore secondary cleanup failure
    }
    throw err;
  }
}
