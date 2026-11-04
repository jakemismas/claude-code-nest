#!/usr/bin/env node
// Builds the README robin images and the robin style sheet (docs/mascot.md) from the same scenes
// the panel draws, so they never drift apart. Writes an animated hero and a state sheet as SVG,
// light and dark, still PNG fallbacks (vsce refuses SVG-only images), and the style sheet with
// one animated image per state, the still poses, the icons and both palettes.
// Usage: node scripts/readme/robin.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const repo = path.resolve(__dirname, '..', '..');
const sandbox = {};
vm.runInNewContext(fs.readFileSync(path.join(repo, 'media', 'mascot.js'), 'utf8'), sandbox);
const mascot = sandbox.NestMascot;

// The rows above the branch's top row that jumps, notes and sparkles may use; the panel header
// keeps the same room, and a unit test holds every scene to it.
const HEADROOM = 13;
// The area one robin needs, with that headroom above the art's top row.
const BOX = { x: -4, y: -HEADROOM, w: 34, h: 27 };
const STEP_MS = 50;
// The hero loop: the robin works with two chats, then finishes and celebrates.
const HERO = [
  { state: 'working', ms: 4000 },
  { state: 'done', ms: 3500 },
];
const HERO_NOTES = { delays: [150, 1350], minMs: 2500, spreadMs: 0 };
// One telling moment per state for the README sheet, in ms.
const SHEET = [
  ['idle', 'idle', 0],
  ['working', 'working', 1000],
  ['needs', 'needs you', 600],
  ['done', 'done', 1400],
  ['error', 'error', 200],
  ['sleep', 'sleeping', 600],
  ['night', 'night', 2000],
  ['worm', 'new chat', 1050],
  ['rotate', 'new orchestrator', 3000],
  ['hatch', 'first run', 2750],
  ['milestone', 'queue done', 1500],
];

// The host's timing, from the compiled extension, so the style sheet says what the host does.
const hostFile = path.join(repo, 'out', 'fleet', 'robinState.js');
if (!fs.existsSync(hostFile)) {
  throw new Error('Run npm run compile first: the style sheet reads the robin timing from ' + path.relative(repo, hostFile));
}
const host = require(hostFile);
const T = host.TRANSIENT_MS;
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const word = (n) => (n >= 0 && n < WORDS.length ? WORDS[n] : String(n));
const upper = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const seconds = (ms) => {
  const n = Math.round(ms / 100) / 10;
  return n + (n === 1 ? ' second' : ' seconds');
};
const clock = (h) => (h % 12 === 0 ? 12 : h % 12) + (h < 12 ? ' AM' : ' PM');
const sleepMinutes = host.SLEEP_AFTER_MS / 60000;

