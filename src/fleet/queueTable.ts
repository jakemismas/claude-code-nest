// Pure parser for a queue kept as a Markdown table. No vscode, no filesystem.
import { coerceString } from './fleetRecord';

export const MAX_QUEUE_ROWS = 500;
export const MAX_QUEUE_CELL = 200;

export interface QueueColumns {
  readonly keyColumn: string;
  readonly stageColumn: string;
  readonly titleColumn?: string;
}

export interface QueueRow {
  readonly key: string;
  readonly stage: string;
  readonly title: string | null;
}

function splitRow(line: string): string[] | null {
  const text = line.trim();
  if (!text.includes('|')) {
    return null;
  }
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && text[i + 1] === '|') {
      current += '|';
      i++;
    } else if (ch === '|') {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  if (text.startsWith('|')) {
    cells.shift();
  }
  if (text.endsWith('|') && !text.endsWith('\\|')) {
    cells.pop();
  }
  return cells.map((c) => c.trim());
}

function isSeparator(cells: readonly string[] | null): boolean {
  return cells !== null && cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
}

function columnIndex(header: readonly string[], name: string): number {
  const wanted = name.trim().toLowerCase();
  return header.findIndex((cell) => cell.toLowerCase() === wanted);
}

// Reads the first table whose header has both the key and stage columns, in row order.
// Returns an empty list when no such table exists.
export function parseQueueTable(text: string, columns: QueueColumns): QueueRow[] {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i + 1 < lines.length; i++) {
    const header = splitRow(lines[i]);
    if (header === null || !isSeparator(splitRow(lines[i + 1]))) {
      continue;
    }
    const keyIdx = columnIndex(header, columns.keyColumn);
    const stageIdx = columnIndex(header, columns.stageColumn);
    if (keyIdx === -1 || stageIdx === -1) {
      continue;
    }
    const titleIdx = columns.titleColumn === undefined ? -1 : columnIndex(header, columns.titleColumn);
    const rows: QueueRow[] = [];
    for (let j = i + 2; j < lines.length && rows.length < MAX_QUEUE_ROWS; j++) {
      const cells = splitRow(lines[j]);
      if (cells === null) {
        break;
      }
      const key = coerceString(cells[keyIdx], MAX_QUEUE_CELL);
      if (key === undefined) {
        continue;
      }
      rows.push({
        key,
        stage: coerceString(cells[stageIdx], MAX_QUEUE_CELL) ?? '',
        title: titleIdx === -1 ? null : coerceString(cells[titleIdx], MAX_QUEUE_CELL) ?? null,
      });
    }
    return rows;
  }
  return [];
}
