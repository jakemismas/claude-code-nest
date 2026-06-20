import { ChatRecord } from '../model/types';
import { ChatMessageBody } from '../claude/bodyReader';

// PURE, vscode-free formatters for the per-chat export (Slice 5 s2-export-and-rollup).
// Two renderers: renderMarkdown (YAML front-matter org layer + a readable body) and
// renderJson (a single round-trippable JSON document). Both take only plain data (a
// ChatRecord plus its resolved org layer plus the ordered bodies from bodyReader),
// so they stay in the headless unit gate and the command layer wraps the write
// through exportIO. Nothing here touches the filesystem or vscode.
//
// FRONT-MATTER ESCAPING (slice patch "FRONT-MATTER ESCAPING/INJECTION"): the export
// front-matter carries user/transcript-derived strings (title, tags, folder name).
// A title containing a colon, a quote, a newline, or a leading '---' must not break
// the document or inject a second front-matter block. The JSON formatter gets this
// for free via JSON.stringify; the Markdown front-matter does NOT, so every scalar
// is emitted as a DOUBLE-QUOTED YAML string with its backslashes, quotes, and
// control characters escaped (yamlQuote), and the closing fence is the only '---' a
// parser can find at column 0 inside the block. chatTooltip.ts solves the
// markdown-injection twin with escapeMarkdown; this is the YAML twin.

// The resolved org layer for one exported chat: the plain folder name (null when
// unfiled), the full tag label set, the starred flag, and the link target chat ids.
// The command layer resolves these from ProjectMeta (chatMeta resolvers) before
// calling a formatter, so the formatter stays vscode-free and store-free.
export interface ExportOrgLayer {
  folder: string | null;
  tags: readonly string[];
  starred: boolean;
  links: readonly string[];
}

