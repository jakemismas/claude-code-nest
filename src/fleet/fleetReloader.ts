// Debounced reload controller. vscode-free: the watcher and the clock are injected.
import { loadFleetState } from './fleetSource';
import { EMPTY_FLEET_STATE, FleetState } from './types';

export const FLEET_RELOAD_DEBOUNCE_MS = 250;

export interface FleetTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface FleetReloaderDeps {
  readonly getPaths: () => readonly string[];
  readonly onChange: (state: FleetState) => void;
  readonly warn?: (message: string) => void;
  readonly timers?: FleetTimers;
  readonly debounceMs?: number;
}

const realTimers: FleetTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class FleetReloader {
  private state: FleetState = EMPTY_FLEET_STATE;
  private handle: unknown = undefined;
  private disposed = false;
  private generation = 0;
  private readonly timers: FleetTimers;
  private readonly debounceMs: number;

  constructor(private readonly deps: FleetReloaderDeps) {
    this.timers = deps.timers ?? realTimers;
    this.debounceMs = deps.debounceMs ?? FLEET_RELOAD_DEBOUNCE_MS;
  }

  getState(): FleetState {
    return this.state;
  }

  // Loads now and publishes the result.
  async reload(): Promise<void> {
    const gen = ++this.generation;
    const next = await loadFleetState(this.deps.getPaths(), { warn: this.deps.warn });
    // A newer reload or a dispose supersedes this result.
    if (this.disposed || gen !== this.generation) {
      return;
    }
    this.state = next;
    this.deps.onChange(next);
  }

  // Called by the watcher on any create, change or delete of a fleet file.
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