// The style sheet's states, in the order the host ranks them: when two apply, the earlier one
// shows. loop is the length of one seamless cycle in ms, starting at from; a one-shot scene adds
// a second of rest. Working shows three chats, each with its own note lane. Its cycle holds four
// notes per lane, one per note color, and starts a cycle in, so the notes in flight match at the seam.
const WORKING_NOTES = { delays: [150, 1350, 2550], minMs: 3000, spreadMs: 0 };
const STATES = [
  { state: 'hatch', name: 'Hatch', loop: T.hatch + 1000, when: `The first time Nest opens on a computer. The egg wobbles, cracks and the robin bursts out. Plays once, for ${seconds(T.hatch)}.` },
  { state: 'rotate', name: 'Rotate', loop: T.rotate + 1000, when: `A new orchestrator takes over the chain. The robin flies off to the right and a fresh one lands from the left. Plays once, for ${seconds(T.rotate)}.` },
  { state: 'error', name: 'Error', loop: 4000, when: `A chat fails: its fleet record ends with outcome failed, or the CLI reports it failed. The robin squawks with its crest up. Holds for ${seconds(T.error)}.` },
  { state: 'needs', name: 'Needs you', loop: 6000, when: 'While any chat waits for you. The robin faces you, chirps and hops under a question mark until you answer.' },
  { state: 'worm', name: 'New chat', loop: T.worm + 1000, when: `A new chat starts for a ticket. The robin catches a worm and gulps it down. Plays once, for ${seconds(T.worm)}.` },
  { state: 'done', name: 'Done', loop: T.done + 1000, when: `A chat ends with outcome done, or a ticket reaches a finished stage. The robin jumps, a check pops up and it sings three notes. Plays once, for ${seconds(T.done)}.` },
  { state: 'milestone', name: 'Queue done', loop: T.milestone + 1000, when: `Every ticket in the queue is finished. The robin makes two jumps in a ring of sparkles and sings. Plays once, for ${seconds(T.milestone)}.` },
  {
    state: 'working',
    name: 'Working',
    loop: 12000,
    from: 12000,
    notes: WORKING_NOTES,
    speed: 1,
    when: `While chats work. The robin taps along, and each working chat (up to ${word(host.MAX_NOTES)}) sends a note from its beak at a random moment, at most one every ${seconds(host.NOTE_MIN_GAP_MS)} per chat. ${upper(word(host.FAST_AT))} or more working chats tap faster, ${word(host.FASTER_AT)} or more faster still.`,
  },
  { state: 'sleep', name: 'Sleeping', loop: 7200, when: `No chat has worked or waited for you for ${sleepMinutes} minutes, outside night hours. The robin tucks its head and snores.` },
  { state: 'night', name: 'Night', loop: 21600, when: `No chat has worked or waited for you for ${sleepMinutes} minutes, between ${clock(host.NIGHT_START_HOUR)} and ${clock(host.NIGHT_END_HOUR)} local time. The robin sleeps under a moon and stars.` },
  { state: 'idle', name: 'Idle', loop: 14000, when: 'Nothing else applies. The robin breathes, looks around, blinks, peeps, yawns and pecks at the branch.' },
];

// Plain names for every palette color, grouped for the swatch sheet.
const ROLES = [
  ['Plumage', [['H', 'Head and back'], ['j', 'Lit crown and back'], ['K', 'Shaded belly and tail'], ['w', 'Wing'], ['f', 'Lit wing edge'], ['u', 'Shaded wing edge']]],
  ['Breast', [['r', 'Breast'], ['R', 'Lit breast edge'], ['Q', 'Shaded breast']]],
  ['Face', [['b', 'Beak'], ['e', 'Eye'], ['W', 'Eye ring'], ['M', 'Open mouth'], ['T', 'Tongue']]],
  ['Legs', [['k', 'Legs and feet']]],
  ['Branch', [['m', 'Bark'], ['t', 'Lit bark'], ['d', 'Shaded bark'], ['g', 'Leaf'], ['l', 'Lit leaf'], ['G', 'Shaded leaf']]],
  ['Egg', [['E', 'Shell'], ['s', 'Speckle'], ['O', 'Shell outline'], ['c', 'Crack']]],
  ['Notes', [['n', 'Orange note'], ['p', 'Violet note and sparkle'], ['o', 'Gold note'], ['a', 'Green note and check']]],
  ['Signs', [['y', 'Sparkle, moon and stars'], ['q', 'Question mark'], ['x', 'Alarm'], ['z', 'Sleep letters'], ['B', 'Snore bubble'], ['v', 'Worm'], ['V', 'Worm head and gulp']]],
];

// The default themes' Activity Bar background and active icon color.
const BARS = {
  light: { bg: '#F8F8F8', fg: '#1F1F1F', label: 'Light Modern' },
  dark: { bg: '#181818', fg: '#D7D7D7', label: 'Dark Modern' },
};
const TEXT = { light: '#5B4A42', dark: '#D6C6B8', muted: { light: '#8A7469', dark: '#B8A596' } };
// Two columns of swatches; the style sheet shows the images at their own width.
const COL_W = 260;
const PALETTE_W = 8 + COL_W * 2;
const FONT = 'ui-sans-serif,-apple-system,Segoe UI,Helvetica,Arial,sans-serif';
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';

function runs(rows) {
  const out = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      let x1 = x + 1;
      if (row[x] !== '.') {
        while (x1 < row.length && row[x1] === row[x]) {
          x1 += 1;
        }
        out.push([x, y, x1 - x, row[x]]);
      }
      x = x1;
    }
  });
  return out;
}

function rects(rows, dx, dy, pal) {
  return runs(rows)
    .map(([x, y, w, c]) => `<rect x="${x + dx}" y="${y + dy}" width="${w}" height="1" fill="${pal[c]}"/>`)
    .join('');
}

