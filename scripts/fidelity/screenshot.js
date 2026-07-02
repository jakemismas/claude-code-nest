// Visual-fidelity screenshot driver (slice s3a-visual-harness, issue #79).
//
// Renders two pages at the design's 320px width via headless Chrome or Edge and
// writes full-page PNGs into .claude-working/fidelity/ (gitignored):
//
//   - harness.png      the REAL org-panel asset (media/orgPanel.{css,js}) rendered
//                      by scripts/fidelity/harness.html with synthetic mock data.
//   - prototype.png    media/design/ChatSidebar.html, the design authority.
//
// Reviewers (and the build agent) open these side by side with the committed
// reference screenshots under media/design/reference/ and eyeball the panel
// against the handoff. This slice deliberately does NO pixel diffing (a non-goal):
// the comparison is reviewer-eye plus the human gate.
//
// ZERO npm dependencies by design. The extension is zero-runtime-dependency and
// packages with `vsce package --no-dependencies`; adding puppeteer would either
// bloat the tree or (as a dep) never ship and false-pass the install proof. Node
// 20+ ships a global fetch and WebSocket, so this drives the browser directly over
// the Chrome DevTools Protocol with built-ins only. The whole scripts/ tree is
// excluded from the VSIX (.vscodeignore), so nothing here reaches a user.
//
// Read-only invariant: this script only reads repo files and writes PNGs under
// .claude-working/fidelity/. It never touches ~/.claude/projects and never writes
// under the extension's shipped tree.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

// --- paths -----------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(REPO_ROOT, '.claude-working', 'fidelity');
const HARNESS_HTML = path.join(__dirname, 'harness.html');
const PROTOTYPE_HTML = path.join(REPO_ROOT, 'media', 'design', 'ChatSidebar.html');

// The design capture width (UI-SPEC deviation 1: 320px is the reference width; the
// panel must stay sane 260-480px but the baseline screenshots are 320px).
const VIEWPORT_WIDTH = 320;
// A tall viewport so the full sectioned list fits without the page needing to
// scroll; captureBeyondViewport in the capture call still grabs anything taller.
const VIEWPORT_HEIGHT = 1400;
const DEVICE_SCALE = 2;
// The prototype frames its 320px sidebar to the RIGHT of a ~50px activity-bar rail
// inside a mock VS Code window, so at a 320px viewport the sidebar overflows and
// clips. Render it in a wider viewport, then clip the capture to the sidebar's own
// 320px box so the reference is a clean panel-only frame matching the harness.
const PROTOTYPE_VIEWPORT_WIDTH = 560;

// --- browser discovery -----------------------------------------------------

// The env override for an explicit Chrome/Edge path. When set it is AUTHORITATIVE:
// if it does not point at a real file, the run fails loudly rather than silently
// falling back to an auto-discovered browser the user did not ask for.
function browserOverride() {
  return process.env.NEST_FIDELITY_BROWSER || process.env.CHROME_PATH || '';
}

// The standard auto-discovery Chrome/Edge locations on Windows, macOS, and Linux.
// First existing file wins. Ordered Chrome-before-Edge to match the AC wording
// ("headless Chrome or Edge"). Does NOT include the env override.
function browserCandidates() {
  const list = [];
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env['LOCALAPPDATA'] || '';
  if (process.platform === 'win32') {
    list.push(
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      localAppData
        ? path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')
        : '',
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    );
  } else if (process.platform === 'darwin') {
    list.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );
  } else {
    list.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
    );
  }
  return list.filter((p) => typeof p === 'string' && p.length > 0);
}

