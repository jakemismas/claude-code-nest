// Resolves the ~/.claude/projects subdirectory name for a workspace path.
//
// Claude Code lowercases the drive letter and turns every character outside [A-Za-z0-9-]
// into a hyphen, not only path separators. Examples:
//   c:\Users\User\Documents\sample-app -> c--Users-User-Documents-sample-app
//   c:\Users\User\Notes+ Github -> c--Users-User-Notes--Github
//
// The drive letter on disk is inconsistently cased, so matching ignores case in that segment
// only, then falls back to re-encoding each transcript cwd. File access is injected, so the
// module has no vscode or filesystem dependency.

// Returns the cwd strings found in one project directory's transcripts.
export type CwdProbe = (projectDirName: string) => string[];

export interface ResolveDeps {
  // The list of subdirectory names under ~/.claude/projects.
  listProjectDirs: () => string[];
  // Without it, the cwd scan fallback is skipped.
  probeCwds?: CwdProbe;
}

// The canonical project-key encoding. Pure and deterministic.
export function encodeProjectKey(absPath: string): string {
  let normalized = absPath;
  if (/^[A-Za-z]:/.test(normalized)) {
    normalized = normalized[0].toLowerCase() + normalized.slice(1);
  }
  // Existing hyphens stay, so "Code - Nest" becomes "Code---Nest".
  return normalized.replace(/[^A-Za-z0-9-]/g, '-');
}

// Only the leading drive-letter segment ignores case; paths that differ by case elsewhere
// (...-MyProj vs ...-myproj) are distinct keys. The segment ends at the first "--".
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

// Matches the derived key against the real dirs, then re-encodes each dir's transcript cwd.
// Returns null when nothing resolves.
export function resolveProjectDir(absPath: string, deps: ResolveDeps): string | null {
  const derived = encodeProjectKey(absPath);
  const dirs = deps.listProjectDirs();

  for (const dir of dirs) {
    if (keysMatch(derived, dir)) {
      return dir;
    }
  }

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
