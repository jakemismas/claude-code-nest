import * as vscode from 'vscode';
import * as path from 'path';
import * as exportIO from './exportIO';
import { ChatMessageBody } from '../claude/bodyReader';
import { decideRetention } from './archiveRetention';
import { isSafeRecordId } from './schema';

// vscode-THIN persistence for the Nest-owned ARCHIVED CHAT BODY copy (Slice 4
// s2-star-archive). When the user archives a chat, the full transcript body is
// read once on demand (bodyReader, in the command layer) and a Nest-owned copy is
// written HERE so the chat survives Claude's cleanup of ~/.claude/projects.
//
// READ-ONLY INVARIANT (ARCHITECTURE.md "Read-only invariant"; SPRINT-2-PLAN.md:70
// "Archive is an org-layer flag plus a Nest-owned exported body copy under
// globalStorage; it never renames, moves, or deletes anything under
// ~/.claude/projects"): this module mirrors searchStore.ts EXACTLY. It does NO
// node fs and NO direct vscode.workspace.fs; every write/read/list/delete goes
// through exportIO (exportIO.writeTextFile / readTextFile / listDirectory /
// deleteFile / ensureDirectory), which runtime-asserts assertNotUnderClaudeProjects
// before every write/createDirectory/delete. So this module is under the FULL
// read-only lint bank (it is NOT a carve-out) and cannot write a transcript: the
// only write path is exportIO, whose target here is always
// context.globalStorageUri/archive, never ~/.claude/projects.
//
// LOCAL, NEVER SYNCED (slice patch "GLOBALSTORAGE BODY-COPY CONVENTION";
// SPRINT-2-PLAN.md:68,70): the body copy is a FILE in extension globalStorage, not
// a globalState key, so it is structurally outside the MetadataStore sync surface
// and is never registered with setKeysForSync. The only synced surface stays
// nest.meta.v1::<key> (and the curation scalars on it). The user-archive FLAG
// (ChatMeta.userArchived) syncs; the body COPY does not.
//
// One file per archived chat, keyed by the sessionId (a separator-free UUID), so
// the filename is collision-free and needs no encoding. The stored envelope
// carries the archive timestamp and the starred flag so a prune pass can decide
// retention WITHOUT re-reading the synced store, plus the ordered message bodies.

// The fixed subdir under globalStorage the body copies live in (mirrors
// searchStore's 'search' subdir convention).
const ARCHIVE_DIR = 'archive';
const ENVELOPE_VERSION = 1;

// The on-disk envelope for one archived chat body copy. version guards a future
// incompatible layout (a mismatch reads as absent). sessionId / title carry
// identity for the Archive view to render the copy even when the live transcript
// is gone. archivedAt and starred are the retention inputs captured at write time;
// archivedAt is refreshed on each (re)write and starred is updated by
// updateStarFlag so a prune reads current state from the copy itself. bodies are
// the ordered user/assistant message bodies from bodyReader.
export interface ArchivedBodyEnvelope {
  version: number;
  sessionId: string;
  title: string;
  archivedAt: number;
  starred: boolean;
  bodies: ChatMessageBody[];
}

// Thrown when a body-file sessionId is not a safe record id, or when the resolved
// path would escape the archive directory. A path-traversal sessionId
// ('../../../x') reaches a filesystem sink here (Uri.joinPath collapses '..'), so
// the path is built ONLY after both guards pass. Every caller wraps the build in a
// try/catch and fails safe (no write, no delete, null read), so a thrown guard is
// a no-op for the command, never a crash.
export class ArchivePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchivePathError';
  }
}

// The directory Uri the archive copies live under (globalStorageUri/archive).
function archiveDir(globalStorageUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(globalStorageUri, ARCHIVE_DIR);
}

// Confine a resolved body-file fsPath UNDER the archive directory. Normalizes both
// sides (lexical resolve; on win32 also case-fold to match NTFS's
// case-insensitivity, mirroring exportPathGuard.canonicalize) and requires the
// candidate to sit strictly below the dir, never to equal it or escape it. This is
// the defense-in-depth layer asked for on TOP of the existing
// assertNotUnderClaudeProjects guard inside exportIO: even if a future change let an
// unsafe id slip the isSafeRecordId check, a path that resolves outside the archive
// dir is rejected here before any IO. Pure string math over fsPath, no IO.
function isUnderArchiveDir(dirFsPath: string, candidateFsPath: string): boolean {
  let dir = path.normalize(path.resolve(dirFsPath));
  let candidate = path.normalize(path.resolve(candidateFsPath));
  if (process.platform === 'win32') {
    dir = dir.toLowerCase();
    candidate = candidate.toLowerCase();
  }
  return candidate.startsWith(dir + path.sep);
}

