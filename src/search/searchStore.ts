import * as vscode from 'vscode';
import MiniSearch from './vendor/minisearch';
import { ChatRecord } from '../model/types';
import {
  SearchDoc,
  buildIndex,
  docFromRecord,
} from './searchIndex';
import * as exportIO from '../store/exportIO';

// vscode-THIN persistence for the full-text search index (slice
// s2-fulltext-search). It persists and loads the index ONLY through
// exportIO.writeTextFile / readTextFile against context.globalStorageUri, and
// falls back to an in-memory rebuild when no persisted file is present or it
// cannot be read/parsed. It introduces NO new fs write path (DECISIONS.md
// 2026-06-19 Slice s2-fulltext-search fold-in 1): every write goes through
// exportIO, which runtime-asserts assertNotUnderClaudeProjects before touching
// the disk, so the index can never be written under ~/.claude/projects/.
//
// NEVER SYNCED (sprint-wide hard rule, SPRINT-2-PLAN.md:67; review checkpoint 2):
// the index is a FILE in extension globalStorage, not a globalState key, so it is
// structurally outside the MetadataStore sync surface and is never registered
// with setKeysForSync. The only synced surface stays nest.meta.v1::<key>.
//
// PERSISTED INDEX = TIER-A FIELDS ONLY (ARCHITECTURE.md "search-index location";
// DECISIONS.md fold-in 3): the index this module BUILDS and PERSISTS is built
// from the tier-A fields (title, lastMessageText, filesTouched) only, so no
// body-derived token is ever written to disk. Full-body search is an in-memory
// concern: the caller builds a body-indexed index in memory (searchIndex.buildIndex
// with a bodyText fed in by bodyReader and discarded) and never hands it here.
// This keeps the "bounded reductions on the snapshot, full body never persisted"
// invariant honest.

// The fixed filename of the persisted index under the globalStorage search
// directory. A single file (the index is per-extension, scoped by the documents'
// project-derived sessionIds, which are globally unique UUIDs).
const INDEX_DIR = 'search';
const INDEX_FILE = 'nest-search-index.v1.json';

// The on-disk envelope: a schema version plus the serialized MiniSearch index.
// The version guards against loading an index written by an incompatible future
// build (a mismatch falls back to a rebuild rather than throwing).
const ENVELOPE_VERSION = 1;

interface IndexEnvelope {
  version: number;
  // The MiniSearch.toJSON() payload. Opaque here; passed back to loadJSON.
  index: unknown;
}

// The directory Uri the index file lives under (globalStorageUri/search).
function indexDir(globalStorageUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(globalStorageUri, INDEX_DIR);
}

// The full Uri of the index file.
function indexFileUri(globalStorageUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(indexDir(globalStorageUri), INDEX_FILE);
}

// The MiniSearch options used to RECONSTRUCT a persisted index with loadJSON.
// They must match the build-time options' field/store/id shape (searchIndex's
// indexOptions), so the loaded index searches identically. bodyText is listed as
// an indexable field for shape-compatibility, but a PERSISTED document never
// carried body text (tier-A only), so it contributes nothing.
function loadOptions(): ConstructorParameters<typeof MiniSearch<SearchDoc>>[0] {
  return {
    fields: ['title', 'lastMessage', 'files', 'bodyText'],
    idField: 'sessionId',
    storeFields: ['title', 'lastMessage', 'bodyText'],
    searchOptions: {
      prefix: true,
      fuzzy: 0.2,
      boost: { title: 2 },
    },
  };
}

// Build the TIER-A-ONLY documents for the persisted index from the scan records.
// No bodyText is ever included, so no body-derived token can be persisted.
export function tierADocs(records: ChatRecord[]): SearchDoc[] {
  return records.map((r) => docFromRecord(r));
}

// Persist the tier-A index built from the given records to globalStorage. Builds
// the index from tier-A fields ONLY (no bodies), serializes it, and writes it
// through exportIO (which asserts the target is not under ~/.claude/projects/).
// Best-effort: a write failure is swallowed (the index is a derived cache that a
// rebuild reconstructs), so a storage hiccup never breaks search or activation.
export async function persistTierAIndex(
  globalStorageUri: vscode.Uri,
  records: ChatRecord[],
): Promise<void> {
  try {
    const index = buildIndex(tierADocs(records));
    const envelope: IndexEnvelope = {
      version: ENVELOPE_VERSION,
      index: index.toJSON(),
    };
    await exportIO.ensureDirectory(indexDir(globalStorageUri));
    await exportIO.writeTextFile(indexFileUri(globalStorageUri), JSON.stringify(envelope));
  } catch {
    // Best-effort: the persisted index is a warm-start cache, not the source of
    // truth. A failure leaves no file and the next load falls back to a rebuild.
  }
}

// Load the persisted tier-A index from globalStorage, or rebuild it in memory
// from the given records when no valid persisted file is present. NEVER throws:
// an absent file, an unreadable file, malformed JSON, a version mismatch, or a
// loadJSON failure all fall back to a fresh in-memory rebuild from tier-A docs.
// The returned index is searchable immediately via searchIndex.search.
export async function loadOrRebuildTierAIndex(
  globalStorageUri: vscode.Uri,
  records: ChatRecord[],
): Promise<MiniSearch<SearchDoc>> {
  const loaded = await tryLoadPersisted(globalStorageUri);
  if (loaded !== null) {
    return loaded;
  }
  return buildIndex(tierADocs(records));
}

// Attempt to read and reconstruct the persisted index. Returns null on any
// failure so the caller rebuilds. Reads ONLY through exportIO.readTextFile.
async function tryLoadPersisted(
  globalStorageUri: vscode.Uri,
): Promise<MiniSearch<SearchDoc> | null> {
  let raw: string;
  try {
    raw = await exportIO.readTextFile(indexFileUri(globalStorageUri));
  } catch {
    return null;
  }
  let envelope: IndexEnvelope;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isEnvelope(parsed) || parsed.version !== ENVELOPE_VERSION) {
      return null;
    }
    envelope = parsed;
  } catch {
    return null;
  }
  try {
    return MiniSearch.loadJSON<SearchDoc>(JSON.stringify(envelope.index), loadOptions());
  } catch {
    return null;
  }
}

function isEnvelope(value: unknown): value is IndexEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { version?: unknown }).version === 'number' &&
    'index' in value
  );
}

// Exposed for the guard test: the absolute fsPath the index file resolves to
// under a given globalStorage path, so a test can assert it is under
// globalStorage and that assertNotUnderClaudeProjects throws when globalStorage
// is (pathologically) a projects path. Pure string join over fsPath.
export function indexFilePath(globalStorageUri: vscode.Uri): string {
  return indexFileUri(globalStorageUri).fsPath;
}
