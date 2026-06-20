import * as vscode from 'vscode';
import * as exportIO from './exportIO';
import { ChatMessageBody } from '../claude/bodyReader';
import { decideRetention } from './archiveRetention';

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

// The directory Uri the archive copies live under (globalStorageUri/archive).
function archiveDir(globalStorageUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(globalStorageUri, ARCHIVE_DIR);
}

// The full Uri of one chat's body-copy file. sessionId is a UUID (separator-free),
// so it is a safe filename with no encoding needed.
function bodyFileUri(globalStorageUri: vscode.Uri, sessionId: string): vscode.Uri {
  return vscode.Uri.joinPath(archiveDir(globalStorageUri), sessionId + '.json');
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

// Prune body copies whose retention window has lapsed, using the PURE policy
// (archiveRetention.decideRetention) over each copy's own recorded {archivedAt,
// starred} and the supplied keepWindowDays + now. STARRED copies are exempt
// (decideRetention returns 'keep'), and keepWindowDays <= 0 keeps everything.
// Lists the archive dir through exportIO.listDirectory, reads each copy's envelope
// for its retention inputs, and deletes only the ones the policy returns 'prune'
// for. Returns the sessionIds pruned. Best-effort throughout: a listing or
// per-file failure is swallowed so a prune pass never breaks activation or a
// command.
export async function pruneArchivedBodies(
  globalStorageUri: vscode.Uri,
  keepWindowDays: number,
  now: number,
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
    if (decision === 'prune') {
      await deleteArchivedBody(globalStorageUri, sessionId);
      pruned.push(sessionId);
    }
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
// over fsPath, no IO.
export function archivedBodyPath(globalStorageUri: vscode.Uri, sessionId: string): string {
  return bodyFileUri(globalStorageUri, sessionId).fsPath;
}
