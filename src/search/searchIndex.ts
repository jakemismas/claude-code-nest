import MiniSearch from './vendor/minisearch';
import { ChatRecord } from '../model/types';

// Pure full-text search over chat content: builds a MiniSearch index from each chat's summary text plus optional on-demand body text and returns ranked {sessionId, score, snippet} hits.
// It imports the vendored MiniSearch by relative path because the bare 'minisearch' specifier is not an npm dependency and would not ship in the VSIX.
// It indexes whatever SearchDoc fields it is given; the persisted index (searchStore.ts) never includes bodyText, so no body token reaches disk.

// One document fed into the index. title, lastMessage and files are summary fields, safe to index and persist. bodyText is optional full-body text for in-memory indexes only.
// bodyText has per-message role labels ("You: " / "Claude: ") stripped, since MiniSearch would otherwise index "you" and "claude" on every chat. The label rides only in bodySnippetSource, a stored but unindexed field that buildRoleSnippet uses to re-emit it.
export interface SearchDoc {
  sessionId: string;
  title: string;
  lastMessage: string;
  files: string;
  bodyText: string;
  // Role-labeled body text used only to build a snippet; stored, never indexed. Empty when no body was supplied.
  bodySnippetSource: string;
}

// One ranked hit: the sessionId, the relevance score (higher is better) and a snippet centered on a matched term from the best text available (body, else last message, else title).
export interface SearchHit {
  sessionId: string;
  score: number;
  snippet: string;
}

// The indexed field names, shared by buildIndex and search. bodySnippetSource is deliberately absent so role-label words are never tokenized. Exported so searchStore's load-time options reuse them.
export const FIELDS = ['title', 'lastMessage', 'files', 'bodyText'];

// The stored (retrieved-on-hit) field names. bodySnippetSource is stored but not indexed. Exported so searchStore's load-time options reuse them.
export const STORE_FIELDS = ['title', 'lastMessage', 'bodyText', 'bodySnippetSource'];

// MiniSearch options for building and reconstructing the index. storeFields carry the snippet text on every result; searchOptions enable prefix and light fuzzy matching and boost the title.
function indexOptions(): ConstructorParameters<typeof MiniSearch<SearchDoc>>[0] {
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

// Build an in-memory index from documents. An empty list gives an empty index. Fields are coerced to strings, and documents are deduplicated by sessionId (first wins) because MiniSearch throws on a duplicate id.
export function buildIndex(docs: SearchDoc[]): MiniSearch<SearchDoc> {
  const mini = new MiniSearch<SearchDoc>(indexOptions());
  mini.addAll(dedupeById(docs.map(normalizeDoc)));
  return mini;
}

// Keep the first document per sessionId and drop later duplicates and blank ids, which MiniSearch cannot use.
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

// Build a SearchDoc from a ChatRecord and an optional body text, which the caller supplies only for an in-memory index.
// A role-labeled body (from orgPanelWebview.readBodyText) goes to bodySnippetSource verbatim, and bodyText gets the same text with labels stripped. A body without role markers passes through unchanged in both fields.
export function docFromRecord(record: ChatRecord, bodyText?: string): SearchDoc {
  const labeled = bodyText ?? '';
  return {
    sessionId: record.sessionId,
    title: record.title ?? '',
    lastMessage: record.lastMessageText ?? '',
    files: (record.filesTouched ?? []).join(' '),
    bodyText: stripRoleLabels(labeled),
    bodySnippetSource: labeled,
  };
}

// Strip the leading role label from every newline-joined segment so the label words are never tokenized. Segments without a label are kept, and the '\n' joins keep them aligned 1:1 with the labeled source.
function stripRoleLabels(labeled: string): string {
  if (labeled.length === 0) {
    return '';
  }
  return labeled
    .split('\n')
    .map((seg) => {
      const role = roleOf(seg);
      return role === null ? seg : seg.slice(role.length);
    })
    .join('\n');
}

// Run a query and return ranked hits, each with a snippet centered on the first matched term. Returns [] for an empty or whitespace query or no match.
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
    // buildRoleSnippet re-prepends the role label when the source has role markers; otherwise the snippet is plain.
    hits.push({
      sessionId,
      score: typeof r.score === 'number' ? r.score : 0,
      snippet: buildRoleSnippet(source, term),
    });
  }
  return hits;
}

