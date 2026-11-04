// Local persistence for the Nest-owned copy of an archived chat body, written to extension globalStorage.
// All IO goes through exportIO, which refuses to write under the Claude projects directory.
// The copy is never synced; only the userArchived flag syncs.
import * as vscode from 'vscode';
import * as path from 'path';
import * as exportIO from './exportIO';
import { ChatMessageBody } from '../claude/bodyReader';
import { decideRetention } from './archiveRetention';
import { isSafeRecordId } from './schema';

// Subdir under globalStorage that holds the body copies.
const ARCHIVE_DIR = 'archive';
const ENVELOPE_VERSION = 1;

// On-disk envelope for one body copy. A version mismatch reads as absent. archivedAt and starred are
// stored so a prune can decide retention without the synced store.
export interface ArchivedBodyEnvelope {
  version: number;
  sessionId: string;
  title: string;
  archivedAt: number;
  starred: boolean;
  bodies: ChatMessageBody[];
}

// Thrown for an unsafe sessionId or a path that escapes the archive dir. Callers catch it and fail safe.
export class ArchivePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchivePathError';
  }
}

function archiveDir(globalStorageUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(globalStorageUri, ARCHIVE_DIR);
}

// Confines a body-file fsPath strictly below the archive dir (case-folded on win32), on top of the exportIO guard.
function isUnderArchiveDir(dirFsPath: string, candidateFsPath: string): boolean {
  let dir = path.normalize(path.resolve(dirFsPath));
  let candidate = path.normalize(path.resolve(candidateFsPath));
  if (process.platform === 'win32') {
    dir = dir.toLowerCase();
    candidate = candidate.toLowerCase();
  }
  return candidate.startsWith(dir + path.sep);
}

// The Uri of one chat's body-copy file. An unsafe sessionId from an untrusted import or sync is rejected
// before the path is built, and the resolved path must stay under the archive dir. Throws ArchivePathError.
function bodyFileUri(globalStorageUri: vscode.Uri, sessionId: string): vscode.Uri {
  if (!isSafeRecordId(sessionId)) {
    throw new ArchivePathError(
      'Refusing to build an archive body path for an unsafe sessionId: ' +
        JSON.stringify(sessionId),
    );
  }
  const dir = archiveDir(globalStorageUri);
  const fileUri = vscode.Uri.joinPath(dir, sessionId + '.json');
  if (!isUnderArchiveDir(dir.fsPath, fileUri.fsPath)) {
    throw new ArchivePathError(
      'Refusing an archive body path that resolves outside the archive dir: ' +
        fileUri.fsPath,
    );
  }
  return fileUri;
}

// Writes or overwrites the body copy for one archived chat, only through exportIO so the read-only guard runs.
// Returns false on failure; the synced userArchived flag stays authoritative.
export async function writeArchivedBody(
  globalStorageUri: vscode.Uri,
  envelope: { sessionId: string; title: string; archivedAt: number; starred: boolean; bodies: ChatMessageBody[] },
): Promise<boolean> {
  // Refuse empty bodies: readTranscriptBodies returns [] on any read failure, and an empty envelope
  // would read as an existing copy and block later retries. Returning false matches a storage failure.
  if (envelope.bodies.length === 0) {
    return false;
  }
  try {
    const payload: ArchivedBodyEnvelope = {
      version: ENVELOPE_VERSION,
      sessionId: envelope.sessionId,
      title: envelope.title,
      archivedAt: envelope.archivedAt,
      starred: envelope.starred,
      bodies: envelope.bodies,
    };
    await exportIO.ensureDirectory(archiveDir(globalStorageUri));
    await exportIO.writeTextFile(
      bodyFileUri(globalStorageUri, envelope.sessionId),
      JSON.stringify(payload),
    );
    return true;
  } catch {
    // Best-effort: a storage failure must not break the archive command, since the synced flag still flips.
    return false;
  }
}

