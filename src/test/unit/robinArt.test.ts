// Unit tests for the robin art webview script, loaded in a vm sandbox.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

interface Grid {
  name: string;
  rows: string[];
}
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  c: string;
}
interface Art {
  PALETTE: Record<string, string>;
  BIRD: string[];
  BIRD_ORIGIN: { x: number; y: number };
  BRANCHES: Record<string, string[]>;
  BRANCH_W: number;
  BRANCH_H: number;
  GLYPHS: Record<string, string[]>;
  PLACEMENTS: Record<string, { g: string; c: string; x: number; y: number }>;
  TOGETHER: Record<string, string[]>;
  NOTE_LANES: number[];
  NOTE_Y: number;
  HINT_PLACEMENTS: Record<string, string[]>;
  FLIGHT_KINDS: string[];
  FLIGHT_TOP: number;
  badCells(rows: string[]): unknown[];
  allGrids(): Grid[];
  birdFrame(flags: { blink?: boolean; flick?: boolean }): string[];
  flightFrame(kind: string): string[];
  birdParts(rows: string[]): Record<string, Rect[]>;
  chestFill(rows: string[]): Rect[];
}

function loadArt(): Art {
  const file = path.join(__dirname, '..', '..', '..', 'media', 'robinArt.js');
  const sandbox: { NestRobinArt?: Art } = {};
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox);
  assert.ok(sandbox.NestRobinArt, 'robinArt.js defines NestRobinArt');
  return sandbox.NestRobinArt;
}

const art = loadArt();

