// Screenshot driver for the Nest panel.
//
// Renders the real panel assets (media/orgPanel.{css,js}) through
// scripts/fidelity/harness.html, which feeds them made-up data, in headless Chrome
// or Edge at 320px wide. It writes one full-page PNG per panel state into
// .claude-working/screens/ (gitignored) as <state>-<theme>.png: the default list,
// search results, the context menu, the settings and archive overlays, popovers, drag
// highlight, inline rename and the fleet view (ticket, any-folder, Active, Queue). Review the images by eye; there is no pixel diffing.
//
// Usage: npm run fidelity -- [--theme light|dark] [--out <dir>]
//
// It has zero npm dependencies. The extension ships with no runtime dependencies,
// so this talks to the browser over the Chrome DevTools Protocol using only Node
// built-ins (Node 20+ has a global fetch and WebSocket). The scripts/ folder is
// excluded from the VSIX.
//
// It only reads repo files and writes PNGs under the output folder. It never
// touches ~/.claude/projects.

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

// The query the results-state captures stage. It matches a body line in the mock (the
// harness reply) and a body line while being ABSENT
// from those chats' titles, so the flat "N RESULTS" list shows a role-prefixed "You: ..."
// body-match snippet.
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

    // the RESULTS STATE of the real panel. Re-render the harness, type a
    // body-only-match query into the search box, wait for the flat "N RESULTS" list (the
    // harness echoes a synthetic host searchResults reply), and capture it. This is the
    // results-state analogue of default-<theme>.png.
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
            "return !!h && /RESULTS/.test(h.textContent) && document.querySelectorAll('#list .nest-row-snippet').length > 0;})()",
          10000,
          'harness results state to render',
        );
      },
    );
    console.log('  wrote ' + path.relative(REPO_ROOT, harnessOut('results')));

    // the CHAT CONTEXT MENU (list state) of the real panel. Re-render the
    // harness, dispatch a contextmenu on a chat row, wait for the menu, and capture the
    // full 320px viewport so the floating menu is in frame. The menu is a body-level
    // position:fixed node, so this capture is NOT clipped to the tree.
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

    // the CREATE-TAG state of the chat context menu. Open the menu, click "Create
    // new tag" to switch to the name-input + 8-swatch state, and capture it.
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

    // the SETTINGS OVERLAY of the real panel. Open the harness, click the gear to
    // open the in-panel Settings sub-page, wait for its "Keep chats for" select and the
    // four section switches, and capture the full 320px viewport (the overlay is
    // position:fixed;inset:0 over the panel).
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
            "o.querySelectorAll('.nest-switch').length === 4;})()",
          10000,
          'harness Settings overlay to render with the select and four switches',
        );
        await sleep(150);
      },
    );
    console.log('  wrote ' + path.relative(REPO_ROOT, harnessOut('settings')));

    // the ARCHIVE OVERLAY of the real panel. Open the harness, click the bottom
    // Archived (N) row to open the in-panel Archive sub-page, wait for its gray-glow
    // search box and the archived rows (the harness echoes a synthetic archivedRows
    // reply), and capture the full 320px viewport (the overlay is position:fixed;inset:0
    // over the panel).
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

    // the DRAG DROP-HIGHLIGHT state of the real panel. The .nest-drop-over
    // highlight only paints while a chat drag is in flight (attachDropTarget's dragover
    // handler is gated on draggingChatIds.length > 0), so this stage first dispatches a
    // dragstart on a chat row to arm the in-process drag, then a dragover onto a folder
    // header so the header paints its inset-ring drop target. The capture is the clipped
    // 320px tree (the highlight is an in-list state, not a body-level overlay), matching
    // the "clipped tree for in-list states" rule.
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
      '  wrote ' + path.relative(REPO_ROOT, harnessOut('drop-highlight')),
    );

    // the SORT POPOVER (open) state of the real panel. Click the sort button and
    // wait for the popover to un-hide, then capture the full 320px viewport (the popover
    // is a body-adjacent toolbar overlay, so capture the whole panel like the menus).
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

    // the NEW-FOLDER POPOVER (open) state of the real panel. Click the
    // FOLDERS-header + button (openNewFolderPopover) and wait for the popover with its
    // name input and Create/Cancel actions, then capture the full 320px viewport.
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

    // the INLINE FOLDER RENAME state of the real panel. Double-click a folder
    // header (its dblclick handler calls beginRename), wait for the .nest-rename-input to
    // replace the folder name in place, then capture the clipped 320px tree (an in-list
    // state).
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

    // The ROBIN captures: the header robin, clipped to a header strip. Each entry waits for
    // the panel to apply the state. A freeze time pauses every animation at that moment so
    // the frame is exact; entries without one wait a fixed time. Still captures turn the
    // animations setting off. The first block keeps the original names.
    const robinStates = [
      { name: 'idle', state: 'idle', wait: 500 },
      { name: 'working', state: 'working', wait: 1400 },
      { name: 'needs', state: 'needs', wait: 500 },
      { name: 'done', state: 'done', wait: 330 },
      { name: 'error', state: 'error', wait: 500 },
      { name: 'sleep', state: 'sleep', wait: 500 },
      { name: 'night', state: 'night', wait: 500 },
      { name: 'worm', state: 'worm', wait: 400 },
      { name: 'rotate', state: 'rotate', wait: 700 },
      { name: 'hatch', state: 'hatch', wait: 1100 },
      { name: 'milestone', state: 'milestone', wait: 330 },
      { name: 'still-needs', state: 'needs', wait: 300, still: true },
      { name: 'still-error', state: 'error', wait: 300, still: true },
      { name: 'still-sleep', state: 'sleep', wait: 300, still: true },
      { name: 'still-night', state: 'night', wait: 300, still: true },
      { name: 'still-done', state: 'done', wait: 300, still: true },
      // The perch on each branch.
      { name: 'idle-thick', state: 'idle', wait: 300, branch: 'thick' },
      { name: 'idle-leafy', state: 'idle', wait: 300, branch: 'leafy' },
      // Each wing frame and two moments mid-flight (the flap runs every 0.32 s).
      { name: 'wing-up', state: 'rotate', freeze: 0.68 },
      { name: 'wing-mid', state: 'rotate', freeze: 0.76 },
      { name: 'wing-down', state: 'rotate', freeze: 0.84 },
      { name: 'flight-rotate', state: 'rotate', freeze: 1.12 },
      { name: 'flight-rotate-landing', state: 'rotate', freeze: 2.5 },
      { name: 'flight-lap', state: 'milestone', freeze: 1.7 },
      { name: 'flight-lap-return', state: 'milestone', freeze: 2.4 },
      { name: 'flight-flutter', state: 'idle', wait: 450, flutter: true },
      // Each reaction state at a frame where its glyphs show.
      { name: 'reaction-needs', state: 'needs', freeze: 0.3 },
      { name: 'reaction-error', state: 'error', freeze: 0.3 },
      { name: 'reaction-done', state: 'done', freeze: 0.55 },
      { name: 'reaction-sleep', state: 'sleep', freeze: 1.0 },
      { name: 'reaction-night', state: 'night', freeze: 1.0 },
      { name: 'reaction-worm', state: 'worm', freeze: 0.9 },
      { name: 'reaction-milestone', state: 'milestone', freeze: 3.4 },
      { name: 'reaction-hatch-egg', state: 'hatch', freeze: 0.3 },
      { name: 'reaction-hatch-cracked', state: 'hatch', freeze: 1.1 },
      { name: 'reaction-working', state: 'working', wait: 1400 },
      // Reduced-motion stills for every state not already above.
      { name: 'still-idle', state: 'idle', wait: 300, still: true },
      { name: 'still-working', state: 'working', wait: 300, still: true },
      { name: 'still-worm', state: 'worm', wait: 300, still: true },
      { name: 'still-hatch', state: 'hatch', wait: 300, still: true },
      { name: 'still-rotate', state: 'rotate', wait: 300, still: true },
      { name: 'still-milestone', state: 'milestone', wait: 300, still: true },
    ];
    const robinCaptures = [];
    for (const entry of robinStates) {
      const name = 'robin-' + entry.name;
      robinCaptures.push(name);
      const robinPage = await openPage(browser);
      let robinUrl = harnessUrl() + '&robin=' + entry.state + (entry.still ? '&still=1' : '');
      if (entry.branch) {
        robinUrl += '&branch=' + entry.branch;
      }
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
            await waitForCondition(page, 'window.__nestHarnessFrozen === true', 10000, 'the animations to freeze');
          } else {
            if (entry.flutter) {
              await evaluate(page, "document.getElementById('robinSlot').setAttribute('data-flutter','1')");
            }
            await sleep(entry.wait);
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
