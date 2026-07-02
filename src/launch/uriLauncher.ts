// Fires Claude Code's documented URI handler to open or resume a chat. The
// verified target (anthropic.claude-code 2.1.178 handleUri, case "/open",
// session query param read via URLSearchParams.get) is:
//
//   vscode://Anthropic.claude-code/open?session=<sessionId>
//
// The authority is the cased extension id "Anthropic.claude-code" (VSCode routes
// vscode://<publisher>.<name> to that extension's registered UriHandler); it is
// NOT lowercased. The sessionId is the .jsonl filename with the extension
// stripped; it is a bare UUID and needs no encoding beyond standard query
// encoding. See DECISIONS.md (slice 0).
//
// openExternal is injected so the launcher is unit-testable with a spy and never
// imports the vscode module here. The extension host passes
// vscode.env.openExternal and builds the Uri via vscode.Uri.from.

// The open-chat command id. It lives here, next to the launcher that implements
// it, since slice s3a-view-consolidation deleted its original home (the retired
// flat Chats tree's flatProvider.ts). Every surface that opens a chat (the org
// panel, the Archive view, the kept non-view services' node builders) references
// this constant; extension.ts registers the handler that composes openChat with
// vscode.env.openExternal. A bare string constant keeps this module vscode-free.
export const OPEN_CHAT_COMMAND = 'claudeNest.openChat';

// The minimal Uri shape the launcher constructs and the opener consumes. It
// mirrors the fields of vscode.Uri that matter for routing, so a test spy can
// assert them without the vscode module.
export interface OpenUri {
  scheme: string;
  authority: string;
  path: string;
  query: string;
}

// An injected opener. In production this is backed by vscode.env.openExternal
// composed with vscode.Uri.from; in tests it is a spy capturing the OpenUri. The
// return type is unknown so it accepts vscode.env.openExternal's Thenable, a
// Promise, or void without depending on the vscode module here.
export type OpenExternal = (uri: OpenUri) => unknown;

export function buildOpenUri(sessionId: string): OpenUri {
  return {
    scheme: 'vscode',
    authority: 'Anthropic.claude-code',
    path: '/open',
    query: 'session=' + encodeURIComponent(sessionId),
  };
}

export function openChat(sessionId: string, openExternal: OpenExternal): unknown {
  return openExternal(buildOpenUri(sessionId));
}