// The full Uri of one chat's body-copy file. A legitimate sessionId is a UUID
// (separator-free) that passes isSafeRecordId, so a safe filename needs no
// encoding. An UNSAFE sessionId (a path-traversal string, a prototype name, an
// over-long or illegal value from an untrusted import/sync that re-keyed a chat
// under it) is REJECTED here, before the path is built, so it can never reach the
// filesystem sink. As defense in depth the resolved path is then asserted to stay
// UNDER the archive dir, so a future bypass of the id check still cannot escape
// globalStorage. Throws ArchivePathError on either failure; callers fail safe.
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

// Write (or overwrite) the Nest-owned body copy for one archived chat. Creates the
// archive dir before the first write (ensureDirectory is idempotent). Goes ONLY
// through exportIO, so the read-only guard runs before the bytes land and the
// target can never be a transcript path. Returns true on success, false on a
// swallowed failure (the copy is best-effort durability, not the source of truth;
// the synced userArchived flag is authoritative for membership).
export async function writeArchivedBody(
  globalStorageUri: vscode.Uri,
  envelope: { sessionId: string; title: string; archivedAt: number; starred: boolean; bodies: ChatMessageBody[] },
): Promise<boolean> {
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
    // Best-effort: a storage hiccup (or the read-only guard firing on a
    // pathological globalStorage) must not break the archive command. The synced
    // userArchived flag still flips; only the durable body copy is missing, and a
    // later re-archive retries.
    return false;
  }
}

// Read one archived chat's body copy back. Returns null on any failure (absent
// file, unreadable, malformed JSON, version mismatch), NEVER throwing, so the
// Archive view and a Restore degrade gracefully when a copy is missing.
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

// Delete one archived chat's body copy (used by Restore: clearing the
// userArchived flag also removes the now-redundant Nest-owned copy). Best-effort:
// a swallowed failure leaves a stale copy that a later prune reclaims. Goes only
// through exportIO.deleteFile, whose guard asserts the target is not a transcript.
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

// Update the starred flag recorded on an existing body copy WITHOUT rewriting the
// bodies. Star/unstar of an archived chat must keep the copy's retention input
// (starred) current so a later prune reads the right exemption. Reads the copy,
// flips the flag, rewrites the envelope. No-op (best-effort) when no copy exists.
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

// A live-store backstop the prune consults BEFORE deleting a copy. Given a copy's
// sessionId, it reports whether the LIVE synced state still protects that chat,
// i.e. the chat is still userArchived and either starred or otherwise must not lose
// its only durable form. Returns true to FORCE keep regardless of the copy's own
// recorded {archivedAt, starred}. Optional: when absent, prune falls back to the
// copy's recorded snapshot alone (the historical behavior).
//
// This closes the drift hole: the copy's recorded `starred` is updated only by
// updateStarFlag, which is best-effort (a swallowed write failure, a star applied
// where the copy never landed, or a star synced from another device that never
// touched this install's copy can all leave the copy's snapshot stale-false while
// the live synced flag is true). Trusting only the on-disk snapshot would then prune
// a copy the user explicitly starred (the documented "do not lose this" signal),
// which is silent, permanent loss of the chat's survival mechanism. The backstop
// reads the live synced flag so a starred-but-stale-snapshot copy is never deleted.
export type LiveProtectionCheck = (sessionId: string) => boolean;

// Prune body copies whose retention window has lapsed, using the PURE policy
// (archiveRetention.decideRetention) over each copy's own recorded {archivedAt,
// starred} and the supplied keepWindowDays + now. STARRED copies are exempt
// (decideRetention returns 'keep'), and keepWindowDays <= 0 keeps everything.
// Lists the archive dir through exportIO.listDirectory, reads each copy's envelope
// for its retention inputs, and deletes only the ones the policy returns 'prune'
// for AND the live-store backstop does not protect. Returns the sessionIds pruned.
// Best-effort throughout: a listing or per-file failure is swallowed so a prune
// pass never breaks activation or a command, and a throwing backstop fails SAFE
// (the copy is kept).
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
    // The copy's own snapshot says prune. Before deleting, consult the live synced
    // state: a star (or other protection) that never reached this copy must still
    // exempt it. A throwing backstop fails safe toward KEEP.
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

// Exposed for the guard test (mirrors searchStore.indexFilePath): the absolute
// fsPath one chat's body copy resolves to under a given globalStorage path, so a
// test can assert it is under globalStorage and that assertNotUnderClaudeProjects
// throws when globalStorage is (pathologically) a projects path. Pure string join
// over fsPath, no IO. Throws ArchivePathError when sessionId is unsafe or resolves
// outside the archive dir (the bodyFileUri guards), which a test can assert.
export function archivedBodyPath(globalStorageUri: vscode.Uri, sessionId: string): string {
  return bodyFileUri(globalStorageUri, sessionId).fsPath;
}