function isExecutableFile(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// Resolve the browser to drive. Returns { path } on success, or { error } with an
// actionable message on failure. An explicit override that does not exist is a hard
// error (no silent fallback); otherwise auto-discovery walks the standard paths.
function findBrowser() {
  const override = browserOverride();
  if (override) {
    if (isExecutableFile(override)) {
      return { path: override };
    }
    return {
      error:
        'The browser path set in NEST_FIDELITY_BROWSER / CHROME_PATH does not exist:\n  ' +
        override +
        '\nPoint it at a real Chrome or Edge executable, or unset it to auto-detect.',
    };
  }
  for (const candidate of browserCandidates()) {
    if (isExecutableFile(candidate)) {
      return { path: candidate };
    }
  }
  return {
    error:
      'No headless browser found.\n' +
      'The fidelity harness needs Google Chrome or Microsoft Edge.\n' +
      'Install one, or point NEST_FIDELITY_BROWSER at a Chrome/Edge executable, then re-run:\n' +
      '  npm run fidelity\n' +
      'Looked in:\n  ' +
      browserCandidates().join('\n  '),
  };
}

// --- CDP client (built-ins only) -------------------------------------------

// A minimal Chrome DevTools Protocol client over the browser websocket. Enough to
// open a page target, attach, navigate, evaluate, and capture a screenshot. No
// third-party ws library: Node's global WebSocket carries it.
class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.sessionId = undefined;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const onError = (ev) => reject(new Error('CDP websocket error: ' + describeWsError(ev)));
      ws.addEventListener('open', () => {
        ws.removeEventListener('error', onError);
        resolve();
      });
      ws.addEventListener('error', onError);
      ws.addEventListener('message', (ev) => this.onMessage(ev.data));
      ws.addEventListener('close', () => {
        for (const [, p] of this.pending) {
          p.reject(new Error('CDP connection closed before response'));
        }
        this.pending.clear();
      });
    });
  }

  onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : data.toString());
    } catch {
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) {
        reject(new Error('CDP ' + JSON.stringify(msg.error)));
      } else {
        resolve(msg.result);
      }
    }
  }

  // Send a CDP command. When sessionId is given (after attaching to a page target)
  // the command is routed to that session via the flat protocol. The id counter and
  // the pending map live ONLY on this single client instance, so every command id
  // is globally unique across all page sessions and responses never mis-route.
  send(method, params, sessionId) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const payload = { id, method, params: params || {} };
      if (sessionId) {
        payload.sessionId = sessionId;
      }
      this.ws.send(JSON.stringify(payload));
    });
  }

  close() {
    try {
      if (this.ws) {
        this.ws.close();
      }
    } catch {
      // ignore
    }
  }
}

function describeWsError(ev) {
  if (!ev) {
    return 'unknown';
  }
  if (ev.message) {
    return ev.message;
  }
  if (ev.error && ev.error.message) {
    return ev.error.message;
  }
  return String(ev.type || 'error');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Poll the browser's /json/version until CDP answers or the deadline passes.
async function waitForCdp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/json/version');
      if (res.ok) {
        return await res.json();
      }
    } catch (e) {
      lastErr = e;
    }
    await sleep(150);
  }
  throw new Error(
    'Headless browser did not expose the DevTools endpoint on port ' +
      port +
      ' within ' +
      timeoutMs +
      'ms' +
      (lastErr ? ' (' + lastErr.message + ')' : ''),
  );
}

// --- capture ---------------------------------------------------------------

// Launch a fresh, isolated headless browser instance. A dedicated user-data-dir
// guarantees a NEW process (so a running Chrome does not swallow our flags) and
// keeps the run from touching the user's real profile.
function launchBrowser(browserPath, port, userDataDir) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--mute-audio',
    '--force-device-scale-factor=' + DEVICE_SCALE,
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + userDataDir,
    'about:blank',
  ];
  const child = spawn(browserPath, args, { stdio: 'ignore', windowsHide: true });
  return child;
}

// A per-page command sender bound to one attached target session. It DELEGATES to
// the shared CdpClient (so the id counter and pending map stay single-instance and
// command ids never collide across pages); it only carries this page's sessionId
// and exposes the shared ws for event listeners. Deliberately NOT Object.create on
// the client: that shadowed nextId per page and mis-routed responses.
class Page {
  constructor(client, sessionId, targetId) {
    this.client = client;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.ws = client.ws;
  }

  send(method, params) {
    return this.client.send(method, params, this.sessionId);
  }
}

// Open one page target, attach a session, and return a per-page command sender.
async function openPage(browser) {
  const target = await browser.send('Target.createTarget', { url: 'about:blank' });
  const attached = await browser.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  });
  return new Page(browser, attached.sessionId, target.targetId);
}

