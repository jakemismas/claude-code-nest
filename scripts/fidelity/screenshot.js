// Screenshot driver for the Nest panel. Renders the real panel assets (media/orgPanel.{css,js}) through
// scripts/fidelity/harness.html, which feeds them made-up data, in headless Chrome or Edge at 320px wide.
// Writes one full-page PNG per panel state to .claude-working/screens/ (gitignored) as <state>-<theme>.png:
// the default list, search results, menus, Settings and Archive overlays, popovers, drag highlight, inline
// rename, the fleet view and the robin. Review the images by eye; there is no pixel diffing.
//
// Usage: npm run fidelity -- [--theme light|dark] [--out <dir>]
//
// It has no npm dependencies: it talks to the browser over the Chrome DevTools Protocol with Node built-ins
// (Node 20+ has a global fetch and WebSocket), and scripts/ is excluded from the VSIX. It reads repo files
// and writes PNGs under the output folder only; it never reads the author's Claude Code session data.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

// --- paths -----------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HARNESS_HTML = path.join(__dirname, 'harness.html');

// --theme light|dark (default light) and --out <dir> (default .claude-working/screens/).
function parseArgs(argv) {
  const opts = { theme: 'light', out: path.join(REPO_ROOT, '.claude-working', 'screens') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--theme' || a.startsWith('--theme=')) {
      opts.theme = a === '--theme' ? argv[++i] : a.slice('--theme='.length);
    } else if (a === '--out' || a.startsWith('--out=')) {
      const v = a === '--out' ? argv[++i] : a.slice('--out='.length);
      opts.out = path.resolve(process.cwd(), v || '');
    } else {
      console.error('\nUnknown argument: ' + a + '\nUsage: npm run fidelity -- [--theme light|dark] [--out <dir>]\n');
      process.exit(1);
    }
  }
  if (opts.theme !== 'light' && opts.theme !== 'dark') {
    console.error('\n--theme must be light or dark, got: ' + opts.theme + '\n');
    process.exit(1);
  }
  return opts;
}

const OPTS = parseArgs(process.argv.slice(2));
const OUT_DIR = OPTS.out;
const THEME = OPTS.theme;

// Captures are named <state>-<theme>.png.
function harnessOut(state) {
  return path.join(OUT_DIR, state + '-' + THEME + '.png');
}
// The harness reads ?theme= and opts into the dark --vscode-* variables.
function harnessUrl() {
  return pathToFileURL(HARNESS_HTML).href + '?theme=' + THEME;
}

// The fleet captures add ?fleet=ticket|folder so the harness posts the fleet view.
function harnessFleetUrl(view) {
  return harnessUrl() + '&fleet=' + view;
}

// Panel width for every capture. The panel stays usable from 260 to 480px.
const VIEWPORT_WIDTH = 320;
// A tall viewport so the full sectioned list fits without the page needing to
// scroll; captureBeyondViewport in the capture call still grabs anything taller.
const VIEWPORT_HEIGHT = 1400;
const DEVICE_SCALE = 2;

// --- browser discovery -----------------------------------------------------

// The env override for an explicit Chrome/Edge path. When set it is AUTHORITATIVE:
// if it does not point at a real file, the run fails loudly rather than silently
// falling back to an auto-discovered browser the user did not ask for.
function browserOverride() {
  return process.env.NEST_FIDELITY_BROWSER || process.env.CHROME_PATH || '';
}

// The standard auto-discovery Chrome/Edge locations on Windows, macOS, and Linux.
// First existing file wins. Ordered Chrome-before-Edge. Does NOT include the env override.
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

// Navigate a page session to a file URL and wait for the load event, then run afterLoad
// (async) for page-specific readiness (mock render, thumbnail hide). afterLoad may return
// a clip rect { x, y, width, height } in CSS pixels to crop the capture to a sub-element.
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

