// Opens or resumes a chat through Claude Code's URI handler (2.1.178, case "/open"): vscode://Anthropic.claude-code/open?session=<sessionId>
// The authority is the cased extension id; do not lowercase it. The sessionId is the .jsonl filename without extension, a bare UUID.
// openExternal is injected, so this module never imports vscode and tests use a spy.

import { SESSION_ID_RE } from '../fleet/types';

// The open-chat command id, kept next to its implementation. Every surface that opens a chat references it; extension.ts registers the handler that composes openChat with vscode.env.openExternal.
// A bare string constant keeps this module vscode-free.
export const OPEN_CHAT_COMMAND = 'claudeNest.openChat';

// The minimal Uri shape the launcher builds, mirroring the vscode.Uri fields that matter for routing.
export interface OpenUri {
  scheme: string;
  authority: string;
  path: string;
  query: string;
}

// An injected opener (vscode.env.openExternal composed with vscode.Uri.from in production). The return type is unknown so a Thenable, Promise or void all fit.
export type OpenExternal = (uri: OpenUri) => unknown;

// A session id reaches the URI only when it matches the session id grammar.
export function isOpenableSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

export function buildOpenUri(sessionId: string): OpenUri {
  if (!isOpenableSessionId(sessionId)) {
    throw new Error('Invalid session id');
  }
  return {
    scheme: 'vscode',
    authority: 'Anthropic.claude-code',
    path: '/open',
    query: 'session=' + encodeURIComponent(sessionId),
  };
}

export function openChat(sessionId: string, openExternal: OpenExternal): unknown {
  if (!isOpenableSessionId(sessionId)) {
    return undefined;
  }
  return openExternal(buildOpenUri(sessionId));
}