// Navigate a page session to a file URL and wait for the load event, then run
// afterLoad (async) for page-specific readiness (mock render, thumbnail hide).
// afterLoad may return a clip rect { x, y, width, height } in CSS pixels to crop
// the capture to a sub-element (the prototype frames its sidebar inside a mock VS
// Code window, so we clip to the sidebar to match the harness's panel-only frame).
async function renderAndCapture(page, fileUrl, outPath, afterLoad, viewportWidth) {
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: viewportWidth || VIEWPORT_WIDTH,
    height: VIEWPORT_HEIGHT,
    deviceScaleFactor: DEVICE_SCALE,
    mobile: false,
  });

  // Navigate and wait for the load lifecycle event.
  const loaded = waitForEvent(page, 'Page.loadEventFired', 30000);
  await page.send('Page.navigate', { url: fileUrl });
  await loaded;

  let clip = null;
  if (afterLoad) {
    clip = (await afterLoad(page)) || null;
  }

  // Grab the screenshot. captureBeyondViewport so a list taller than the viewport
  // is not clipped; when a clip rect is returned, crop to that element (at the
  // device scale the capture is taken).
  const shotParams = {
    format: 'png',
    captureBeyondViewport: true,
    fromSurface: true,
  };
  if (clip && clip.width > 0 && clip.height > 0) {
    shotParams.clip = {
      x: clip.x,
      y: clip.y,
      width: clip.width,
      height: clip.height,
      scale: 1,
    };
  }
  const shot = await page.send('Page.captureScreenshot', shotParams);
  fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
}

// Resolve when the given CDP event arrives on this session, or reject on timeout.
function waitForEvent(page, method, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      page.ws.removeEventListener('message', handler);
      reject(new Error('Timed out waiting for CDP event ' + method));
    }, timeoutMs);
    const handler = (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      // Flat protocol: the event carries our sessionId.
      if (msg.method === method && msg.sessionId === page.sessionId) {
        clearTimeout(timer);
        page.ws.removeEventListener('message', handler);
        resolve(msg.params);
      }
    };
    page.ws.addEventListener('message', handler);
  });
}

// Evaluate an expression in the page and return its JSON value.
async function evaluate(page, expression) {
  const res = await page.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error(
      'Page evaluate threw: ' +
        (res.exceptionDetails.exception
          ? res.exceptionDetails.exception.description ||
            res.exceptionDetails.exception.value
          : res.exceptionDetails.text),
    );
  }
  return res.result.value;
}

// Poll a page predicate (a JS expression returning boolean) until true or timeout.
async function waitForCondition(page, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await evaluate(page, expression);
    if (ok) {
      return;
    }
    await sleep(100);
  }
  throw new Error('Timed out waiting for ' + (label || expression));
}

// --- main ------------------------------------------------------------------

