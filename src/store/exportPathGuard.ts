import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// Pure, vscode-free guard that keeps export and snapshot writes out of ~/.claude/projects/.
// The save dialog can target any path, and its extension filter does not stop a user from
// typing an existing transcript filename.

export class ExportPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportPathError';
  }
}

// The forbidden root, anchored on os.homedir() like the other ~/.claude readers.
export function claudeProjectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

// Resolves symlinks and NTFS junctions on the longest existing prefix of the path, then
// rejoins the missing tail. A lexical check misses a junction into the projects tree, and
// realpath on the whole target throws when the file does not exist yet.
// On any fs error it returns the input so the lexical check still applies.
function resolveExistingPrefix(absPath: string): string {
  let head = absPath;
  const tail: string[] = [];
  // path.dirname returns the root unchanged, so the parent check below ends the loop.
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
      return absPath;
    }
    tail.push(path.basename(head));
    head = parent;
  }
}

// Resolves links on the existing prefix, then lowercases the whole path on win32,
// because NTFS is case-insensitive and a re-cased segment names the same location.
export function canonicalize(absPath: string): string {
  let resolved = path.normalize(path.resolve(absPath));
  resolved = resolveExistingPrefix(resolved);
  if (process.platform === 'win32') {
    resolved = resolved.toLowerCase();
  }
  return resolved;
}

// Claude Code's account and project state file and its backup sit beside ~/.claude, in the home folder.
export function claudeStateFiles(): string[] {
  const home = os.homedir();
  return [path.join(home, '.claude.json'), path.join(home, '.claude.json.backup')];
}

// True for the projects root or anything under it. The path.sep suffix keeps a sibling
// such as ~/.claude/projects-archive from matching.
export function isUnderClaudeProjects(targetPath: string): boolean {
  const root = canonicalize(claudeProjectsRoot());
  const candidate = canonicalize(targetPath);
  return candidate === root || candidate.startsWith(root + path.sep);
}

// True for the account state file or its backup in the home folder.
export function isClaudeStateFile(targetPath: string): boolean {
  const candidate = canonicalize(targetPath);
  return claudeStateFiles().some((file) => canonicalize(file) === candidate);
}

// Throws ExportPathError when the target is under ~/.claude/projects/ or is a Claude state file.
export function assertNotUnderClaudeProjects(targetPath: string): void {
  if (isClaudeStateFile(targetPath)) {
    throw new ExportPathError(
      'Refusing to write Claude Code account state (~/.claude.json or its backup). ' +
        'Requested: ' +
        canonicalize(targetPath),
    );
  }
  if (isUnderClaudeProjects(targetPath)) {
    throw new ExportPathError(
      'Refusing to write under ~/.claude/projects/ (read-only invariant: the ' +
        'extension never writes, renames, or deletes a Claude transcript). ' +
        'Requested: ' +
        canonicalize(targetPath),
    );
  }
}
