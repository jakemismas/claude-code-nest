import MiniSearch from './vendor/minisearch';
import { ChatRecord } from '../model/types';

// PURE, vscode-free full-text search over chat content (slice s2-fulltext-search).
// Builds a MiniSearch index from each chat's tier-A text plus, optionally, its
// on-demand body text, and answers a query with a ranked list of
// {sessionId, score, snippet}. It imports the VENDORED MiniSearch by RELATIVE
// path (never the bare specifier 'minisearch', which is not an npm dependency and
// would not ship: see DECISIONS.md 2026-06-19 Slice s2-fulltext-search), so the
// emitted CommonJS require resolves inside out/search/vendor/, which ships in the
// VSIX. This module imports NO vscode, so the headless unit gate exercises it.
//
// Body-index invariant (ARCHITECTURE.md "search-index location"): a chat's full
// BODY may be indexed for an in-memory session index (bodyText fed in by the
// caller, which reads it on demand via bodyReader and discards it), but the
// PERSISTED index (searchStore.ts) is built from tier-A fields ONLY, so no
// body-derived token is ever written to disk. This module is agnostic to that
// split: it indexes whatever SearchDoc fields it is handed. The caller
// (searchStore.ts) decides whether to include bodyText.

// One document fed into the index. sessionId is the MiniSearch id field. title,
// lastMessage, and files are the tier-A fields (always safe to index and
// persist). bodyText is the OPTIONAL full-body text (in-memory sessions only,
// never persisted); when absent the document is indexed on tier-A text alone.
export interface SearchDoc {
  sessionId: string;
  title: string;
  lastMessage: string;
  files: string;
  bodyText: string;
}

// One ranked search hit: the chat's sessionId, the MiniSearch relevance score
// (higher is more relevant), and a snippet centered on a matched term drawn from
// the best available text for that chat (body when indexed, else the tier-A
// last-message text, else the title).
export interface SearchHit {
  sessionId: string;
  score: number;
  snippet: string;
}

// The indexed field names. Kept as a const so buildIndex and search agree and a
// rename cannot drift between them.
const FIELDS = ['title', 'lastMessage', 'files', 'bodyText'];

// The MiniSearch options used for both building and (on load) reconstructing the
// index. storeFields carries the text needed to build a snippet back on every
// result without a second lookup. searchOptions enables prefix + light fuzzy so a
// partial or slightly-misspelled query still matches, and boosts the title.
function indexOptions(): ConstructorParameters<typeof MiniSearch<SearchDoc>>[0] {
  return {
    fields: FIELDS,
    idField: 'sessionId',
    storeFields: ['title', 'lastMessage', 'bodyText'],
    searchOptions: {
      prefix: true,
      fuzzy: 0.2,
      boost: { title: 2 },
    },
  };
}

// Build a fresh in-memory index from a list of documents. Tolerant of an empty
// list (returns an empty index that search() answers with []). Each field is
// coerced to a string so a malformed input cannot throw inside MiniSearch, and
// documents are deduplicated by sessionId (first-seen wins) because MiniSearch
// THROWS on a duplicate id; a pathological scan that yielded the same sessionId
// twice must degrade to one indexed document, not throw out of a content search.
export function buildIndex(docs: SearchDoc[]): MiniSearch<SearchDoc> {
  const mini = new MiniSearch<SearchDoc>(indexOptions());
  mini.addAll(dedupeById(docs.map(normalizeDoc)));
  return mini;
}

