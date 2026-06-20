import { ChatRecord } from '../model/types';
import { relativeTime } from './relativeTime';

// The PURE builder for the rich hover-preview card (slice 1). It returns plain
// MARKDOWN text and takes only plain data (a ChatRecord plus the chat's resolved
// folder name and full tag set); the provider wraps the result in a
// vscode.MarkdownString. This split keeps the builder vscode-free so the headless
// unit gate covers it, mirroring the occurrence.ts / tagsProvider.ts and
// dropReducer.ts / dndController.ts vscode-free-builder convention (ARCHITECTURE.md
// "the unit test that imports the reducer must not transitively require vscode").
//
// The card is built to the BINDING UI-SPEC.md hover card (DECISIONS.md 2026-06-19
// Slice 1 reconcile): folder, age (relative time), ~token total, full tag set, and
// BOTH a first AND a last message snippet. Models and the files-touched COUNT are
// additive context below that, not a substitute for the spec fields. It is a
// PREVIEW, not a transcript renderer: it shows the bounded tier-A snippets that
// ride the scan snapshot (firstMessageText/lastMessageText), never the full body.
// The full body is read on demand by bodyReader.ts behind the "Preview Full Chat"
// command and is never held by a provider.
//
// The metadata field block is emitted with CommonMark HARD breaks (two trailing
// spaces + newline) between fields so VS Code's hover renderer (markdown-it,
// breaks:false) shows each field on its own line rather than collapsing the soft
// line breaks into one run-together paragraph.

// A short ~token badge string for a chat row description, e.g. "~12.3k tokens".
// Sums the four trusted tier-A token counts (input + output + cache creation +
// cache read) into one human figure. Returns '' when the total is 0 (no usage was
// recorded), so a usage-less chat shows no badge rather than a misleading "~0".
// Exported so the providers set the row description from the same rule the hover
// card's token line uses.
export function tokenBadge(record: ChatRecord): string {
  const total = totalTokens(record);
  if (total <= 0) {
    return '';
  }
  return '~' + formatTokens(total) + ' tokens';
}

// Build the hover-card markdown for one chat. folderName is the chat's resolved
// home folder name (null/undefined renders "Unfiled"); tags is the chat's FULL
// resolved tag label set (empty renders "none"). Both are plain values the
// provider already reads at its call site, so the builder never touches the store
// or vscode. The returned string is markdown the provider feeds to a
// vscode.MarkdownString.
export function buildChatTooltip(
  record: ChatRecord,
  folderName: string | null | undefined,
  tags: readonly string[],
): string {
  // The metadata fields render as DISTINCT lines on the card. In CommonMark /
  // markdown-it (VS Code's hover renderer, breaks:false by default) consecutive
  // non-blank lines collapse into one paragraph with soft breaks rendered as a
  // single space, which would run the fields together on one line. Joining them
  // with a CommonMark HARD break (two trailing spaces + newline) forces each field
  // onto its own line without needing isTrusted/supportHtml or a blank line per
  // field. The verifying test asserts the rendered shape via the '  \n' separator,
  // not just substring presence, so a regression to soft joins is caught.
  const HARD_BREAK = '  \n';

  const fields: string[] = [];

  // The binding UI-SPEC card fields: folder, age, ~tokens, full tag set.
  fields.push('Folder: ' + escapeMarkdown(displayFolder(folderName)));
  fields.push('Age: ' + escapeMarkdown(displayAge(record.timestamp)));
  fields.push('Tokens: ' + escapeMarkdown(displayTokens(record)));
  fields.push('Tags: ' + escapeMarkdown(displayTags(tags)));

  // Additive context (slice plan): the distinct models and the files-touched
  // COUNT. Omitted entirely when empty so a sparse chat's card stays clean.
  if (record.models.length > 0) {
    fields.push('Models: ' + escapeMarkdown(record.models.join(', ')));
  }
  if (record.filesTouched.length > 0) {
    fields.push('Files touched: ' + String(record.filesTouched.length));
  }

  const sections: string[] = [];

  // Title (bold). escapeMarkdown keeps a title containing '*', '_', '`', '[' etc.
  // from rendering as markup in the hover. Separated from the field block by a
  // blank line so the title is its own paragraph.
  sections.push('**' + escapeMarkdown(record.title) + '**');
  sections.push(fields.join(HARD_BREAK));

  // The binding UI-SPEC first/last message snippet (DECISIONS.md 2026-06-19): BOTH
  // the first and the last genuine turn, each a bounded tier-A reduction (never the
  // full body). Rendered under a rule so the block reads as a preview. Each present
  // snippet is its own hard-broken line; the whole block is omitted when neither
  // was captured. First then last, so the card reads chronologically.
  const snippetLines: string[] = [];
  const first = record.firstMessageText;
  if (first !== null && first.trim().length > 0) {
    snippetLines.push(firstSnippetLine(record.firstMessageRole) + ' ' + blockquote(first));
  }
  const last = record.lastMessageText;
  if (last !== null && last.trim().length > 0) {
    snippetLines.push(lastSnippetLine(record.lastMessageRole) + ' ' + blockquote(last));
  }
  if (snippetLines.length > 0) {
    sections.push('---' + HARD_BREAK + snippetLines.join(HARD_BREAK));
  }

  // Sections are separated by a blank line so each is its own paragraph; the hard
  // breaks WITHIN a section keep its lines distinct.
  return sections.join('\n\n');
}

