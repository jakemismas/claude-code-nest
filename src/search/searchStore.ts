import * as vscode from 'vscode';
import MiniSearch from './vendor/minisearch';
import { ChatRecord } from '../model/types';
import {
  SearchDoc,
  buildIndex,
  docFromRecord,
  FIELDS,
  STORE_FIELDS,
} from './searchIndex';
import * as exportIO from '../store/exportIO';

// vscode-thin persistence for the full-text search index, via exportIO.writeTextFile and readTextFile under context.globalStorageUri; it rebuilds in memory when no valid file exists.
// Every write goes through exportIO, which asserts the target is not under ~/.claude/projects/. The index is a file, not a globalState key, so it is never synced.
// It persists summary fields only (title, lastMessageText, filesTouched), so no body-derived token reaches disk; body-indexed search stays in memory (searchIndex.buildIndex).

// The fixed filename of the persisted index in the globalStorage search directory; one file per extension, since sessionIds are globally unique UUIDs.
const INDEX_DIR = 'search';
const INDEX_FILE = 'nest-search-index.v1.json';

// The on-disk envelope: a schema version plus the serialized MiniSearch index. A version mismatch falls back to a rebuild rather than throwing.
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

// MiniSearch options to reconstruct a persisted index with loadJSON. They reuse searchIndex's FIELDS and STORE_FIELDS so the shape matches the build side.
// bodyText and bodySnippetSource are listed for shape compatibility; persisted documents never carry them.
function loadOptions(): ConstructorParameters<typeof MiniSearch<SearchDoc>>[0] {
  return {
    fields: FIELDS,
    idField: 'sessionId',
    storeFields: STORE_FIELDS,
    searchOptions: {
      prefix: true,
      fuzzy: 0.2,
      boost: { title: 2 },
    },
  };
}

// Build the summary-only documents for the persisted index from the scan records; no bodyText, so no body-derived token is persisted.
export function tierADocs(records: ChatRecord[]): SearchDoc[] {
  return records.map((r) => docFromRecord(r));
}

// Persist the summary index to globalStorage through exportIO. Best-effort: a write failure is swallowed because the index is a cache a rebuild reconstructs.
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
    // Best-effort warm-start cache: a failure leaves no file and the next load rebuilds.
  }
}

// Load the persisted summary index, or rebuild it in memory from the records when no valid file exists. Never throws: any read, parse, version or loadJSON failure falls back to a rebuild.
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

// Read and reconstruct the persisted index through exportIO.readTextFile; null on any failure so the caller rebuilds.
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

// Exposed for the guard test: the fsPath the index file resolves to under a given globalStorage path.
export function indexFilePath(globalStorageUri: vscode.Uri): string {
  return indexFileUri(globalStorageUri).fsPath;
}