// The token total summary the export header carries: the four trusted tier-A counts
// plus their sum. tokens only, NO USD (slice non-goal).
interface ExportTokenSummary {
  total: number;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

// One exported turn: the role and its text (null for a textless tool turn, rendered
// as a placeholder in Markdown and carried as null in JSON).
interface ExportTurn {
  role: 'user' | 'assistant';
  text: string | null;
}

// The full JSON export shape. Round-trippable: JSON.parse(renderJson(...)) yields
// this object back. Versioned so a future incompatible layout is detectable.
export interface ChatExportJson {
  exportVersion: number;
  sessionId: string;
  title: string;
  timestamp: number | null;
  org: {
    folder: string | null;
    tags: string[];
    starred: boolean;
    links: string[];
  };
  models: string[];
  filesTouched: string[];
  tokenTotals: ExportTokenSummary;
  messageCount: number;
  messages: ExportTurn[];
}

const EXPORT_VERSION = 1;

// Render one chat to Markdown: a YAML front-matter block carrying the org layer and
// token total, then the chat title as a heading, then the ordered turns as labelled
// paragraphs. A textless turn renders a compact placeholder (mirrors the preview
// formatter) so the turn sequence stays honest without dumping tool payloads.
export function renderMarkdown(
  record: ChatRecord,
  org: ExportOrgLayer,
  bodies: readonly ChatMessageBody[],
): string {
  const tokens = tokenSummary(record);
  const lines: string[] = [];

  // YAML front-matter. Every scalar is double-quoted-and-escaped so no value can
  // break the block or inject a second '---'. Sequences (tags, links, models) are
  // rendered as quoted flow arrays for the same reason.
  lines.push('---');
  lines.push('title: ' + yamlQuote(record.title));
  lines.push('sessionId: ' + yamlQuote(record.sessionId));
  lines.push('timestamp: ' + yamlNumberOrNull(record.timestamp));
  lines.push('folder: ' + (org.folder === null ? 'null' : yamlQuote(org.folder)));
  lines.push('tags: ' + yamlFlowArray(org.tags));
  lines.push('starred: ' + (org.starred ? 'true' : 'false'));
  lines.push('links: ' + yamlFlowArray(org.links));
  lines.push('models: ' + yamlFlowArray(record.models));
  lines.push('filesTouched: ' + yamlNumber(record.filesTouched.length));
  lines.push('messageCount: ' + yamlNumber(record.messageCount));
  lines.push('tokenTotal: ' + yamlNumber(tokens.total));
  lines.push('tokenInput: ' + yamlNumber(tokens.input));
  lines.push('tokenOutput: ' + yamlNumber(tokens.output));
  lines.push('tokenCacheCreation: ' + yamlNumber(tokens.cacheCreation));
  lines.push('tokenCacheRead: ' + yamlNumber(tokens.cacheRead));
  lines.push('---');
  lines.push('');

  // Body. The title heading is escaped for markdown so it cannot render as markup
  // (mirrors chatTooltip.escapeMarkdown intent). A '#' prefix plus the escaped title.
  lines.push('# ' + escapeMarkdownInline(record.title));
  lines.push('');

  if (bodies.length === 0) {
    // No-body case (slice patch test target): the front-matter still carries the
    // full org layer; the body section states the transcript had no readable
    // messages rather than rendering an empty document.
    lines.push('_No readable messages in this transcript._');
    lines.push('');
  } else {
    for (const body of bodies) {
      lines.push('## ' + roleHeading(body.role));
      lines.push('');
      lines.push(
        body.text !== null && body.text.length > 0
          ? body.text
          : '_(no text in this turn)_',
      );
      lines.push('');
    }
  }

  return lines.join('\n').trimEnd() + '\n';
}

// Render one chat to a single round-trippable JSON document. JSON.stringify handles
// all string escaping, so a title with a colon/quote/newline is safe by construction.
export function renderJson(
  record: ChatRecord,
  org: ExportOrgLayer,
  bodies: readonly ChatMessageBody[],
): string {
  const doc: ChatExportJson = {
    exportVersion: EXPORT_VERSION,
    sessionId: record.sessionId,
    title: record.title,
    timestamp: record.timestamp,
    org: {
      folder: org.folder,
      tags: [...org.tags],
      starred: org.starred,
      links: [...org.links],
    },
    models: [...record.models],
    filesTouched: [...record.filesTouched],
    tokenTotals: tokenSummary(record),
    messageCount: record.messageCount,
    messages: bodies.map((b) => ({ role: b.role, text: b.text })),
  };
  return JSON.stringify(doc, null, 2);
}

// ---- pure helpers ----

function tokenSummary(record: ChatRecord): ExportTokenSummary {
  const t = record.tokenTotals;
  return {
    total: t.input + t.output + t.cacheCreation + t.cacheRead,
    input: t.input,
    output: t.output,
    cacheCreation: t.cacheCreation,
    cacheRead: t.cacheRead,
  };
}

function roleHeading(role: 'user' | 'assistant'): string {
  return role === 'user' ? 'You' : 'Claude';
}

// Render a number for YAML, defaulting a non-finite value to 0 so the block stays
// valid. Used for counts and token totals (always integers here).
function yamlNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : '0';
}

// Render a nullable number: the literal value or the YAML null.
function yamlNumberOrNull(value: number | null): string {
  return value === null || !Number.isFinite(value) ? 'null' : String(value);
}

// Render a string array as a YAML flow sequence of double-quoted, escaped scalars,
// e.g. ["a", "b"]. An empty array renders as []. Each element is escaped so no tag
// or link id can break the block.
function yamlFlowArray(values: readonly string[]): string {
  if (values.length === 0) {
    return '[]';
  }
  return '[' + values.map((v) => yamlQuote(v)).join(', ') + ']';
}

// Double-quote-and-escape a string for YAML. A double-quoted YAML scalar escapes the
// backslash and the double-quote with a backslash, and control characters (newline,
// carriage return, tab) with their YAML escapes, so a value containing a colon, a
// quote, a newline, or a leading '---' is contained entirely on its own quoted line
// and cannot terminate the front-matter block or inject a second one.
function yamlQuote(value: string): string {
  let out = '"';
  for (const ch of value) {
    switch (ch) {
      case '\\':
        out += '\\\\';
        break;
      case '"':
        out += '\\"';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      default:
        out += ch;
    }
  }
  return out + '"';
}

// Escape the markdown control characters in an inline string (the title heading) so
// transcript content cannot render as markup. Mirrors chatTooltip.escapeMarkdown.
function escapeMarkdownInline(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+!>|-]/g, (ch) => '\\' + ch);
}
