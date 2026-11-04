// The README robin images and the robin style sheet are generated from media/mascot.js; these
// tests fail when a change to the art was not followed by a run of the generator.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { ROBIN_STATES, TRANSIENT_MS } from '../../fleet/robinState';

const repo = path.join(__dirname, '..', '..', '..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const generator = require(path.join(repo, 'scripts', 'readme', 'robin.js')) as {
  build(): Record<string, string>;
  pngs(): { file: string; w: number; h: number }[];
  STATES: { state: string; when: string; loop: number; from?: number; notes?: unknown; speed?: number }[];
  HEADROOM: number;
};
interface Placement {
  k: string;
  x: number;
  y: number;
  rows: string[];
}
const sandbox: { NestMascot?: { DURATIONS: Record<string, number>; frame(s: string, t: number, o?: unknown): Placement[] } } = {};
vm.runInNewContext(fs.readFileSync(path.join(repo, 'media', 'mascot.js'), 'utf8'), sandbox);
const mascot = sandbox.NestMascot as NonNullable<typeof sandbox.NestMascot>;
const REGENERATE = '; run node scripts/readme/robin.js';

function pngSize(file: string): { w: number; h: number } {
  const b = fs.readFileSync(file);
  assert.strictEqual(b.toString('latin1', 12, 16), 'IHDR', file + ' is a PNG');
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

describe('robin art files', () => {
  const files = generator.build();

  it('match what the generator draws from media/mascot.js', () => {
    assert.ok(Object.keys(files).length >= 30, 'the generator writes the README art and the style sheet');
    for (const [rel, text] of Object.entries(files)) {
      const file = path.join(repo, rel);
      assert.ok(fs.existsSync(file), rel + ' is missing' + REGENERATE);
      const onDisk = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      assert.ok(onDisk === text, rel + ' is out of date' + REGENERATE);
    }
  });

  it('give the style sheet an animated light and dark image and a description for every state', () => {
    assert.deepStrictEqual(generator.STATES.map((s) => s.state).sort(), [...ROBIN_STATES].sort());
    // The table runs in the order the host ranks the states, which the page says.
    assert.deepStrictEqual(generator.STATES.map((s) => s.state), [...ROBIN_STATES]);
    const doc = files['docs/mascot.md'];
    for (const s of generator.STATES) {
      assert.ok(doc.includes('srcset="mascot/state-' + s.state + '-dark.svg"'), s.state + ' dark image');
      assert.ok(doc.includes('src="mascot/state-' + s.state + '.svg"'), s.state + ' light image');
      assert.ok(s.when.length > 20 && doc.includes(s.when), s.state + ' says when it plays');
    }
  });

  it('link only images that exist from the style sheet', () => {
    const doc = files['docs/mascot.md'];
    const refs = [...doc.matchAll(/(?:src|srcset)="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(refs.length >= 28, 'found ' + refs.length + ' image references');
    for (const ref of refs) {
      assert.ok(!/^[a-z]+:/i.test(ref), ref + ' is a relative path');
      assert.ok(fs.existsSync(path.join(repo, 'docs', ref)), ref + ' exists');
    }
  });

  it('loop each repeating state without a jump at the seam', () => {
    for (const s of generator.STATES) {
      if (s.state in mascot.DURATIONS) {
        continue;
      }
      const opts = { notes: s.notes, speed: s.speed };
      const from = s.from ?? 0;
      assert.strictEqual(
        JSON.stringify(mascot.frame(s.state, from + s.loop, opts)),
        JSON.stringify(mascot.frame(s.state, from, opts)),
        s.state + ' loops every ' + s.loop + ' ms',
      );
    }
  });

  it('say how long each timed state lasts, from the host timing', () => {
    for (const s of generator.STATES) {
      const ms = TRANSIENT_MS[s.state as keyof typeof TRANSIENT_MS];
      if (ms !== undefined) {
        const n = Math.round(ms / 100) / 10;
        assert.ok(s.when.includes('for ' + n + ' second'), s.state + ' says ' + n + ' seconds: ' + s.when);
      }
    }
  });

  it('keep every scene inside the header room the panel and the style sheet give it', () => {
    const css = fs.readFileSync(path.join(repo, 'media', 'orgPanel.css'), 'utf8');
    const header = /\.nest-header \{[^}]*padding: (\d+)px/.exec(css);
    assert.ok(header, 'the header sets its top padding');
    assert.strictEqual(Number(header?.[1]) / 3, generator.HEADROOM, 'the header keeps the headroom at 3 CSS pixels per art pixel');
    const notes = { delays: [0, 300, 600, 900, 1200, 1500], minMs: 2500, spreadMs: 3500 };
    for (const state of ROBIN_STATES) {
      for (let t = 0; t < 16000; t += 25) {
        // The egg's cap and the robin flying away may leave through the top.
        const leaving = (k: string): boolean => k === 'cap' || (state === 'rotate' && t >= 150 && t < 1350);
        for (const d of mascot.frame(state, t, { notes })) {
          const top = d.y + d.rows.findIndex((r) => /[^.]/.test(r));
          assert.ok(leaving(d.k) || top >= -generator.HEADROOM, state + ' at ' + t + ' ms draws ' + d.k + ' at row ' + top);
        }
      }
    }
  });

  it('render the PNG fallbacks at twice their SVG size', () => {
    for (const p of generator.pngs()) {
      const size = pngSize(path.join(repo, p.file));
      assert.deepStrictEqual(size, { w: p.w * 2, h: p.h * 2 }, p.file + REGENERATE);
    }
  });

  it('keep the desktop tile at 512 pixels or less', () => {
    const size = pngSize(path.join(repo, 'docs', 'mascot', 'desktop-tile.png'));
    assert.ok(size.w <= 512 && size.h <= 512, 'desktop tile is ' + size.w + ' by ' + size.h);
    assert.strictEqual(size.w, size.h, 'the tile is square');
  });

  it('link the style sheet from the README robin section', () => {
    const readme = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
    const start = readme.indexOf('### Robin');
    assert.ok(start >= 0, 'the README has a robin section');
    const section = readme.slice(start, readme.indexOf('\n## ', start));
    assert.ok(section.includes('](docs/mascot.md)'), 'the robin section links docs/mascot.md');
  });
});
