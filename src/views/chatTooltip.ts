import { ChatRecord } from '../model/types';
import { relativeTime } from './relativeTime';

// Pure, vscode-free builder for the hover card markdown. It shows only the bounded
// first and last message snippets from the scan snapshot; the full body is read on demand
// elsewhere.

// Row badge such as "~12.3k tokens", or '' when no usage was recorded (avoids a "~0").
export function tokenBadge(record: ChatRecord): string {
  const total = totalTokens(record);
  if (total <= 0) {
    return '';
  }
  return '~' + formatTokens(total) + ' tokens';
}

// A null folderName renders "Unfiled" and empty tags render "none".
export function buildChatTooltip(
  record: ChatRecord,
  folderName: string | null | undefined,
  tags: readonly string[],
): string {
  // The hover renderer collapses soft line breaks into one paragraph; a hard break
  // (two trailing spaces) keeps each field on its own line.
  const HARD_BREAK = '  \n';

  const fields: string[] = [];

  fields.push('Folder: ' + escapeMarkdown(displayFolder(folderName)));
  fields.push('Age: ' + escapeMarkdown(displayAge(record.timestamp)));
  fields.push('Tokens: ' + escapeMarkdown(displayTokens(record)));
  fields.push('Tags: ' + escapeMarkdown(displayTags(tags)));

  // Omitted when empty so a sparse chat's card stays clean.
  if (record.models.length > 0) {
    fields.push('Models: ' + escapeMarkdown(record.models.join(', ')));
  }
  if (record.filesTouched.length > 0) {
    fields.push('Files touched: ' + String(record.filesTouched.length));
  }

  const sections: string[] = [];

  sections.push('**' + escapeMarkdown(record.title) + '**');
  sections.push(fields.join(HARD_BREAK));

  // First then last so the card reads chronologically; omitted when neither was captured.
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

  return sections.join('\n\n');
}

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

// Deduped, blank labels dropped; an empty set renders "none" so the line always shows.
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

// 12345 becomes "12.3k"; millions use "m".
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

// Single line with markdown escaped so transcript content cannot inject markup.
function blockquote(text: string): string {
  return escapeMarkdown(text.replace(/\s+/g, ' ').trim());
}

// Backslash-escapes markdown control characters so chat content cannot render as markup.
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+!>|-]/g, (ch) => '\\' + ch);
}
