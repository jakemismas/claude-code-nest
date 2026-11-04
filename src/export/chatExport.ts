import { ChatRecord } from '../model/types';
import { ChatMessageBody } from '../claude/bodyReader';

// Pure formatters for the per-chat export: renderMarkdown (YAML front matter plus body) and renderJson.
// They take plain data only, so they run without vscode or the filesystem.
// Every front-matter scalar is double-quoted and escaped (yamlQuote) so a title cannot inject a second block.

// The resolved org layer for one exported chat (folder name, tags, star, link ids), built by the caller so formatters stay store-free.
export interface ExportOrgLayer {
  folder: string | null;
  tags: readonly string[];
  starred: boolean;
  links: readonly string[];
}

// Token totals in the export header: the four summary counts plus their sum (tokens only, no USD).
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

// Render one chat to Markdown: YAML front matter, the title heading, then labelled turns.
// A textless turn becomes a placeholder so the sequence stays honest without tool payloads.
export function renderMarkdown(
  record: ChatRecord,
  org: ExportOrgLayer,
  bodies: readonly ChatMessageBody[],
): string {
  const tokens = tokenSummary(record);
  const lines: string[] = [];

  // Quote and escape every scalar so no value can break the block or inject a second '---'.
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

  // Escape the title so transcript text cannot render as markup.
  lines.push('# ' + escapeMarkdownInline(record.title));
  lines.push('');

  if (bodies.length === 0) {
    // Say the transcript had no readable messages rather than emit an empty body.
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

// Render one chat to a round-trippable JSON document; JSON.stringify handles all escaping.
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

// Render a number for YAML, mapping a non-finite value to 0 so the block stays valid.
function yamlNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : '0';
}

// Render a nullable number: the literal value or the YAML null.
function yamlNumberOrNull(value: number | null): string {
  return value === null || !Number.isFinite(value) ? 'null' : String(value);
}

// Render a string array as a YAML flow sequence of escaped scalars, for example ["a", "b"].
function yamlFlowArray(values: readonly string[]): string {
  if (values.length === 0) {
    return '[]';
  }
  return '[' + values.map((v) => yamlQuote(v)).join(', ') + ']';
}

// Double-quote a string for YAML, escaping backslash, quote and control characters so a value stays on one line.
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
