// The header robin. Scenes are pure functions of time that return sprite placements, so a test can
// sample any frame; render() draws them as square SVG rects and rebuilds only when a placement moves.
(function (root) {
  'use strict';

  // One light direction (upper left): j and f catch the light, K and u sit in shade. The beak (b) is a
  // lighter gold and the eye (e, W) has more contrast, so both read at small sizes.
  const LIGHT = {
    H: '#5B4A42', j: '#74615A', K: '#4E3F37', w: '#8A7469', f: '#A39083', u: '#6B594E',
    r: '#D9692E', R: '#EC8A4B', Q: '#B7521F', b: '#E9AE24', e: '#050403', W: '#FFFCF0', k: '#7A5A48',
    M: '#9E2B2B', T: '#E58C8C', B: '#B9CFEC',
    t: '#C29261', m: '#8A5A3B', d: '#5E3E26', g: '#4E9A5B', G: '#357544', l: '#7CC06A',
    x: '#C8462E', s: '#C9A66A', E: '#E6D3AA', O: '#9C8863', c: '#7A5E3F',
    n: '#C2571A', p: '#8C6FE0', o: '#C99413', a: '#2E9E57', y: '#C9A227', q: '#C98A00', z: '#6A8CC8', v: '#D46A86', V: '#A8325A',
  };
  const DARK = {
    H: '#8B7466', j: '#A38E80', K: '#66554A', w: '#B8A596', f: '#D6C6B8', u: '#907B6D',
    r: '#EA8240', R: '#F89E5E', Q: '#CB6A2C', b: '#F0BC40', e: '#050403', W: '#FFFCF0', k: '#C8A68C',
    M: '#D9544A', T: '#F3A0A0', B: '#C9DCF7',
    t: '#D9AE80', m: '#A87650', d: '#80593A', g: '#5FB06D', G: '#4A9A5A', l: '#8FD07E',
    x: '#E4624C', s: '#E8CF92', E: '#EDDDB8', O: '#B8A57F', c: '#7A5E3F',
    n: '#EA8240', p: '#B9A2F7', o: '#E3AC2E', a: '#4CC97E', y: '#EBCB4A', q: '#E3A424', z: '#93B4EE', v: '#F28DA9', V: '#FF9CB8',
  };

  const W = 26;
  const H = 14;
  const BX = 2;
  const BRANCH = [
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
  ];

  // Bird parts in bird coordinates: 22 wide, the body on rows 4 to 8 and the feet on row 9.
  const BODY = [
    '.......jjjjHHHRrrrr...',
    '.....jHHffffHHRrrrrr..',
    '..jjHHHHwwwwwHRrrrrrr.',
    'KHHHHHHHuuuuHHrrrrrQ..',
    '....KKKKKKKKKKQQQQQ...',
  ];
  const LEGS = ['...........k...k......', '...........kk..kk.....'];
  // Beak c closed, s half open, w wide, y yawn; n (no beak) is c without the beak pixels.
  const HEAD = {
    c: ['...jjjHH....', '..jjHHHHHH..', '.jHHHHeHrrbb', '.HHHHHWrrrb.', '..HHHrrrrr..'],
    s: ['...jjjHH....', '..jjHHHHHHbb', '.jHHHHeHrMM.', '.HHHHHWrrrbb', '..HHHrrrrr..'],
    w: ['...jjjHH.bb', '..jjHHHHHHb.', '.jHHHHeHHMM.', '.HHHHHWrMMM.', '..HHHrrrrrbb'],
    y: ['...jjjHH..bb', '..jjHHHHHHb.', '.jHHHHeHMMM.', '.HHHHHWrMTM.', '..HHHrrrrrbb'],
  };
  const FRONT = {
    c: ['...jjHHH...', '..jHHHHHH..', '.HWeHHHeWH.', '.HrrbbbrrH.', '..rrrbrrr..'],
    s: ['...jjHHH...', '..jHHHHHH..', '.HWeHHHeWH.', '.HrrbbbrrH.', '..rrMMMrr..'],
    w: ['...jjHHH...', '..jHHHHHH..', '.HWeHHHeWH.', '.HrrbbbrrH.', '..rMMMMMr..'],
  };

  // Wing frames as [x0, y, x1] spans in bird coordinates.
  const WING_SPANS = {
    lift: [[5, 2, 9], [6, 3, 10], [7, 4, 12]],
    up: [[2, -2, 6], [3, -1, 7], [4, 0, 8], [5, 1, 9], [6, 2, 10], [7, 3, 11], [8, 4, 12]],
    mid: [[0, 3, 10], [1, 4, 12], [3, 5, 11]],
    down: [[6, 7, 12], [6, 8, 13], [7, 9, 12], [8, 10, 11], [9, 11, 10]],
    low: [[0, 7, 9], [1, 8, 11], [3, 9, 11], [5, 10, 10]],
  };
  const FLAP = ['up', 'mid', 'down', 'low', 'lift'];

  const EGG = [
    '...EEEEEE...',
    '..EEEEEEEE..',
    '.EEsEEEEEEE.',
    '.EEEEEEEEEE.',
    'EEEEEEEEEEEE',
    'EEEEEEEEEsEE',
    'EEEEEEEEEEEE',
    '.EEEEEEEEEE.',
    '..EEEEEEEE..',
    '...EEEEEE...',
  ];
  const EGG_X = 8;
  const CRACKS = [
    [],
    [[6, 1], [5, 2], [6, 3]],
    [[6, 1], [5, 2], [6, 3], [5, 4], [6, 5]],
    [[6, 1], [5, 2], [6, 3], [5, 4], [6, 5], [3, 5], [4, 4], [7, 4], [8, 5], [9, 4]],
  ];
  const GLYPHS = {
    note: ['.##', '.#.', '.#.', '##.', '##.'],
    q: ['.##.', '#..#', '..#.', '....', '..#.'],
    bang: ['##', '##', '##', '..', '##'],
    z: ['###', '..#', '.#.', '###'],
    Z: ['####', '...#', '..#.', '.#..', '####'],
    plus: ['.#.', '###', '.#.'],
    star: ['#.#', '.#.', '#.#'],
    big: ['..#..', '.###.', '#####', '.###.', '..#..'],
    dot: ['#'],
    check: ['...#', '..#.', '#.#.', '.#..'],
    moon: ['.###', '##..', '##..', '##..', '##..', '.###'],
    ring: ['.#.', '#.#', '.#.'],
    box: ['##', '##'],
  };

  // How long each one-shot scene runs before it settles into idle. The host holds the state as long.
  const DURATIONS = { done: 3500, milestone: 4500, rotate: 4400, hatch: 5300, worm: 4000 };

  const cache = {};
  function sprite(key, make) {
    if (!Object.prototype.hasOwnProperty.call(cache, key)) {
      cache[key] = make();
    }
    return cache[key];
  }
  function spr(rows, ox, oy) {
    return { rows, ox: ox || 0, oy: oy || 0 };
  }
  function setPx(rows, x, y, c) {
    const r = rows[y];
    if (r && x >= 0 && x < r.length) {
      rows[y] = r.substring(0, x) + c + r.substring(x + 1);
    }
  }
  function edit(rows, list) {
    const out = rows.slice();
    for (const [x, y, c] of list) {
      setPx(out, x, y, c);
    }
    return out;
  }

  // kind: rest, or fly with the wing patch folded away; tail u is raised, d trails down.
  function bodySprite(kind, tail) {
    return sprite('body-' + kind + tail, () => {
      let rows = BODY.slice();
      if (kind === 'fly') {
        rows = rows.map((r) => r.replace(/[fwu]/g, 'H'));
      }
      const e = [];
      if (tail === 'u') {
        for (let i = 0; i < 4; i += 1) {
          e.push([i, 3, '.']);
        }
        for (let i = 0; i < 2; i += 1) {
          e.push([i, 2, '.']);
        }
        for (let i = 1; i <= 4; i += 1) {
          e.push([i, 1, 'H']);
        }
        for (let i = 3; i <= 6; i += 1) {
          e.push([i, 0, 'j']);
        }
        e.push([2, 2, 'H'], [3, 2, 'H']);
      } else if (tail === 'd') {
        e.push([0, 3, '.'], [1, 3, '.'], [2, 2, '.'], [3, 2, '.']);
        for (let i = 0; i < 4; i += 1) {
          e.push([i, 4, 'K']);
        }
        e.push([0, 5, 'K'], [1, 5, 'K']);
      }
      rows = edit(rows, e);
      if (tail === 'd') {
        rows.push('KK..................');
        rows[4] = 'KKKK' + rows[4].substring(4);
        rows[3] = '..' + rows[3].substring(2);
      }
      return spr(rows);
    });
  }
  function wingSprite(kind) {
    return sprite('wing-' + kind, () => {
      const spans = WING_SPANS[kind];
      const minY = Math.min(...spans.map((s) => s[1]));
      const maxY = Math.max(...spans.map((s) => s[1]));
      const rows = [];
      for (let i = 0; i <= maxY - minY; i += 1) {
        rows.push('......................');
      }
      spans.forEach(([x0, y, x1], i) => {
        const c = i === 0 ? 'f' : i === spans.length - 1 ? 'u' : 'w';
        for (let x = x0; x <= x1; x += 1) {
          setPx(rows, x, y - minY, c);
        }
      });
      return spr(rows, 0, minY);
    });
  }
  function headSprite(front, beak, eye) {
    return sprite('head-' + front + beak + eye, () => {
      const set = front ? FRONT : HEAD;
      let rows = (set[beak === 'n' ? 'c' : beak] || set.w).slice();
      if (beak === 'n') {
        rows = rows.map((r) => r.replace(/b/g, '.'));
      }
      if (front) {
        if (eye === 'b' || eye === 'z') {
          const c = eye === 'z' ? 'e' : 'H';
          rows = edit(rows, [[3, 2, c], [7, 2, c]]);
        }
      } else if (eye === 'b') {
        rows = edit(rows, [[6, 2, 'H']]);
      } else if (eye === 'z') {
        rows = edit(rows, [[5, 2, 'e'], [6, 2, 'e'], [5, 1, 'H'], [6, 1, 'H'], [6, 3, 'H']]);
      }
      return spr(rows);
    });
  }
  function glyph(name, color) {
    return sprite('g-' + name + color, () => spr(GLYPHS[name].map((r) => r.replace(/#/g, color))));
  }
  function spikes(frame) {
    return sprite('sp-' + frame, () => spr([frame ? '.H.H.' : 'H.H.H']));
  }

  function D(key, sp, x, y, op) {
    return { k: key, sp, x: x + sp.ox, y: y + sp.oy, op: op === undefined ? 1 : op };
  }
  function G(name, color, x, y, op) {
    return D('g-' + name + color, glyph(name, color), x, y, op);
  }

  // p: dx dy (whole bird), by (body), hx hy (head), br (breath lifts the head and swells the chest),
  // chest 0 1 2, beak c s w y n, eye o b z, front, tail u d, air, wing (a WING_SPANS key), spikes 0 1 2.
  function bird(p) {
    const out = [];
    const X = (p.dx || 0) + BX;
    const Y = p.dy || 0;
    const by = p.by || 0;
    const wing = p.wing && WING_SPANS[p.wing] ? p.wing : '';
    if (p.air) {
      out.push(D('tuck', sprite('tuck', () => spr(LEGS.slice(0, 1))), X, 9 + Y + by));
    } else {
      out.push(D('legs', sprite('legs', () => spr(LEGS)), X, 8 + Y));
    }
    const kind = p.air || wing ? 'fly' : 'rest';
    const tail = p.tail || '';
    out.push(D('body' + kind + tail, bodySprite(kind, tail), X, 4 + Y + by));
    if (wing) {
      out.push(D('wing' + wing, wingSprite(wing), X, Y + by));
    }
    const chest = p.chest === undefined ? (p.br ? 1 : 0) : p.chest;
    if (!p.air && !wing && chest) {
      const rows = chest === 2 ? ['.rr', 'rrr', 'rrr', '.rr'] : ['r.', '.r', 'r.'];
      out.push(D('chest' + chest, sprite('chest' + chest, () => spr(rows)), X + 20, (chest === 2 ? 4 : 5) + Y + by));
    }
    // A head lift and a breath together would open a gap above the body; one row is the most.
    const hy = Math.max(-1, (p.hy || 0) + (p.br || 0));
    const beak = p.beak || 'c';
    const eye = p.eye || 'o';
    out.push(D('head' + (p.front ? 'F' : 'S') + beak + eye, headSprite(!!p.front, beak, eye), X + 10 + (p.hx || 0), Y + by + hy));
    if (p.spikes) {
      out.push(D('sph' + p.spikes, spikes(p.spikes === 2), X + (p.spikes === 2 ? 14 : 13) + (p.hx || 0), -1 + Y + by + hy));
    }
    return out;
  }

  // The clock is musical: 120 bpm, so a beat is 500 ms and a sixteenth 125 ms.
  function lerp(t, pts) {
    if (t <= pts[0][0]) {
      return Math.round(pts[0][1]);
    }
    for (let i = 1; i < pts.length; i += 1) {
      if (t <= pts[i][0]) {
        const u = (t - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]);
        return Math.round(pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * u);
      }
    }
    return Math.round(pts[pts.length - 1][1]);
  }

  // Landing: squash, the head rebounds, and the tail flicks up as follow-through.
  const LAND_MS = 270;
  function landPose(a) {
    if (a < 70) {
      return { by: 1, hy: 1, wing: 'lift', tail: 'u', beak: 'c' };
    }
    if (a < 130) {
      return { by: 1, hy: 1, tail: 'u', beak: 'c' };
    }
    if (a < 200) {
      return { br: -1, tail: 'u', beak: 'c' };
    }
    if (a < LAND_MS) {
      return { tail: 'u', beak: 'c' };
    }
    return null;
  }

  // A jump with anticipation (dip, crouch, wings loading), a flapping rise, a hang, a braking
  // descent and the landing. o: h (pixels), A up hang dn (ms), F (ms per wing frame), seqUp seqDn.
  function leap(a, o) {
    const A = o.A === undefined ? 150 : o.A;
    const up = o.up || 200;
    const hang = o.hang === undefined ? 60 : o.hang;
    const dn = o.dn || 220;
    const F = o.F || 60;
    const t1 = A;
    const t2 = t1 + up;
    const t3 = t2 + hang;
    const t4 = t3 + dn;
    const end = t4 + LAND_MS;
    const seqUp = o.seqUp || FLAP;
    const seqDn = o.seqDn || ['up', 'mid', 'up', 'lift'];
    const h = o.h;
    if (a < 0) {
      return { p: {}, end };
    }
    if (a >= end) {
      return { p: null, end };
    }
    if (a < t1) {
      const p = { beak: 'c', hy: 1 };
      if (a >= 50) {
        p.by = 1;
        if (a >= t1 - 70) {
          p.wing = a < t1 - 35 ? 'lift' : o.seqUp ? seqUp[0] : 'up';
        }
      }
      return { p, end };
    }
    if (a < t2) {
      const u = (a - t1) / up;
      const dy = Math.min(-1, -Math.round(h * (1 - (1 - u) * (1 - u))));
      return { p: { air: true, dy, wing: seqUp[Math.floor((a - t1) / F) % seqUp.length], tail: 'd', beak: 's' }, end };
    }
    if (a < t3) {
      const wing = o.hangFlap ? seqUp[Math.floor((a - t2) / F) % seqUp.length] : 'up';
      return { p: { air: true, dy: -h, wing, beak: 'w' }, end };
    }
    if (a < t4) {
      const v = (a - t3) / dn;
      const dy = Math.min(-1, -Math.round(h * (1 - v * v)));
      return { p: { air: true, dy, wing: seqDn[Math.floor((a - t3) / 70) % seqDn.length], tail: 'u', beak: 's' }, end };
    }
    return { p: landPose(a - t4), end };
  }

  function sparkle(t, t0, x, y, color, life) {
    const a = t - t0;
    const L = life || 480;
    if (a < 0 || a >= L) {
      return [];
    }
    const s = Math.floor((a / L) * 4);
    return s === 0 || s === 3 ? [G('dot', color, x + 1, y + 1)] : [G('plus', color, x, y)];
  }
  function bigSparkle(t, t0, x, y, color) {
    const a = t - t0;
    if (a < 0 || a >= 700) {
      return [];
    }
    const s = Math.floor(a / 175);
    return s === 0 || s === 3 ? [G('plus', color, x + 1, y + 1)] : [G('big', color, x, y)];
  }
  const NOTE_COLORS = ['n', 'p', 'o', 'a'];
  // A note leaves the open beak at t0 and drifts up and to the right.
  function mouthNote(t, t0, color) {
    const a = t - t0;
    if (a < 0 || a >= 1300) {
      return [];
    }
    const s = Math.floor(a / 120);
    return [G('note', color, 24 + Math.floor(s * 0.5), -s, a > 950 ? (a > 1150 ? 0.3 : 0.6) : 1)];
  }
  function worm(len, phase, head) {
    const ph = phase % 4;
    return sprite('worm' + len + '-' + ph + head, () => {
      let top = '';
      let bot = '';
      for (let i = 0; i < len; i += 1) {
        const up = Math.floor((i + ph) / 2) % 2 === 0;
        const c = i === 0 ? head : 'v';
        top += up ? c : '.';
        bot += up ? '.' : c;
      }
      return spr([top, bot]);
    });
  }

  function breath(t, period) {
    return t % period >= period / 2 ? -1 : 0;
  }
  // Two beats of singing in sixteenths: wide, half, wide, closed.
  const SING = ['w', 's', 'w', 'c', 'w', 's', 'c', 'c'];
  function singBeak(t) {
    return SING[Math.floor(t / 125) % SING.length];
  }

  function idleScene(t) {
    const L = t % 14000;
    const p = { br: breath(t, 3200) };
    if ((L >= 3500 && L < 3625) || (L >= 8375 && L < 8500) || (L >= 8625 && L < 8750)) {
      p.eye = 'b';
    }
    if (L >= 2250 && L < 3250) {
      p.hx = -1;
    } else if (L >= 4375 && L < 5000) {
      p.hx = 1;
    }
    // Two quick peeps with the head lifting.
    if ((L >= 6000 && L < 6125) || (L >= 6250 && L < 6375)) {
      p.beak = 's';
      p.br = -1;
    } else if (L >= 6375 && L < 6500) {
      p.br = -1;
    }
    // Two head dips, like pecks at the branch.
    if ((L >= 11500 && L < 11625) || (L >= 11875 && L < 12000)) {
      p.hy = 1;
      p.hx = 1;
      p.br = 0;
    }
    // A yawn: inhale, gape with the eyes shut and the chest swelling, then close.
    if (L >= 9750 && L < 10000) {
      p.beak = 's';
      p.br = -1;
    } else if (L >= 10000 && L < 10750) {
      p.beak = 'y';
      p.eye = 'z';
      p.br = -1;
      p.chest = 2;
    } else if (L >= 10750 && L < 10875) {
      p.beak = 's';
      p.eye = 'z';
      p.br = 0;
    } else if (L >= 10875 && L < 11000) {
      p.eye = 'b';
    }
    return bird(p);
  }

  function lcg(seed) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }
  // One note lane per working chat, right to left; lane 0 sits beside the head.
  const LANE_X = [24, 19, 14, 10, 6, 2];
  const NOTE_LIFE = 1800;
  // A faster tap for more working chats, always a whole number of beats.
  const TAP_MS = [1000, 750, 500];

  // The gap before a lane's next note: the host's minimum plus its random spread when given.
  function laneGap(c) {
    if (c.notes) {
      return Math.max(NOTE_LIFE + 240, c.notes.minMs + Math.floor(c.rand() * c.notes.spreadMs));
    }
    return NOTE_LIFE + 240 + Math.floor(c.rand() * 8) * 240;
  }

  function workingScene(t, c) {
    if (!c.lanes) {
      c.lanes = [];
      for (let i = 0; i < c.laneCount; i += 1) {
        const first = c.notes ? c.notes.delays[i] : Math.floor(c.rand() * 10) * 120 + i * 240;
        c.lanes.push({ s: first, n: 0 });
      }
    }
    const bar = TAP_MS[c.speed];
    const ph = (t % bar) / bar;
    const p = { br: breath(t, 3000), hx: 0, hy: 0, beak: 'c' };
    if (ph >= 0.25 && ph < 0.5) {
      p.hy = 1;
      p.beak = 's';
    } else if (ph >= 0.5 && ph < 0.75) {
      p.hy = 2;
      p.hx = 1;
    } else if (ph >= 0.75) {
      p.hy = 1;
    }
    const notes = [];
    c.lanes.forEach((lane, l) => {
      while (lane.s + NOTE_LIFE <= t) {
        lane.s += laneGap(c);
        lane.n += 1;
      }
      const a = t - lane.s;
      if (a < 0) {
        return;
      }
      // The beak opens as a note leaves it.
      if (a < 250) {
        p.beak = a < 125 ? 'w' : 's';
        p.hy = 0;
        p.hx = 0;
        p.br = -1;
      }
      const step = Math.min(4, Math.floor(a / 400));
      const x = LANE_X[l] + (l === 0 ? Math.floor(step / 2) : 0);
      const y = (l === 0 ? -2 : -7) - step;
      notes.push(G('note', NOTE_COLORS[(l + lane.n) % 4], x, y, a > 1450 ? (a > 1650 ? 0.3 : 0.6) : 1));
    });
    return bird(p).concat(notes);
  }

  function needsScene(t) {
    const T = t % 2000;
    let p = { front: true, br: breath(t, 3000), beak: 'c' };
    // Two chirps on the beat, a head cock, then the hop.
    if (T < 125 || (T >= 250 && T < 375)) {
      p.beak = 's';
      p.br = -1;
    } else if (T >= 500 && T < 750) {
      p.beak = 'w';
      p.hy = -1;
    }
    const lp = leap(T - 1000, { h: 2, A: 120, up: 120, hang: 0, dn: 130, F: 70, seqUp: ['mid', 'lift'], seqDn: ['mid', 'lift'] });
    if (T >= 1000 && lp.p) {
      const q = lp.p;
      p = {
        front: true,
        dy: q.dy,
        by: q.by,
        hy: q.hy === undefined ? p.hy : q.hy,
        air: q.air,
        wing: q.wing,
        tail: q.tail,
        beak: q.beak === 'w' ? 's' : q.beak || 'c',
        br: q.br === undefined ? 0 : q.br,
      };
    }
    const pulse = Math.floor(t / 250) % 2;
    const bob = T >= 1000 && T < 1500 ? -1 : 0;
    return bird(p).concat([G('q', 'q', 22, -8 - pulse + bob, pulse ? 1 : 0.7)]);
  }

  function doneScene(t) {
    if (t >= DURATIONS.done) {
      return idleScene(t - DURATIONS.done);
    }
    const lp = leap(t, { h: 5, A: 150, up: 190, hang: 60, dn: 210 });
    let p = lp.p ? lp.p : { beak: 'c', br: breath(t, 3000) };
    if (!lp.p && t >= 1000 && t < 2500) {
      p = { beak: singBeak(t - 1000), br: -1 };
    } else if (!lp.p && t >= 2500 && t < 2750) {
      p = { beak: 's', br: 0 };
    }
    let out = bird(p);
    for (let k = 0; k < 3; k += 1) {
      out = out.concat(mouthNote(t, 1000 + k * 500, NOTE_COLORS[k]));
    }
    const sp = [[340, -1, -1, 'y'], [400, 5, -6, 'p'], [460, 24, -4, 'y'], [520, 12, -8, 'a'], [580, -2, -5, 'y'], [640, 22, -9, 'p'], [760, 0, 2, 'p'], [860, 8, -7, 'y']];
    for (const [t0, x, y, c] of sp) {
      out = out.concat(sparkle(t, t0, x, y, c));
    }
    // The check pops in after the landing, small then big, then settles.
    if (t >= 900 && t < 3000) {
      const ca = t - 900;
      out.push(G('check', 'a', 22, -5 - (ca < 100 ? 1 : 0), ca > 1900 ? 0.5 : 1));
    }
    return out;
  }

  function milestoneScene(t) {
    if (t >= DURATIONS.milestone) {
      return idleScene(t - DURATIONS.milestone);
    }
    const l1 = leap(t, { h: 4, A: 150, up: 170, hang: 40, dn: 190 });
    const l2 = leap(t - 750, { h: 9, A: 150, up: 270, hang: 130, dn: 300, F: 50, hangFlap: true });
    let p;
    if (t < 750) {
      p = l1.p || { beak: 'c' };
    } else if (l2.p) {
      p = l2.p;
    } else if (t >= 2100 && t < 3700) {
      p = { beak: singBeak(t - 2100), br: -1 };
    } else if (t >= 3700 && t < 3950) {
      p = { beak: 's' };
    } else {
      p = { beak: 'c', br: breath(t, 3000) };
    }
    let out = bird(p);
    for (let k = 0; k < 3; k += 1) {
      out = out.concat(mouthNote(t, 2100 + k * 500, NOTE_COLORS[k % 4]));
    }
    const cols = ['y', 'p', 'a', 'n'];
    for (let k = 0; k < 10; k += 1) {
      const ang = (k / 10) * Math.PI * 2;
      const big = k % 2 === 0;
      const x = Math.round(12 + Math.cos(ang) * (big ? 13 : 9));
      const y = Math.round(-4 + Math.sin(ang) * (big ? 9 : 6));
      out = out.concat(sparkle(t, 1200 + (k % 5) * 70, x, y, cols[k % 4], 640));
      out = out.concat(sparkle(t, 1900 + (k % 5) * 90, x, y, cols[(k + 1) % 4], 640));
    }
    return out.concat(bigSparkle(t, 1250, 1, -10, 'p'), bigSparkle(t, 1370, 23, -10, 'y'), bigSparkle(t, 1950, 12, -12, 'a'));
  }

  function errorScene(t) {
    const T = t % 2000;
    const p = { br: breath(t, 1000), beak: 'c' };
    let out;
    if (T < 1000) {
      // A squawk: only the head shakes while its crest spikes; the back stays smooth (feet rule).
      const j = [0, -1, 0, 1][Math.floor(t / 80) % 4];
      p.hx = j;
      p.beak = Math.floor(t / 125) % 2 ? 's' : 'y';
      p.spikes = Math.floor(t / 80) % 2 ? 2 : 1;
      p.chest = 2;
      p.br = -1;
      out = bird(p);
      const fr = Math.floor(t / 125) % 2;
      out.push(D('snd' + fr, sprite('snd' + fr, () => spr(fr ? ['x.', '.x'] : ['.x', 'x.'])), 25 + j, 0));
      out.push(D('snd' + fr + 'b', sprite('sndb' + fr, () => spr(fr ? ['.x', 'x.'] : ['x.', '.x'])), 25 + j, 4));
    } else {
      p.beak = T >= 1250 && T < 1375 ? 's' : 'c';
      p.eye = T >= 1625 && T < 1750 ? 'b' : 'o';
      out = bird(p);
    }
    const pulse = Math.floor(t / 250) % 2;
    out.push(G('bang', 'x', 23, -8 - pulse));
    return out;
  }

  function zs(t, extra) {
    const out = [];
    for (let k = 0; k < 2; k += 1) {
      const age = (((t - k * 1200) % 2400) + 2400) % 2400;
      const s = Math.floor(age / 300);
      const base = k === 0 ? [19, -3] : [24, -8];
      const op = s < 1 ? 0.4 : s >= 7 ? 0.25 : s >= 6 ? 0.55 : 1;
      out.push(G(k === 0 ? 'z' : 'Z', 'z', base[0] + Math.floor(s / 3), base[1] - Math.floor(s / 2), op));
    }
    return out.concat(extra || []);
  }
  function snore(t) {
    const a = t % 3400;
    if (a < 700 || a >= 3100) {
      return [];
    }
    if (a < 1400) {
      return [G('dot', 'B', 22, 4)];
    }
    if (a < 2200) {
      return [G('box', 'B', 22, 3)];
    }
    if (a < 2900) {
      return [G('ring', 'B', 22, 2)];
    }
    return [G('dot', 'B', 24, 2), G('dot', 'B', 21, 2)];
  }
  const SLEEP_P = { hx: -2, hy: 1, beak: 'n', eye: 'z' };
  function sleepScene(t) {
    return bird(Object.assign({ br: breath(t, 3400) }, SLEEP_P)).concat(zs(t), snore(t));
  }
  function nightScene(t) {
    const tw = Math.floor(t / 900);
    const extra = [G('moon', 'y', 1, -9)];
    if (tw % 3 !== 0) {
      extra.push(G('dot', 'y', 8, -7));
    }
    if (tw % 3 !== 1) {
      extra.push(G('dot', 'z', 13, -10));
    }
    if (tw % 3 !== 2) {
      extra.push(G('dot', 'y', 26, -6));
    }
    return bird(Object.assign({ br: breath(t, 5000) }, SLEEP_P)).concat(zs(t, extra));
  }

  function wormScene(t) {
    if (t >= DURATIONS.worm) {
      return idleScene(t - DURATIONS.worm);
    }
    const p = { br: breath(t, 3000), beak: 'c', hx: 0, hy: 0 };
    const out = [];
    const ph = Math.floor(t / 125);
    let wormAt = null;
    let len = 6;
    if (t < 500) {
      // The worm wriggles in while the bird watches.
      wormAt = lerp(t, [[0, 34], [500, 26]]);
    } else if (t < 800) {
      // The wind-up: the worm freezes and the head draws back.
      wormAt = 26 - Math.floor((t - 500) / 150);
      p.hx = -1;
    } else if (t < 1000) {
      wormAt = 24;
      p.hx = -1;
      p.hy = -1;
      p.beak = 's';
    } else if (t < 1125) {
      // The strike.
      p.hx = 2;
      p.hy = 1;
      p.beak = t < 1060 ? 'w' : 's';
      wormAt = 24;
    } else if (t < 1250) {
      p.hx = 1;
      wormAt = 25;
    } else if (t < 2150) {
      // The slurp: the worm shortens in beat-sized bites.
      len = 6 - Math.floor((t - 1250) / 150);
      const bob = Math.floor((t - 1250) / 150) % 2;
      p.beak = bob ? 'c' : 's';
      p.hx = bob ? 0 : 1;
      if (len > 0) {
        wormAt = 24 + p.hx;
      }
    } else if (t < 2750) {
      // The gulp: a lump slides down the chest.
      const s = Math.floor((t - 2150) / 200);
      p.hy = s === 0 ? -1 : 0;
      p.beak = s === 0 ? 's' : 'c';
      const spots = [[19, 5], [18, 6], [17, 7]];
      if (s < 3) {
        out.push(G('dot', 'V', spots[s][0], spots[s][1]));
      }
    } else if (t < 3500) {
      // Content: the eyes shut, a quick blink, a happy peep.
      p.eye = t < 3125 ? 'z' : Math.floor((t - 3125) / 125) % 2 ? 'o' : 'b';
      p.beak = t < 2875 ? 's' : t < 3000 ? 'c' : t < 3125 ? 's' : 'c';
      p.br = -1;
      if (t >= 2750 && t < 3250) {
        out.push(G('plus', 'y', 22, -3 - Math.floor((t - 2750) / 250)));
      }
    }
    const res = bird(p).concat(out);
    if (wormAt !== null) {
      res.push(D('wm' + len + (ph % 4), worm(len, ph, 'V'), wormAt, 2 + (p.hy > 0 ? 1 : 0)));
    }
    return res;
  }

  // Flight: a flapping body with a small lift on each downstroke.
  function flight(t, a0, dx, dy, beak, tail) {
    const f = Math.floor((t - a0) / 60);
    const wing = FLAP[((f % 5) + 5) % 5];
    const bob = wing === 'down' || wing === 'low' ? -1 : 0;
    return bird({ dx, dy: dy + bob, air: true, wing, beak, tail });
  }
  function streaks(x, y, n) {
    const out = [];
    const line = sprite('streak', () => spr(['uuu']));
    for (let i = 0; i < n; i += 1) {
      out.push(D('streak', line, x - 7 - i * 4, y + 5 + i * 2 - (i % 2), 0.55));
    }
    return out;
  }

  // Rotate: the bird flies off to the right, the branch sits empty, and a fresh one lands from the left.
  function rotateScene(t) {
    if (t >= DURATIONS.rotate) {
      return idleScene(t - DURATIONS.rotate);
    }
    if (t < 150) {
      return bird(t < 50 ? { hy: 1 } : { by: 1, hy: 1, wing: t >= 115 ? 'up' : 'lift' });
    }
    if (t < 1350) {
      const a = t - 150;
      const dx = lerp(a, [[0, 0], [150, 3], [350, 10], [650, 24], [950, 42], [1200, 60]]);
      const dy = lerp(a, [[0, -1], [150, -4], [350, -7], [650, -10], [950, -12], [1200, -13]]);
      let out = flight(t, 150, dx, dy, 's', a < 300 ? 'd' : '');
      if (a > 250) {
        out = out.concat(streaks(BX + dx, dy, a > 600 ? 3 : 2));
      }
      // A feather drifts down from the perch.
      if (a < 700) {
        out.push(G('dot', 'f', 8 + Math.floor(a / 250), 4 + Math.floor(a / 90), a > 450 ? 0.5 : 1));
      }
      return out;
    }
    if (t < 2250) {
      return [];
    }
    if (t < 3300) {
      const b = t - 2250;
      const dx = lerp(b, [[0, -22], [350, -14], [700, -5], [1050, 0]]);
      const dy = lerp(b, [[0, -11], [350, -9], [700, -5], [1050, -1]]);
      const wing = b < 650 ? FLAP[Math.floor(b / 60) % 5] : ['up', 'mid', 'up', 'lift'][Math.floor((b - 650) / 70) % 4];
      const bob = b < 650 && (wing === 'down' || wing === 'low') ? -1 : 0;
      return bird({ dx, dy: dy + bob, air: true, wing, beak: 's', tail: b > 600 ? 'u' : '' });
    }
    const l = t - 3300;
    const lp = landPose(l);
    let q = bird(lp || { beak: 'c', br: breath(t, 3000) });
    if (!lp && l >= 400 && l < 900) {
      q = bird({ beak: l < 525 ? 's' : l < 650 ? 'c' : l < 775 ? 's' : 'c', br: -1 });
    }
    for (const [t0, x, y, c] of [[3350, 0, -3, 'y'], [3450, 22, -4, 'p'], [3550, 12, -7, 'y']]) {
      q = q.concat(sparkle(t, t0, x, y, c));
    }
    return q;
  }

  // The egg with its cracks and a one-pixel outline so the shell reads on a light panel.
  function eggSprite(stage) {
    return sprite('egg' + stage, () => {
      const rows = edit(EGG, CRACKS[stage].map(([x, y]) => [x, y, 'c']));
      const h = rows.length;
      const w = rows[0].length;
      const filled = (x, y) => y >= 0 && y < h && x >= 0 && x < w && rows[y][x] !== '.';
      const out = [];
      for (let y = -1; y <= h; y += 1) {
        let line = '';
        for (let x = -1; x <= w; x += 1) {
          if (filled(x, y)) {
            line += rows[y][x];
          } else {
            const near = filled(x + 1, y) || filled(x - 1, y) || filled(x, y + 1) || filled(x, y - 1);
            line += near && y < h ? 'O' : '.';
          }
        }
        out.push(line);
      }
      return spr(out, -1, -1);
    });
  }

  function hatchScene(t) {
    const T0 = 3300;
    if (t >= DURATIONS.hatch) {
      return idleScene(t - DURATIONS.hatch);
    }
    if (t < T0) {
      const stage = t >= 2600 ? 3 : t >= 1900 ? 2 : t >= 1000 ? 1 : 0;
      // Each wobble is a little bigger as the chick gets ready.
      let amp = 0;
      let tt = 0;
      for (const [from, to, size] of [[600, 1000, 1], [1500, 1900, 1], [2300, 2600, 1], [2900, T0, 2]]) {
        if (t >= from && t < to) {
          amp = size;
          tt = t - from;
        }
      }
      const dx = amp ? [0, -1, 0, 1][Math.floor(tt / 100) % 4] * amp : 0;
      const out = [D('egg' + stage, eggSprite(stage), EGG_X + dx, 0)];
      // The beak pokes out of the crack and peeps.
      if (t >= 2600 && t < 2900) {
        out.push(D('poke', sprite('poke', () => spr(['bb'])), EGG_X + 5 + dx, 0));
        if (t >= 2700) {
          out.push(G('dot', 'q', EGG_X + 9, -2));
        }
      }
      return out;
    }
    const a = t - T0;
    const lp = leap(a, { h: 6, A: 0, up: 240, hang: 80, dn: 260, F: 55 });
    let p = lp.p;
    if (p && a < 60) {
      p = { air: true, dy: -3, wing: 'up', beak: 'w' };
    }
    const settle = a >= lp.end + 100 && a < lp.end + 900;
    const q = p || (settle ? { beak: ['s', 'c', 's', 'c', 'c', 'c'][Math.floor((a - lp.end - 100) / 125) % 6], br: -1 } : { beak: 'c' });
    let res = bird(q);
    if (a < 600) {
      const cap = sprite('cap', () => spr(EGG.slice(0, 4).concat(['E.EE.EE.EE.E'])));
      res.push(D('cap', cap, EGG_X + 1 + Math.round(a / 45), -3 - Math.round(a / 40), a > 380 ? 0.4 : 1));
      const sh = sprite('shard', () => spr(['EE']));
      const f = a > 400 ? 0.4 : 1;
      res.push(D('shard', sh, 7 - Math.round(a / 80), 5 + Math.round(a / 150), f));
      res.push(D('shard', sh, 5 - Math.round(a / 110), 7 + Math.round(a / 200), f));
      res.push(D('shard', sh, 20 + Math.round(a / 80), 5 + Math.round(a / 150), f));
      res.push(D('shard', sh, 22 + Math.round(a / 110), 7 + Math.round(a / 200), f));
    }
    if (a < 1100) {
      const fade = a > 800 ? 0.4 : 1;
      res.push(D('clL', sprite('clL', () => spr(['EEEE', 'EEE.'])), 6, 8, fade));
      res.push(D('clR', sprite('clR', () => spr(['EEE', '.EE'])), 19, 8, fade));
    }
    for (const [t0, x, y, c] of [[100, 3, -2, 'y'], [220, 24, -3, 'p'], [340, 14, -6, 'y'], [460, 0, 2, 'p']]) {
      res = res.concat(sparkle(t, T0 + t0, x, y, c));
    }
    return res;
  }

  // Reduced motion: one still pose per state with the glyph that names it.
  function stillScene(state) {
    let p = {};
    let m = [];
    if (state === 'working') {
      p = { hx: 1, hy: 1, beak: 's' };
      m = [G('note', 'n', 25, -4)];
    } else if (state === 'needs') {
      p = { front: true, beak: 's' };
      m = [G('q', 'q', 22, -8)];
    } else if (state === 'done') {
      p = { beak: 's' };
      m = [G('check', 'a', 23, -6), G('plus', 'y', 1, -3)];
    } else if (state === 'error') {
      p = { beak: 'y', spikes: 1, chest: 2, br: -1 };
      m = [G('bang', 'x', 23, -8)];
    } else if (state === 'sleep') {
      p = SLEEP_P;
      m = [G('z', 'z', 19, -3), G('Z', 'z', 24, -8)];
    } else if (state === 'night') {
      p = SLEEP_P;
      m = [G('moon', 'y', 1, -9), G('z', 'z', 19, -3), G('Z', 'z', 22, -8)];
    } else if (state === 'worm') {
      p = { beak: 's', hx: 1 };
      m = [D('wm50', worm(5, 0, 'V'), 24, 2)];
    } else if (state === 'rotate') {
      m = [G('plus', 'y', 24, -6)];
    } else if (state === 'milestone') {
      p = { beak: 's' };
      m = [G('big', 'p', 1, -10), G('plus', 'y', 22, -9), G('star', 'a', 12, -8), G('dot', 'n', 26, -3), G('dot', 'y', 0, -3)];
    } else if (state === 'hatch') {
      return [D('egg3', eggSprite(3), EGG_X, 0)];
    }
    return bird(p).concat(m);
  }

  const SCENES = {
    idle: idleScene,
    working: workingScene,
    needs: needsScene,
    done: doneScene,
    error: errorScene,
    sleep: sleepScene,
    night: nightScene,
    worm: wormScene,
    rotate: rotateScene,
    hatch: hatchScene,
    milestone: milestoneScene,
  };

  function finite(n, fallback) {
    return typeof n === 'number' && isFinite(n) ? n : fallback;
  }

  // Per-render state: the note lanes and their random source, seeded for a frozen frame.
  function makeCtx(o, seeded) {
    const count = Math.max(1, Math.min(LANE_X.length, Math.floor(finite(o.workingCount, 1))));
    let notes = null;
    if (o.notes && Array.isArray(o.notes.delays)) {
      notes = {
        delays: o.notes.delays.slice(0, LANE_X.length).map((n) => Math.max(0, finite(n, 0))),
        minMs: Math.max(0, finite(o.notes.minMs, 0)),
        spreadMs: Math.max(0, finite(o.notes.spreadMs, 0)),
      };
    }
    return {
      lanes: null,
      laneCount: notes ? notes.delays.length : count,
      notes,
      // Without a host speed, step up at the host's thresholds: 3 and 6 working chats.
      speed: o.speed === 0 || o.speed === 1 || o.speed === 2 ? o.speed : count >= 6 ? 2 : count >= 3 ? 1 : 0,
      rand: seeded ? lcg(11) : Math.random,
    };
  }

  function placements(state, t, ctx, still) {
    if (still) {
      return stillScene(state);
    }
    const scene = Object.prototype.hasOwnProperty.call(SCENES, state) ? SCENES[state] : idleScene;
    return scene(t, ctx);
  }

  // The sprites drawn at time t, for tests and captures. A fresh seeded context makes it repeatable.
  function frame(state, t, opts) {
    const o = opts || {};
    return placements(state, t, makeCtx(o, true), !!o.still).map((d) => ({ k: d.k, x: d.x, y: d.y, op: d.op, rows: d.sp.rows }));
  }

  const NS = 'http://www.w3.org/2000/svg';
  const runCache = {};
  // Horizontal runs of one color as [x, y, width, color key].
  function runs(rows) {
    const out = [];
    rows.forEach((row, y) => {
      let x = 0;
      while (x < row.length) {
        const ch = row[x];
        let x1 = x + 1;
        if (ch !== '.') {
          while (x1 < row.length && row[x1] === ch) {
            x1 += 1;
          }
          out.push([x, y, x1 - x, ch]);
        }
        x = x1;
      }
    });
    return out;
  }
  function runsOf(d) {
    if (!Object.prototype.hasOwnProperty.call(runCache, d.k)) {
      runCache[d.k] = runs(d.sp.rows);
    }
    return runCache[d.k];
  }
  function el(tag, attrs) {
    const e = root.document.createElementNS(NS, tag);
    for (const k of Object.keys(attrs)) {
      e.setAttribute(k, String(attrs[k]));
    }
    return e;
  }
  function addRuns(parent, list, dx, dy, pal) {
    for (const [x, y, w, c] of list) {
      parent.appendChild(el('rect', { x: x + dx, y: y + dy, width: w, height: 1, fill: pal[c] }));
    }
  }

  // Draws the robin into container and animates it until stop(). opts: dark, still, scale (CSS px per
  // art pixel), workingCount, speed, notes { delays, minMs, spreadMs }, freezeAt (ms, one seeded frame)
  // and startAt (ms, resume a scene where it left off).
  function render(container, state, opts) {
    const o = opts || {};
    const pal = o.dark ? DARK : LIGHT;
    const scale = finite(o.scale, 1);
    const svg = el('svg', {
      width: W * scale,
      height: H * scale,
      viewBox: '0 0 ' + W + ' ' + H,
      'shape-rendering': 'crispEdges',
      overflow: 'visible',
      'aria-hidden': 'true',
      focusable: 'false',
    });
    const branch = el('g', { 'data-k': 'branch' });
    addRuns(branch, runs(BRANCH), 0, 0, pal);
    const live = el('g', {});
    svg.appendChild(branch);
    svg.appendChild(live);
    container.replaceChildren(svg);

    const frozen = typeof o.freezeAt === 'number';
    const ctx = makeCtx(o, frozen);
    let sig = null;
    let shown = 0;
    function draw(t) {
      shown = t;
      const list = placements(state, t, ctx, !!o.still);
      let s = '';
      for (const d of list) {
        s += d.k + ':' + d.x + ':' + d.y + ':' + d.op + ';';
      }
      if (s === sig) {
        return;
      }
      sig = s;
      const frag = root.document.createDocumentFragment();
      for (const d of list) {
        const attrs = { 'data-k': d.k };
        if (d.op < 1) {
          attrs.opacity = d.op;
        }
        const g = el('g', attrs);
        addRuns(g, runsOf(d), d.x, d.y, pal);
        frag.appendChild(g);
      }
      live.replaceChildren(frag);
    }

    let raf = 0;
    let stopped = false;
    if (o.still) {
      draw(0);
    } else if (frozen) {
      draw(o.freezeAt);
    } else {
      const start = Math.max(0, finite(o.startAt, 0));
      let t0 = null;
      let last = -1000;
      draw(start);
      const tick = (now) => {
        if (stopped) {
          return;
        }
        raf = root.requestAnimationFrame(tick);
        if (t0 === null) {
          t0 = now;
        }
        // About 30 frames a second is enough for pixel steps and spares the CPU.
        if (now - last < 30) {
          return;
        }
        last = now;
        draw(start + now - t0);
      };
      raf = root.requestAnimationFrame(tick);
    }
    return {
      stop() {
        stopped = true;
        if (raf) {
          root.cancelAnimationFrame(raf);
          raf = 0;
        }
      },
      elapsed() {
        return shown;
      },
    };
  }

  root.NestMascot = { W, H, BX, LIGHT, DARK, BRANCH, DURATIONS, STATES: Object.keys(SCENES), frame, render };
})(typeof globalThis !== 'undefined' ? globalThis : window);
