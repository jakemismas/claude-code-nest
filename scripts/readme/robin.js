#!/usr/bin/env node
// Builds the README robin images from the same pixel art the panel draws, so the two never
// drift apart. Writes animated SVGs plus still PNG fallbacks (vsce refuses SVG-only images).
// Usage: node scripts/readme/robin.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const repo = path.resolve(__dirname, '..', '..');
const outDir = path.join(repo, 'media', 'readme');
require(path.join(repo, 'media', 'robinArt.js'));
const art = globalThis.NestRobinArt;

// Follow the branch the panel ships with.
const panelJs = fs.readFileSync(path.join(repo, 'media', 'orgPanel.js'), 'utf8');
const branchMatch = /const ROBIN_BRANCH = '([a-z]+)'/.exec(panelJs);
const BRANCH = branchMatch && art.BRANCHES[branchMatch[1]] ? branchMatch[1] : 'thick';

// The area one robin needs: glyphs reach 9 pixels above the branch and 5 past its end.
const BOX = { x: -1, y: -9, w: 32, h: 23 };

function rects(list, dx, dy) {
  return list
    .map((r) => `<rect x="${r.x + dx}" y="${r.y + dy}" width="${r.w}" height="1" fill="${art.PALETTE[r.c]}"/>`)
    .join('');
}

function rows(gridRows, dx, dy) {
  return rects(art.runs(gridRows), dx, dy);
}

function glyph(key, cls) {
  const p = art.PLACEMENTS[key];
  return `<g class="${cls}">${rows(art.glyphRows(p.g, p.c), p.x, p.y)}</g>`;
}

function bird(peck) {
  const o = art.BIRD_ORIGIN;
  const rest = art.birdParts(art.BIRD);
  const flick = art.birdParts(art.birdFrame({ flick: true }));
  return (
    `<g class="tail-rest">${rects(rest.tail, o.x, o.y)}</g>` +
    `<g class="tail-flick">${rects(flick.tail, o.x, o.y)}</g>` +
    rects(rest.legs, o.x, o.y) +
    rects(rest.lower, o.x, o.y) +
    rects(rest.chest, o.x, o.y) +
    `<g class="${peck ? 'peck' : 'head'}">${rects(rest.head, o.x, o.y)}` +
    `<g class="eye">${rects(rest.eye, o.x, o.y)}</g></g>`
  );
}

// Glyphs per state; classes pick the motion below.
const STATES = [
  { id: 'idle', label: 'idle', glyphs: [] },
  {
    id: 'working',
    label: 'working',
    glyphs: [
      ['noteB', 'rise r1'],
      ['noteA', 'rise r2'],
    ],
  },
  { id: 'needs', label: 'needs you', glyphs: [['question', 'bob']] },
  {
    id: 'done',
    label: 'done',
    glyphs: [
      ['stillCheck', 'pop'],
      ['sparkA', 'twinkle t1'],
      ['sparkB', 'twinkle t2'],
      ['sparkC', 'twinkle t3'],
    ],
  },
  {
    id: 'sleep',
    label: 'sleeping',
    glyphs: [
      ['zSmall', 'drift d1'],
      ['zBig', 'drift d2'],
    ],
  },
  { id: 'error', label: 'error', glyphs: [['bang', 'flash']] },
];