// Runs in the page. Boxes of the drawn legs, body and head in art pixels from the robin's top-left
// corner, with the boxes frame() gives the legs and body at rest. A part not drawn reads as null.
function robinPartBoxes() {
  const m = window.NestMascot;
  const svg = document.querySelector('.nest-robin-svg');
  if (!m || !svg) {
    return null;
  }
  const s = svg.getBoundingClientRect();
  const px = s.height / m.H;
  const drawn = (selector) => {
    const el = svg.querySelector(selector);
    const r = el ? el.getBoundingClientRect() : null;
    if (!r || r.width === 0) {
      return null;
    }
    return { left: (r.left - s.left) / px, top: (r.top - s.top) / px, right: (r.right - s.left) / px, bottom: (r.bottom - s.top) / px };
  };
  const atRest = (test) => {
    const d = m.frame('idle', 0).find((p) => test(p.k));
    const cells = [];
    d.rows.forEach((row, y) => [...row].forEach((c, x) => c !== '.' && cells.push([d.x + x, d.y + y])));
    return {
      left: Math.min(...cells.map((c) => c[0])),
      top: Math.min(...cells.map((c) => c[1])),
      right: Math.max(...cells.map((c) => c[0])) + 1,
      bottom: Math.max(...cells.map((c) => c[1])) + 1,
    };
  };
  return {
    legs: { actual: drawn('[data-k="legs"]'), expect: atRest((k) => k === 'legs') },
    body: { actual: drawn('[data-k^="body"]'), expect: atRest((k) => k.startsWith('body')) },
    head: drawn('[data-k^="head"]'),
  };
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

// The query the results captures stage. It matches a body line in the harness reply but no chat title, so
// the flat "N RESULTS" list shows a role-prefixed "You: ..." body-match snippet.
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

    // the real org-panel asset via the harness.
    const harnessPage = await openPage(browser);
    await renderAndCapture(
      harnessPage,
      harnessUrl(),
      harnessOut('default'),
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
    console.log('  wrote ' + path.relative(REPO_ROOT, harnessOut('default')));

    // Results state: re-render the harness, type a body-only query, wait for the flat "N RESULTS" list (the
    // harness echoes a synthetic searchResults reply) and capture it.
    const harnessResultsPage = await openPage(browser);
    await renderAndCapture(
      harnessResultsPage,
      harnessUrl(),
      harnessOut('results'),
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
            "return !!h && /RESULTS?/.test(h.textContent) && document.querySelectorAll('#list .nest-row-snippet').length > 0;})()",
          10000,
          'harness results state to render',
        );
      },
    );
    console.log('  wrote ' + path.relative(REPO_ROOT, harnessOut('results')));

    // Chat context menu (list state): dispatch contextmenu on a chat row and capture the full viewport, since
    // the menu is a body-level fixed node and a tree clip would cut it.
    const harnessMenuPage = await openPage(browser);
    await renderAndCapture(
      harnessMenuPage,
      harnessUrl(),
      harnessOut('context-menu'),
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
      '  wrote ' + path.relative(REPO_ROOT, harnessOut('context-menu')),
    );

    // Create-tag state: open the menu, click Create new tag and capture the name input and swatches.
    const harnessNewTagPage = await openPage(browser);
    await renderAndCapture(
      harnessNewTagPage,
      harnessUrl(),
      harnessOut('context-menu-newtag'),
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
        path.relative(REPO_ROOT, harnessOut('context-menu-newtag')),
    );

    // Settings overlay: click the gear, wait for the Keep chats for select and the section switches, and
    // capture the full viewport (the overlay is fixed over the panel).
    const harnessSettingsPage = await openPage(browser);
    await renderAndCapture(
      harnessSettingsPage,
      harnessUrl(),
      harnessOut('settings'),
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
            "o.querySelectorAll('.nest-switch').length === 5 && o.querySelectorAll('.nest-seg-opt').length === 4;})()",
          10000,
          'harness Settings overlay to render with the select, group-by control and five switches',
        );
        await sleep(150);
      },
    );
    console.log('  wrote ' + path.relative(REPO_ROOT, harnessOut('settings')));

    // The ORGANIZE section of the Settings overlay: the Preview list with Apply and Undo
    // enabled, the empty result, rule problems, and the state after an Apply. The harness
    // posts the made-up report when the URL carries ?organize=<state>.
    const organizeStates = [
      { name: 'organize-preview', mode: 'preview', ready: "document.querySelectorAll('.nest-organize-move').length === 4" },
      { name: 'organize-empty', mode: 'empty', ready: "!!document.querySelector('.nest-organize-status') && document.querySelector('.nest-organize-status').textContent.indexOf('Nothing to move') === 0" },
      { name: 'organize-problems', mode: 'problems', ready: "document.querySelectorAll('.nest-organize-problems li').length === 2" },
      { name: 'organize-applied', mode: 'applied', ready: "!!document.querySelector('.nest-organize-status') && document.querySelector('.nest-organize-status').textContent.indexOf('organized') > 0" },
    ];
    for (const state of organizeStates) {
      const organizePage = await openPage(browser);
      await renderAndCapture(
        organizePage,
        harnessUrl() + '&organize=' + state.mode,
        harnessOut(state.name),
        async (page) => {
          await waitForCondition(page, 'window.__nestHarnessReady === true', 10000, 'harness mock post');
          await waitForCondition(
            page,
            "document.querySelectorAll('#list .nest-row').length > 0",
            10000,
            'harness sectioned rows to render',
          );
          const opened = await evaluate(
            page,
            "(function(){var g=document.getElementById('settings');if(!g)return 'no-gear';g.click();return 'ok';})()",
          );
          if (opened !== 'ok') {
            throw new Error('Could not open the harness Settings overlay: ' + opened);
          }
          await waitForCondition(page, "!!document.querySelector('.nest-settings-overlay')", 10000, 'harness Settings overlay');
          // The overlay is built after the report arrived; paint it from the report.
          await evaluate(
            page,
            "(function(){window.postMessage(window.__nestHarnessOrganize,'*');return 'ok';})()",
          );
          await waitForCondition(page, state.ready, 10000, 'the ' + state.name + ' state to render');
          await sleep(150);
        },
      );
      console.log('  wrote ' + path.relative(REPO_ROOT, harnessOut(state.name)));
    }

    // Archive overlay: click the Archived (N) row, wait for the search box and rows (the harness echoes a
    // synthetic archivedRows reply) and capture the full viewport.
    const harnessArchivePage = await openPage(browser);
    await renderAndCapture(
      harnessArchivePage,
      harnessUrl(),
      harnessOut('archive'),
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
    console.log('  wrote ' + path.relative(REPO_ROOT, harnessOut('archive')));

    // Drag drop highlight: .nest-drop-over paints only while a chat drag is in flight (dragover is gated on
    // draggingChatIds), so dispatch dragstart on a row, then dragover on a folder header. The capture is the
    // clipped tree, since the highlight is an in-list state.
    const harnessDropPage = await openPage(browser);
    await renderAndCapture(
      harnessDropPage,
      harnessUrl(),
      harnessOut('drop-highlight'),
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
        // Arm the drag on the 'Fix N+1 query in orders' row (s-05), then drag over the second folder header. The
        // DragEvent carries a real DataTransfer so onRowDragStart records draggingChatIds; the highlight is
        // purely visual and does not depend on the target folder.
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
      '  wrote ' + path.relative(REPO_ROOT, harnessOut('drop-highlight')),
    );

    // Sort popover: click the sort button, wait for it to un-hide and capture the full viewport.
    const harnessSortPage = await openPage(browser);
    await renderAndCapture(
      harnessSortPage,
      harnessUrl(),
      harnessOut('sort-popover'),
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
    console.log('  wrote ' + path.relative(REPO_ROOT, harnessOut('sort-popover')));

    // New-folder popover: click the FOLDERS + button, wait for the name input and Create and Cancel actions,
    // and capture the full viewport.
    const harnessNewFolderPage = await openPage(browser);
    await renderAndCapture(
      harnessNewFolderPage,
      harnessUrl(),
      harnessOut('newfolder-popover'),
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
      '  wrote ' + path.relative(REPO_ROOT, harnessOut('newfolder-popover')),
    );

    // Inline folder rename: double-click a folder header, wait for .nest-rename-input to replace the name,
    // and capture the clipped tree.
    const harnessRenamePage = await openPage(browser);
    await renderAndCapture(
      harnessRenamePage,
      harnessUrl(),
      harnessOut('rename'),
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
    console.log('  wrote ' + path.relative(REPO_ROOT, harnessOut('rename')));

    // The FLEET VIEW states: the ticket view, the any-folder view, the Active filter on
    // and the Queue list open. Each page loads the harness with made-up fleet data and
    // waits for the group rows. Captures are the clipped 320px column.
    const fleetStates = [
      { name: 'fleet-ticket', view: 'ticket', drive: null, ready: "document.querySelectorAll('#list .nest-fleet-group').length > 0" },
      { name: 'fleet-folder', view: 'folder', drive: null, ready: "document.querySelectorAll('#list .nest-fleet-group').length > 0" },
      {
        name: 'fleet-active',
        view: 'ticket',
        drive: "document.getElementById('activeBtn').click();",
        ready:
          "document.getElementById('activeBtn').getAttribute('aria-pressed')==='true'" +
          " && document.querySelectorAll('#list .nest-fleet-group').length > 0" +
          " && !document.querySelector('#list .nest-fleet-group[data-group-id=\"ticket.A-099\"]')",
      },
      {
        name: 'fleet-queue',
        view: 'ticket',
        drive: "document.getElementById('queueBtn').click();",
        ready: "document.querySelectorAll('#queueList .nest-queue-row').length === 3",
      },
      { name: 'fleet-markup', view: 'markup', drive: null, ready: "document.querySelectorAll('#list .nest-fleet-group').length > 0" },
    ];
    for (const state of fleetStates) {
      const fleetPage = await openPage(browser);
      await renderAndCapture(
        fleetPage,
        harnessFleetUrl(state.view),
        harnessOut(state.name),
        async (page) => {
          await waitForCondition(page, 'window.__nestHarnessReady === true', 10000, 'harness mock post');
          await waitForCondition(
            page,
            "document.querySelectorAll('#list .nest-fleet-group').length > 0 && !document.getElementById('activeBtn').hidden",
            10000,
            'harness fleet groups to render',
          );
          if (state.drive) {
            const driven = await evaluate(page, '(function(){' + state.drive + "return 'ok';})()");
            if (driven !== 'ok') {
              throw new Error('Could not drive the ' + state.name + ' state: ' + driven);
            }
          }
          await waitForCondition(page, state.ready, 10000, 'the ' + state.name + ' state to render');
          await sleep(500);
          return await evaluate(
            page,
            '(function(){return {x:0,y:0,width:320,height:document.documentElement.scrollHeight};})()',
          );
        },
      );
      console.log('  wrote ' + path.relative(REPO_ROOT, harnessOut(state.name)));
    }

    // DOM checks on the fleet panel. Each failure adds one short line; any failure fails the run.
    const domFailures = [];
    const probe = async (view, drive, ready) => {
      const page = await openPage(browser);
      await renderAndCapture(page, harnessFleetUrl(view), path.join(OUT_DIR, 'dom-check-' + view + '.png'), async (p) => {
        await waitForCondition(p, 'window.__nestHarnessReady === true', 10000, 'harness mock post');
        await waitForCondition(
          p,
          "document.querySelectorAll('#list .nest-fleet-group, #list [role=treeitem]').length > 0 && !document.getElementById('activeBtn').hidden",
          10000,
          'harness fleet rows to render',
        );
        return await drive(p);
      });
    };
    const ev = async (page, code) => evaluate(page, '(function(){' + code + '})()');
    await probe('ticket', async (page) => {
      const pressed = "document.getElementById('activeBtn').getAttribute('aria-pressed')";
      const before = await ev(page, 'return ' + pressed);
      await ev(page, "document.getElementById('activeBtn').click();");
      await sleep(150);
      const during = await ev(page, 'return ' + pressed);
      await ev(page, "document.getElementById('activeBtn').click();");
      await sleep(150);
      const after = await ev(page, 'return ' + pressed);
      if (before !== 'false' || during !== 'true' || after !== 'false') {
        domFailures.push('Active button does not toggle aria-pressed (' + [before, during, after].join(',') + ')');
      }

      await ev(page, "document.getElementById('queueBtn').click();");
      await waitForCondition(page, "document.querySelectorAll('#queueList .nest-queue-row').length > 0", 10000, 'the queue list');
      const extras = await ev(
        page,
        "return Array.from(document.querySelectorAll('#queueList *')).filter(function(n){" +
          "if (n.matches('.nest-queue-close, .nest-queue-back')) return false;" +
          "return n.matches('button, input, select, textarea, a[href], summary, [role=button], [role=link], [role=menuitem], [onclick], [tabindex]:not([tabindex=\"-1\"])');" +
          "}).length;",
      );
      if (extras !== 0) {
        domFailures.push('Queue card has ' + extras + ' interactive element(s)');
      }
      await ev(page, "document.getElementById('queueBtn').click();");

      const moved = await ev(
        page,
        "var rows = Array.from(document.querySelectorAll('#list [role=treeitem]'));" +
          'if (rows.length < 2) return "too few rows";' +
          'rows[0].focus();' +
          'var first = document.activeElement;' +
          "first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));" +
          "return document.activeElement !== first && document.activeElement.getAttribute('role') === 'treeitem' ? 'ok' : 'focus did not move';",
      );
      if (moved !== 'ok') {
        domFailures.push('Arrow-down in the fleet tree: ' + moved);
      }
    });
    await probe('markup', async (page) => {
      const res = await ev(
        page,
        "var list = document.getElementById('list');" +
          "var q = document.getElementById('queueBtn'); q.click();" +
          "var scope = [list, document.getElementById('queueList')];" +
          "var injected = scope.reduce(function(n, el){ return n + el.querySelectorAll('b, i').length; }, 0);" +
          "var literal = list.textContent.indexOf('<b>x</b>') !== -1;" +
          'return injected + "|" + literal;',
      );
      if (res !== '0|true') {
        domFailures.push('Markup in a fleet title renders as elements (injected|literal=' + res + ')');
      }
    });
    if (domFailures.length > 0) {
      throw new Error('Fleet DOM checks failed:\n  ' + domFailures.join('\n  '));
    }
    console.log('  fleet DOM checks passed');

    // The ROBIN captures: the header robin, clipped to a header strip. Each entry waits for the
    // panel to apply the state. A freeze time (seconds) draws that exact moment of the scene with
    // seeded notes; entries without one run live for a fixed wait. Still captures turn the
    // animations setting off.
    const live = ['idle', 'working', 'needs', 'done', 'error', 'sleep', 'night', 'worm', 'rotate', 'hatch', 'milestone'];
    const moments = {
      idle: [['rest', 0], ['breathe', 1.7], ['look', 2.5], ['blink', 3.55], ['peep', 6.05], ['yawn', 10.3], ['peck', 11.55]],
      working: [['tap', 0.3], ['peck', 0.55], ['notes', 1.0], ['notes-high', 2.0]],
      needs: [['chirp', 0.05], ['cock', 0.6], ['crouch', 1.1], ['hop', 1.2], ['land', 1.45]],
      done: [['crouch', 0.1], ['rise', 0.25], ['top', 0.37], ['land', 0.6], ['check', 0.95], ['sing', 1.4], ['sing-late', 2.3]],
      error: [['squawk', 0.2], ['squawk-2', 0.33], ['calm', 1.3]],
      sleep: [['zs', 0.6], ['snore', 1.8]],
      night: [['zs', 0.6], ['stars', 2.0]],
      worm: [['arrive', 0.25], ['windup', 0.9], ['strike', 1.05], ['slurp', 1.6], ['gulp', 2.4], ['content', 3.0]],
      rotate: [['crouch', 0.12], ['takeoff', 0.35], ['flight', 0.65], ['away', 1.1], ['empty', 1.8], ['return', 2.5], ['approach', 3.0], ['land', 3.32], ['settle', 3.8]],
      hatch: [['egg', 0.3], ['wobble', 0.75], ['crack', 2.0], ['poke', 2.75], ['burst', 3.35], ['air', 3.6], ['land', 4.0], ['peep', 4.3]],
      milestone: [['hop', 0.3], ['crouch', 0.85], ['high', 1.3], ['burst', 1.5], ['sparkles', 2.0], ['sing', 2.6]],
    };
    const robinStates = [];
    for (const state of live) {
      robinStates.push({ name: state, state, wait: 600 });
    }
    for (const state of live) {
      robinStates.push({ name: 'still-' + state, state, wait: 200, still: true });
    }
    for (const state of live) {
      for (const [moment, freeze] of moments[state]) {
        robinStates.push({ name: state + '-' + moment, state, freeze });
      }
    }
    const robinCaptures = [];
    // States where both feet stay on the branch; the rest hop, jump or fly.
    const plantedStates = ['idle', 'working', 'error', 'sleep', 'night', 'worm'];
    const feetFailures = [];
    for (const entry of robinStates) {
      const name = 'robin-' + entry.name;
      robinCaptures.push(name);
      const robinPage = await openPage(browser);
      let robinUrl = harnessUrl() + '&robin=' + entry.state + (entry.still ? '&still=1' : '');
      if (entry.freeze !== undefined) {
        robinUrl += '&freeze=' + entry.freeze;
      }
      await renderAndCapture(
        robinPage,
        robinUrl,
        harnessOut(name),
        async (page) => {
          await waitForCondition(page, 'window.__nestHarnessReady === true', 10000, 'harness mock post');
          await waitForCondition(
            page,
            "document.getElementById('robinSlot').getAttribute('data-state') === '" + entry.state + "'" +
              " && document.getElementById('robinSlot').getAttribute('data-motion') === '" + (entry.still ? 'still' : 'full') + "'",
            10000,
            'the robin ' + entry.state + ' state to apply',
          );
          if (entry.freeze !== undefined) {
            await waitForCondition(page, 'window.__nestHarnessFrozen === true', 10000, 'the frozen frame');
          } else {
            await sleep(entry.wait);
          }
          // In a planted state the legs and body sit exactly where the art puts them at rest, and
          // in every state the head never rises far enough to leave a gap above the body.
          const boxes = await evaluate(page, '(' + robinPartBoxes.toString() + ')()');
          const planted = plantedStates.includes(entry.state);
          if (!boxes) {
            feetFailures.push(name + ': the robin is not drawn');
          } else if (planted && (!boxes.legs.actual || !boxes.body.actual || !boxes.head)) {
            feetFailures.push(name + ': the robin parts are missing');
          } else {
            for (const key of planted ? ['legs', 'body'] : []) {
              const { actual, expect } = boxes[key];
              for (const side of ['left', 'top', 'right', 'bottom']) {
                if (Math.abs(actual[side] - expect[side]) > 0.01) {
                  feetFailures.push(name + ': the ' + key + ' moved (' + side + ' ' + actual[side].toFixed(2) + ', rest ' + expect[side] + ')');
                }
              }
            }
            if (boxes.head && boxes.body.actual && boxes.body.actual.top - boxes.head.bottom > 0.01) {
              feetFailures.push(name + ': a ' + (boxes.body.actual.top - boxes.head.bottom).toFixed(2) + ' pixel gap under the head');
            }
          }
          return await evaluate(
            page,
            '(function(){const r=document.querySelector(".nest-header").getBoundingClientRect();return {x:0,y:0,width:320,height:Math.ceil(r.bottom)};})()',
          );
        },
      );
      console.log('  wrote ' + path.relative(REPO_ROOT, harnessOut(name)));
    }
    // Every robin capture must be on disk for this theme.
    const missingRobin = robinCaptures.filter((name) => {
      try {
        return fs.statSync(harnessOut(name)).size === 0;
      } catch {
        return true;
      }
    });
    if (missingRobin.length > 0) {
      throw new Error('Missing robin captures for the ' + THEME + ' theme: ' + missingRobin.join(', '));
    }
    if (feetFailures.length > 0) {
      throw new Error('Robin lower body and feet checks failed:\n  ' + feetFailures.join('\n  '));
    }
    console.log('  robin lower body and feet checks passed');

    // The robin follows a theme change and a reduced motion change without a reload. The light
    // run starts light, so each body class VS Code sets must pick its palette on the spot.
    if (THEME === 'light') {
      const themePage = await openPage(browser);
      await renderAndCapture(themePage, harnessUrl() + '&robin=idle', path.join(OUT_DIR, 'robin-switch-check.png'), async (page) => {
        await waitForCondition(page, 'window.__nestHarnessReady === true', 10000, 'harness mock post');
        await waitForCondition(page, "document.getElementById('robinSlot').getAttribute('data-motion') === 'full'", 10000, 'the robin to animate');
        const uses = (palette) =>
          "Array.from(document.querySelectorAll('#robinSlot rect')).some((r) => r.getAttribute('fill') === window.NestMascot." + palette + ".H)";
        const cases = [
          ['vscode-dark', 'DARK'],
          ['vscode-high-contrast', 'DARK'],
          ['vscode-high-contrast vscode-high-contrast-light', 'LIGHT'],
          ['vscode-light', 'LIGHT'],
        ];
        for (const [cls, palette] of cases) {
          await evaluate(page, "document.body.className = '" + cls + "'");
          await waitForCondition(page, uses(palette) + ' && !' + uses(palette === 'DARK' ? 'LIGHT' : 'DARK'), 3000, 'the ' + palette.toLowerCase() + ' robin for ' + cls);
        }
        await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
        await waitForCondition(page, "document.getElementById('robinSlot').getAttribute('data-motion') === 'still'", 3000, 'the robin to go still for reduced motion');
        await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
        await waitForCondition(page, "document.getElementById('robinSlot').getAttribute('data-motion') === 'full'", 3000, 'the robin to move again');
        return null;
      });
      console.log('  robin theme and reduced motion switch checks passed');
    }

    // One contact sheet with every robin capture in a grid. It is written next to the PNGs.
    const sheetName = 'robin-contact';
    const sheetHtml = path.join(OUT_DIR, sheetName + '-' + THEME + '.html');
    const cells = robinCaptures
      .map(
        (name) =>
          '<figure><img src="' + pathToFileURL(harnessOut(name)).href + '" width="320"><figcaption>' +
          name.replace(/^robin-/, '') + '</figcaption></figure>',
      )
      .join('');
    fs.writeFileSync(
      sheetHtml,
      '<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:12px;background:' +
        (THEME === 'dark' ? '#1e1e1e' : '#ffffff') + ';color:' + (THEME === 'dark' ? '#ccc' : '#333') +
        ';font:12px sans-serif;display:grid;grid-template-columns:repeat(4,320px);gap:10px}figure{margin:0}' +
        'img{display:block;border:1px solid #8884}</style>' + cells,
    );
    const sheetPage = await openPage(browser);
    await renderAndCapture(
      sheetPage,
      pathToFileURL(sheetHtml).href,
      harnessOut(sheetName),
      async (page) => {
        await waitForCondition(page, 'Array.from(document.images).every((i) => i.complete)', 10000, 'the contact sheet images');
        return await evaluate(
          page,
          '(function(){return {x:0,y:0,width:1400,height:document.documentElement.scrollHeight};})()',
        );
      },
      1400,
    );
    console.log('  wrote ' + path.relative(REPO_ROOT, harnessOut(sheetName)));

    // The ACTIVITY BAR icon, drawn the way VS Code draws a contributed icon: the SVG is a mask
    // filled with the bar's foreground color, so it must read as one color at 24 px. The colors
    // are the default themes' Activity Bar colors; each row shows the active and inactive icon.
    const iconSvg = fs.readFileSync(path.join(REPO_ROOT, 'media', 'nest.svg'), 'utf8');
    const iconUrl = 'data:image/svg+xml;base64,' + Buffer.from(iconSvg).toString('base64');
    const bars =
      THEME === 'dark'
        ? [['Dark Modern', '#181818', '#D7D7D7', '#868686', '#0078D4'], ['High Contrast', '#000000', '#FFFFFF', '#FFFFFF', '#F38518']]
        : [['Light Modern', '#F8F8F8', '#1F1F1F', '#616161', '#005FB8'], ['High Contrast Light', '#FFFFFF', '#292929', '#292929', '#B5200D']];
    const barRows = bars
      .map(
        ([label, bg, fg, idle, accent]) =>
          '<div class="row" style="background:' + bg + ';color:' + fg + '">' +
          '<span class="cell" style="border-left:2px solid ' + accent + '"><i style="background:' + fg + '"></i></span>' +
          '<span class="cell"><i style="background:' + idle + '"></i></span>' +
          '<span class="cell big"><i style="background:' + fg + '"></i></span>' +
          '<span class="label">' + label + '</span></div>',
      )
      .join('');
    const barHtml = path.join(OUT_DIR, 'activitybar-' + THEME + '.html');
    fs.writeFileSync(
      barHtml,
      '<!doctype html><meta charset="utf-8"><style>body{margin:0;font:12px sans-serif}' +
        '.row{display:flex;align-items:center;height:96px}.cell{display:flex;align-items:center;justify-content:center;width:48px;height:48px;box-sizing:border-box}' +
        '.cell i{display:block;width:24px;height:24px;-webkit-mask:url(' + iconUrl + ') no-repeat 50% 50%;-webkit-mask-size:24px}' +
        '.cell.big{width:120px;height:96px}.cell.big i{width:96px;height:96px;-webkit-mask-size:96px}.label{padding-left:12px}</style>' + barRows,
    );
    const barPage = await openPage(browser);
    await renderAndCapture(barPage, pathToFileURL(barHtml).href, harnessOut('activitybar'), async (page) => {
      return await evaluate(page, '(function(){return {x:0,y:0,width:320,height:document.body.scrollHeight};})()');
    });
    console.log('  wrote ' + path.relative(REPO_ROOT, harnessOut('activitybar')));

    console.log('Fidelity screenshots written to ' + path.relative(REPO_ROOT, OUT_DIR));
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
