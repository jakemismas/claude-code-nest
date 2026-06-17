import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// The read-only chokepoint (ARCHITECTURE.md "Read-only invariant"): this is the
// ONLY module in src permitted to perform a write-capable fs call. The eslint
// no-restricted-syntax bank that bans every write-capable fs call shape across
// src carves out exactly this file (and the test tree). Every write that lands
// under ~/.claude routes through writeCleanupPeriodDays here, which hard-asserts
// the canonicalized absolute target equals the ONE allowed settings.json path and
// throws otherwise. Nothing may ever write under ~/.claude/projects/.
//
// This module is vscode-free so its surgical-edit, path-assertion, and mtime-guard
// logic is exercised headlessly against scratch fixtures (build contract: unit
// tests and the modules they import must not require vscode).
//
// The settings.json edit is SURGICAL: a single-key jsonc byte-range replacement
// (or insertion) that preserves sibling keys, whitespace, and the file's EOL
// style. It never parse-then-stringifies the whole document, so comments, key
// order, and formatting survive untouched. A pre-write mtime re-stat aborts the
// write if the file changed between read and write (a concurrent edit), comparing
// float milliseconds so a same-second concurrent edit is still caught.

// The key this slice reads and writes. Claude Code's cleanup period for stale
// transcript retention; absent by default (Claude applies its own default).
export const CLEANUP_PERIOD_DAYS_KEY = 'cleanupPeriodDays';

// Claude Code's documented default retention window when the key is absent. Shown
// in the webview as the effective value so the user knows what they are changing.
export const CLAUDE_DEFAULT_CLEANUP_PERIOD_DAYS = 30;

export class SettingsIoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsIoError';
  }
}

// --- Webview message protocol (pure, vscode-free) ---
//
// The webview and the host exchange small JSON messages. The protocol logic is a
// pure function so a unit test drives it through a fake messenger (no vscode, no
// real panel). settingsWebview.ts owns only the vscode binding (panel creation,
// onDidReceiveMessage wiring, postMessage).

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

// The IO seam the protocol uses, injected so the test supplies fakes and the host
// supplies the real read/write. read returns the current effective value; write
// persists a validated integer (routed through the chokepoint).
export interface SettingsIo {
  read(): CleanupPeriodRead;
  write(value: number): void;
}

// Handle one inbound message and return the outbound messages to post back (zero
// or more). Pure: all IO is via the injected SettingsIo, all validation via
// validateCleanupPeriodDays. A 'ready' message yields the current state; a 'save'
// validates, writes through the chokepoint on success, then replies with 'saved'
// plus a fresh 'state', or 'error' on a validation/IO failure.
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

// The single allowed write target. Anchored on os.homedir() exactly as
// chatScanner.defaultProjectsRoot anchors the projects root, so the chokepoint and
// the read-only surface agree on where ~/.claude is.
export function settingsJsonPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

// Canonicalize an absolute path for comparison WITHOUT realpath-ing it: the
// create-when-missing case means the target file may not exist, and
// fs.realpathSync throws on a nonexistent path. We normalize and resolve (a pure
// lexical operation) and case-fold ONLY the leading drive letter on win32, exactly
// as projectKeyResolver.encodeProjectKey does (lowercase position 0 when the path
// starts with a single ASCII letter followed by a colon). The rest of the path is
// left case-sensitive: Windows is case-insensitive on the filesystem, but the
// allowed path is constructed from the same os.homedir() the target is derived
// from, so a case mismatch outside the drive letter signals a genuinely different
// path and must be rejected.
function canonicalizeTarget(absPath: string): string {
  let resolved = path.resolve(absPath);
  resolved = path.normalize(resolved);
  if (process.platform === 'win32' && /^[A-Za-z]:/.test(resolved)) {
    resolved = resolved[0].toLowerCase() + resolved.slice(1);
  }
  return resolved;
}

