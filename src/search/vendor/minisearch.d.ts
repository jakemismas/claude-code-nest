// Hand-thin type surface for the VENDORED MiniSearch v7.2.0 UMD module
// (./minisearch.js). It covers ONLY the constructor and the
// add/addAll/search/toJSON/loadJSON members searchIndex.ts uses, NOT the full
// upstream API. The vendored .js is plain JavaScript with no bundled types, so
// this sibling declaration is what makes `import MiniSearch from
// './vendor/minisearch'` type-check under strict mode (tsc resolves the import to
// this .d.ts; the emitted CommonJS require resolves to the sibling .js, which the
// compile step copies into out/search/vendor/). .eslintrc ignores **/*.d.ts.
// Keep it in sync if MiniSearch is ever re-vendored; widen it only as
// searchIndex.ts grows to use more of the surface.

// The indexing/search options. Only the fields searchIndex.ts sets are typed; the
// rest of MiniSearch's Options are intentionally omitted.
export interface MiniSearchOptions<T = unknown> {
  // Document field names to index (full-text searchable).
  fields: string[];
  // The id field name (defaults to 'id' upstream; we set it explicitly).
  idField?: string;
  // Field names whose values are stored on each result for retrieval.
  storeFields?: string[];
  // Default options applied to every search() call.
  searchOptions?: SearchOptions;
  // Custom field extractor (document, fieldName) -> field value.
  extractField?: (document: T, fieldName: string) => unknown;
  // Custom tokenizer (text, fieldName) -> tokens.
  tokenize?: (text: string, fieldName: string) => string[];
  // Custom per-term processor; return null/false to drop a term.
  processTerm?: (
    term: string,
    fieldName?: string,
  ) => string | string[] | null | undefined | false;
}

// Per-call search options. Only the knobs searchIndex.ts uses are typed.
export interface SearchOptions {
  // Enable prefix matching (a query term matches longer tokens).
  prefix?: boolean | ((term: string) => boolean);
  // Enable fuzzy matching within an edit distance (number) or fraction.
  fuzzy?: boolean | number | ((term: string) => boolean | number);
  // Restrict the search to a subset of indexed fields.
  fields?: string[];
  // 'OR' (default) unions term matches; 'AND' requires all terms.
  combineWith?: string;
  // Per-field score boosts.
  boost?: { [field: string]: number };
}

// One search hit. id is the document id; score is the relevance score; the
// storeFields values are spread on as additional own properties.
export interface SearchResult {
  id: string;
  score: number;
  terms: string[];
  queryTerms: string[];
  match: { [term: string]: string[] };
  [storedField: string]: unknown;
}

// The serialized index shape produced by toJSON / consumed by loadJSON. Opaque to
// callers; treated as a JSON value.
export type AsPlainObject = Record<string, unknown>;

export default class MiniSearch<T = unknown> {
  constructor(options: MiniSearchOptions<T>);
  add(document: T): void;
  addAll(documents: readonly T[]): void;
  search(query: string, searchOptions?: SearchOptions): SearchResult[];
  toJSON(): AsPlainObject;
  static loadJSON<T = unknown>(
    json: string,
    options: MiniSearchOptions<T>,
  ): MiniSearch<T>;
}