// Each sprite once as a symbol; every frame then places sprites with <use>, which keeps the file small.
function Sprites(pal) {
  const ids = new Map();
  const defs = [];
  return {
    use(d, dx, dy) {
      let id = ids.get(d.k);
      if (!id) {
        id = 's' + ids.size;
        ids.set(d.k, id);
        defs.push(`<symbol id="${id}" overflow="visible">${rects(d.rows, 0, 0, pal)}</symbol>`);
      }
      const op = d.op < 1 ? ` opacity="${d.op}"` : '';
      return `<use href="#${id}" x="${d.x + dx}" y="${d.y + dy}"${op}/>`;
    },
    defs() {
      return `<defs>${defs.join('')}</defs>`;
    },
  };
}

function svg(w, h, viewBox, label, style, body, crisp) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${w}" height="${h}" ` +
    `${crisp === false ? '' : 'shape-rendering="crispEdges" '}role="img" aria-label="${label}"><style>${style}</style>${body}</svg>\n`
  );
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// An animated loop over real frames: each run of identical frames becomes one group that a
// stepped CSS animation shows for its share of the loop. Reduced motion shows the still pose.
function animated(pal, parts, stillState, label, scale) {
  const sprites = Sprites(pal);
  const frames = [];
  for (const part of parts) {
    const from = part.from || 0;
    for (let t = from; t < from + part.ms; t += STEP_MS) {
      frames.push(mascot.frame(part.state, t, part.opts));
    }
  }
  const merged = [];
  for (const f of frames) {
    const key = JSON.stringify(f.map((d) => [d.k, d.x, d.y, d.op]));
    const last = merged[merged.length - 1];
    if (last && last.key === key) {
      last.steps += 1;
    } else {
      merged.push({ key, frame: f, steps: 1 });
    }
  }
  const period = (frames.length * STEP_MS) / 1000;
  const branch = rects(mascot.BRANCH, 0, 0, pal);
  let at = 0;
  const keyframes = [];
  const groups = merged.map((m, i) => {
    const from = ((at / frames.length) * 100).toFixed(3);
    at += m.steps;
    const to = ((at / frames.length) * 100).toFixed(3);
    keyframes.push(
      `@keyframes k${i}{0%,${from}%{visibility:hidden}${from}%,${to}%{visibility:visible}${to}%,100%{visibility:hidden}}` +
        `.k${i}{animation:k${i} ${period}s steps(1,end) infinite}`,
    );
    return `<g class="f k${i}">${m.frame.map((d) => sprites.use(d, 0, 0)).join('')}</g>`;
  });
  const pose = mascot.frame(stillState, 0, { still: true }).map((d) => sprites.use(d, 0, 0)).join('');
  return { sprites, branch, groups, keyframes, pose, label, scale };
}

function animatedSvg(a, still) {
  const style =
    '.f{visibility:hidden}.pose{visibility:hidden}' +
    a.keyframes.join('') +
    '@media (prefers-reduced-motion:reduce){.f{animation:none!important}.pose{visibility:visible}}' +
    (still ? '.f{animation:none!important}.pose{visibility:visible}' : '');
  const body = a.sprites.defs() + a.branch + a.groups.join('') + `<g class="pose">${a.pose}</g>`;
  return svg(BOX.w * a.scale, BOX.h * a.scale, `${BOX.x} ${BOX.y} ${BOX.w} ${BOX.h}`, a.label, style, body);
}

function hero(pal, still) {
  const parts = HERO.map((p) => ({ state: p.state, ms: p.ms, opts: { notes: HERO_NOTES, speed: 0 } }));
  const a = animated(pal, parts, 'working', 'A pixel-art robin working on a branch, then singing when the work is done', 6);
  return animatedSvg(a, still);
}

function stateLoop(entry, pal) {
  const opts = { notes: entry.notes, speed: entry.speed };
  const a = animated(pal, [{ state: entry.state, ms: entry.loop, from: entry.from, opts }], entry.state, 'The robin: ' + entry.name.toLowerCase(), 5);
  return animatedSvg(a, false);
}