// Hard-assert the target is the one allowed settings.json path. Throws a
// SettingsIoError otherwise. This is the chokepoint's core guarantee: a caller
// (including a future buggy one) cannot redirect this module's write anywhere
// else, and in particular never under ~/.claude/projects/.
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

// The integer-validation contract surfaced to the webview and reused in the write
// path. cleanupPeriodDays must be a finite, non-negative INTEGER. Returns the
// parsed integer on success or an error message on failure. Accepts a number or a
// numeric string (the webview posts a string from the input field).
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
    // Reject anything that is not a plain base-10 integer literal: Number() would
    // accept '0x10', '1e3', '  12  ', and '12.0'; the webview must store a clean
    // integer, so we require digits only (with an optional leading sign handled by
    // the explicit check below).
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
  // The stored value when the key is present and an integer; null when the key is
  // absent (the webview then shows Claude's default as the effective value).
  value: number | null;
  // True when cleanupPeriodDays is absent from settings.json (or the file does not
  // exist): the webview shows CLAUDE_DEFAULT_CLEANUP_PERIOD_DAYS as the effective
  // value and notes it is Claude's default, not an explicit setting.
  usingDefault: boolean;
}

// Read the current cleanupPeriodDays. Read-only: a plain readFileSync and a
// tolerant jsonc parse. A missing file or absent key both yield usingDefault:true.
// A present-but-non-integer value is treated as "using default" for display (the
// webview will not surface a corrupt value as editable state); the write path
// still creates/replaces a clean integer.
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

// Write cleanupPeriodDays surgically. This is the ONLY write entry point. It:
//   1. Hard-asserts the target is the allowed settings.json path (throws otherwise).
//   2. Reads the current bytes and captures statSync().mtimeMs.
//   3. Computes a single-key byte-range edit (replace the value if the key exists,
//      else insert the key preserving sibling formatting and EOL).
//   4. Re-stats immediately before the write and aborts if mtimeMs changed (a
//      concurrent edit); the same float-ms comparison catches a same-second edit.
//   5. Writes atomically via a temp file + rename, both inside this exempt module.
//
// When the file does not exist it is created with a minimal well-formed document
// containing just the key (create-when-missing is in scope; the path assertion
// already proved the target is the allowed path, and realpath was deliberately
// NOT used so a nonexistent target does not throw).
// Optional injection seam, mirroring ScannerOptions / ResolveDeps elsewhere. The
// production path uses the real fs; a unit test injects a moving mtime reader to
// exercise the concurrent-edit abort deterministically (fs.statSync is a
// non-configurable module property, so it cannot be monkeypatched in-place).
export interface WriteOptions {
  // Read the target's mtime in float milliseconds. Called twice: once right after
  // the content read, once immediately before the write. Defaults to
  // fs.statSync(p).mtimeMs.
  statMtimeMs?: (targetPath: string) => number;
}

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
    // Create-when-missing: write a minimal well-formed document. The directory is
    // assumed to exist (it is ~/.claude, which Claude Code created); if it does
    // not, the write throws, which is the correct surfaced failure.
    const eol = '\n';
    const created = '{' + eol + '  "' + CLEANUP_PERIOD_DAYS_KEY + '": ' + String(value) + eol + '}' + eol;
    atomicWrite(targetPath, created);
    return;
  }

  const eol = detectEol(original);
  const edit = computeCleanupPeriodEdit(original, value, eol);

  // mtime re-stat guard: abort if the file changed since we read it. Compare float
  // milliseconds (mtimeMs), not the second-resolution Date, so a concurrent
  // same-second edit is still caught.
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

// The computed single-key edit: a byte-range replacement or insertion plus the
// surrounding bytes left verbatim. Exposed for unit testing the surgical edit
// without touching the filesystem.
export interface CleanupPeriodEdit {
  before: string;
  replacement: string;
  after: string;
  // True when the existing value already equals the requested integer (no write
  // needed); before/replacement/after still reconstruct the original.
  unchanged: boolean;
  // Whether the key existed (replacement) or was inserted (creation in an existing
  // doc).
  existed: boolean;
}