async function main() {
  const resolved = findBrowser();
  if (resolved.error) {
    fail(resolved.error);
  }
  const browserPath = resolved.path;

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const port = 9200 + Math.floor(Math.random() * 700);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-fidelity-'));
  const child = launchBrowser(browserPath, port, userDataDir);

  let launchFailed = null;
  child.on('error', (e) => {
    launchFailed = e;
  });

  let browser = null;
  try {
    if (launchFailed) {
      throw new Error('Failed to launch browser: ' + launchFailed.message);
    }
    const version = await waitForCdp(port, 15000);
    browser = new CdpClient(version.webSocketDebuggerUrl);
    await browser.connect();

    // Page 1: the real org-panel asset via the harness.
    const harnessPage = await openPage(browser);
    await renderAndCapture(
      harnessPage,
      pathToFileURL(HARNESS_HTML).href,
      path.join(OUT_DIR, 'harness.png'),
      async (page) => {
        // Wait for the mock to be posted AND for the script to render at least one
        // chat row, so we never screenshot an empty tree.
        await waitForCondition(
          page,
          'window.__nestHarnessReady === true',
          10000,
          'harness mock post',
        );
        await waitForCondition(
          page,
          "document.querySelectorAll('#list .nest-row').length > 0",
          10000,
          'harness rows to render',
        );
      },
    );
    console.log('  wrote ' + path.relative(REPO_ROOT, path.join(OUT_DIR, 'harness.png')));

    // Page 2: the design prototype. It embeds a gzip+base64 React bundle and shows
    // a full-viewport #__bundler_thumbnail placeholder until hydration. We MUST
    // wait for the real sidebar to mount and hide that placeholder, or the capture
    // is just the gray unpack screen and the visual lens goes blind.
    const protoPage = await openPage(browser);
    await renderAndCapture(
      protoPage,
      pathToFileURL(PROTOTYPE_HTML).href,
      path.join(OUT_DIR, 'prototype.png'),
      async (page) => {
        // The bundler unpacks the embedded React app asynchronously; wait until the
        // loading node is gone and real, non-bundler content has been rendered into
        // the body. The sidebar renders many elements; the placeholder/loading
        // nodes are the only #__bundler_* ones, so "real content present" is
        // "there is a sizable element that is not a bundler node".
        await waitForCondition(
          page,
          '(function(){' +
            "var loading=document.getElementById('__bundler_loading');" +
            'if(loading && loading.offsetParent!==null) return false;' +
            // A rendered sidebar has many divs beyond the two bundler wrappers.
            "var divs=document.querySelectorAll('body div');" +
            'return divs.length > 8;' +
            '})()',
          30000,
          'prototype React mount',
        );
        // Belt and suspenders: physically remove the thumbnail/loading placeholders
        // so nothing overlays the captured sidebar even if their teardown lagged.
        await evaluate(
          page,
          '(function(){' +
            "for(var id of ['__bundler_thumbnail','__bundler_loading','__bundler_err']){" +
            'var n=document.getElementById(id); if(n) n.remove();' +
            '} return true; })()',
        );
        // A short settle so fonts/layout finish before we measure and grab.
        await sleep(400);
        // Locate the 320px sidebar column (inline style: 320px wide with the
        // #E6E2D9 right border) and return its bounding box so the capture is
        // clipped to the panel only, dropping the mock window chrome and the
        // activity-bar rail. Fall back to the full page if it cannot be found.
        const rect = await evaluate(
          page,
          '(function(){' +
            "var divs=Array.prototype.slice.call(document.querySelectorAll('div'));" +
            'for(var i=0;i<divs.length;i++){' +
            '  var el=divs[i]; var cs=getComputedStyle(el);' +
            '  var r=el.getBoundingClientRect();' +
            // The sidebar is a 320px content-box column with a 1px solid right
            // border, so its bounding width is ~321px. Match a small tolerance
            // band and require the solid right border so we do not catch an inner
            // 320-ish wrapper. Require a tall box (the full-height column) too.
            '  var hasRight=parseFloat(cs.borderRightWidth)>=1 && cs.borderRightStyle==="solid";' +
            '  if(r.width>=319 && r.width<=323 && hasRight && r.height>=400){' +
            '    return {x:r.x,y:r.y,width:Math.min(r.width,320),height:r.height};' +
            '  }' +
            '}' +
            'return null;' +
            '})()',
        );
        if (!rect) {
          throw new Error(
            'Could not locate the 320px sidebar column in the prototype to clip to. ' +
              'The prototype layout may have changed; update the sidebar selector in screenshot.js.',
          );
        }
        return rect;
      },
      PROTOTYPE_VIEWPORT_WIDTH,
    );
    console.log('  wrote ' + path.relative(REPO_ROOT, path.join(OUT_DIR, 'prototype.png')));

    console.log('Fidelity screenshots written to ' + path.relative(REPO_ROOT, OUT_DIR));
    console.log('Compare by eye:');
    console.log('  harness.png (the real org-panel asset) vs media/design/reference/prototype-320.png');
    console.log('  prototype.png (freshly rendered) vs media/design/reference/prototype-320.png (drift check)');
  } catch (err) {
    fail(
      'Fidelity capture failed: ' +
        (err && err.message ? err.message : String(err)) +
        '\nBrowser used: ' +
        browserPath,
    );
  } finally {
    if (browser) {
      browser.close();
    }
    try {
      child.kill();
    } catch {
      // ignore
    }
    // Best-effort cleanup of the throwaway profile.
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function fail(message) {
  console.error('\n' + message + '\n');
  process.exit(1);
}

main();
