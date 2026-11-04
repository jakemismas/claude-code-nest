import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ChatRecord } from '../model/types';
import { scanTranscript, resolveTitle } from './jsonlReader';
import {
  ResolveDeps,
  resolveProjectDir,
} from './projectKeyResolver';

// Discovers Claude Code chat transcripts for a workspace and reads each into a ChatRecord.
// Read-only: it only lists and reads ~/.claude/projects/<projectDir>/*.jsonl, so bare-UUID
// transcript dirs and the "memory" sidecar dir are ignored. It takes the workspace path as
// a plain string and has no vscode dependency.

export interface ScannerOptions {
  // Defaults to ~/.claude/projects; tests point it at a scratch fixture.
  projectsRoot?: string;
  // Plain callbacks let the vscode layer show progress and cancel without this module importing vscode.
  // onProgress runs after each transcript; shouldCancel is polled before each file.
  onProgress?: (done: number, total: number) => void;
  shouldCancel?: () => boolean;
}

export function defaultProjectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

// Returns null when no project directory exists yet.
export function resolveDir(workspacePath: string, options: ScannerOptions = {}): string | null {
  const root = options.projectsRoot ?? defaultProjectsRoot();
  const deps: ResolveDeps = {
    listProjectDirs: () => listDirNames(root),
    probeCwds: (dirName: string) => probeCwds(path.join(root, dirName)),
  };
  return resolveProjectDir(workspacePath, deps);
}

// Sorted newest first, records with no timestamp last. Returns [] when the project directory
// does not resolve; an unreadable transcript is skipped. A cancel returns the sorted records
// gathered so far instead of throwing, so a cancelled refresh leaves the view consistent.
export function scanChats(workspacePath: string, options: ScannerOptions = {}): ChatRecord[] {
  const root = options.projectsRoot ?? defaultProjectsRoot();
  const dirName = resolveDir(workspacePath, options);
  if (dirName === null) {
    return [];
  }
  const projectDir = path.join(root, dirName);
  const files = globJsonl(projectDir);
  const total = files.length;
  const records: ChatRecord[] = [];

  let done = 0;
  for (const filePath of files) {
    if (options.shouldCancel?.() === true) {
      break;
    }
    const record = readChat(filePath);
    if (record !== null) {
      records.push(record);
    }
    done++;
    options.onProgress?.(done, total);
  }

  records.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  return records;
}

export interface LinkedScan {
  readonly records: ChatRecord[];
  // sessionId -> basename of the folder whose transcript directory held the chat.
  readonly sourceByChat: Map<string, string>;
}

// The folders to scan: the workspace first, then each linked folder once. The caller
// passes linked folders already expanded and checked against ~/.claude/projects.
export function foldersToScan(workspacePath: string, linkedFolders: readonly string[]): string[] {
  return [workspacePath, ...new Set(linkedFolders.filter((f) => f !== workspacePath))];
}

// Merges per-folder scan results into one list. A chat found twice keeps the first
// (workspace) copy. Sorted newest first. Pure: the caller runs scanChats per folder.
export function mergeFolderScans(
  parts: ReadonlyArray<{ folder: string; records: readonly ChatRecord[] }>,
): LinkedScan {
  const sourceByChat = new Map<string, string>();
  const byId = new Map<string, ChatRecord>();
  for (const part of parts) {
    const label = path.basename(part.folder) || part.folder;
    for (const record of part.records) {
      if (!byId.has(record.sessionId)) {
        byId.set(record.sessionId, record);
        sourceByChat.set(record.sessionId, label);
      }
    }
  }
  const records = [...byId.values()];
  records.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  return { records, sourceByChat };
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
    prNumber: scan.prNumber,
    prUrl: scan.prUrl,
    prRepository: scan.prRepository,
    gitBranch: scan.gitBranch,
    cwd: scan.cwd ?? null,
    leadingMessageUuids: scan.leadingMessageUuids,
    messageCount: scan.messageCount,
    firstMessageText: scan.firstMessageText,
    firstMessageRole: scan.firstMessageRole,
    lastMessageText: scan.lastMessageText,
    lastMessageRole: scan.lastMessageRole,
    tokenTotals: scan.tokenTotals,
    filesTouched: scan.filesTouched,
    models: scan.models,
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

// Collects each transcript's first cwd so the resolver can verify a directory match.
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
