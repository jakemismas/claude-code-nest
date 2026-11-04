// The ONLY module that imports child_process. It runs `claude agents --json` through
// execFile with a fixed binary and fixed arguments (no shell, no user input in the
// command line), a timeout and an output cap. Output is untrusted: every field is
// coerced, capped and stripped of control characters before it leaves this module.
import { execFile } from 'child_process';
import * as os from 'os';

import { coerceString, isSessionId } from '../fleet/fleetRecord';

export const AGENTS_BINARY = 'claude';
export const AGENTS_ARGS: readonly string[] = ['agents', '--json'];
export const AGENTS_TIMEOUT_MS = 5000;
export const AGENTS_MAX_BUFFER = 4 * 1024 * 1024;
export const MAX_AGENT_SESSIONS = 500;
const MAX_AGENT_FIELD = 200;

export interface AgentSession {
  readonly sessionId: string;
  readonly kind: string | null;
  readonly state: string | null;
  readonly status: string | null;
  readonly cwd: string | null;
  readonly name: string | null;
  readonly startedAt: string | null;
  readonly pid: number | null;
}

// Runs the CLI in `cwd` and resolves with its stdout. Rejects on a missing binary, a
// non-zero exit, a timeout or output over the cap.
export type AgentsRunner = (cwd: string) => Promise<string>;

export type AgentsResult =
  | { readonly ok: true; readonly sessions: readonly AgentSession[] }
  | { readonly ok: false; readonly reason: string };

function field(value: unknown): string | null {
  return coerceString(value, MAX_AGENT_FIELD) ?? null;
}

function coerceStartedAt(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return field(value);
}

function coercePid(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

// Parses the CLI output. Anything other than an array of objects yields an empty list;
// an object without a valid session id is dropped. Never throws.
export function parseAgentsOutput(stdout: string): AgentSession[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) {
    return [];
  }
  const sessions: AgentSession[] = [];
  for (const item of data) {
    if (sessions.length >= MAX_AGENT_SESSIONS) {
      break;
    }
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      continue;
    }
    const raw = item as Record<string, unknown>;
    if (!isSessionId(raw.sessionId)) {
      continue;
    }
    sessions.push({
      sessionId: raw.sessionId,
      kind: field(raw.kind),
      state: field(raw.state),
      status: field(raw.status),
      cwd: field(raw.cwd),
      name: field(raw.name),
      startedAt: coerceStartedAt(raw.startedAt),
      pid: coercePid(raw.pid),
    });
  }
  return sessions;
}

// The process runs from the home directory, never the workspace, so a binary planted in a
// repository folder cannot be picked up by the lookup.
export const execFileRunner: AgentsRunner = () =>
  new Promise<string>((resolve, reject) => {
    execFile(
      AGENTS_BINARY,
      [...AGENTS_ARGS],
      { cwd: os.homedir(), timeout: AGENTS_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: AGENTS_MAX_BUFFER, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });

// Lists the live sessions. A failing runner becomes a failed result, never a throw.
export async function listAgentSessions(runner: AgentsRunner, cwd: string): Promise<AgentsResult> {
  try {
    return { ok: true, sessions: parseAgentsOutput(await runner(cwd)) };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return { ok: false, reason: code === 'ENOENT' ? 'The claude command was not found.' : 'The claude agents command failed.' };
  }
}