const STYLE = `
  .eye { animation: blink 4.2s steps(1, end) infinite; }
  .tail-flick { opacity: 0; animation: flick 7s steps(1, end) infinite; }
  .tail-rest { animation: rest 7s steps(1, end) infinite; }
  .peck { animation: peck 0.8s steps(1, end) infinite; }
  .rise { animation: rise 2.4s steps(6, end) infinite; }
  .r2 { animation-delay: 1.2s; }
  .bob { animation: bob 1.4s steps(1, end) infinite; }
  .pop { animation: pop 2.8s steps(1, end) infinite; }
  .twinkle { animation: twinkle 1.6s steps(1, end) infinite; }
  .t2 { animation-delay: 0.5s; } .t3 { animation-delay: 1s; }
  .drift { animation: drift 3s steps(6, end) infinite; }
  .d2 { animation-delay: 1.5s; }
  .flash { animation: flash 1s steps(1, end) infinite; }
  .label { font: 600 3.4px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; fill: #8A7469; }
  @keyframes blink { 0%, 94% { opacity: 1; } 96% { opacity: 0; } }
  @keyframes rest { 0%, 88% { opacity: 1; } 90%, 94% { opacity: 0; } 96% { opacity: 1; } }
  @keyframes flick { 0%, 88% { opacity: 0; } 90%, 94% { opacity: 1; } 96% { opacity: 0; } }
  @keyframes peck { 0% { transform: translate(0, 0); } 45% { transform: translate(1px, 2px); } 60% { transform: translate(1px, 1px); } 75% { transform: translate(0, 0); } }
  @keyframes rise { 0% { transform: translateY(2px); opacity: 0; } 15% { opacity: 1; } 80% { opacity: 1; } 100% { transform: translateY(-4px); opacity: 0; } }
  @keyframes bob { 0%, 49% { transform: translateY(0); } 50% { transform: translateY(-1px); } }
  @keyframes pop { 0%, 79% { opacity: 1; } 80%, 89% { opacity: 0; } 90% { opacity: 1; } }
  @keyframes twinkle { 0%, 59% { opacity: 1; } 60% { opacity: 0.25; } }
  @keyframes drift { 0% { transform: translate(0, 1px); opacity: 0; } 20% { opacity: 1; } 75% { opacity: 1; } 100% { transform: translate(1px, -3px); opacity: 0; } }
  @keyframes flash { 0%, 59% { opacity: 1; } 60% { opacity: 0.2; } }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
`;

function robinAt(state, dx, dy) {
  const g = state.glyphs.map(([key, cls]) => glyph(key, cls)).join('');
  return `<g transform="translate(${dx} ${dy})">${rows(art.BRANCHES[BRANCH], 0, 0)}${bird(state.id === 'working')}${g}</g>`;
}

function svg(w, h, body, label, viewBox, extraStyle) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${w}" height="${h}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="${label}">` +
    `<style>${STYLE}${extraStyle || ''}</style>${body}</svg>\n`
  );
}

function hero(still) {
  const working = STATES.find((s) => s.id === 'working');
  const vb = `${BOX.x} ${BOX.y} ${BOX.w} ${BOX.h}`;
  return svg(BOX.w * 6, BOX.h * 6, robinAt(working, 0, 0), 'A pixel-art robin singing on a branch', vb, still ? STILL : '');
}

function sheet(still) {
  const cols = 3;
  const tileH = BOX.h + 7;
  const tiles = STATES.map((s, i) => {
    const tx = (i % cols) * BOX.w - BOX.x;
    const ty = Math.floor(i / cols) * tileH - BOX.y;
    const text = `<text class="label" x="${tx + 13}" y="${ty + 18.5}" text-anchor="middle" shape-rendering="auto">${s.label}</text>`;
    return robinAt(s, tx, ty) + text;
  }).join('');
  const w = cols * BOX.w;
  const h = Math.ceil(STATES.length / cols) * tileH;
  return svg(w * 5, h * 5, tiles, 'The robin in six states: idle, working, needs you, done, sleeping and error', `0 0 ${w} ${h}`, still ? STILL : '');
}

// The PNG fallback shows the resting pose with every glyph in place.
const STILL = '* { animation: none !important; } .tail-flick { opacity: 0; }';

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
  execFileSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=2',
    '--default-background-color=00000000',
    `--window-size=${w},${h}`,
    `--screenshot=${outFile}`,
    'file://' + src,
  ], { stdio: 'ignore' });
}

const heroSvg = hero(false);
const sheetSvg = sheet(false);
fs.writeFileSync(path.join(outDir, 'robin.svg'), heroSvg);
fs.writeFileSync(path.join(outDir, 'robin-states.svg'), sheetSvg);
png(hero(true), BOX.w * 6, BOX.h * 6, path.join(outDir, 'robin.png'));
png(sheet(true), 3 * BOX.w * 5, 2 * (BOX.h + 7) * 5, path.join(outDir, 'robin-states.png'));
console.log('Wrote robin.svg, robin.png, robin-states.svg and robin-states.png (' + BRANCH + ' branch).');