// A grid of labeled robins, one per entry: [state, label, t] at that moment, or the still pose.
function sheet(pal, labelColor, entries, still, title) {
  const sprites = Sprites(pal);
  const cols = 4;
  const tileH = BOX.h + 6;
  const tiles = entries.map(([state, label, t], i) => {
    const tx = (i % cols) * BOX.w - BOX.x;
    const ty = Math.floor(i / cols) * tileH - BOX.y;
    const list = still ? mascot.frame(state, 0, { still: true }) : mascot.frame(state, t, { notes: HERO_NOTES });
    const art = rects(mascot.BRANCH, tx, ty, pal) + list.map((d) => sprites.use(d, tx, ty)).join('');
    const text = `<text class="label" x="${tx + 13}" y="${ty + 18.5}" text-anchor="middle" shape-rendering="auto">${esc(label)}</text>`;
    return art + text;
  });
  const w = cols * BOX.w;
  const h = Math.ceil(entries.length / cols) * tileH;
  const style = `.label{font:600 3.4px ${MONO};fill:${labelColor}}`;
  const label = title + ' in ' + entries.length + ' states: ' + entries.map((s) => s[1]).join(', ');
  return { text: svg(w * 5, h * 5, `0 0 ${w} ${h}`, label, style, sprites.defs() + tiles.join('')), w: w * 5, h: h * 5 };
}

// The palette as swatches with plain role names, in columns of groups.
function palette(theme) {
  const pal = theme === 'dark' ? mascot.DARK : mascot.LIGHT;
  const keys = new Set(Object.keys(pal));
  const named = ROLES.flatMap(([, list]) => list.map(([k]) => k));
  const missing = [...keys].filter((k) => !named.includes(k));
  const unknown = named.filter((k) => !keys.has(k));
  if (missing.length || unknown.length || new Set(named).size !== named.length) {
    throw new Error('ROLES must name each palette color once. Missing: ' + missing.join(' ') + '; unknown: ' + unknown.join(' '));
  }
  const ROW = 22;
  const HEAD = 26;
  const columns = [[], []];
  const heights = [0, 0];
  for (const group of ROLES) {
    const h = HEAD + group[1].length * ROW + 10;
    const c = heights[0] <= heights[1] ? 0 : 1;
    columns[c].push(group);
    heights[c] += h;
  }
  const ink = TEXT[theme];
  const muted = TEXT.muted[theme];
  const edge = theme === 'dark' ? '#FFFFFF33' : '#00000026';
  const w = PALETTE_W;
  const h = 8 + Math.max(...heights);
  // Both palettes show side by side on one page, so each carries its own theme's background.
  let body = `<rect width="${w}" height="${h}" rx="6" fill="${theme === 'dark' ? '#1F1F1F' : '#FBF9F4'}"/>`;
  columns.forEach((groups, c) => {
    let y = 8;
    const x = 8 + c * COL_W;
    for (const [title, list] of groups) {
      body += `<text class="h" x="${x}" y="${y + 16}">${esc(title)}</text>`;
      y += HEAD;
      for (const [k, name] of list) {
        body += `<rect x="${x}" y="${y}" width="16" height="16" rx="2" fill="${pal[k]}" stroke="${edge}"/>`;
        body += `<text class="n" x="${x + 24}" y="${y + 12.5}">${esc(name)}</text>`;
        body += `<text class="v" x="${x + COL_W - 18}" y="${y + 12.5}" text-anchor="end">${pal[k]}</text>`;
        y += ROW;
      }
      y += 10;
    }
  });
  const style = `.h{font:600 13px ${FONT};fill:${ink}}.n{font:12px ${FONT};fill:${ink}}.v{font:11px ${MONO};fill:${muted}}`;
  const label = 'The robin ' + theme + ' palette: ' + ROLES.map(([t]) => t).join(', ');
  return svg(w, h, `0 0 ${w} ${h}`, label, style, body, false);
}