describe('robin art', () => {
  it('keeps every frame, branch, egg and reaction to two values per 2x2 cell', () => {
    const grids = art.allGrids();
    assert.ok(grids.length >= 20, 'expected at least 20 definitions, got ' + grids.length);
    for (const g of grids) {
      const bad = art.badCells(g.rows);
      assert.strictEqual(bad.length, 0, g.name + ' ' + JSON.stringify(bad));
    }
  });

  it('uses only palette colors and rectangular grids', () => {
    for (const g of art.allGrids()) {
      const width = g.rows[0].length;
      for (const row of g.rows) {
        assert.strictEqual(row.length, width, g.name + ' is rectangular');
        for (const ch of row) {
          assert.ok(ch === '.' || ch in art.PALETTE, g.name + ' uses unknown color ' + ch);
        }
      }
    }
  });

  it('shares no 2x2 cell between the bird and either branch', () => {
    for (const [name, rows] of Object.entries(art.BRANCHES)) {
      assert.strictEqual(rows.length, art.BRANCH_H, name);
      assert.strictEqual(rows[0].length, art.BRANCH_W, name);
      const bird = new Set<string>();
      art.BIRD.forEach((row, y) => {
        [...row].forEach((c, x) => {
          if (c !== '.') {
            bird.add(Math.floor((x + art.BIRD_ORIGIN.x) / 2) + ',' + Math.floor((y + art.BIRD_ORIGIN.y) / 2));
          }
        });
      });
      rows.forEach((row, y) => {
        [...row].forEach((c, x) => {
          if (c !== '.') {
            assert.ok(!bird.has(Math.floor(x / 2) + ',' + Math.floor(y / 2)), name + ' overlaps the bird at ' + x + ',' + y);
          }
        });
      });
    }
  });

  it('starts the bird at an even pixel column so its cells line up with the branch', () => {
    assert.strictEqual(art.BIRD_ORIGIN.x % 2, 0);
    assert.strictEqual(art.BIRD_ORIGIN.y % 2, 0);
    assert.strictEqual(art.FLIGHT_TOP % 2, 0);
  });

  it('has two to four wing frames that differ', () => {
    assert.ok(art.FLIGHT_KINDS.length >= 2 && art.FLIGHT_KINDS.length <= 4);
    const frames = art.FLIGHT_KINDS.map((k) => art.flightFrame(k).join('\n'));
    assert.strictEqual(new Set(frames).size, frames.length);
  });

  it('draws the blink by changing only the eye pixel', () => {
    const open = art.birdFrame({});
    const shut = art.birdFrame({ blink: true });
    const changed: string[] = [];
    open.forEach((row, y) => {
      [...row].forEach((c, x) => {
        if (c !== shut[y][x]) {
          changed.push(x + ',' + y + ':' + c + '>' + shut[y][x]);
        }
      });
    });
    assert.deepStrictEqual(changed, ['15,2:e>H']);
  });

  it('splits the bird into parts that cover every pixel once', () => {
    for (const flags of [{}, { blink: true }, { flick: true }]) {
      const rows = art.birdFrame(flags);
      const parts = art.birdParts(rows);
      const total = Object.values(parts).reduce((n, list) => n + list.reduce((m, r) => m + r.w, 0), 0);
      const lit = rows.join('').replace(/\./g, '').length;
      assert.strictEqual(total, lit);
      assert.ok(['head', 'tail', 'chest', 'lower', 'legs'].every((name) => parts[name].length > 0));
    }
  });

  it('puts exactly the two leg pixels in the legs part, in every frame', () => {
    const legs = [
      { x: 11, y: 9, w: 1, h: 1, c: 'H' },
      { x: 15, y: 9, w: 1, h: 1, c: 'r' },
    ];
    for (const flags of [{}, { blink: true }, { flick: true }]) {
      const parts = art.birdParts(art.birdFrame(flags));
      assert.deepStrictEqual(JSON.parse(JSON.stringify(parts.legs)), legs);
      for (const [name, list] of Object.entries(parts)) {
        if (name !== 'legs') {
          assert.ok(list.every((r) => r.y < 9), name + ' has no pixel on the leg row');
        }
      }
    }
  });

  it('breathes with rows 4 to 6 only and fills the row the chest leaves', () => {
    for (const flags of [{}, { blink: true }, { flick: true }]) {
      const parts = art.birdParts(art.birdFrame(flags));
      assert.ok(parts.head.every((r) => r.y < 4), 'head rows 0 to 3');
      assert.ok(parts.chest.every((r) => r.y >= 4 && r.y <= 6 && r.x > 7), 'chest rows 4 to 6');
      assert.ok(parts.lower.every((r) => r.y >= 7 && r.y <= 8 && r.x > 7), 'lower body rows 7 and 8');
      assert.ok(parts.tail.every((r) => r.x <= 7), 'tail columns 0 to 7');
    }
    const fill = art.chestFill(art.BIRD);
    const row6 = art.birdParts(art.BIRD).chest.filter((r) => r.y === 6);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(fill)), JSON.parse(JSON.stringify(row6)));
    for (const r of fill) {
      for (let x = r.x; x < r.x + r.w; x += 1) {
        assert.strictEqual(art.BIRD[r.y][x], r.c, 'the chest hides the fill at ' + x + ',' + r.y);
      }
    }
  });

  it('moves only the head and chest in a state that is not a jump, hop or flight', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'media', 'orgPanel.css'), 'utf8');
    const planted = ['idle', 'working', 'error', 'sleep', 'night', 'worm'];
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map((r) => r.trim());
    const whole = /\.rp-(perch|hop|at)\b/;
    const still = /\.rp-(legs|lower|tail|chest)\b/;
    const mayMove = /^\.(rp-upper|rp-head|rp-note|rb-[a-z-]+)$/;
    let checked = 0;
    for (const rule of rules) {
      const brace = rule.indexOf('{');
      if (brace < 0 || rule.startsWith('@keyframes')) {
        continue;
      }
      const decl = rule.slice(brace + 1);
      if (!/(^|[\s;])(animation|transform)\s*:/.test(decl)) {
        continue;
      }
      for (const raw of rule.slice(0, brace).split(',')) {
        const sel = raw.trim();
        assert.ok(!still.test(sel), 'the legs, lower body, tail and chest move only with the whole bird: ' + sel);
        const state = /\[data-state="([a-z]+)"\]/.exec(sel);
        if (whole.test(sel)) {
          assert.ok(state, 'a rule that moves the whole bird names its state: ' + sel);
          assert.ok(!planted.includes(state[1]), state[1] + ' moves the whole bird: ' + sel);
        }
        if (state && planted.includes(state[1])) {
          const target = sel.split(/\s+/).pop() || '';
          assert.ok(mayMove.test(target), state[1] + ' moves more than the head and chest: ' + sel);
          checked += 1;
        }
      }
    }
    assert.ok(checked >= 10, 'expected the planted state rules to be checked, got ' + checked);
  });

  it('draws the legs, lower body and tail in the panel outside the moving head and chest', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'media', 'orgPanel.js'), 'utf8');
    const start = src.indexOf('function buildRobin(');
    const body = src.slice(start, src.indexOf('\n  }\n', start));
    for (const cls of ['rp-legs', 'rp-lower', 'rp-tail rp-tail-rest', 'rp-tail rp-tail-flick', 'rp-upper']) {
      assert.ok(body.includes("robinGroup(hop, '" + cls + "')"), cls + ' sits directly in rp-hop');
    }
    assert.ok(body.includes("robinGroup(upper, 'rp-chest')"), 'the chest sits in rp-upper');
    assert.ok(body.includes("robinGroup(upper, 'rp-head')"), 'the head sits in rp-upper');
  });

  it('places every reaction on a known glyph and color', () => {
    for (const p of Object.values(art.PLACEMENTS)) {
      assert.ok(art.GLYPHS[p.g], 'glyph ' + p.g);
      assert.ok(art.PALETTE[p.c], 'color ' + p.c);
    }
  });

  const box = (key: string): { x0: number; y0: number; x1: number; y1: number } => {
    const p = art.PLACEMENTS[key];
    const rows = art.GLYPHS[p.g];
    return { x0: p.x, y0: p.y, x1: p.x + rows[0].length - 1, y1: p.y + rows.length - 1 };
  };
  const gap = (a: ReturnType<typeof box>, b: ReturnType<typeof box>): number =>
    Math.max(b.x0 - a.x1 - 1, a.x0 - b.x1 - 1, b.y0 - a.y1 - 1, a.y0 - b.y1 - 1);

  it('keeps reactions that show together at least 3 pixels apart', () => {
    for (const [state, keys] of Object.entries(art.TOGETHER)) {
      for (let i = 0; i < keys.length; i += 1) {
        for (let j = i + 1; j < keys.length; j += 1) {
          assert.ok(gap(box(keys[i]), box(keys[j])) >= 3, state + ': ' + keys[i] + ' and ' + keys[j] + ' are too close');
        }
      }
    }
  });

  it('gives each working note lane its own 1 pixel gap and clears the head', () => {
    const width = art.GLYPHS.note[0].length;
    const height = art.GLYPHS.note.length;
    art.NOTE_LANES.forEach((x, i) => {
      if (i > 0) {
        assert.ok(x - (art.NOTE_LANES[i - 1] + width - 1) - 1 >= 1, 'lane ' + i);
      }
    });
    assert.ok(art.NOTE_Y + height - 1 < 0, 'the note sits above the head');
  });

  it('shows a marker for every hint the host can send', () => {
    for (const keys of Object.values(art.HINT_PLACEMENTS)) {
      for (const key of keys) {
        assert.ok(art.PLACEMENTS[key], key);
      }
    }
  });

  it('has the webview skip an identical robin message so notes in flight survive', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'media', 'orgPanel.js'), 'utf8');
    const start = src.indexOf('function onRobinMessage(');
    assert.ok(start >= 0);
    const body = src.slice(start, src.indexOf('buildRobin();', start));
    const guard = body.indexOf('JSON.stringify(robinMsg) === JSON.stringify(next)');
    assert.ok(guard >= 0, 'compares the new message with the current one');
    assert.ok(guard < body.indexOf('applyRobin()'), 'returns before applyRobin');
  });

  it('colors the panel with the same palette the art file declares', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'media', 'orgPanel.css'), 'utf8');
    for (const [key, hex] of Object.entries(art.PALETTE)) {
      const m = new RegExp('^\\.rp-' + key + ' \\{ fill: (#[0-9A-Fa-f]{6}); \\}', 'm').exec(css);
      assert.ok(m, 'a .rp-' + key + ' fill rule exists');
      assert.strictEqual(m?.[1].toLowerCase(), hex.toLowerCase(), 'color ' + key);
    }
  });
});
