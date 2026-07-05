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

// Set an <input>'s value the way a real keystroke would and fire the 'input' event
// the panel (and React, in the prototype) listens on. Uses the native value setter
// so a controlled React input actually updates. selector picks the input; text is
// the query to stage. Returns 'ok' or a diagnostic string.
async function typeIntoInput(page, selector, text) {
  return evaluate(
    page,
    '(function(){' +
      'var inp=document.querySelector(' +
      JSON.stringify(selector) +
      ');' +
      "if(!inp) return 'no-input';" +
      "var set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;" +
      'set.call(inp, ' +
      JSON.stringify(text) +
      ');' +
      "inp.dispatchEvent(new Event('input',{bubbles:true}));" +
      "return 'ok';" +
      '})()',
  );
}

// Locate the prototype's 320px sidebar column and return its bounding box so the
// capture is clipped to the panel only (dropping the mock window chrome and the
// activity-bar rail), matching the harness's panel-only frame. The column is a
// 320px content-box with a 1px solid right border, so its bounding width is ~321px;
// match a small tolerance band, require the solid right border, and require a tall
// box. Throws with an actionable message when the column cannot be found (the
// prototype layout changed). Shared by every prototype capture stage.
async function clipToSidebar(page) {
  const rect = await evaluate(
    page,
    '(function(){' +
      "var divs=Array.prototype.slice.call(document.querySelectorAll('div'));" +
      'for(var i=0;i<divs.length;i++){' +
      '  var el=divs[i]; var cs=getComputedStyle(el);' +
      '  var r=el.getBoundingClientRect();' +
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
}

// The query the results-state captures stage. It matches a body line in the mock
// (the harness reply) and the prototype's c2 body ("...backed by Redis...") while
// being ABSENT from those chats' titles, so the flat "N RESULTS" list shows a
// role-prefixed "You: ..." body-match snippet (issue #83 AC #1/#6).
const RESULTS_QUERY = 'redis';

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

    // Page 3: the RESULTS STATE of the real panel (issue #83 AC #6). Re-render the
    // harness, type a body-only-match query into the search box, wait for the flat
    // "N RESULTS" list (the harness echoes a synthetic host searchResults reply), and
    // capture it. This is the results-state analogue of harness.png.
    const harnessResultsPage = await openPage(browser);
    await renderAndCapture(
      harnessResultsPage,
      pathToFileURL(HARNESS_HTML).href,
      path.join(OUT_DIR, 'harness-results.png'),
      async (page) => {
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
          'harness sectioned rows to render',
        );
        const typed = await typeIntoInput(page, '#filter', RESULTS_QUERY);
        if (typed !== 'ok') {
          throw new Error('Could not type into the harness search box: ' + typed);
        }
        // Wait for the flat results list: the "N RESULTS" label and at least one
        // result row with a body-match snippet (the synthetic host reply lands after
        // the debounce, so poll rather than fix a delay).
        await waitForCondition(
          page,
          "(function(){var h=document.querySelector('#list .nest-section-label');" +
            "return !!h && /RESULTS/.test(h.textContent) && document.querySelectorAll('#list .nest-row-snippet').length > 0;})()",
          10000,
          'harness results state to render',
        );
      },
    );
    console.log('  wrote ' + path.relative(REPO_ROOT, path.join(OUT_DIR, 'harness-results.png')));

    // Page 4: the RESULTS STATE of the design prototype, the fidelity baseline the
    // results capture is judged against. Same query, driven into the prototype's own
    // search box, then clipped to the 320px sidebar like prototype.png.
    const protoResultsPage = await openPage(browser);
    await renderAndCapture(
      protoResultsPage,
      pathToFileURL(PROTOTYPE_HTML).href,
      path.join(OUT_DIR, 'prototype-results.png'),
      async (page) => {
        await waitForCondition(
          page,
          '(function(){' +
            "var loading=document.getElementById('__bundler_loading');" +
            'if(loading && loading.offsetParent!==null) return false;' +
            "var divs=document.querySelectorAll('body div');" +
            'return divs.length > 8;' +
            '})()',
          30000,
          'prototype React mount',
        );
        await evaluate(
          page,
          '(function(){' +
            "for(var id of ['__bundler_thumbnail','__bundler_loading','__bundler_err']){" +
            'var n=document.getElementById(id); if(n) n.remove();' +
            '} return true; })()',
        );
        const typed = await typeIntoInput(
          page,
          'input[placeholder="Search chats & messages"]',
          RESULTS_QUERY,
        );
        if (typed !== 'ok') {
          throw new Error('Could not type into the prototype search box: ' + typed);
        }
        await sleep(500);
        const rect = await evaluate(
          page,
          '(function(){' +
            "var divs=Array.prototype.slice.call(document.querySelectorAll('div'));" +
            'for(var i=0;i<divs.length;i++){' +
            '  var el=divs[i]; var cs=getComputedStyle(el);' +
            '  var r=el.getBoundingClientRect();' +
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
            'Could not locate the 320px sidebar column in the prototype results state to clip to.',
          );
        }
        return rect;
      },
      PROTOTYPE_VIEWPORT_WIDTH,
    );
    console.log('  wrote ' + path.relative(REPO_ROOT, path.join(OUT_DIR, 'prototype-results.png')));

    // Page 5: the HOVER CARD state of the real panel (issue #84 AC #6). Re-render the
    // harness, dispatch a mouseenter on a chat row (with cursor coords), wait for the
    // card to open AND for its message lines to land (the harness echoes a synthetic
    // previewBody reply), then capture the full 320px viewport so the floating card is
    // in frame. The card is a body-level position:fixed node, so this capture is NOT
    // clipped to the tree; it shows the panel with the card overlaid, matching how the
    // reviewer eyeballs it against the prototype's card.
    const harnessHoverPage = await openPage(browser);
    await renderAndCapture(
      harnessHoverPage,
      pathToFileURL(HARNESS_HTML).href,
      path.join(OUT_DIR, 'harness-hover.png'),
      async (page) => {
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
          'harness sectioned rows to render',
        );
        // Open the card on the starred 'Refactor auth middleware' row (s-01), which the
        // harness gives a rich synthetic body reply, by dispatching a mouseenter with
        // cursor coords low enough that the card (which anchors near the cursor) sits in
        // the captured frame.
        const opened = await evaluate(
          page,
          '(function(){' +
            "var row=document.querySelector('#list .nest-row[data-id=\"s-01\"]');" +
            "if(!row) return 'no-row';" +
            'var r=row.getBoundingClientRect();' +
            "var ev=new MouseEvent('mouseenter',{bubbles:false,clientX:r.left+40,clientY:r.top+200});" +
            'row.dispatchEvent(ev);' +
            "return 'ok';" +
            '})()',
        );
        if (opened !== 'ok') {
          throw new Error('Could not open the harness hover card: ' + opened);
        }
        // Wait for the card AND its two message lines (the synthetic previewBody reply
        // lands after the postMessage round-trip, so poll rather than fix a delay).
        await waitForCondition(
          page,
          "(function(){var c=document.querySelector('.nest-preview-card');" +
            "return !!c && c.querySelectorAll('.nest-preview-text').length >= 2;})()",
          10000,
          'harness hover card to render with body lines',
        );
        // A short settle so the card's layout/fonts finish before capture.
        await sleep(150);
      },
    );
    console.log('  wrote ' + path.relative(REPO_ROOT, path.join(OUT_DIR, 'harness-hover.png')));

    // Page 6: the CHAT CONTEXT MENU (list state) of the real panel (issue #85 AC #7).
    // Re-render the harness, dispatch a contextmenu on a chat row, wait for the menu, and
    // capture the full 320px viewport so the floating menu is in frame. The menu is a
    // body-level position:fixed node, so this capture is NOT clipped to the tree.
    const harnessMenuPage = await openPage(browser);
    await renderAndCapture(
      harnessMenuPage,
      pathToFileURL(HARNESS_HTML).href,
      path.join(OUT_DIR, 'harness-context-menu.png'),
      async (page) => {
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
          'harness sectioned rows to render',
        );
        // Open the menu on the starred 'Refactor auth middleware' row (s-01), which is
        // starred so its menu shows the "kept and never archived" note in place of Archive.
        const opened = await evaluate(
          page,
          '(function(){' +
            "var row=document.querySelector('#list .nest-row[data-id=\"s-01\"]');" +
            "if(!row) return 'no-row';" +
            'var r=row.getBoundingClientRect();' +
            "var ev=new MouseEvent('contextmenu',{bubbles:true,clientX:r.left+30,clientY:r.top+8});" +
            'row.dispatchEvent(ev);' +
            "return 'ok';" +
            '})()',
        );
        if (opened !== 'ok') {
          throw new Error('Could not open the harness chat context menu: ' + opened);
        }
        await waitForCondition(
          page,
          "(function(){var m=document.querySelector('.nest-chat-menu');" +
            "return !!m && m.querySelectorAll('.nest-menu-tag').length > 0;})()",
          10000,
          'harness chat context menu to render with tag rows',
        );
        await sleep(150);
      },
    );
    console.log(
      '  wrote ' + path.relative(REPO_ROOT, path.join(OUT_DIR, 'harness-context-menu.png')),
    );

    // Page 7: the CREATE-TAG state of the chat context menu (issue #85 AC #2/#7). Open
    // the menu, click "Create new tag" to switch to the name-input + 8-swatch state, and
    // capture it.
    const harnessNewTagPage = await openPage(browser);
    await renderAndCapture(
      harnessNewTagPage,
      pathToFileURL(HARNESS_HTML).href,
      path.join(OUT_DIR, 'harness-context-menu-newtag.png'),
      async (page) => {
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
          'harness sectioned rows to render',
        );
        // Open on an UNSORTED (unstarred) row so the list mode shows the Archive entry,
        // then switch to the create-tag state.
        const opened = await evaluate(
          page,
          '(function(){' +
            "var row=document.querySelector('#list .nest-row[data-id=\"s-08\"]')" +
            " || document.querySelector('#list .nest-row');" +
            "if(!row) return 'no-row';" +
            'var r=row.getBoundingClientRect();' +
            "var ev=new MouseEvent('contextmenu',{bubbles:true,clientX:r.left+30,clientY:r.top+8});" +
            'row.dispatchEvent(ev);' +
            "return 'ok';" +
            '})()',
        );
        if (opened !== 'ok') {
          throw new Error('Could not open the harness chat context menu: ' + opened);
        }
        await waitForCondition(
          page,
          "!!document.querySelector('.nest-chat-menu .nest-menu-create')",
          10000,
          'harness chat menu create-tag entry to render',
        );
        const switched = await evaluate(
          page,
          '(function(){' +
            "var b=document.querySelector('.nest-chat-menu .nest-menu-create');" +
            "if(!b) return 'no-create';" +
            'b.click();' +
            "return 'ok';" +
            '})()',
        );
        if (switched !== 'ok') {
          throw new Error('Could not switch the harness chat menu to create-tag: ' + switched);
        }
        await waitForCondition(
          page,
          "(function(){var m=document.querySelector('.nest-chat-menu');" +
            "return !!m && !!m.querySelector('.nest-menu-newtag-input') && " +
            "m.querySelectorAll('.nest-menu-newtag-swatch').length === 8;})()",
          10000,
          'harness chat menu create-tag state to render',
        );
        await sleep(150);
      },
    );
    console.log(
      '  wrote ' +
        path.relative(REPO_ROOT, path.join(OUT_DIR, 'harness-context-menu-newtag.png')),
    );

    // Page 8: the SETTINGS OVERLAY of the real panel (slice s3b-settings-overlay, issue
    // #86). Open the harness, click the gear to open the in-panel Settings sub-page, wait
    // for its "Keep chats for" select and the four section switches, and capture the full
    // 320px viewport (the overlay is position:fixed;inset:0 over the panel).
    const harnessSettingsPage = await openPage(browser);
    await renderAndCapture(
      harnessSettingsPage,
      pathToFileURL(HARNESS_HTML).href,
      path.join(OUT_DIR, 'harness-settings.png'),
      async (page) => {
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
          'harness sectioned rows to render',
        );
        const opened = await evaluate(
          page,
          '(function(){' +
            "var gear=document.getElementById('settings');" +
            "if(!gear) return 'no-gear';" +
            'gear.click();' +
            "return 'ok';" +
            '})()',
        );
        if (opened !== 'ok') {
          throw new Error('Could not open the harness Settings overlay: ' + opened);
        }
        await waitForCondition(
          page,
          "(function(){var o=document.querySelector('.nest-settings-overlay');" +
            "return !!o && !!o.querySelector('.nest-settings-select') && " +
            "o.querySelectorAll('.nest-switch').length === 4;})()",
          10000,
          'harness Settings overlay to render with the select and four switches',
        );
        await sleep(150);
      },
    );
    console.log('  wrote ' + path.relative(REPO_ROOT, path.join(OUT_DIR, 'harness-settings.png')));

    // Page 9: the SETTINGS SUB-PAGE of the design prototype, the fidelity baseline the
    // settings capture is judged against. Click the gear (the ⚙ glyph) to open the
    // prototype's own Settings sub-page, then clip to the 320px sidebar like the other
    // prototype captures.
    const protoSettingsPage = await openPage(browser);
    await renderAndCapture(
      protoSettingsPage,
      pathToFileURL(PROTOTYPE_HTML).href,
      path.join(OUT_DIR, 'prototype-settings.png'),
      async (page) => {
        await waitForCondition(
          page,
          '(function(){' +
            "var loading=document.getElementById('__bundler_loading');" +
            'if(loading && loading.offsetParent!==null) return false;' +
            "var divs=document.querySelectorAll('body div');" +
            'return divs.length > 8;' +
            '})()',
          30000,
          'prototype React mount',
        );
        await evaluate(
          page,
          '(function(){' +
            "for(var id of ['__bundler_thumbnail','__bundler_loading','__bundler_err']){" +
            'var n=document.getElementById(id); if(n) n.remove();' +
            '} return true; })()',
        );
        // Click the gear glyph to open the Settings sub-page.
        const clicked = await evaluate(
          page,
          '(function(){' +
            "var spans=Array.prototype.slice.call(document.querySelectorAll('span'));" +
            'for(var i=0;i<spans.length;i++){' +
            "  if(spans[i].getAttribute('title')==='Settings'){ spans[i].click(); return 'ok'; }" +
            '}' +
            "return 'no-gear';" +
            '})()',
        );
        if (clicked !== 'ok') {
          throw new Error('Could not open the prototype Settings sub-page: ' + clicked);
        }
        await sleep(400);
        const rect = await evaluate(
          page,
          '(function(){' +
            "var divs=Array.prototype.slice.call(document.querySelectorAll('div'));" +
            'for(var i=0;i<divs.length;i++){' +
            '  var el=divs[i]; var cs=getComputedStyle(el);' +
            '  var r=el.getBoundingClientRect();' +
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
            'Could not locate the 320px sidebar column in the prototype Settings state to clip to.',
          );
        }
        return rect;
      },
      PROTOTYPE_VIEWPORT_WIDTH,
    );
    console.log('  wrote ' + path.relative(REPO_ROOT, path.join(OUT_DIR, 'prototype-settings.png')));

    // Page 10: the ARCHIVE OVERLAY of the real panel (slice s3b-archive-overlay, issue #87).
    // Open the harness, click the bottom Archived (N) row to open the in-panel Archive
    // sub-page, wait for its gray-glow search box and the archived rows (the harness echoes a
    // synthetic archivedRows reply), and capture the full 320px viewport (the overlay is
    // position:fixed;inset:0 over the panel).
    const harnessArchivePage = await openPage(browser);
    await renderAndCapture(
      harnessArchivePage,
      pathToFileURL(HARNESS_HTML).href,
      path.join(OUT_DIR, 'harness-archive.png'),
      async (page) => {
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
          'harness sectioned rows to render',
        );
        const opened = await evaluate(
          page,
          '(function(){' +
            "var row=document.querySelector('.nest-archived-row');" +
            "if(!row) return 'no-archived-row';" +
            'row.click();' +
            "return 'ok';" +
            '})()',
        );
        if (opened !== 'ok') {
          throw new Error('Could not open the harness Archive overlay: ' + opened);
        }
        await waitForCondition(
          page,
          "(function(){var o=document.querySelector('.nest-archive-overlay');" +
            "return !!o && !!o.querySelector('.nest-archive-search-input') && " +
            "o.querySelectorAll('.nest-archive-row').length > 0;})()",
          10000,
          'harness Archive overlay to render with the search box and rows',
        );
        await sleep(150);
      },
    );
    console.log('  wrote ' + path.relative(REPO_ROOT, path.join(OUT_DIR, 'harness-archive.png')));

    // Page 11: the ARCHIVE SUB-PAGE of the design prototype, the fidelity baseline the
    // archive capture is judged against. Click the prototype's Archived row to open its
    // Archive sub-page, then clip to the 320px sidebar like the other prototype captures.
    const protoArchivePage = await openPage(browser);
    await renderAndCapture(
      protoArchivePage,
      pathToFileURL(PROTOTYPE_HTML).href,
      path.join(OUT_DIR, 'prototype-archive.png'),
      async (page) => {
        await waitForCondition(
          page,
          '(function(){' +
            "var loading=document.getElementById('__bundler_loading');" +
            'if(loading && loading.offsetParent!==null) return false;' +
            "var divs=document.querySelectorAll('body div');" +
            'return divs.length > 8;' +
            '})()',
          30000,
          'prototype React mount',
        );
        await evaluate(
          page,
          '(function(){' +
            "for(var id of ['__bundler_thumbnail','__bundler_loading','__bundler_err']){" +
            'var n=document.getElementById(id); if(n) n.remove();' +
            '} return true; })()',
        );
        // Click the "Archived" row (a div whose text starts with "Archived") to open the
        // Archive sub-page.
        const clicked = await evaluate(
          page,
          '(function(){' +
            "var divs=Array.prototype.slice.call(document.querySelectorAll('div'));" +
            'for(var i=0;i<divs.length;i++){' +
            '  var t=(divs[i].textContent||\"\").trim();' +
            "  if(/^Archived\\s*\\d*$/.test(t) && divs[i].querySelector('svg')){ divs[i].click(); return 'ok'; }" +
            '}' +
            "return 'no-archived-row';" +
            '})()',
        );
        if (clicked !== 'ok') {
          throw new Error('Could not open the prototype Archive sub-page: ' + clicked);
        }
        await sleep(400);
        const rect = await evaluate(
          page,
          '(function(){' +
            "var divs=Array.prototype.slice.call(document.querySelectorAll('div'));" +
            'for(var i=0;i<divs.length;i++){' +
            '  var el=divs[i]; var cs=getComputedStyle(el);' +
            '  var r=el.getBoundingClientRect();' +
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
            'Could not locate the 320px sidebar column in the prototype Archive state to clip to.',
          );
        }
        return rect;
      },
      PROTOTYPE_VIEWPORT_WIDTH,
    );
    console.log('  wrote ' + path.relative(REPO_ROOT, path.join(OUT_DIR, 'prototype-archive.png')));

    // Page 12: the DRAG DROP-HIGHLIGHT state of the real panel (slice s3c-fidelity-sweep,
    // issue #88). The .nest-drop-over highlight only paints while a chat drag is in flight
    // (attachDropTarget's dragover handler is gated on draggingChatIds.length > 0), so this
    // stage first dispatches a dragstart on a chat row to arm the in-process drag, then a
    // dragover onto a folder header so the header paints its inset-ring drop target. The
    // capture is the clipped 320px tree (the highlight is an in-list state, not a body-level
    // overlay), matching the "clipped tree for in-list states" rule in the fit patch.
    const harnessDropPage = await openPage(browser);
    await renderAndCapture(
      harnessDropPage,
      pathToFileURL(HARNESS_HTML).href,
      path.join(OUT_DIR, 'harness-drop-highlight.png'),
      async (page) => {
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
          'harness sectioned rows to render',
        );
        // Arm the drag on the 'Fix N+1 query in orders' row (s-05), then drag over the
        // 'Backend API' folder header (the second .nest-folder-row) so that header shows
        // the drop highlight. A DragEvent carries a real DataTransfer so the panel's
        // dragstart handler (onRowDragStart) records draggingChatIds and the dragover
        // handler paints .nest-drop-over (the handler paints on any folder header while a
        // drag is armed; the highlight is purely visual and does not depend on the target
        // being a non-home folder).
        const dropped = await evaluate(
          page,
          '(function(){' +
            "var row=document.querySelector('#list .nest-row[data-id=\"s-05\"]')" +
            " || document.querySelector('#list .nest-row');" +
            "if(!row) return 'no-row';" +
            'var dt=new DataTransfer();' +
            "row.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));" +
            "var folders=document.querySelectorAll('#list .nest-folder-row');" +
            "if(folders.length===0) return 'no-folder';" +
            'var target=folders[folders.length>1?1:0];' +
            'var r=target.getBoundingClientRect();' +
            "target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt,clientX:r.left+20,clientY:r.top+8}));" +
            "return 'ok';" +
            '})()',
        );
        if (dropped !== 'ok') {
          throw new Error('Could not arm the harness drag drop-highlight: ' + dropped);
        }
        await waitForCondition(
          page,
          "!!document.querySelector('#list .nest-folder-row.nest-drop-over')",
          10000,
          'harness folder drop-highlight to paint',
        );
        await sleep(150);
        // Clip to the panel's own tree column (in-list state), returning the body box.
        return await evaluate(
          page,
          '(function(){var b=document.body.getBoundingClientRect();' +
            'return {x:0,y:0,width:Math.min(b.width,320),height:document.documentElement.scrollHeight};})()',
        );
      },
    );
    console.log(
      '  wrote ' + path.relative(REPO_ROOT, path.join(OUT_DIR, 'harness-drop-highlight.png')),
    );

    // Page 13: the SORT POPOVER (open) state of the real panel (issue #88). Click the sort
    // button and wait for the popover to un-hide, then capture the full 320px viewport (the
    // popover is a body-adjacent toolbar overlay, so capture the whole panel like the menus).
    const harnessSortPage = await openPage(browser);
    await renderAndCapture(
      harnessSortPage,
      pathToFileURL(HARNESS_HTML).href,
      path.join(OUT_DIR, 'harness-sort-popover.png'),
      async (page) => {
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
          'harness sectioned rows to render',
        );
        const opened = await evaluate(
          page,
          '(function(){' +
            "var b=document.getElementById('sortBtn');" +
            "if(!b) return 'no-sort-btn';" +
            'b.click();' +
            "return 'ok';" +
            '})()',
        );
        if (opened !== 'ok') {
          throw new Error('Could not open the harness sort popover: ' + opened);
        }
        await waitForCondition(
          page,
          "(function(){var p=document.getElementById('sortPopover');" +
            "return !!p && !p.hidden && p.querySelectorAll('.nest-popover-item').length === 3;})()",
          10000,
          'harness sort popover to open with its three items',
        );
        await sleep(150);
      },
    );
    console.log('  wrote ' + path.relative(REPO_ROOT, path.join(OUT_DIR, 'harness-sort-popover.png')));

    // Page 14: the SORT POPOVER of the design prototype, the fidelity baseline the sort
    // capture is judged against. Click the prototype's Sort glyph to open its popover, then
    // clip to the 320px sidebar like the other prototype captures.
    const protoSortPage = await openPage(browser);
    await renderAndCapture(
      protoSortPage,
      pathToFileURL(PROTOTYPE_HTML).href,
      path.join(OUT_DIR, 'prototype-sort-popover.png'),
      async (page) => {
        await waitForCondition(
          page,
          '(function(){' +
            "var loading=document.getElementById('__bundler_loading');" +
            'if(loading && loading.offsetParent!==null) return false;' +
            "var divs=document.querySelectorAll('body div');" +
            'return divs.length > 8;' +
            '})()',
          30000,
          'prototype React mount',
        );
        await evaluate(
          page,
          '(function(){' +
            "for(var id of ['__bundler_thumbnail','__bundler_loading','__bundler_err']){" +
            'var n=document.getElementById(id); if(n) n.remove();' +
            '} return true; })()',
        );
        // Click the Sort trigger (the ⇅ glyph carries title="Sort").
        const clicked = await evaluate(
          page,
          '(function(){' +
            "var e=document.querySelector('[title=\"Sort\"]');" +
            "if(!e) return 'no-sort';" +
            '(e.closest("button") || e).click();' +
            "return 'ok';" +
            '})()',
        );
        if (clicked !== 'ok') {
          throw new Error('Could not open the prototype sort popover: ' + clicked);
        }
        await waitForCondition(
          page,
          "Array.prototype.some.call(document.querySelectorAll('*'),function(e){return e.children.length===0 && /SORT BY/i.test((e.textContent||'').trim());})",
          10000,
          'prototype sort popover (SORT BY) to open',
        );
        await sleep(300);
        return await clipToSidebar(page);
      },
      PROTOTYPE_VIEWPORT_WIDTH,
    );
    console.log(
      '  wrote ' + path.relative(REPO_ROOT, path.join(OUT_DIR, 'prototype-sort-popover.png')),
    );

    // Page 15: the NEW-FOLDER POPOVER (open) state of the real panel (issue #88). Click the
    // FOLDERS-header + button (openNewFolderPopover) and wait for the popover with its name
    // input and Create/Cancel actions, then capture the full 320px viewport.
    const harnessNewFolderPage = await openPage(browser);
    await renderAndCapture(
      harnessNewFolderPage,
      pathToFileURL(HARNESS_HTML).href,
      path.join(OUT_DIR, 'harness-newfolder-popover.png'),
      async (page) => {
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
          'harness sectioned rows to render',
        );
        // The FOLDERS header renders a + (new folder) mini-btn as its first .nest-mini-btn.
        const opened = await evaluate(
          page,
          '(function(){' +
            "var add=document.querySelector('.nest-folders-header .nest-mini-btn');" +
            "if(!add) return 'no-add-btn';" +
            'add.click();' +
            "return 'ok';" +
            '})()',
        );
        if (opened !== 'ok') {
          throw new Error('Could not open the harness new-folder popover: ' + opened);
        }
        await waitForCondition(
          page,
          "(function(){var p=document.querySelector('.nest-newfolder-popover');" +
            "return !!p && !!p.querySelector('.nest-newfolder-input') && " +
            "!!p.querySelector('.nest-newfolder-create');})()",
          10000,
          'harness new-folder popover to open with its input and Create action',
        );
        await sleep(150);
      },
    );
    console.log(
      '  wrote ' + path.relative(REPO_ROOT, path.join(OUT_DIR, 'harness-newfolder-popover.png')),
    );

    // Page 16: the NEW-FOLDER POPOVER of the design prototype, the fidelity baseline the
    // new-folder capture is judged against. Click the prototype's + glyph (title="New folder")
    // to open its popover, then clip to the 320px sidebar.
    const protoNewFolderPage = await openPage(browser);
    await renderAndCapture(
      protoNewFolderPage,
      pathToFileURL(PROTOTYPE_HTML).href,
      path.join(OUT_DIR, 'prototype-newfolder-popover.png'),
      async (page) => {
        await waitForCondition(
          page,
          '(function(){' +
            "var loading=document.getElementById('__bundler_loading');" +
            'if(loading && loading.offsetParent!==null) return false;' +
            "var divs=document.querySelectorAll('body div');" +
            'return divs.length > 8;' +
            '})()',
          30000,
          'prototype React mount',
        );
        await evaluate(
          page,
          '(function(){' +
            "for(var id of ['__bundler_thumbnail','__bundler_loading','__bundler_err']){" +
            'var n=document.getElementById(id); if(n) n.remove();' +
            '} return true; })()',
        );
        const clicked = await evaluate(
          page,
          '(function(){' +
            "var e=document.querySelector('[title=\"New folder\"]');" +
            "if(!e) return 'no-nf';" +
            '(e.closest("button") || e).click();' +
            "return 'ok';" +
            '})()',
        );
        if (clicked !== 'ok') {
          throw new Error('Could not open the prototype new-folder popover: ' + clicked);
        }
        await waitForCondition(
          page,
          "Array.prototype.some.call(document.querySelectorAll('*'),function(e){return /NEW FOLDER/i.test((e.textContent||''));})",
          10000,
          'prototype new-folder popover (NEW FOLDER) to open',
        );
        await sleep(300);
        return await clipToSidebar(page);
      },
      PROTOTYPE_VIEWPORT_WIDTH,
    );
    console.log(
      '  wrote ' + path.relative(REPO_ROOT, path.join(OUT_DIR, 'prototype-newfolder-popover.png')),
    );

    // Page 17: the INLINE FOLDER RENAME state of the real panel (issue #88). Double-click a
    // folder header (its dblclick handler calls beginRename), wait for the .nest-rename-input
    // to replace the folder name in place, then capture the clipped 320px tree (an in-list
    // state). The prototype has no headlessly reproducible rename-input path (verified during
    // the fit review), so the harness capture is this state's committed baseline; see
    // DECISIONS.md Slice s3c-fidelity-sweep.
    const harnessRenamePage = await openPage(browser);
    await renderAndCapture(
      harnessRenamePage,
      pathToFileURL(HARNESS_HTML).href,
      path.join(OUT_DIR, 'harness-rename.png'),
      async (page) => {
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
          'harness sectioned rows to render',
        );
        // Double-click the first folder header ('Work') to begin an in-place rename.
        const opened = await evaluate(
          page,
          '(function(){' +
            "var header=document.querySelector('#list .nest-folder-row');" +
            "if(!header) return 'no-folder';" +
            "header.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));" +
            "return 'ok';" +
            '})()',
        );
        if (opened !== 'ok') {
          throw new Error('Could not begin the harness inline rename: ' + opened);
        }
        await waitForCondition(
          page,
          "!!document.querySelector('#list .nest-folder-row .nest-rename-input')",
          10000,
          'harness inline rename input to appear',
        );
        await sleep(150);
        return await evaluate(
          page,
          '(function(){var b=document.body.getBoundingClientRect();' +
            'return {x:0,y:0,width:Math.min(b.width,320),height:document.documentElement.scrollHeight};})()',
        );
      },
    );
    console.log('  wrote ' + path.relative(REPO_ROOT, path.join(OUT_DIR, 'harness-rename.png')));

    console.log('Fidelity screenshots written to ' + path.relative(REPO_ROOT, OUT_DIR));
    console.log('Compare by eye:');
    console.log('  harness.png (the real org-panel asset) vs media/design/reference/prototype-320.png');
    console.log('  prototype.png (freshly rendered) vs media/design/reference/prototype-320.png (drift check)');
    console.log('  harness-results.png (real panel, filtered) vs prototype-results.png (results-state fidelity)');
    console.log('  harness-hover.png (real panel, hover card) vs the prototype hover card');
    console.log('  harness-context-menu.png (real panel, chat menu) vs the prototype context menu');
    console.log(
      '  harness-context-menu-newtag.png (real panel, create-tag state) vs the prototype new-tag menu',
    );
    console.log(
      '  harness-settings.png (real panel, Settings overlay) vs prototype-settings.png (settings sub-page fidelity)',
    );
    console.log(
      '  harness-archive.png (real panel, Archive overlay) vs prototype-archive.png (archive sub-page fidelity)',
    );
    console.log(
      '  harness-drop-highlight.png (real panel, folder drop target) vs the prototype drop highlight',
    );
    console.log(
      '  harness-sort-popover.png (real panel, sort open) vs prototype-sort-popover.png (sort popover fidelity)',
    );
    console.log(
      '  harness-newfolder-popover.png (real panel, new-folder open) vs prototype-newfolder-popover.png (new-folder popover fidelity)',
    );
    console.log(
      '  harness-rename.png (real panel, inline folder rename) vs the prototype rename input',
    );
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
