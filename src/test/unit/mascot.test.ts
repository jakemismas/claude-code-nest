// Unit tests for the header robin script, loaded in a vm sandbox and sampled through frame().
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { NOTE_MIN_GAP_MS, NOTE_SPREAD_MS, ROBIN_STATES, STILL_MARKERS, TRANSIENT_MS } from '../../fleet/robinState';

interface Placement {
  k: string;
  x: number;
  y: number;
  op: number;
  rows: string[];
}
interface FrameOpts {
  still?: boolean;
  workingCount?: number;
  speed?: number;
  notes?: { delays: number[]; minMs: number; spreadMs: number };
}
interface Mascot {
  W: number;
  H: number;
  BX: number;
  LIGHT: Record<string, string>;
  DARK: Record<string, string>;
  BRANCH: string[];
  DURATIONS: Record<string, number>;
  STATES: string[];
  frame(state: string, t: number, opts?: FrameOpts): Placement[];
}

const repo = path.join(__dirname, '..', '..', '..');

function loadMascot(): Mascot {
  const sandbox: { NestMascot?: Mascot } = {};
  vm.runInNewContext(fs.readFileSync(path.join(repo, 'media', 'mascot.js'), 'utf8'), sandbox);
  assert.ok(sandbox.NestMascot, 'mascot.js defines NestMascot');
  return sandbox.NestMascot;
}

const mascot = loadMascot();
const PLANTED = ['idle', 'working', 'error', 'sleep', 'night', 'worm'];
const LEAVES = ['needs', 'done', 'milestone', 'rotate', 'hatch'];
const NOTES = { delays: [0, 300, 600, 900], minMs: NOTE_MIN_GAP_MS, spreadMs: NOTE_SPREAD_MS };

// Every 50 ms up to until (6 s by default), plus a late moment that wraps the looping scenes.
// No pose in any scene lasts less than 50 ms, so this step lands on every pose.
function samples(until = 6000): number[] {
  const out: number[] = [];
  for (let t = 0; t < until; t += 50) {
    out.push(t);
  }
  out.push(until + 9000);
  return out;
}
// The planted check covers the whole 14 s idle cycle, which the one-shot scenes settle into.
const PLANTED_UNTIL = 16000;

// The legs and body placement, the parts that must stay on the branch in a planted state.
function feet(list: Placement[]): string {
  const legs = list.find((d) => d.k === 'legs');
  const body = list.find((d) => d.k.startsWith('body'));
  return legs && body ? [legs.x, legs.y, body.k, body.x, body.y].join(':') : 'off the branch';
}

function topRow(d: Placement): number {
  const i = d.rows.findIndex((r) => /[^.]/.test(r));
  return d.y + i;
}

function bottomRow(d: Placement): number {
  let last = -1;
  d.rows.forEach((r, i) => {
    if (/[^.]/.test(r)) {
      last = i;
    }
  });
  return d.y + last;
}

