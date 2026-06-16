// Resolves the ~/.claude/projects subdirectory name for a given workspace path.
//
// Encoding rule (verified exact, authoritative for DERIVATION): lowercase only
// the leading drive letter, then replace every character that is not [A-Za-z0-9-]
// with a single hyphen, preserving existing hyphens. This matches Claude Code's
// real on-disk encoding, which hyphenates any non-alphanumeric character, not
// just the path separators (verified against the live ~/.claude/projects listing:
// e.g. "Notes+ Github" on disk is "Notes--Github" -- both the '+' and the space
// collapse to hyphens). Examples:
//   c:\Users\JakeMismas\Documents\Claude Code - Nest
//   -> c--Users-JakeMismas-Documents-Claude-Code---Nest
//   c:\Users\JakeMismas\Notes+ Github
//   -> c--Users-JakeMismas-Notes--Github
//
// Matching against the real on-disk directories is tolerant: the drive letter
// on disk is inconsistently cased (both C--Users-JakeMismas and
// c--Users-JakeMismas-* exist on one machine), so the resolver matches the
// leading drive-letter segment case-insensitively, or falls through to a cwd
// scan across all project dirs. The transcript cwd field is the self-verify
// anchor: re-encoding a transcript cwd must reproduce the directory name.
//
// This module is filesystem-aware only through an injected lister, so it stays
// vscode-free and unit-testable; the scanner supplies the real reader.

// Reads one project directory's transcript cwd fields. A resolver caller injects
// this so tests can supply fixtures and the production path reads the real dirs.
// Returns the cwd strings found across the directory's transcripts (used by the
// scan fallback to self-verify a match).
export type CwdProbe = (projectDirName: string) => string[];

export interface ResolveDeps {
  // The list of subdirectory names under ~/.claude/projects.
  listProjectDirs: () => string[];
  // Optional: probe a project dir for transcript cwd values, for the scan
  // fallback's self-verification. When omitted, the fallback matches on the
  // encoded form alone.
  probeCwds?: CwdProbe;
}

// The canonical project-key encoding. Pure and deterministic.
export function encodeProjectKey(absPath: string): string {
  // Lowercase only the leading drive letter, if present (a single ASCII letter
  // immediately followed by a colon at position 0).
  let normalized = absPath;
  if (/^[A-Za-z]:/.test(normalized)) {
    normalized = normalized[0].toLowerCase() + normalized.slice(1);
  }
  // Replace every non-[A-Za-z0-9-] character with a single hyphen. Existing
  // hyphens are preserved (they are in the allowed class), so "Code - Nest" with
  // its space-hyphen-space becomes "Code---Nest", and a non-separator special
  // character like '+' is hyphenated too ("Notes+ Github" -> "Notes--Github").
  return normalized.replace(/[^A-Za-z0-9-]/g, '-');
}

// Compare two encoded keys, tolerating ONLY the leading drive-letter segment's
// casing; the remainder must match exactly. The encoder lowercases just the
// drive letter, so the only legitimate cross-source casing difference is that
// first character (the real on-disk dirs carry both C-- and c-- forms). Matching
// the whole string case-insensitively would be too broad: two paths differing
// only by case in a NON-drive segment (e.g. ...-MyProj vs ...-myproj) derive
// distinct keys and must NOT be treated as equal. The leading segment is the
// run before the first "--" the encoder produces for "<drive>:".
export function keysMatch(derived: string, onDisk: string): boolean {
  const d = splitLeadingSegment(derived);
  const o = splitLeadingSegment(onDisk);
  return d.lead.toLowerCase() === o.lead.toLowerCase() && d.rest === o.rest;
}

function splitLeadingSegment(key: string): { lead: string; rest: string } {
  const idx = key.indexOf('--');
  if (idx === -1) {
    return { lead: key, rest: '' };
  }
  return { lead: key.slice(0, idx), rest: key.slice(idx) };
}

// Resolve the on-disk project directory name for a workspace path. Strategy:
//   1. Derive the key by the exact encoding rule.
//   2. Match it against the real dirs case-insensitively (drive-letter casing).
//   3. If no match, scan: re-encode each candidate's transcript cwd and accept
//      the dir whose self-encoded cwd matches the derived key (case-insensitive).
//   4. Return null when nothing resolves.
export function resolveProjectDir(absPath: string, deps: ResolveDeps): string | null {
  const derived = encodeProjectKey(absPath);
  const dirs = deps.listProjectDirs();

  // Step 2: tolerant direct match.
  for (const dir of dirs) {
    if (keysMatch(derived, dir)) {
      return dir;
    }
  }

  // Step 3: cwd scan fallback with self-verify.
  if (deps.probeCwds) {
    for (const dir of dirs) {
      const cwds = deps.probeCwds(dir);
      for (const cwd of cwds) {
        if (keysMatch(derived, encodeProjectKey(cwd))) {
          return dir;
        }
      }
    }
  }

  return null;
}
