#!/usr/bin/env node
// Builds the README robin images from the same scenes the panel draws, so the two never drift
// apart. Writes an animated hero and a state sheet as SVG, light and dark, plus still PNG
// fallbacks (vsce refuses SVG-only images).
// Usage: node scripts/readme/robin.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const repo = path.resolve(__dirname, '..', '..');
const outDir = path.join(repo, 'media', 'readme');
const sandbox = {};
vm.runInNewContext(fs.readFileSync(path.join(repo, 'media', 'mascot.js'), 'utf8'), sandbox);
const mascot = sandbox.NestMascot;

// The area one robin needs: the highest jump and burst reach 13 pixels above the art's top row.
const BOX = { x: -4, y: -13, w: 34, h: 27 };
// The hero loop: the robin works with two chats, then finishes and celebrates.
const HERO = [
  { state: 'working', ms: 4000 },
  { state: 'done', ms: 3500 },
];
const HERO_STEP_MS = 50;
const NOTES = { delays: [150, 1350], minMs: 2500, spreadMs: 0 };
// One telling moment per state for the sheet, in ms.
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

function svg(w, h, viewBox, label, style, body) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${w}" height="${h}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="${label}"><style>${style}</style>${body}</svg>\n`
  );
}

// The hero steps through real frames: each frame group shows for one step of the loop.
function hero(pal, still) {
  const sprites = Sprites(pal);
  const frames = [];
  for (const part of HERO) {
    for (let t = 0; t < part.ms; t += HERO_STEP_MS) {
      frames.push(mascot.frame(part.state, t, { notes: NOTES, speed: 0 }));
    }
  }
  // Merge runs of identical frames so the file carries each pose once.
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
  const period = (frames.length * HERO_STEP_MS) / 1000;
  const branch = rects(mascot.BRANCH, 0, 0, pal);
  let at = 0;
  const keyframes = [];
  const groups = merged.map((m, i) => {
    const from = (at / frames.length) * 100;
    at += m.steps;
    const to = (at / frames.length) * 100;
    keyframes.push(
      `@keyframes k${i}{0%,${from.toFixed(3)}%{visibility:hidden}${from.toFixed(3)}%,${to.toFixed(3)}%{visibility:visible}${to.toFixed(3)}%,100%{visibility:hidden}}` +
        `.k${i}{animation:k${i} ${period}s steps(1,end) infinite}`,
    );
    return `<g class="f k${i}">${m.frame.map((d) => sprites.use(d, 0, 0)).join('')}</g>`;
  });
  const pose = mascot.frame('working', 0, { still: true }).map((d) => sprites.use(d, 0, 0)).join('');
  const style =
    '.f{visibility:hidden}.pose{visibility:hidden}' +
    keyframes.join('') +
    '@media (prefers-reduced-motion:reduce){.f{animation:none!important}.pose{visibility:visible}}' +
    (still ? '.f{animation:none!important}.pose{visibility:visible}' : '');
  const body = sprites.defs() + branch + groups.join('') + `<g class="pose">${pose}</g>`;
  const vb = `${BOX.x} ${BOX.y} ${BOX.w} ${BOX.h}`;
  return svg(BOX.w * 6, BOX.h * 6, vb, 'A pixel-art robin working on a branch, then singing when the work is done', style, body);
}

function sheet(pal, labelColor) {
  const sprites = Sprites(pal);
  const cols = 4;
  const tileH = BOX.h + 6;
  const tiles = SHEET.map(([state, label, t], i) => {
    const tx = (i % cols) * BOX.w - BOX.x;
    const ty = Math.floor(i / cols) * tileH - BOX.y;
    const art = rects(mascot.BRANCH, tx, ty, pal) + mascot.frame(state, t, { notes: NOTES }).map((d) => sprites.use(d, tx, ty)).join('');
    const text = `<text class="label" x="${tx + 13}" y="${ty + 18.5}" text-anchor="middle" shape-rendering="auto">${label}</text>`;
    return art + text;
  });
  const w = cols * BOX.w;
  const h = Math.ceil(SHEET.length / cols) * tileH;
  const style = `.label{font:600 3.4px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;fill:${labelColor}}`;
  const label = 'The robin in ' + SHEET.length + ' states: ' + SHEET.map((s) => s[1]).join(', ');
  return { text: svg(w * 5, h * 5, `0 0 ${w} ${h}`, label, style, sprites.defs() + tiles.join('')), w: w * 5, h: h * 5 };
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
    console.warn('No Chrome found; skipped ' + path.basename(outFile));
    return;
  }
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

const LABEL = { light: '#8A7469', dark: '#B8A596' };
fs.writeFileSync(path.join(outDir, 'robin.svg'), hero(mascot.LIGHT, false));
fs.writeFileSync(path.join(outDir, 'robin-dark.svg'), hero(mascot.DARK, false));
const light = sheet(mascot.LIGHT, LABEL.light);
fs.writeFileSync(path.join(outDir, 'robin-states.svg'), light.text);
fs.writeFileSync(path.join(outDir, 'robin-states-dark.svg'), sheet(mascot.DARK, LABEL.dark).text);
png(hero(mascot.LIGHT, true), BOX.w * 6, BOX.h * 6, path.join(outDir, 'robin.png'));
png(light.text, light.w, light.h, path.join(outDir, 'robin-states.png'));
console.log('Wrote robin.svg, robin-dark.svg, robin.png, robin-states.svg, robin-states-dark.svg and robin-states.png.');