// Compute the surgical single-key edit over an existing document's text. Pure: no
// filesystem. Replaces the value bytes of an existing top-level cleanupPeriodDays,
// or inserts the key as the first member (preserving existing members, whitespace,
// and EOL) when absent. Never parse-then-stringifies.
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

  // Key absent: insert it as the first member of the top-level object, preserving
  // every existing member byte-for-byte. Find the opening brace, insert
  //   <eol>  "cleanupPeriodDays": <value>,
  // right after it. If the object is empty ({} possibly with whitespace) insert
  // without a trailing comma.
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
    // Not a recognizable object; treat as create-from-scratch content. This is a
    // defensive fallback (the read path would have reported usingDefault); produce
    // a clean minimal doc.
    const created = '{' + eol + '  "' + CLEANUP_PERIOD_DAYS_KEY + '": ' + valueLiteral + eol + '}' + eol;
    return { before: '', replacement: created, after: text };
  }
  const afterBrace = braceIdx + 1;
  const isEmpty = isEmptyObjectAfter(text, afterBrace);
  const indent = '  ';
  if (isEmpty) {
    // {} -> insert the sole member; drop any existing inner whitespace by anchoring
    // the after-slice at the closing brace.
    const closeIdx = text.indexOf('}', afterBrace);
    const before = text.slice(0, afterBrace);
    const replacement = eol + indent + '"' + CLEANUP_PERIOD_DAYS_KEY + '": ' + valueLiteral + eol;
    const after = text.slice(closeIdx);
    return { before, replacement, after };
  }
  // Non-empty object: insert as the FIRST member, followed by a comma, before the
  // existing first member. Anchor right after the opening brace.
  const before = text.slice(0, afterBrace);
  const replacement = eol + indent + '"' + CLEANUP_PERIOD_DAYS_KEY + '": ' + valueLiteral + ',';
  const after = text.slice(afterBrace);
  return { before, replacement, after };
}

// EOL detection: if the document carries any CRLF, preserve CRLF; otherwise LF.
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

// Find the byte range [start, end) of the VALUE of a top-level key, scanning the
// top-level object only (depth 1). Returns null if the key is not a direct member.
// jsonc-aware: skips // and /* */ comments and string contents. The value range
// spans the bytes after the colon's optional whitespace up to (but not including)
// the following comma, closing brace, or comment/newline that ends the value.
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
      // A top-level KEY string (we are at depth 1). Read it, then expect a colon
      // and a value.
      const keyStr = readString(text, i);
      if (keyStr === null) {
        return null;
      }
      const matched = keyStr.value === key;
      i = keyStr.end;
      // Skip whitespace/comments to the colon.
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

// Confirm the value start sits at object depth 1 (a direct top-level member),
// scanning from the opening brace. Guards against matching a nested key with the
// same name.
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

// The end index (exclusive) of a value beginning at start. Handles a string,
// object, array, or scalar literal (number/true/false/null). For an object/array
// it balances brackets (string-aware); for a scalar it reads to the next
// structural terminator (comma, closing brace/bracket, whitespace, comment start).
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
  // Trim trailing inline whitespace from the scalar range so the replacement
  // targets just the literal.
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

// Read a JSON string starting at the opening quote at idx. Returns the unescaped
// value and the index just past the closing quote, or null on an unterminated
// string. Handles standard escapes for the closing-quote scan; the unescaped value
// is approximate (only \" \\ matter for matching simple keys) but sufficient for
// top-level key comparison.
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

// Atomic write via a temp file in the same directory followed by a rename, so a
// crash mid-write never leaves a truncated settings.json. Both calls live inside
// this exempt chokepoint module (ARCHITECTURE.md: "If atomicity uses
// temp-write-then-rename, that rename stays inside the exempt chokepoint module").
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