describe('mascot', () => {
  it('has a scene for every state the host can send', () => {
    assert.deepStrictEqual([...mascot.STATES].sort(), [...ROBIN_STATES].sort());
    for (const state of ROBIN_STATES) {
      assert.ok(mascot.frame(state, 1000, { notes: NOTES }).length > 0, state + ' draws something');
      assert.ok(mascot.frame(state, 0, { still: true }).length > 0, state + ' has a still pose');
    }
  });

  it('draws the same seeded frame twice', () => {
    for (const state of ROBIN_STATES) {
      for (const t of [0, 777, 2345, 9001]) {
        const a = JSON.stringify(mascot.frame(state, t, { notes: NOTES, speed: 1 }));
        const b = JSON.stringify(mascot.frame(state, t, { notes: NOTES, speed: 1 }));
        assert.strictEqual(a, b, state + ' at ' + t);
      }
    }
  });

  it('keeps a still pose the same at any time', () => {
    for (const state of ROBIN_STATES) {
      const first = JSON.stringify(mascot.frame(state, 0, { still: true }));
      for (const t of [500, 4000, 60000]) {
        assert.strictEqual(JSON.stringify(mascot.frame(state, t, { still: true })), first, state);
      }
    }
  });

  it('gives both palettes the same keys and a color for every pixel it draws', () => {
    assert.deepStrictEqual(Object.keys(mascot.DARK).sort(), Object.keys(mascot.LIGHT).sort());
    const used = new Set<string>();
    const add = (rows: string[]): void => rows.forEach((r) => [...r].forEach((c) => c !== '.' && used.add(c)));
    add(mascot.BRANCH);
    for (const state of ROBIN_STATES) {
      mascot.frame(state, 0, { still: true }).forEach((d) => add(d.rows));
      for (const t of samples()) {
        mascot.frame(state, t, { notes: NOTES }).forEach((d) => add(d.rows));
      }
    }
    for (const c of used) {
      assert.ok(/^#[0-9A-F]{6}$/i.test(mascot.LIGHT[c] || ''), 'light color for ' + c);
      assert.ok(/^#[0-9A-F]{6}$/i.test(mascot.DARK[c] || ''), 'dark color for ' + c);
    }
  });

  it('keeps the legs and body on the branch in a planted state, where only the head and chest move', () => {
    const rest = feet(mascot.frame('idle', 0));
    assert.strictEqual(rest, [mascot.BX, 8, 'bodyrest', mascot.BX, 4].join(':'));
    for (const state of PLANTED) {
      let headMoved = false;
      const head0 = mascot.frame(state, 0, { notes: NOTES }).find((d) => d.k.startsWith('head'));
      for (const speed of state === 'working' ? [0, 1, 2] : [0]) {
        for (const t of samples(PLANTED_UNTIL)) {
          const list = mascot.frame(state, t, { notes: NOTES, speed });
          assert.strictEqual(feet(list), rest, state + ' at ' + t + ' ms, speed ' + speed);
          const head = list.find((d) => d.k.startsWith('head'));
          headMoved = headMoved || !head0 || !head || head.x !== head0.x || head.y !== head0.y;
        }
      }
      assert.ok(headMoved, state + ' still moves its head');
      assert.strictEqual(feet(mascot.frame(state, 0, { still: true })), rest, state + ' still pose');
    }
  });

  it('breathes by lifting the head one pixel and swelling the chest, nothing else', () => {
    // Idle 0 ms is the rest pose; 1.7 s is the in-breath, before any look, blink or peep.
    const out = mascot.frame('idle', 0);
    const inn = mascot.frame('idle', 1700);
    const at = (list: Placement[], prefix: string): Placement | undefined => list.find((d) => d.k.startsWith(prefix));
    assert.strictEqual(feet(inn), feet(out), 'the legs and body stay put');
    assert.strictEqual(at(inn, 'head')?.y, (at(out, 'head')?.y ?? 0) - 1, 'the head rises one pixel');
    assert.strictEqual(at(inn, 'head')?.x, at(out, 'head')?.x, 'the head does not move sideways');
    assert.ok(!at(out, 'chest') && at(inn, 'chest'), 'the chest swells only on the in-breath');
    assert.strictEqual(inn.length, out.length + 1, 'nothing else is drawn');
  });

  it('leaves the branch only in a hop, jump or flight', () => {
    for (const state of LEAVES) {
      const rest = feet(mascot.frame(state, 0));
      assert.ok(
        samples().some((t) => feet(mascot.frame(state, t)) !== rest),
        state + ' hops, jumps or flies at some moment',
      );
    }
  });

  it('never lets the head float above the body', () => {
    for (const state of ROBIN_STATES) {
      for (const t of samples()) {
        const list = mascot.frame(state, t, { notes: NOTES });
        const head = list.find((d) => d.k.startsWith('head'));
        const body = list.find((d) => d.k.startsWith('body'));
        if (head && body) {
          assert.ok(bottomRow(head) >= topRow(body) - 1, state + ' at ' + t + ' ms leaves a gap under the head');
        }
      }
    }
  });

  it('runs each one-shot scene exactly as long as the host holds its state', () => {
    for (const [state, ms] of Object.entries(mascot.DURATIONS)) {
      assert.strictEqual(TRANSIENT_MS[state as keyof typeof TRANSIENT_MS], ms, state);
    }
    for (const state of Object.keys(TRANSIENT_MS)) {
      assert.ok(state === 'error' || state in mascot.DURATIONS, state + ' has a scene length');
    }
  });

  it('shows the host still marker for every state in its still pose', () => {
    const glyphFor: Record<string, string> = {
      egg: 'egg',
      plus: 'g-plus',
      bang: 'g-bang',
      question: 'g-q',
      worm: 'wm',
      check: 'g-check',
      burst: 'g-big',
      note: 'g-note',
      z: 'g-z',
      moon: 'g-moon',
    };
    for (const state of ROBIN_STATES) {
      const marker = STILL_MARKERS[state];
      const keys = mascot.frame(state, 0, { still: true }).map((d) => d.k);
      if (marker === '') {
        assert.ok(!keys.some((k) => k.startsWith('g-')), state + ' shows no marker');
      } else {
        assert.ok(glyphFor[marker], 'a glyph for marker ' + marker);
        assert.ok(keys.some((k) => k.startsWith(glyphFor[marker])), state + ' shows ' + marker);
      }
    }
  });

  it('draws one note lane per working chat the host budgets', () => {
    const notesAt = (t: number, delays: number[]): number =>
      mascot.frame('working', t, { notes: { delays, minMs: NOTE_MIN_GAP_MS, spreadMs: NOTE_SPREAD_MS } }).filter((d) =>
        d.k.startsWith('g-note'),
      ).length;
    assert.strictEqual(notesAt(100, [0, 0, 0, 0, 0, 0]), 6);
    assert.strictEqual(notesAt(100, [0, 0]), 2);
    assert.strictEqual(notesAt(100, [5000]), 0, 'a lane waits for its first delay');
    assert.ok(samples().every((t) => notesAt(t, []) === 0), 'no budget, no notes');
  });

  it('keeps the host minimum gap between notes in a lane', () => {
    const births: number[] = [];
    let was = false;
    for (let t = 0; t < 60000; t += 10) {
      const lane0 = mascot
        .frame('working', t, { notes: { delays: [0], minMs: NOTE_MIN_GAP_MS, spreadMs: NOTE_SPREAD_MS } })
        .some((d) => d.k.startsWith('g-note') && d.x >= 24);
      if (lane0 && !was) {
        births.push(t);
      }
      was = lane0;
    }
    assert.ok(births.length >= 8, 'notes keep coming: ' + births.length);
    for (let i = 1; i < births.length; i += 1) {
      assert.ok(births[i] - births[i - 1] >= NOTE_MIN_GAP_MS, 'gap ' + (births[i] - births[i - 1]) + ' ms');
    }
  });

  it('has the webview skip an identical robin message so a scene in flight keeps playing', () => {
    const src = fs.readFileSync(path.join(repo, 'media', 'orgPanel.js'), 'utf8');
    const start = src.indexOf('function onRobinMessage(');
    assert.ok(start >= 0);
    const body = src.slice(start, src.indexOf('\n  }\n', start));
    const guard = body.indexOf('JSON.stringify(robinMsg) === JSON.stringify(next)');
    assert.ok(guard >= 0, 'compares the new message with the current one');
    assert.ok(guard < body.indexOf('drawRobin()'), 'returns before drawRobin');
  });

  it('loads the robin script with the panel nonce and colors it with SVG fills, not CSS', () => {
    const host = fs.readFileSync(path.join(repo, 'src', 'views', 'orgPanelWebview.ts'), 'utf8');
    assert.ok(host.includes('<script nonce="${nonce}" src="${mascotUri}"></script>'));
    assert.ok(host.indexOf('${mascotUri}') < host.indexOf('${scriptUri}"></script>'), 'mascot.js loads before orgPanel.js');
    const css = fs.readFileSync(path.join(repo, 'media', 'orgPanel.css'), 'utf8');
    assert.ok(!/@keyframes nest-robin/.test(css), 'no robin keyframes are left');
    assert.ok(!/\.rp-[A-Za-z]/.test(css), 'no robin color classes are left');
  });
});