// Keep the first document seen for each sessionId; drop later duplicates. A blank
// sessionId is dropped entirely (it cannot be a real chat and MiniSearch needs a
// usable id).
function dedupeById(docs: SearchDoc[]): SearchDoc[] {
  const seen = new Set<string>();
  const out: SearchDoc[] = [];
  for (const doc of docs) {
    const id = doc.sessionId;
    if (id.length === 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(doc);
  }
  return out;
}

// Build a SearchDoc from a ChatRecord and an OPTIONAL body text. The tier-A
// fields come off the record; bodyText is supplied by the caller only for an
// in-memory session index (it is never persisted). Exported so both the in-memory
// path and the persisted (tier-A-only) path build documents the same way.
export function docFromRecord(record: ChatRecord, bodyText?: string): SearchDoc {
  return {
    sessionId: record.sessionId,
    title: record.title ?? '',
    lastMessage: record.lastMessageText ?? '',
    files: (record.filesTouched ?? []).join(' '),
    bodyText: bodyText ?? '',
  };
}

// Run a query against an index and return ranked hits with a snippet each.
// Returns [] for an empty/whitespace query or no match. The snippet is built
// from the best available stored text for the hit, centered on the first matched
// term so the matched context is visible.
export function search(
  index: MiniSearch<SearchDoc>,
  query: string,
  limit = 50,
): SearchHit[] {
  const trimmed = (query ?? '').trim();
  if (trimmed.length === 0) {
    return [];
  }
  const results = index.search(trimmed);
  const hits: SearchHit[] = [];
  for (const r of results) {
    if (hits.length >= limit) {
      break;
    }
    const sessionId = typeof r.id === 'string' ? r.id : String(r.id);
    const source = bestSnippetSource(r);
    const term = firstMatchedTerm(r);
    hits.push({
      sessionId,
      score: typeof r.score === 'number' ? r.score : 0,
      snippet: buildSnippet(source, term),
    });
  }
  return hits;
}

// The default snippet window length and the trailing/leading ellipsis marker.
export const SNIPPET_LENGTH = 160;
const ELLIPSIS = '...';

// Build a snippet from a source text centered on the first occurrence of term.
// PURE and exported so the unit gate exercises the centering/truncation directly.
// Rules:
//   - whitespace is collapsed to single spaces and the text trimmed;
//   - an empty source yields '';
//   - a source at or under SNIPPET_LENGTH is returned whole (no ellipsis);
//   - when term is found, the window is centered on the match, with a leading
//     '...' when the window does not start at the beginning and a trailing '...'
//     when it does not reach the end; the window snaps to word boundaries where
//     possible so it does not cut mid-word;
//   - when term is empty or not found, the head of the text is returned
//     (truncated with a trailing '...').
export function buildSnippet(
  source: string,
  term: string,
  windowLength = SNIPPET_LENGTH,
): string {
  const text = collapse(source);
  if (text.length === 0) {
    return '';
  }
  if (text.length <= windowLength) {
    return text;
  }

  const needle = collapse(term).toLowerCase();
  const matchIndex = needle.length > 0 ? text.toLowerCase().indexOf(needle) : -1;

  if (matchIndex < 0) {
    // No located term: return the head of the text.
    return clampHead(text, windowLength);
  }

  // Center the window on the match.
  const matchEnd = matchIndex + needle.length;
  const half = Math.floor((windowLength - needle.length) / 2);
  let start = Math.max(0, matchIndex - half);
  let end = Math.min(text.length, start + windowLength);
  // If the window hit the right edge, pull start back so the full window is used.
  start = Math.max(0, end - windowLength);

  // Snap start to a word boundary (the next space) so the snippet does not begin
  // mid-word, unless that would drop the match itself.
  if (start > 0) {
    const space = text.indexOf(' ', start);
    if (space >= 0 && space < matchIndex) {
      start = space + 1;
      end = Math.min(text.length, start + windowLength);
    }
  }
  // Snap end to a word boundary (the previous space) for the same reason, unless
  // that would cut into the match.
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end);
    if (space > matchEnd) {
      end = space;
    }
  }

  let snippet = text.slice(start, end).trim();
  if (start > 0) {
    snippet = ELLIPSIS + snippet;
  }
  if (end < text.length) {
    snippet = snippet + ELLIPSIS;
  }
  return snippet;
}

// ---- pure helpers ----

function normalizeDoc(doc: SearchDoc): SearchDoc {
  return {
    sessionId: String(doc.sessionId ?? ''),
    title: asString(doc.title),
    lastMessage: asString(doc.lastMessage),
    files: asString(doc.files),
    bodyText: asString(doc.bodyText),
  };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

// The best text to snippet from for a hit: the indexed body when present,
// otherwise the tier-A last message, otherwise the title. Reads from the stored
// fields MiniSearch returns on the result (storeFields above), so no second
// record lookup is needed.
function bestSnippetSource(result: Record<string, unknown>): string {
  const body = asString(result.bodyText);
  if (body.trim().length > 0) {
    return body;
  }
  const last = asString(result.lastMessage);
  if (last.trim().length > 0) {
    return last;
  }
  return asString(result.title);
}

// The first matched term reported by MiniSearch (the indexed token a query term
// matched), used to center the snippet. '' when none.
function firstMatchedTerm(result: { terms?: unknown }): string {
  const terms = result.terms;
  if (Array.isArray(terms) && terms.length > 0 && typeof terms[0] === 'string') {
    return terms[0];
  }
  return '';
}

function collapse(text: string): string {
  return asString(text).replace(/\s+/g, ' ').trim();
}

function clampHead(text: string, windowLength: number): string {
  if (text.length <= windowLength) {
    return text;
  }
  // Cut at the last word boundary inside the window so the head does not end
  // mid-word, then append the ellipsis.
  const slice = text.slice(0, windowLength);
  const space = slice.lastIndexOf(' ');
  const head = space > windowLength / 2 ? slice.slice(0, space) : slice;
  return head.trimEnd() + ELLIPSIS;
}