// The Activity Bar icon the way VS Code paints it: one color on the bar, at 24 px and enlarged.
function activityBar(theme, iconSvg) {
  const bar = BARS[theme];
  const inner = iconSvg
    .replace(/<\?xml[^>]*>/, '')
    .trim()
    .replace(/currentColor/g, bar.fg);
  const at = (x, y, size) => inner.replace(/<svg\b/, `<svg x="${x}" y="${y}" width="${size}" height="${size}"`).replace(/ width="24" height="24"(?= viewBox)/, '');
  const body =
    `<rect width="200" height="96" fill="${bar.bg}"/>` +
    `<rect x="0" y="24" width="2" height="48" fill="${theme === 'dark' ? '#0078D4' : '#005FB8'}"/>` +
    at(12, 36, 24) +
    at(80, 12, 72);
  return svg(200, 96, '0 0 200 96', 'The Activity Bar icon on ' + bar.label, '', body, false);
}

function picture(light, dark, alt, width) {
  return (
    `<picture><source media="(prefers-color-scheme: dark)" srcset="${dark}">` +
    `<img src="${light}" alt="${esc(alt)}" width="${width}"></picture>`
  );
}

function mascotDoc() {
  const rows = STATES.map(
    (s) =>
      `<tr><td>${picture('mascot/state-' + s.state + '.svg', 'mascot/state-' + s.state + '-dark.svg', 'The robin: ' + s.name.toLowerCase(), 170)}</td>` +
      `<td><b>${esc(s.name)}</b><br><code>${s.state}</code></td><td>${esc(s.when)}</td></tr>`,
  );
  const swatchRows = ROLES.flatMap(([group, list]) =>
    list.map(([k, name]) => `| ${group} | ${name} | \`${mascot.LIGHT[k]}\` | \`${mascot.DARK[k]}\` |`),
  );
  return [
    '# Robin style sheet',
    '',
    'The header robin is pixel art drawn by `media/mascot.js`. Every image on this page is generated from that file by `node scripts/readme/robin.js`, so the page shows exactly what the panel draws. Run the script again after you change the art; a unit test fails while this page is out of date.',
    '',
    '## Rules',
    '',
    '- Every art pixel is a square. The panel draws 3 CSS pixels per art pixel, with crisp edges.',
    `- The robin sits on a branch ${mascot.W} pixels wide and ${mascot.H} pixels tall. Jumps, notes and sparkles stay within ${HEADROOM} pixels above it; only the robin flying away and the egg's cap leave through the top.`,
    '- Light comes from the upper left: lit edges on top, shade underneath.',
    '- Only hatch, rotate, needs you, done and queue done take the feet off the branch. In every other state the legs and body stay put and only the head and chest move.',
    '- Breathing lifts the head one pixel and swells the chest one pixel.',
    '- Every state has a still pose with a marker glyph. The panel shows it when **Robin animations** is off or the system asks for reduced motion.',
    '- Colors come from two palettes: one for light themes, one for dark and high contrast themes.',
    '',
    '## States',
    '',
    'When two states apply at once, the one higher in this table shows. A scene that plays once always plays whole: one that starts while another plays waits for it, and one that a higher state interrupts is skipped.',
    '',
    '<table>',
    '<tr><th>Animation</th><th>State</th><th>When it plays</th></tr>',
    ...rows,
    '</table>',
    '',
    '## Still poses',
    '',
    'The reduced motion pose for each state, with the marker that names it.',
    '',
    '<p align="center">',
    '  ' + picture('mascot/still.svg', 'mascot/still-dark.svg', 'The robin still poses in ' + STATES.length + ' states', 680),
    '</p>',
    '',
    '## Icons',
    '',
    '<table>',
    '<tr><th>Icon</th><th>Use</th></tr>',
    '<tr><td><img src="../media/icon.png" alt="The listing icon: the robin singing in its nest" width="128"></td>' +
      '<td><b>Listing icon</b><br><code>media/icon.png</code>, 256 by 256 pixels. Shown in the Extensions view and on the extension page.</td></tr>',
    '<tr><td><img src="mascot/activitybar.svg" alt="The Activity Bar icon on a light bar" width="200"><br>' +
      '<img src="mascot/activitybar-dark.svg" alt="The Activity Bar icon on a dark bar" width="200"></td>' +
      '<td><b>Activity Bar icon</b><br><code>media/nest.svg</code>, a 24 pixel line drawing. VS Code paints it in one color, the bar\'s icon color, so it reads the same in every theme.</td></tr>',
    '<tr><td><img src="mascot/desktop-tile.png" alt="The desktop tile: the robin in its nest on a pale blue rounded square" width="128"></td>' +
      '<td><b>Desktop tile</b><br><code>docs/mascot/desktop-tile.png</code>, 512 by 512 pixels. For a desktop or dock shortcut; it is not part of the extension.</td></tr>',
    '</table>',
    '',
    '## Palette',
    '',
    '### Light themes',
    '',
    `<img src="mascot/palette.svg" alt="The light palette" width="${PALETTE_W}">`,
    '',
    '### Dark and high contrast themes',
    '',
    `<img src="mascot/palette-dark.svg" alt="The dark palette" width="${PALETTE_W}">`,
    '',
    '<details>',
    '<summary>Palette values</summary>',
    '',
    '| Group | Role | Light | Dark |',
    '| --- | --- | --- | --- |',
    ...swatchRows,
    '',
    '</details>',
    '',
  ].join('\n');
}

