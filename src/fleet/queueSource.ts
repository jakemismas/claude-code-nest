// The SOLE reader of the queue file named by queue.file in .nest/config.json.
// Read-only: no write API is imported, and the file is read with stat plus readFile.
import * as fs from 'fs';
import * as path from 'path';

import { ExpandDeps, NestQueueConfig, defaultExpandDeps, expandHome, isUnderProjectsRoot } from './nestConfig';
import { QueueRow, parseQueueTable } from './queueTable';

export const MAX_QUEUE_FILE_BYTES = 256 * 1024;

// Resolves `~` and relative paths (against the first workspace folder). Returns null
// when the path lands in the Claude transcript directory, by path or by realpath.
export function resolveQueuePath(
  file: string,
  workspaceFolder: string,
  deps: ExpandDeps = defaultExpandDeps(),
): string | null {
  const expanded = expandHome(file, deps.homedir);
  const resolved = path.normalize(path.isAbsolute(expanded) ? expanded : path.join(workspaceFolder, expanded));
  if (isUnderProjectsRoot(resolved, deps) || isUnderProjectsRoot(path.dirname(resolved), deps)) {
    return null;
  }
  return resolved;
}

export interface QueueLoadOptions {
  readonly trusted: boolean;
  readonly deps?: ExpandDeps;
  readonly warn?: (message: string) => void;
}

// Reads and parses the queue. A missing, unreadable, oversized or excluded file, an
// untrusted workspace, or no queue setting all yield an empty list.
export async function loadQueueRows(
  queue: NestQueueConfig | null,
  workspaceFolder: string | undefined,
  options: QueueLoadOptions,
): Promise<QueueRow[]> {
  if (queue === null || workspaceFolder === undefined || !options.trusted) {
    return [];
  }
  const filePath = resolveQueuePath(queue.file, workspaceFolder, options.deps);
  if (filePath === null) {
    options.warn?.('Nest ignored a queue file that resolves into the Claude transcript directory.');
    return [];
  }
  try {
    const st = await fs.promises.stat(filePath);
    if (!st.isFile()) {
      return [];
    }
    if (st.size > MAX_QUEUE_FILE_BYTES) {
      options.warn?.(`Nest skipped a queue file larger than ${MAX_QUEUE_FILE_BYTES} bytes.`);
      return [];
    }
    const text = await fs.promises.readFile(filePath, 'utf8');
    return parseQueueTable(text, {
      keyColumn: queue.keyColumn,
      stageColumn: queue.stageColumn,
      titleColumn: queue.titleColumn,
    });
  } catch {
    return [];
  }
}
