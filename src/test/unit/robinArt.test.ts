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
      assert.ok(parts.head.length > 0 && parts.tail.length > 0 && parts.wing.length > 0 && parts.body.length > 0);
    }
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
});