// Every generated text file, keyed by its path from the repo root.
function build() {
  const files = {};
  const iconSvg = fs.readFileSync(path.join(repo, 'media', 'nest.svg'), 'utf8');
  files['media/readme/robin.svg'] = hero(mascot.LIGHT, false);
  files['media/readme/robin-dark.svg'] = hero(mascot.DARK, false);
  files['media/readme/robin-states.svg'] = sheet(mascot.LIGHT, TEXT.muted.light, SHEET, false, 'The robin').text;
  files['media/readme/robin-states-dark.svg'] = sheet(mascot.DARK, TEXT.muted.dark, SHEET, false, 'The robin').text;
  for (const s of STATES) {
    files['docs/mascot/state-' + s.state + '.svg'] = stateLoop(s, mascot.LIGHT);
    files['docs/mascot/state-' + s.state + '-dark.svg'] = stateLoop(s, mascot.DARK);
  }
  const stills = STATES.map((s) => [s.state, s.name.toLowerCase(), 0]);
  files['docs/mascot/still.svg'] = sheet(mascot.LIGHT, TEXT.muted.light, stills, true, 'The robin still poses').text;
  files['docs/mascot/still-dark.svg'] = sheet(mascot.DARK, TEXT.muted.dark, stills, true, 'The robin still poses').text;
  files['docs/mascot/palette.svg'] = palette('light');
  files['docs/mascot/palette-dark.svg'] = palette('dark');
  files['docs/mascot/activitybar.svg'] = activityBar('light', iconSvg);
  files['docs/mascot/activitybar-dark.svg'] = activityBar('dark', iconSvg);
  files['docs/mascot.md'] = mascotDoc();
  return files;
}

function findChrome() {
  const list = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  return list.find((p) => p && fs.existsSync(p));
}

function png(svgText, w, h, outFile) {
  const chrome = findChrome();
  if (!chrome) {
    // A skipped PNG would leave a stale README fallback behind, so the run fails.
    console.error('No Chrome found for ' + path.basename(outFile) + '; set CHROME_PATH and run again.');
    process.exitCode = 1;
    return;
  }
  const { execFileSync } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-readme-'));
  const src = path.join(tmp, 'img.svg');
  fs.writeFileSync(src, svgText);
  execFileSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=2',
      '--default-background-color=00000000',
      `--window-size=${w},${h}`,
      `--screenshot=${outFile}`,
      'file://' + src,
    ],
    { stdio: 'ignore' },
  );
}

// The PNG fallbacks: the README still hero and the state sheet, rendered at twice these sizes.
function pngs() {
  const light = sheet(mascot.LIGHT, TEXT.muted.light, SHEET, false, 'The robin');
  return [
    { file: 'media/readme/robin.png', svg: hero(mascot.LIGHT, true), w: BOX.w * 6, h: BOX.h * 6 },
    { file: 'media/readme/robin-states.png', svg: light.text, w: light.w, h: light.h },
  ];
}

module.exports = { build, pngs, STATES, ROLES, HEADROOM };

if (require.main === module) {
  const files = build();
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  }
  for (const p of pngs()) {
    png(p.svg, p.w, p.h, path.join(repo, p.file));
  }
  console.log('Wrote ' + Object.keys(files).length + ' files, robin.png and robin-states.png.');
}
