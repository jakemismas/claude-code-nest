// The SOLE reader of the queue file named by queue.file in .nest/config.json.
// Read-only: no write API is imported, and the file is read with stat plus readFile.
import * as fs from 'fs';
import * as path from 'path';

import { ExpandDeps, NestQueueConfig, defaultExpandDeps, expandHome, isUnderProjectsRoot } from './nestConfig';
import { QueueRow, parseQueueTable } from './queueTable';
import { SingleFlight } from './singleFlight';

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

export const QUEUE_RELOAD_DEBOUNCE_MS = 250;

export interface QueueTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface QueueReloaderDeps {
  readonly getQueue: () => NestQueueConfig | null;
  readonly getWorkspaceFolder: () => string | undefined;
  readonly isTrusted: () => boolean;
  readonly onRows: (rows: QueueRow[]) => void;
  readonly warn?: (message: string) => void;
  readonly expandDeps?: ExpandDeps;
  readonly timers?: QueueTimers;
  readonly debounceMs?: number;
}

const realTimers: QueueTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

// The path to watch for the current queue setting, or undefined when no queue is read
// (no setting, no workspace, untrusted workspace or an excluded location).
export function currentQueuePath(deps: Pick<QueueReloaderDeps, 'getQueue' | 'getWorkspaceFolder' | 'isTrusted' | 'expandDeps'>): string | undefined {
  const queue = deps.getQueue();
  const folder = deps.getWorkspaceFolder();
  if (queue === null || folder === undefined || !deps.isTrusted()) {
    return undefined;
  }
  return resolveQueuePath(queue.file, folder, deps.expandDeps) ?? undefined;
}

// Debounced queue reload with one load in flight. vscode-free: the clock is injected.
export class QueueReloader {
  private handle: unknown = undefined;
  private disposed = false;
  private readonly timers: QueueTimers;
  private readonly debounceMs: number;
  private readonly flight = new SingleFlight(
    () => this.loadOnce(),
    () => this.disposed,
  );

  constructor(private readonly deps: QueueReloaderDeps) {
    this.timers = deps.timers ?? realTimers;
    this.debounceMs = deps.debounceMs ?? QUEUE_RELOAD_DEBOUNCE_MS;
  }

  reload(): Promise<void> {
    return this.flight.run();
  }

  private async loadOnce(): Promise<void> {
    const rows = await loadQueueRows(this.deps.getQueue(), this.deps.getWorkspaceFolder(), {
      trusted: this.deps.isTrusted(),
      deps: this.deps.expandDeps,
      warn: this.deps.warn,
    });
    if (!this.disposed) {
      this.deps.onRows(rows);
    }
  }

  // Called by the watcher on any create, change or delete of the queue file.
  notifyFileEvent(): void {
    if (this.disposed) {
      return;
    }
    if (this.handle !== undefined) {
      this.timers.clearTimeout(this.handle);
    }
    this.handle = this.timers.setTimeout(() => {
      this.handle = undefined;
      void this.reload();
    }, this.debounceMs);
  }

  dispose(): void {
    this.disposed = true;
    if (this.handle !== undefined) {
      this.timers.clearTimeout(this.handle);
      this.handle = undefined;
    }
  }
}
