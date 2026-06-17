import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// The PURE, vscode-free path guard for the export/import and auto-export snapshot
// writes (build contract: logic the unit gate exercises must not import vscode).
// exportIO.ts (the vscode-bound, lint-exempt IO module) calls assertNotUnder-
// ClaudeProjects before every write/createDirectory/delete.
//
// Why this guard exists (read-only invariant, ARCHITECTURE.md): unlike the settings
// chokepoint, whose target is a single fixed path, the export target comes from a
// save dialog the user can navigate ANYWHERE, including into
// ~/.claude/projects/<encoded-dir>/ where they could overwrite a Claude transcript.
// The dialog's JSON extension filter does not hard-block typing an existing
// transcript filename. An exempt fs module must runtime-assert its target, exactly
// as claudeSettingsIO.assertAllowedTarget does, rather than trust the dialog. This
// is the export twin of that assertion, pulled into a pure module so the same
// headless unit suite that proves the settings chokepoint can prove this one.

export class ExportPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportPathError';
  }
}

// The forbidden root: ~/.claude/projects/. Anchored on os.homedir() exactly as
// claudeSettingsIO.settingsJsonPath and chatScanner.defaultProjectsRoot anchor
// ~/.claude, so the read-only surface and this guard agree on where it is.
export function claudeProjectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

// Resolve symlinks/NTFS junctions on the LONGEST existing prefix of an absolute
// path, then rejoin the non-existent tail verbatim. A purely lexical path cannot
// see through a junction: ~/nestlink/<dir>/x.jsonl, where ~/nestlink is a junction
// into ~/.claude/projects/, lexically reads as nestlink/... and slips the prefix
// test, but the OS follows the junction and the write lands on a real transcript.
// fs.realpathSync was deliberately NOT used on the whole target because the target
// file may not exist yet and realpath throws on a nonexistent path; the fix is to
// realpath the part that DOES exist (the parent dir survives even when the file
// does not) and rejoin the missing basename(s). Walk up until an existing ancestor
// is found, realpath it, then re-append the stripped tail. On any fs error
// (permission, race) fall back to the input so the lexical case-fold + prefix test
// still applies (defense in depth, never less strict than before).
function resolveExistingPrefix(absPath: string): string {
  let head = absPath;
  const tail: string[] = [];
  // Climb until an existing ancestor is found. path.dirname is idempotent at the
  // root ('C:\\' -> 'C:\\', '/' -> '/'), so guard against an infinite loop.
  for (;;) {
    try {
      if (fs.existsSync(head)) {
        const realHead = fs.realpathSync.native(head);
        return tail.length === 0 ? realHead : path.join(realHead, ...tail.reverse());
      }
    } catch {
      return absPath;
    }
    const parent = path.dirname(head);
    if (parent === head) {
      // Reached the filesystem root without finding an existing component.
      return absPath;
    }
    tail.push(path.basename(head));
    head = parent;
  }
}

// Canonicalize an absolute path for comparison. Resolve and normalize (a pure
// lexical operation), follow any symlink/junction on the existing prefix (so the
// guard sees the real on-disk location, not a redirecting link), then on win32
// case-fold the ENTIRE path. Earlier this folded only the leading drive letter,
// which left every other segment case-sensitive; because Windows NTFS is
// case-insensitive, ~/.claude/PROJECTS/x, ~/.CLAUDE/projects/x, and a lowercased
// ~/users/... target are all the SAME on-disk location as the real projects tree,
// yet a case-sensitive prefix test treated them as different and let the write
// through. Folding the whole path on win32 matches the OS's actual
// case-insensitivity so a membership test cannot be defeated by re-casing a segment.
export function canonicalize(absPath: string): string {
  let resolved = path.normalize(path.resolve(absPath));
  resolved = resolveExistingPrefix(resolved);
  if (process.platform === 'win32') {
    resolved = resolved.toLowerCase();
  }
  return resolved;
}

// True when targetPath is the ~/.claude/projects/ root or anywhere under it. The
// root + path.sep prefix test means a SIBLING like ~/.claude/projects-archive is
// NOT falsely matched (a bare startsWith(root) would match it), while the exact-root
// equality still rejects the root directory itself. Both sides go through
// canonicalize, so both resolve junctions and (on win32) are case-folded the same
// way: a re-cased segment or a link into the tree cannot evade the comparison.
export function isUnderClaudeProjects(targetPath: string): boolean {
  const root = canonicalize(claudeProjectsRoot());
  const candidate = canonicalize(targetPath);
  return candidate === root || candidate.startsWith(root + path.sep);
}

// Hard-assert the target is NOT under ~/.claude/projects/. Throws an
// ExportPathError otherwise. The export half of the read-only chokepoint: a
// save-dialog target (or a future buggy caller) cannot redirect an export/snapshot
// write under the sacred transcript tree.
export function assertNotUnderClaudeProjects(targetPath: string): void {
  if (isUnderClaudeProjects(targetPath)) {
    throw new ExportPathError(
      'Refusing to write under ~/.claude/projects/ (read-only invariant: the ' +
        'extension never writes, renames, or deletes a Claude transcript). ' +
        'Requested: ' +
        canonicalize(targetPath),
    );
  }
}