// Reads a body copy back and returns null on any failure, so the Archive view and Restore degrade gracefully.
export async function readArchivedBody(
  globalStorageUri: vscode.Uri,
  sessionId: string,
): Promise<ArchivedBodyEnvelope | null> {
  let raw: string;
  try {
    raw = await exportIO.readTextFile(bodyFileUri(globalStorageUri, sessionId));
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isEnvelope(parsed) || parsed.version !== ENVELOPE_VERSION) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// Whether a copy with content exists. An envelope with empty bodies reads as absent, so a legacy empty
// copy does not stop the next pass from retrying the protective copy.
export async function hasArchivedBody(
  globalStorageUri: vscode.Uri,
  sessionId: string,
): Promise<boolean> {
  const envelope = await readArchivedBody(globalStorageUri, sessionId);
  return envelope !== null && envelope.bodies.length > 0;
}

// Deletes one chat's body copy (used by Restore). A failure leaves a stale copy that a later prune reclaims.
export async function deleteArchivedBody(
  globalStorageUri: vscode.Uri,
  sessionId: string,
): Promise<void> {
  try {
    await exportIO.deleteFile(bodyFileUri(globalStorageUri, sessionId));
  } catch {
    // Best-effort: an absent or locked copy is not an error for Restore.
  }
}

// Updates the starred flag on an existing copy without rewriting bodies, so retention sees the
// current exemption. No-op when no copy exists.
export async function updateStarFlag(
  globalStorageUri: vscode.Uri,
  sessionId: string,
  starred: boolean,
): Promise<void> {
  const existing = await readArchivedBody(globalStorageUri, sessionId);
  if (existing === null) {
    return;
  }
  if (existing.starred === starred) {
    return;
  }
  await writeArchivedBody(globalStorageUri, {
    sessionId: existing.sessionId,
    title: existing.title,
    archivedAt: existing.archivedAt,
    starred,
    bodies: existing.bodies,
  });
}

// Live-store check consulted before a prune deletes a copy; true forces keep. The copy's recorded
// starred flag can be stale (a failed write, or a star synced from another device), and trusting it
// would delete a starred chat's only durable copy.
export type LiveProtectionCheck = (sessionId: string) => boolean;

// Prunes copies the retention policy marks 'prune' and the live check does not protect, and returns
// the pruned sessionIds. Failures are swallowed so a prune never breaks activation.
export async function pruneArchivedBodies(
  globalStorageUri: vscode.Uri,
  keepWindowDays: number,
  now: number,
  isLiveProtected?: LiveProtectionCheck,
): Promise<string[]> {
  const pruned: string[] = [];
  let entries: [string, vscode.FileType][];
  try {
    entries = await exportIO.listDirectory(archiveDir(globalStorageUri));
  } catch {
    return pruned;
  }
  for (const [name, type] of entries) {
    if (type !== vscode.FileType.File || !name.endsWith('.json')) {
      continue;
    }
    const sessionId = name.slice(0, -'.json'.length);
    const envelope = await readArchivedBody(globalStorageUri, sessionId);
    if (envelope === null) {
      continue;
    }
    const decision = decideRetention({
      archivedAt: envelope.archivedAt,
      starred: envelope.starred,
      keepWindowDays,
      now,
    });
    if (decision !== 'prune') {
      continue;
    }
    // Consult live state before deleting: a star that never reached this copy must still exempt it.
    // A throwing check keeps the copy.
    if (isLiveProtected !== undefined) {
      let protectedLive: boolean;
      try {
        protectedLive = isLiveProtected(sessionId);
      } catch {
        protectedLive = true;
      }
      if (protectedLive) {
        continue;
      }
    }
    await deleteArchivedBody(globalStorageUri, sessionId);
    pruned.push(sessionId);
  }
  return pruned;
}

function isEnvelope(value: unknown): value is ArchivedBodyEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { version?: unknown }).version === 'number' &&
    typeof (value as { sessionId?: unknown }).sessionId === 'string' &&
    Array.isArray((value as { bodies?: unknown }).bodies)
  );
}

// Test helper: the absolute fsPath a chat's body copy resolves to under a globalStorage path.
// Throws ArchivePathError for an unsafe sessionId.
export function archivedBodyPath(globalStorageUri: vscode.Uri, sessionId: string): string {
  return bodyFileUri(globalStorageUri, sessionId).fsPath;
}