// ---- display helpers (pure) ----

function displayFolder(folderName: string | null | undefined): string {
  if (folderName === null || folderName === undefined || folderName.trim().length === 0) {
    return 'Unfiled';
  }
  return folderName;
}

function displayAge(timestamp: number | null): string {
  if (timestamp === null) {
    return 'no timestamp';
  }
  const rel = relativeTime(timestamp);
  return rel.length > 0 ? rel : 'no timestamp';
}

function displayTokens(record: ChatRecord): string {
  const total = totalTokens(record);
  if (total <= 0) {
    return 'unknown';
  }
  return '~' + formatTokens(total);
}

// The FULL tag set, deduped and rendered comma-separated. Empty labels are
// dropped; an empty effective set renders "none" so the card always shows the tag
// line (the UI-SPEC card lists the full tag set).
function displayTags(tags: readonly string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const label = typeof tag === 'string' ? tag.trim() : '';
    if (label.length === 0 || seen.has(label)) {
      continue;
    }
    seen.add(label);
    out.push(label);
  }
  return out.length === 0 ? 'none' : out.join(', ');
}

function firstSnippetLine(role: 'user' | 'assistant' | null): string {
  if (role === 'user') {
    return 'First (you):';
  }
  if (role === 'assistant') {
    return 'First (Claude):';
  }
  return 'First:';
}

function lastSnippetLine(role: 'user' | 'assistant' | null): string {
  if (role === 'user') {
    return 'Last (you):';
  }
  if (role === 'assistant') {
    return 'Last (Claude):';
  }
  return 'Last:';
}

function totalTokens(record: ChatRecord): number {
  const t = record.tokenTotals;
  return t.input + t.output + t.cacheCreation + t.cacheRead;
}

// Compact a token count: under 1000 shows the integer; 1000+ shows one decimal in
// thousands (e.g. 12345 -> "12.3k"); 1,000,000+ shows one decimal in millions.
function formatTokens(total: number): string {
  if (total < 1000) {
    return String(Math.round(total));
  }
  if (total < 1_000_000) {
    return trimDecimal(total / 1000) + 'k';
  }
  return trimDecimal(total / 1_000_000) + 'm';
}

function trimDecimal(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

// Render a snippet as a single-line markdown blockquote-ish inline: collapse
// newlines (a snippet is already truncated/space-collapsed by the reader, but be
// defensive) and escape markdown so transcript content cannot inject markup.
function blockquote(text: string): string {
  return escapeMarkdown(text.replace(/\s+/g, ' ').trim());
}

// Escape the markdown control characters that would otherwise let chat content
// (a title, a snippet, a tag label) render as markup or break the card layout.
// Backslash-escapes the inline-formatting set and neutralizes a leading list/quote
// marker; newlines are collapsed by callers that need a single line.
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+!>|-]/g, (ch) => '\\' + ch);
}
