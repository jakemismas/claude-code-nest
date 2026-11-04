// Opens a running background chat in a VS Code terminal that runs `claude attach <id>`.
// The terminal factory and every other side effect are injected, so this module never
// imports the vscode module and never starts a process itself: the terminal's shell is
// the claude binary with fixed arguments, and nothing is sent as text to a shell.
import { SESSION_ID_RE } from '../fleet/types';

// The command id lives here so the panel can reference it without importing vscode.
export const OPEN_IN_TERMINAL_COMMAND = 'claudeNest.openInTerminal';

export const ATTACH_BINARY = 'claude';
export const ATTACH_VERB = 'attach';
export const MAX_TERMINAL_NAME = 60;
export const DEFAULT_TERMINAL_NAME = 'Claude chat';
export const OPEN_IN_TERMINAL_LABEL = 'Open in terminal';

export interface AttachTerminalOptions {
  readonly name: string;
  readonly shellPath: string;
  readonly shellArgs: readonly string[];
}

// The part of a terminal the launcher reads. vscode.Terminal satisfies it.
export interface TerminalHandle {
  readonly exitStatus: { readonly code: number | undefined } | undefined;
  show(): void;
}

export interface AttachDeps {
  createTerminal(options: AttachTerminalOptions): TerminalHandle;
  onDidCloseTerminal(listener: (terminal: TerminalHandle) => void): { dispose(): void };
  warn(message: string): void;
}

export interface OpenRunningDeps extends AttachDeps {
  // The chat is a working or needs background session in the live session list.
  isAttachable(sessionId: string): boolean;
  // False in an untrusted workspace, where no terminal is created.
  isTrusted(): boolean;
  chatName(sessionId: string): string;
  // Shows the notification and resolves true only when the button is pressed.
  offer(message: string, button: string): PromiseLike<boolean>;
  // The URI open that every other chat uses.
  openChat(sessionId: string): unknown;
}

export type OpenRunningResult = 'attached' | 'opened' | 'refused';

export function isAttachableSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

// A terminal title from a chat name: control characters removed, capped, never empty.
export function terminalName(chatName: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = chatName.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length === 0 ? DEFAULT_TERMINAL_NAME : clean.slice(0, MAX_TERMINAL_NAME);
}

export function attachTerminalOptions(sessionId: string, chatName: string): AttachTerminalOptions {
  if (!isAttachableSessionId(sessionId)) {
    throw new Error('Invalid session id');
  }
  return { name: terminalName(chatName), shellPath: ATTACH_BINARY, shellArgs: [ATTACH_VERB, sessionId] };
}

export const NOT_FOUND_WARNING =
  '"claude attach" exited with an error. The session may have ended, or the claude command is not on your PATH.';

// Creates the terminal after the id guard. A terminal that closes with a non-zero exit
// code, which is what a missing claude binary produces, raises one warning.
export function attachInTerminal(sessionId: string, chatName: string, deps: AttachDeps): boolean {
  if (!isAttachableSessionId(sessionId)) {
    deps.warn('Cannot open the chat in a terminal: the session id is not valid.');
    return false;
  }
  const terminal = deps.createTerminal(attachTerminalOptions(sessionId, chatName));
  let settled = false;
  const subscription = deps.onDidCloseTerminal((closed) => {
    if (closed !== terminal || settled) {
      return;
    }
    settled = true;
    subscription.dispose();
    const code = closed.exitStatus?.code;
    if (code !== undefined && code !== 0) {
      deps.warn(NOT_FOUND_WARNING);
    }
  });
  terminal.show();
  return true;
}

// Click on a running background chat: offer the terminal, and use the URI open when the
// chat is not attachable, the workspace is untrusted or the offer is dismissed. An
// explicit choice from the context menu skips the offer and attaches directly.
export async function openRunningChat(
  sessionId: string,
  deps: OpenRunningDeps,
  explicit = false,
): Promise<OpenRunningResult> {
  if (!isAttachableSessionId(sessionId)) {
    deps.warn('Cannot open the chat: the session id is not valid.');
    return 'refused';
  }
  if (!deps.isTrusted() || !deps.isAttachable(sessionId)) {
    await deps.openChat(sessionId);
    return 'opened';
  }
  if (explicit) {
    return attachInTerminal(sessionId, deps.chatName(sessionId), deps) ? 'attached' : 'refused';
  }
  const picked = await deps.offer('This chat is running in the background.', OPEN_IN_TERMINAL_LABEL);
  if (picked) {
    return attachInTerminal(sessionId, deps.chatName(sessionId), deps) ? 'attached' : 'refused';
  }
  await deps.openChat(sessionId);
  return 'opened';
}
