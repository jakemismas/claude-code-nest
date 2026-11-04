// Pixel art for the header robin. One character per square pixel, '.' is transparent.
// The panel draws these grids as SVG rects. The same data also prints as terminal block
// characters because every 2x2 pixel cell holds at most two colors (see the unit test).
(function (root) {
  'use strict';

  const PALETTE = {
    H: '#5B4A42', // head and back
    w: '#8A7469', // wing
    r: '#D9692E', // breast
    b: '#C99413', // beak
    e: '#1F1A17', // eye
    t: '#C29261', // branch highlight
    m: '#8A5A3B', // branch
    d: '#5E3E26', // branch shadow
    g: '#4E9A5B', // leaf
    G: '#357544', // leaf shade
    l: '#7CC06A', // leaf light
    x: '#C8462E', // berry and the exclamation mark
    s: '#C9A66A', // egg speckle
    E: '#E6D3AA', // egg shell
    n: '#C2571A', // note orange
    p: '#8C6FE0', // note purple and sparkle
    o: '#C99413', // note gold
    a: '#2E9E57', // note green and check
    y: '#C9A227', // sparkle gold
    q: '#C98A00', // question mark
    z: '#6A8CC8', // sleep and moon
    v: '#D46A86', // worm
  };

  // The bird alone. Its top-left pixel sits at column 2, row 0 of a branch.
  const BIRD = [
    '..............HHHH....',
    '............HHHHHHH...',
    '...........HHHHeHHHHbb',
    '..........HHHHHHHHHHb.',
    '.....HHHwwwwHHrrrrr...',
    '..HHHHHHwwwwHHrrrrr...',
    'HHHHHHHHwwwwHHrrrrr...',
    '......HHwwwwHHrrrr....',
    '........HHHHHHrrr.....',
    '...........H...r......',
  ];
  const BIRD_ORIGIN = { x: 2, y: 0 };
  // Rows 0 to 3 are the head; the eye is the single 'e' pixel.
  const HEAD_ROWS = 4;

  // The branches with the bird removed (the bird's feet land on row 10).
  const BRANCHES = {
    thick: [
      '..........................',
      '..........................',
      '..........................',
      '..........................',
      '..........................',
      '..........................',
      'lg....................gll.',
      'gl....................lgll',
      'Ggg...................m.GG',
      'gG....................m.G.',
      'mmttmmmmttmmmmttmmmmttmmmm',
      'dddddddddddddddddddddddddd',
      '..ggG.............glGGl...',
      '..g...............lgG.....',
    ],
    leafy: [
      '..........................',
      '..........................',
      '..........................',
      '..........................',
      '..........................',
      '..........................',
      '.l....................gl..',
      'll....................ggll',
      'llgGg................gGgll',
      'ggGgg...............gggGl.',
      'mmmmmmmmmmmmmmmmmmmmmmmmmm',
      '....gg....gg......gg......',
      '....gG....xx......Gg.x....',
      '....Gg....x.......gGxx....',
    ],
  };
  const BRANCH_W = 26;
  const BRANCH_H = 14;

  // Pixels edited out of the perched bird for the blink and the tail flick.
  const EDITS = {
    blink: [[15, 2, 'H']],
    flick: [
      [0, 3, 'H'],
      [1, 3, 'H'],
      [0, 4, 'H'],
      [1, 4, 'H'],
      [2, 4, 'H'],
      [3, 4, 'H'],
      [4, 4, 'H'],
      [0, 6, '.'],
      [1, 6, '.'],
      [2, 6, '.'],
      [3, 6, '.'],
    ],
  };

  function toGrid(rows) {
    return rows.map((r) => r.split(''));
  }
  function fromGrid(grid) {
    return grid.map((r) => r.join(''));
  }

  // The perched bird with a blink and or a tail flick applied.
  function birdFrame(flags) {
    const grid = toGrid(BIRD);
    const apply = (list) => {
      for (const [x, y, c] of list) {
        grid[y][x] = c;
      }
    };
    if (flags && flags.flick) {
      apply(EDITS.flick);
    }
    if (flags && flags.blink) {
      apply(EDITS.blink);
    }
    return fromGrid(grid);
  }

  // Flight frames share the bird's grid. Rows start FLIGHT_TOP pixels above the bird so a
  // raised wing fits on the same grid.
  const FLIGHT_TOP = 6;
  const WING_UP = [
    [4, -2, 5],
    [4, -1, 6],
    [4, 0, 7],
    [5, 1, 8],
    [5, 2, 9],
    [6, 3, 9],
  ];
  const WING_DOWN = [
    [8, 8, 11],
    [8, 9, 11],
    [8, 10, 10],
    [8, 11, 10],
  ];
  function flightFrame(kind) {
    const w = BIRD[0].length;
    const grid = [];
    for (let y = 0; y < FLIGHT_TOP + BIRD.length + 2; y += 1) {
      grid.push(new Array(w).fill('.'));
    }
    for (let y = 0; y < BIRD.length; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const c = BIRD[y][x];
        grid[y + FLIGHT_TOP][x] = c === 'w' && kind === 'up' ? 'H' : c;
      }
    }
    const spans = kind === 'up' ? WING_UP : kind === 'down' ? WING_DOWN : [];
    for (const [x0, y, x1] of spans) {
      for (let x = x0; x <= x1; x += 1) {
        grid[y + FLIGHT_TOP][x] = 'w';
      }
    }
    return fromGrid(grid);
  }
  const FLIGHT_KINDS = ['up', 'mid', 'down'];

  const EGG = [
    '....EEEEEEEE....',
    '..EEEEEEEEEEEE..',
    '.EEsEEEEEEEEEEE.',
    'EEEEEEEEEEEEEEEE',
    'EEEEEEEEEEEEEEEE',
    'EEEEEEEEEEEsEEEE',
    'EEEEEEEEEEEEEEEE',
    '.EEEEEEEEEEEEEE.',
    '..EEEEEEEEEEEE..',
    '....EEEEEEEE....',
  ];
  const EGG_CRACKED = [
    '....EEEEEEEE....',
    '..EEEEEEEEEEEE..',
    '.EEsEEEwEEEEEEE.',
    'EEEEEEEEwEEEEEEE',
    'EEEEEEEwEEEEEEEE',
    'EEEEEEEEwEEsEEEE',
    'EEEEEEEEEwEEEEEE',
    '.EEEEEEEEEwEEEE.',
    '..EEEEEEEEEEEE..',
    '....EEEEEEEE....',
  ];
  const EGG_ORIGIN = { x: 5, y: 0 };

  // Reaction bitmaps; '#' is a lit pixel.
  const GLYPHS = {
    note: ['.###', '.#.#', '.#..', '##..', '##..'],
    q: ['.##.', '#..#', '..#.', '....', '..#.'],
    bang: ['##', '##', '##', '..', '##'],
    Z: ['####', '...#', '..#.', '.#..', '####'],
    z: ['###', '..#', '.#.', '###'],
    plus: ['.#.', '###', '.#.'],
    star: ['#.#', '.#.', '#.#'],
    dot: ['#'],
    check: ['...#', '..#.', '#.#.', '.#..'],
    moon: ['..##', '.###', '##..', '##..', '##..', '.###', '..##'],
    worm: ['.##..#', '#..##.'],
  };

  // Where each reaction sits, in branch pixel coordinates (the bird starts at x 2).
  // g is the glyph, c the palette key, x and y the top-left pixel. Glyphs that can show at
  // the same time sit at least 3 pixels apart.
  const PLACEMENTS = {
    question: { g: 'q', c: 'q', x: 17, y: -7 },
    bang: { g: 'bang', c: 'x', x: 18, y: -7 },
    noteA: { g: 'note', c: 'n', x: 17, y: -8 },
    noteB: { g: 'note', c: 'p', x: 10, y: -7 },
    sparkA: { g: 'plus', c: 'y', x: 0, y: -2 },
    sparkB: { g: 'star', c: 'p', x: 0, y: -8 },
    sparkC: { g: 'dot', c: 'y', x: 24, y: -2 },
    bigB: { g: 'star', c: 'p', x: 24, y: -8 },
    zSmall: { g: 'z', c: 'z', x: 13, y: -5 },
    zBig: { g: 'Z', c: 'z', x: 19, y: -8 },
    worm: { g: 'worm', c: 'v', x: 24, y: 2 },
    moon: { g: 'moon', c: 'z', x: 1, y: -8 },
    stillQuestion: { g: 'q', c: 'q', x: 17, y: -7 },
    stillBang: { g: 'bang', c: 'x', x: 18, y: -7 },
    stillCheck: { g: 'check', c: 'a', x: 18, y: -6 },
    stillZ: { g: 'z', c: 'z', x: 18, y: -6 },
    stillNote: { g: 'note', c: 'n', x: 17, y: -7 },
    stillWorm: { g: 'worm', c: 'v', x: 24, y: 2 },
    stillPlus: { g: 'plus', c: 'y', x: 18, y: -6 },
    stillBurstA: { g: 'star', c: 'p', x: 12, y: -7 },
    stillBurstB: { g: 'plus', c: 'y', x: 18, y: -7 },
    stillBurstC: { g: 'dot', c: 'a', x: 24, y: -5 },
  };
  // Placements that show together in one state.
  const TOGETHER = {
    done: ['noteA', 'noteB', 'sparkA', 'sparkB', 'sparkC'],
    milestone: ['noteA', 'noteB', 'sparkA', 'sparkB', 'sparkC', 'bigB'],
    sleep: ['zSmall', 'zBig'],
    night: ['moon', 'zSmall', 'zBig'],
    burst: ['stillBurstA', 'stillBurstB', 'stillBurstC'],
  };
  // The note colors a working chat cycles through.
  const NOTE_COLORS = ['n', 'p', 'o', 'a'];
  // A working note starts above the head in a lane per chat, 5 pixels apart (4 wide plus a gap).
  const NOTE_LANES = [2, 7, 12, 17, 22, 27];
  const NOTE_Y = -6;

  // The still markers a reduced-motion pose shows, by the hint the host sends. The egg hint
  // has no glyph: the pose shows the cracked egg instead of the bird.
  const HINT_PLACEMENTS = {
    question: ['stillQuestion'],
    bang: ['stillBang'],
    check: ['stillCheck'],
    z: ['stillZ'],
    note: ['stillNote'],
    worm: ['stillWorm'],
    plus: ['stillPlus'],
    burst: ['stillBurstA', 'stillBurstB', 'stillBurstC'],
    egg: [],
  };

  // Merges horizontal runs of one color into rects. keep(x, y, c) filters pixels.
  function runs(rows, keep) {
    const out = [];
    for (let y = 0; y < rows.length; y += 1) {
      let x = 0;
      while (x < rows[y].length) {
        const c = rows[y][x];
        if (c === '.' || (keep && !keep(x, y, c))) {
          x += 1;
          continue;
        }
        let x1 = x + 1;
        while (x1 < rows[y].length && rows[y][x1] === c && (!keep || keep(x1, y, c))) {
          x1 += 1;
        }
        out.push({ x, y, w: x1 - x, h: 1, c });
        x = x1;
      }
    }
    return out;
  }

  // Splits a bird frame into head, eye, tail, wing and body so each part can move alone.
  function birdParts(rows) {
    const part = (x, y, c) => {
      if (c === 'e') {
        return 'eye';
      }
      if (c === 'H' && x <= 7) {
        return 'tail';
      }
      if (y < HEAD_ROWS) {
        return 'head';
      }
      if (c === 'w') {
        return 'wing';
      }
      return 'body';
    };
    const out = {};
    for (const name of ['head', 'eye', 'tail', 'wing', 'body']) {
      out[name] = runs(rows, (x, y, c) => part(x, y, c) === name);
    }
    return out;
  }

  function glyphRows(name, color) {
    return GLYPHS[name].map((r) => r.replace(/#/g, color));
  }

  // Cells (2x2 pixels, padded with transparent) that hold more than two values, counting
  // transparent as one. Such a cell could not print as one quadrant block.
  function badCells(rows) {
    const h = rows.length;
    const w = rows[0].length;
    const bad = [];
    for (let cy = 0; cy < h; cy += 2) {
      for (let cx = 0; cx < w; cx += 2) {
        const vals = new Set();
        for (const y of [cy, cy + 1]) {
          for (const x of [cx, cx + 1]) {
            vals.add(y < h && x < w ? rows[y][x] : '.');
          }
        }
        if (vals.size > 2) {
          bad.push({ cx: cx / 2, cy: cy / 2, vals: Array.from(vals).sort().join('') });
        }
      }
    }
    return bad;
  }

  // Every grid the panel draws, by name, for the unit test.
  function allGrids() {
    const list = [];
    for (const blink of [false, true]) {
      for (const flick of [false, true]) {
        list.push({ name: 'bird blink=' + blink + ' flick=' + flick, rows: birdFrame({ blink, flick }) });
      }
    }
    for (const kind of FLIGHT_KINDS) {
      list.push({ name: 'flight ' + kind, rows: flightFrame(kind) });
    }
    for (const name of Object.keys(BRANCHES)) {
      list.push({ name: 'branch ' + name, rows: BRANCHES[name] });
    }
    list.push({ name: 'egg', rows: EGG });
    list.push({ name: 'egg cracked', rows: EGG_CRACKED });
    for (const name of Object.keys(GLYPHS)) {
      list.push({ name: 'glyph ' + name, rows: glyphRows(name, 'n') });
    }
    return list;
  }

  root.NestRobinArt = {
    PALETTE,
    BIRD,
    BIRD_ORIGIN,
    BRANCHES,
    BRANCH_W,
    BRANCH_H,
    EDITS,
    FLIGHT_TOP,
    FLIGHT_KINDS,
    EGG,
    EGG_CRACKED,
    EGG_ORIGIN,
    GLYPHS,
    PLACEMENTS,
    TOGETHER,
    NOTE_COLORS,
    NOTE_LANES,
    NOTE_Y,
    HINT_PLACEMENTS,
    birdFrame,
    flightFrame,
    runs,
    birdParts,
    glyphRows,
    badCells,
    allGrids,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
