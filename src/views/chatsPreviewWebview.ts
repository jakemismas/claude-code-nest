import * as vscode from 'vscode';
import { scanChats } from '../claude/chatScanner';
import { relativeTime } from './relativeTime';
import { OPEN_CHAT_COMMAND } from './flatProvider';

// PROOF-OF-CONCEPT (Tier 2 webview demo): the same chat list as claudeNest.flat,
// but rendered as a WebviewView instead of a native TreeView. It exists to show
// what visual control a webview unlocks (arbitrary colors, an inline filter box,
// recency group headers, card rows) that the TreeDataProvider API cannot express.
//
// It is intentionally additive: the native Chats tree is untouched, so the two
// render side by side in the same Activity Bar container for comparison. Data
// comes from the SAME scanChats path and opens through the SAME OPEN_CHAT_COMMAND,
// so this only swaps the rendering layer, nothing about the model.

export const CHATS_PREVIEW_VIEW = 'claudeNest.chatsPreview';

interface PreviewRow {
  sessionId: string;
  title: string;
  description: string;
  timestamp: number | null;
}

// Messages the webview posts to the host.
type Inbound =
  | { type: 'ready' }
  | { type: 'open'; sessionId: string }
  | { type: 'refresh' };

export class ChatsPreviewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workspacePath: string | undefined,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    };

    webviewView.webview.onDidReceiveMessage((raw: unknown) => {
      const msg = coerce(raw);
      if (msg === null) {
        return;
      }
      if (msg.type === 'ready' || msg.type === 'refresh') {
        this.postRows();
      } else if (msg.type === 'open') {
        void vscode.commands.executeCommand(OPEN_CHAT_COMMAND, msg.sessionId);
      }
    });

    webviewView.webview.html = this.renderHtml(webviewView.webview, mediaRoot);
  }

  private postRows(): void {
    if (this.view === undefined) {
      return;
    }
    void this.view.webview.postMessage({ type: 'rows', rows: this.buildRows() });
  }

  private buildRows(): PreviewRow[] {
    if (this.workspacePath === undefined) {
      return [];
    }
    let records;
    try {
      records = scanChats(this.workspacePath);
    } catch {
      return [];
    }
    return records.map((r) => ({
      sessionId: r.sessionId,
      title: r.title,
      description: relativeTime(r.timestamp),
      timestamp: r.timestamp,
    }));
  }

  private renderHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const nonce = makeNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'chatsPreview.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'chatsPreview.css'));
    const cspSource = webview.cspSource;
    const csp = [
      "default-src 'none'",
      `style-src ${cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${cspSource}`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link href="${styleUri}" rel="stylesheet" />
</head>
<body>
  <div class="nest-toolbar">
    <input id="filter" class="nest-filter" type="text" placeholder="Filter chats..." />
    <button id="refresh" class="nest-refresh" title="Refresh">Refresh</button>
  </div>
  <div id="list" class="nest-list"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function coerce(raw: unknown): Inbound | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const obj = raw as { type?: unknown; sessionId?: unknown };
  if (obj.type === 'ready') {
    return { type: 'ready' };
  }
  if (obj.type === 'refresh') {
    return { type: 'refresh' };
  }
  if (obj.type === 'open' && typeof obj.sessionId === 'string') {
    return { type: 'open', sessionId: obj.sessionId };
  }
  return null;
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