// The role labels prefixed on each message in the body feed (orgPanelWebview.readBodyText) and re-emitted on body-match snippets. Exported so the feed and snippet sides share the literal.
export const ROLE_LABEL_USER = 'You: ';
export const ROLE_LABEL_ASSISTANT = 'Claude: ';

// The default snippet window length and the trailing/leading ellipsis marker.
export const SNIPPET_LENGTH = 160;
const ELLIPSIS = '...';

// Build a snippet centered on the first occurrence of term, whitespace-collapsed and trimmed, with '...' at a trimmed edge and word-boundary snapping.
// An empty source gives ''; text at or under SNIPPET_LENGTH returns whole; an empty or missing term returns the truncated head.
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
    return clampHead(text, windowLength);
  }

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

// Role-aware snippet over a body whose messages are prefixed with role labels and joined by '\n': snippets the segment containing the match with buildSnippet and keeps the label leading, for example "You: ...".
// A source with no role labels (summary text, title, plain body) is one segment and gets the plain buildSnippet with no prefix.
export function buildRoleSnippet(
  source: string,
  term: string,
  windowLength = SNIPPET_LENGTH,
): string {
  const raw = asString(source);
  if (collapse(raw).length === 0) {
    return '';
  }
  // Split into per-message segments on the feed's newline; a segment without a role label has role null and snippets plain.
  const segments = raw.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
  const needle = collapse(term).toLowerCase();

  // Use the segment containing the term (case-insensitive); otherwise the first labelled segment, else the whole collapsed source.
  let chosen: string | null = null;
  if (needle.length > 0) {
    for (const seg of segments) {
      if (collapse(seg).toLowerCase().indexOf(needle) >= 0) {
        chosen = seg;
        break;
      }
    }
  }
  if (chosen === null) {
    chosen = segments.length > 0 ? segments[0] : raw;
  }

  const role = roleOf(chosen);
  if (role === null) {
    // No role marker anywhere in the chosen segment: plain snippet, no prefix.
    return buildSnippet(chosen, term, windowLength);
  }

  // Snippet the text after the label so the window budget goes to content, then re-prepend the label even when the match is deep and buildSnippet opens with '...'.
  const body = chosen.slice(role.length);
  const inner = buildSnippet(body, term, Math.max(8, windowLength - role.length));
  if (inner.length === 0) {
    return role.trimEnd();
  }
  return role + inner;
}

// The role label a segment opens with, or null. Case-sensitive on the exact literal the feed writes, so prose starting with "you" is not mistaken for a label.
function roleOf(segment: string): string | null {
  if (segment.startsWith(ROLE_LABEL_USER)) {
    return ROLE_LABEL_USER;
  }
  if (segment.startsWith(ROLE_LABEL_ASSISTANT)) {
    return ROLE_LABEL_ASSISTANT;
  }
  return null;
}

// ---- pure helpers ----

function normalizeDoc(doc: SearchDoc): SearchDoc {
  return {
    sessionId: String(doc.sessionId ?? ''),
    title: asString(doc.title),
    lastMessage: asString(doc.lastMessage),
    files: asString(doc.files),
    bodyText: asString(doc.bodyText),
    bodySnippetSource: asString(doc.bodySnippetSource),
  };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

// The best text to snippet from: bodySnippetSource (role-labeled, stored, never indexed), else bodyText, else the summary last message, else the title.
// It reads the stored fields on the hit, so no second record lookup is needed.
function bestSnippetSource(result: Record<string, unknown>): string {
  const body = asString(result.bodySnippetSource);
  if (body.trim().length > 0) {
    return body;
  }
  // A marker-less body has its text only in bodyText; prefer it over the summary fields.
  const plainBody = asString(result.bodyText);
  if (plainBody.trim().length > 0) {
    return plainBody;
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
