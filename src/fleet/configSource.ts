// The SOLE reader of .nest/config.json. Read-only: no write API is imported, and the
// file is read with stat plus readFile (no open handle). The reloader is vscode-free;
// the watcher and the clock are injected.
import * as fs from 'fs';
import * as path from 'path';

import {
  DEFAULT_NEST_CONFIG,
  MAX_CONFIG_BYTES,
  NEST_CONFIG_RELATIVE,
  ParsedNestConfig,
  parseNestConfig,
} from './nestConfig';

export const CONFIG_RELOAD_DEBOUNCE_MS = 150;

export function nestConfigPath(workspaceFolder: string): string {
  return path.join(workspaceFolder, NEST_CONFIG_RELATIVE);
}

// Reads and parses the file. A missing, unreadable or oversized file yields defaults.
export async function loadNestConfig(
  filePath: string | undefined,
  warn: (message: string) => void = () => undefined,
): Promise<ParsedNestConfig> {
  if (filePath === undefined) {
    return { config: DEFAULT_NEST_CONFIG, problems: [] };
  }
  try {
    const st = await fs.promises.stat(filePath);
    if (!st.isFile()) {
      return { config: DEFAULT_NEST_CONFIG, problems: [] };
    }
    if (st.size > MAX_CONFIG_BYTES) {
      warn(`Nest skipped a layout file larger than ${MAX_CONFIG_BYTES} bytes.`);
      return { config: DEFAULT_NEST_CONFIG, problems: ['The layout file is too large; defaults are in use.'] };
    }
  } catch {
    // A missing file is the normal case for a folder with no layout file.
    return { config: DEFAULT_NEST_CONFIG, problems: [] };
  }
  let text: string;
  try {
    text = await fs.promises.readFile(filePath, 'utf8');
  } catch {
    return { config: DEFAULT_NEST_CONFIG, problems: [] };
  }
  return parseNestConfig(text);
}

export interface ConfigTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ConfigReloaderDeps {
  readonly getPath: () => string | undefined;
  readonly onChange: (parsed: ParsedNestConfig) => void;
  readonly warn?: (message: string) => void;
  readonly timers?: ConfigTimers;
  readonly debounceMs?: number;
}

const realTimers: ConfigTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class ConfigReloader {
  private parsed: ParsedNestConfig = { config: DEFAULT_NEST_CONFIG, problems: [] };
  private handle: unknown = undefined;
  private disposed = false;
  private generation = 0;
  private readonly timers: ConfigTimers;
  private readonly debounceMs: number;

  constructor(private readonly deps: ConfigReloaderDeps) {
    this.timers = deps.timers ?? realTimers;
    this.debounceMs = deps.debounceMs ?? CONFIG_RELOAD_DEBOUNCE_MS;
  }

  getParsed(): ParsedNestConfig {
    return this.parsed;
  }

  // Loads now and publishes the result.
  async reload(): Promise<void> {
    const gen = ++this.generation;
    const next = await loadNestConfig(this.deps.getPath(), this.deps.warn);
    // A newer reload or a dispose supersedes this result.
    if (this.disposed || gen !== this.generation) {
      return;
    }
    this.parsed = next;
    this.deps.onChange(next);
  }

  // Called by the watcher on any create, change or delete of the layout file.
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
