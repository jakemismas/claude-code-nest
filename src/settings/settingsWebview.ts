import * as vscode from 'vscode';
import * as fs from 'fs';
import {
  InboundMessage,
  OutboundMessage,
  SettingsIo,
  handleSettingsMessage,
  readCleanupPeriodDays,
  writeCleanupPeriodDays,
} from './claudeSettingsIO';

// The Settings webview: a gear opens a CSP-locked, nonce-scripted WebviewPanel
// that reads and edits cleanupPeriodDays. This module owns ONLY the vscode
// binding (panel lifecycle, CSP/nonce HTML assembly, asWebviewUri asset URLs,
// localResourceRoots, and the onDidReceiveMessage <-> postMessage wiring). All
// validation, read, surgical write, and the message-protocol reducer live in the
// vscode-free claudeSettingsIO chokepoint, so the protocol is unit-tested with a
// fake messenger and every write routes through the path-asserting chokepoint.
//
// Asset plumbing (ARCHITECTURE/fit patch): the CSP-locked panel loads
// media/settings.{js,css} via webview.asWebviewUri against context.extensionUri,
// and createWebviewPanel sets localResourceRoots to the media dir, or the
// nonce/CSP-locked panel silently refuses the assets. media ships in the VSIX (no
// .vscodeignore exclusion of media/), so no packaging change is needed.

export const OPEN_SETTINGS_COMMAND = 'claudeNest.openSettings';

const VIEW_TYPE = 'claudeNest.settings';

// A single reusable panel: re-opening the gear reveals the existing panel rather
// than stacking duplicates.
let activePanel: vscode.WebviewPanel | undefined;

export function openSettingsWebview(extensionUri: vscode.Uri): void {
  if (activePanel) {
    activePanel.reveal(vscode.ViewColumn.Active);
    return;
  }

  const mediaRoot = vscode.Uri.joinPath(extensionUri, 'media');
  const panel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    'Claude Code Nest Settings',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      // Without this the nonce/CSP-locked panel silently refuses media assets.
      localResourceRoots: [mediaRoot],
      retainContextWhenHidden: true,
    },
  );
  activePanel = panel;

  const io: SettingsIo = {
    read: () => readCleanupPeriodDays(),
    write: (value: number) => writeCleanupPeriodDays(value),
  };

  panel.webview.onDidReceiveMessage((raw: unknown) => {
    const message = coerceInbound(raw);
    if (message === null) {
      return;
    }
    const outbound = handleSettingsMessage(io, message);
    for (const msg of outbound) {
      void panel.webview.postMessage(msg satisfies OutboundMessage);
    }
  });

  panel.onDidDispose(() => {
    if (activePanel === panel) {
      activePanel = undefined;
    }
  });

  panel.webview.html = renderHtml(panel.webview, extensionUri, mediaRoot);
}

// Narrow an untrusted webview message to a known InboundMessage, or null. The
// webview is our own code, but onDidReceiveMessage delivers an unknown, so we
// validate the shape before handing it to the pure reducer.
function coerceInbound(raw: unknown): InboundMessage | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const obj = raw as { type?: unknown; value?: unknown };
  if (obj.type === 'ready') {
    return { type: 'ready' };
  }
  if (obj.type === 'save') {
    return { type: 'save', value: obj.value };
  }
  return null;
}

function renderHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  mediaRoot: vscode.Uri,
): string {
  const nonce = makeNonce();
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'settings.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'settings.css'));
  const cspSource = webview.cspSource;
  // CSP lock: no inline script (scripts gated to the per-load nonce), styles only
  // from the webview source, default-src none. img-src is omitted (none needed).
  const csp = [
    "default-src 'none'",
    `style-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  // The body markup ships as media/settings.html (the plan's module). The per-load
  // nonce, the CSP, and the asWebviewUri asset URLs cannot be baked into a static
  // file, so they are substituted here. A namespace-import fs read is read-only and
  // not a chokepoint concern.
  const templatePath = vscode.Uri.joinPath(extensionUri, 'media', 'settings.html').fsPath;
  const template = fs.readFileSync(templatePath, 'utf8');
  return template
    .replace(/\{\{csp\}\}/g, csp)
    .replace(/\{\{nonce\}\}/g, nonce)
    .replace(/\{\{scriptUri\}\}/g, scriptUri.toString())
    .replace(/\{\{styleUri\}\}/g, styleUri.toString());
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
