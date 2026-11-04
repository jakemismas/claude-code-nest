// Poll scheduler for the live session list. vscode-free: the runner and the clock are
// injected. It polls fast while the panel is visible, slowly otherwise, never runs two
// polls at once, and backs off while the command is unavailable.
import type { AgentSession, AgentsResult } from '../claude/agentsCli';

export const POLL_VISIBLE_MS = 10_000;
export const POLL_HIDDEN_MS = 60_000;
export const POLL_RETRY_MS = 5 * 60_000;
// Independent deadline so a hung runner cannot keep inFlight set forever.
export const POLL_WATCHDOG_MS = 15_000;

export interface PollerTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

// Polls that were started but whose underlying call has not settled. A hung child must
// not let every tick add another one.
export const MAX_UNSETTLED_POLLS = 2;

export interface AgentsPollerDeps {
  readonly poll: () => Promise<AgentsResult>;
  readonly onSessions: (sessions: readonly AgentSession[]) => void;
  readonly log?: (message: string) => void;
  readonly timers?: PollerTimers;
  // Clock for the per-poll deadline; defaults to the real one.
  readonly watchdogTimers?: PollerTimers;
  readonly watchdogMs?: number;
}

const realTimers: PollerTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class AgentsPoller {
  private readonly timers: PollerTimers;
  private readonly watchdogTimers: PollerTimers;
  private readonly watchdogMs: number;
  private unsettled = 0;
  private handle: unknown = undefined;
  private visible = false;
  private failing = false;
  private inFlight = false;
  private started = false;
  private disposed = false;

  constructor(private readonly deps: AgentsPollerDeps) {
    this.timers = deps.timers ?? realTimers;
    this.watchdogTimers = deps.watchdogTimers ?? realTimers;
    this.watchdogMs = deps.watchdogMs ?? POLL_WATCHDOG_MS;
  }

  start(): void {
    if (this.started || this.disposed) {
      return;
    }
    this.started = true;
    void this.runPoll();
  }

  // A visible panel polls sooner. Becoming visible polls now unless the command is failing.
  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) {
      return;
    }
    this.visible = visible;
    if (!this.started || this.inFlight) {
      return;
    }
    if (visible && !this.failing) {
      void this.runPoll();
    } else {
      this.schedule();
    }
  }

  // Polls now, ignoring the retry wait (for example after the workspace becomes trusted).
  retryNow(): void {
    if (this.disposed || !this.started || this.inFlight) {
      return;
    }
    void this.runPoll();
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private clear(): void {
    if (this.handle !== undefined) {
      this.timers.clearTimeout(this.handle);
      this.handle = undefined;
    }
  }

  private delay(): number {
    if (this.failing) {
      return POLL_RETRY_MS;
    }
    return this.visible ? POLL_VISIBLE_MS : POLL_HIDDEN_MS;
  }

  private schedule(): void {
    this.clear();
    if (this.disposed) {
      return;
    }
    this.handle = this.timers.setTimeout(() => {
      this.handle = undefined;
      void this.runPoll();
    }, this.delay());
  }

  private startPoll(): Promise<AgentsResult> {
    this.unsettled++;
    const call = (async () => this.deps.poll())();
    const settled = (): void => {
      this.unsettled--;
    };
    call.then(settled, settled);
    return call;
  }

  private async runPoll(): Promise<void> {
    // An overlapping poll is skipped; the running one schedules the next.
    if (this.inFlight || this.disposed) {
      return;
    }
    this.clear();
    if (this.unsettled >= MAX_UNSETTLED_POLLS) {
      this.schedule();
      return;
    }
    this.inFlight = true;
    let result: AgentsResult;
    let watchdog: unknown;
    try {
      const deadline = new Promise<AgentsResult>((resolve) => {
        watchdog = this.watchdogTimers.setTimeout(
          () => resolve({ ok: false, reason: 'The claude agents command timed out.' }),
          this.watchdogMs,
        );
      });
      // A late result from a run that lost the race is dropped with the race.
      result = await Promise.race([this.startPoll(), deadline]);
    } catch {
      result = { ok: false, reason: 'The claude agents command failed.' };
    } finally {
      if (watchdog !== undefined) {
        this.watchdogTimers.clearTimeout(watchdog);
      }
      this.inFlight = false;
    }
    if (this.disposed) {
      return;
    }
    if (result.ok) {
      this.failing = false;
      this.deps.onSessions(result.sessions);
    } else if (result.unavailable === true) {
      if (!this.failing) {
        this.deps.log?.(`${result.reason} Nest falls back to transcripts and fleet records.`);
      }
      this.failing = true;
      this.deps.onSessions([]);
    }
    // Any other failure keeps the last good sessions and retries at the normal cadence.
    this.schedule();
  }
}
