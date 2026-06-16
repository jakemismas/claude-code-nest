import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ChatRecord } from '../model/types';
import { scanTranscript, resolveTitle } from './jsonlReader';
import {
  ResolveDeps,
  resolveProjectDir,
} from './projectKeyResolver';

// Discovers Claude Code chat transcripts for a workspace and reads each into a
// ChatRecord. STRICTLY READ-ONLY: this module only globs and reads files under
// ~/.claude/projects/<projectDir>/*.jsonl. It never writes, renames, moves, or
// deletes anything there. It globs *.jsonl ONLY, so bare-UUID transcript dirs
// and the "memory" sidecar dir are ignored.
//
// This module is vscode-free (it takes the workspace path as a plain string),
// so the extension host wires it to the active workspace folder.

export interface ScannerOptions {
  // Override the projects root, used by tests to point at a scratch fixture.
  // Defaults to ~/.claude/projects.
  projectsRoot?: string;
}

export function defaultProjectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

// Resolve the project directory for a workspace path against the on-disk dirs,
// using the tolerant resolver (case-insensitive drive letter plus cwd scan
// self-verify). Returns null when no project directory exists yet.
export function resolveDir(workspacePath: string, options: ScannerOptions = {}): string | null {
  const root = options.projectsRoot ?? defaultProjectsRoot();
  const deps: ResolveDeps = {
    listProjectDirs: () => listDirNames(root),
    probeCwds: (dirName: string) => probeCwds(path.join(root, dirName)),
  };
  return resolveProjectDir(workspacePath, deps);
}

// Scan all transcripts for a workspace into ChatRecords, sorted newest first
// (records with no timestamp sort last). Returns [] when the project directory
// does not resolve or contains no *.jsonl files; never throws on a malformed or
// unreadable individual transcript.
export function scanChats(workspacePath: string, options: ScannerOptions = {}): ChatRecord[] {
  const root = options.projectsRoot ?? defaultProjectsRoot();
  const dirName = resolveDir(workspacePath, options);
  if (dirName === null) {
    return [];
  }
  const projectDir = path.join(root, dirName);
  const records: ChatRecord[] = [];

  for (const filePath of globJsonl(projectDir)) {
    const record = readChat(filePath);
    if (record !== null) {
      records.push(record);
    }
  }

  records.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  return records;
}

// Read one transcript into a ChatRecord. Returns null only when the file cannot
// be read at all; an empty or title-less transcript still yields a record whose
// title falls back to the sessionId.
export function readChat(filePath: string): ChatRecord | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const sessionId = sessionIdFromPath(filePath);
  const scan = scanTranscript(content);
  const title = resolveTitle(scan) ?? sessionId;
  return {
    sessionId,
    title,
    timestamp: scan.timestamp,
    filePath,
  };
}

// The sessionId is the .jsonl filename with the extension stripped.
export function sessionIdFromPath(filePath: string): string {
  return path.basename(filePath, '.jsonl');
}

function globJsonl(projectDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => path.join(projectDir, e.name));
}

function listDirNames(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

// Read transcript cwd fields from a project dir for the resolver's scan-fallback
// self-verification. Reads at most a few lines per transcript, just enough to
// surface a cwd. Read-only; tolerant of malformed files.
function probeCwds(projectDir: string): string[] {
  const cwds = new Set<string>();
  for (const filePath of globJsonl(projectDir)) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const cwd = firstCwd(content);
    if (cwd !== null) {
      cwds.add(cwd);
    }
  }
  return Array.from(cwds);
}

function firstCwd(content: string): string | null {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const obj = JSON.parse(line) as { cwd?: unknown };
      if (typeof obj.cwd === 'string' && obj.cwd.length > 0) {
        return obj.cwd;
      }
    } catch {
      continue;
    }
  }
  return null;
}
