// The SOLE reader of dev/fleet.jsonl. Read-only: no write API is imported, and the
// file is read with stat plus readFile (no open handle).
import * as fs from 'fs';
import * as path from 'path';

import { foldFleet, parseFleetLine } from './fleetRecord';
import { FleetRecord, FleetState } from './types';

export const FLEET_FILE_RELATIVE = path.join('dev', 'fleet.jsonl');
export const MAX_FLEET_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_FLEET_LINE_BYTES = 16 * 1024;

export interface FleetSourceOptions {
  readonly warn?: (message: string) => void;
}

// The default fleet file paths: one per workspace folder.
export function fleetFilePaths(workspaceFolders: readonly string[]): string[] {
  return workspaceFolders.map((folder) => path.join(folder, FLEET_FILE_RELATIVE));
}

// Splits text into lines and drops any line longer than the cap. Exported for tests.
export function splitFleetLines(text: string, maxLineBytes = MAX_FLEET_LINE_BYTES): string[] {
  const lines: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim().length === 0) {
      continue;
    }
    if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
      continue;
    }
    lines.push(line);
  }
  return lines;
}

async function readFleetFile(
  filePath: string,
  warn: (message: string) => void,
): Promise<FleetRecord[]> {
  let size: number;
  try {
    const st = await fs.promises.stat(filePath);
    if (!st.isFile()) {
      return [];
    }
    size = st.size;
  } catch {
    // A missing file is the normal case for a folder with no fleet.
    return [];
  }
  if (size > MAX_FLEET_FILE_BYTES) {
    warn(`Nest skipped a fleet file larger than ${MAX_FLEET_FILE_BYTES} bytes: ${path.basename(filePath)}`);
    return [];
  }
  let text: string;
  try {
    text = await fs.promises.readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  const records: FleetRecord[] = [];
  for (const line of splitFleetLines(text)) {
    const rec = parseFleetLine(line);
    if (rec !== null) {
      records.push(rec);
    }
  }
  return records;
}

// Reads every listed fleet file and folds the records into one state. Unreadable,
// missing and oversized files contribute nothing.
export async function loadFleetState(
  filePaths: readonly string[],
  options: FleetSourceOptions = {},
): Promise<FleetState> {
  const warn = options.warn ?? (() => undefined);
  const all: FleetRecord[] = [];
  for (const filePath of new Set(filePaths)) {
    all.push(...(await readFleetFile(filePath, warn)));
  }
  return foldFleet(all);
}
