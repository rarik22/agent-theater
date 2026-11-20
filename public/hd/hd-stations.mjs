// Agent Theater HD · hd-stations.mjs
// The lane hardware: the row's back wall with its overhead rail and station lamps, the walkway track with
// its grating, conduit and LED strip, the lane chip, the station name plates, and the five console kinds (SETUP rack and
// container, CODE desk and monitor, REVIEW diff terminal, FIX bench and tool wall, PREP packer). Consoles
// are material masks shaded once into sprites; their lights, screens and keys are drawn per frame from
// the state (lit only when an agent works there). Pure.
import { dot, glow, hline, lightRect, panel, rect, remap, shadeRect, text, vline } from './hd-gfx.mjs';
import { fontText, textWidth } from './hd-font.mjs';
import { stationGeometry } from './hd-layout.mjs';
import { LIGHT, R } from './hd-palette.mjs';
import { createMask, maskFromRows, mdisc, mline, mrect, mround, shadeMask } from './hd-shade.mjs';

const memo = new Map();
const once = (k, make) => {
  if (!memo.has(k)) memo.set(k, make());
  return memo.get(k);
};

// ---------------------------------------------------------------- materials for machinery
export const MACHINE = {
  g: { ramp: 'gun', base: 3, bevel: 2, k: 2.4, steps: [1, 5], vgrad: [0.18, 0.22], brushed: true }, // gunmetal body
  G: { ramp: 'gun', base: 2, bevel: 2, k: 2.2, steps: [0, 4] }, // darker gunmetal
  s: { ramp: 'steel', base: 1, bevel: 1, k: 2, steps: [0, 3] }, // steel trim
  S: { ramp: 'steel', base: 2, bevel: 2, k: 2.2, steps: [0, 4] }, // polished steel
  n: { ramp: 'panel', base: 2, bevel: 2, k: 2.2, steps: [0, 4], vgrad: [0.2, 0.2] }, // navy panel
  N: { ramp: 'panel', base: 1, bevel: 1, k: 1.6, steps: [0, 3] }, // inset navy
  w: { ramp: 'glass', base: 1, flat: true, outline: R.gun[0], seam: false }, // screen glass
  v: { ramp: 'violet', base: 2, bevel: 1, k: 2, steps: [1, 4] },
  a: { ramp: 'amber', base: 2, bevel: 1, k: 2, steps: [1, 4] },
  b: { ramp: 'blue', base: 1, bevel: 1, k: 2, steps: [0, 3] },
  r: { ramp: 'red', base: 2, bevel: 1, k: 2, steps: [1, 3] },
  l: { ramp: 'leather', base: 2, bevel: 1, k: 2, steps: [1, 3] },
  c: { ramp: 'cyan', base: 2, bevel: 1, k: 2, steps: [1, 4] },
  k: { ramp: 'gun', base: 1, flat: true, outline: null, seam: false }, // dark recess
};

// ---------------------------------------------------------------- CODE: desk + monitor
// Desk 46 x 16: top surface (g) with a lit front lip (s), a drawer stack (N, handles drawn after),
// a navy front (n) with a vent recess (k), violet trim (v), and a recessed plinth (G).
export const DESK_W = 46;
function deskMask(w = DESK_W) {
  const k = createMask(w, 16);
  mrect(k, 1, 0, w - 2, 1, 'g');
  mrect(k, 0, 1, w, 2, 'g');
  mrect(k, 0, 3, w, 1, 's');
  mrect(k, 0, 4, 12, 8, 'N');
  mrect(k, 12, 4, w - 12, 8, 'n');
  mrect(k, w - 9, 5, 6, 4, 'k');
  mrect(k, 0, 12, w, 1, 'v');
  mrect(k, 0, 13, 12, 1, 'N');
  mrect(k, 12, 13, w - 12, 1, 'n');
  mrect(k, 1, 14, w - 2, 1, 'G');
  mrect(k, 2, 15, w - 4, 1, 'G');
  return k;
}

export function deskSprite() {
  return once('desk', () => {
    const w = DESK_W;
    const s = shadeMask(deskMask(), { ...MACHINE, g: { ...MACHINE.g, base: 3, bevel: 1, vgrad: null, brushed: false }, N: { ramp: 'panel', base: 2, bevel: 2, k: 2, steps: [0, 3], group: 'drawers' } });
    const set = (x, y, c) => {
      if (s.data[y * s.w + x] >= 0) s.data[y * s.w + x] = c;
    };
    // drawers: a seam and a steel pull on each
    for (let x = 1; x < 11; x += 1) set(x, 8, R.panel[0]);
    for (const y of [6, 10]) {
      for (let x = 4; x < 8; x += 1) set(x, y, R.steel[1]);
      set(4, y + 1, R.panel[0]);
      set(7, y + 1, R.panel[0]);
    }
    // vent slats in the recess
    for (let y = 5; y <= 8; y += 1) for (let x = w - 9; x < w - 3; x += 1) set(x, y, y % 2 ? R.gun[0] : R.void[0]);
    // screws on the front panel
    for (const [x, y] of [[13, 5], [w - 12, 5], [13, 11], [w - 12, 11]]) {
      set(x, y, R.steel[0]);
      set(x, y + 1, R.panel[0]);
    }
    // a status LED and a stencilled stripe on the front
    set(16, 6, R.violet[4]);
    for (let x = 16; x < 24; x += 1) set(x, 9, R.panel[3]);
    // desk-top lip glint
    for (let x = 2; x < 9; x += 1) set(x, 3, R.steel[3]);
    return s;
  });
}

// Monitor 26 x 23: bezel (g) around the screen, the arm (G) and the foot (s). The right side shows the
// bezel's depth (the screen is turned towards the coder).
const MONITOR = [
  '.gggggggggggggggggggggg...',
  'gggggggggggggggggggggggg..',
  'ggwwwwwwwwwwwwwwwwwwwwGGg.',
  'ggwwwwwwwwwwwwwwwwwwwwGGg.',
  'ggwwwwwwwwwwwwwwwwwwwwGGg.',
  'ggwwwwwwwwwwwwwwwwwwwwGGg.',
  'ggwwwwwwwwwwwwwwwwwwwwGGg.',
  'ggwwwwwwwwwwwwwwwwwwwwGGg.',
  'ggwwwwwwwwwwwwwwwwwwwwGGg.',
  'ggwwwwwwwwwwwwwwwwwwwwGGg.',
  'ggwwwwwwwwwwwwwwwwwwwwGGg.',
  'ggwwwwwwwwwwwwwwwwwwwwGGg.',
  'ggwwwwwwwwwwwwwwwwwwwwGGg.',
  'ggwwwwwwwwwwwwwwwwwwwwGGg.',
  'ggwwwwwwwwwwwwwwwwwwwwGGg.',
  'gggggggggggggggggggggggg..',
  '.gggggggggggggggggggggg...',
  '..........GGGG............',
  '..........GGGG............',
  '..........GGGG............',
  '.........GGGGGG...........',
  '.......SSSSSSSSSS.........',
  '......SSSSSSSSSSSS........',
];
export const SCREEN = { x: 2, y: 2, w: 20, h: 13 };

export function monitorSprite() {
  return once('monitor', () => {
    const s = shadeMask(maskFromRows(MONITOR), { ...MACHINE, g: { ...MACHINE.g, brushed: false, vgrad: null } });
    s.data[15 * s.w + 4] = R.gun[4];
    s.data[15 * s.w + 5] = R.gun[4];
    // cable down the arm
    for (let y = 17; y < 21; y += 1) s.data[y * s.w + 14] = R.gun[0];
    return s;
  });
}

// ---------------------------------------------------------------- the other consoles
// All consoles are 30 px tall so they fit under the row's rail; they stand on the back of the walkway.
// SETUP: a provisioning rack with drive bays, and a container crate beside it.
function setupMask() {
  const k = createMask(42, 30);
  mround(k, 0, 0, 16, 30, 1, 'g');
  for (let i = 0; i < 5; i += 1) mrect(k, 2, 3 + i * 5, 12, 4, 'N');
  mrect(k, 18, 14, 22, 14, 'b');
  mrect(k, 18, 14, 22, 2, 'G');
  mrect(k, 18, 26, 22, 2, 'G');
  mrect(k, 19, 28, 4, 2, 'G');
  mrect(k, 35, 28, 4, 2, 'G');
  return k;
}
// REVIEW: a diff terminal on a post, two panes, a lens on an arm.
function reviewMask() {
  const k = createMask(34, 30);
  mrect(k, 13, 14, 8, 13, 'g');
  mround(k, 7, 26, 20, 4, 1, 'G');
  mround(k, 1, 3, 30, 12, 2, 'g');
  mrect(k, 3, 5, 12, 8, 'w');
  mrect(k, 17, 5, 12, 8, 'w');
  mrect(k, 28, 0, 2, 4, 'G');
  mround(k, 25, 0, 9, 4, 1, 'S');
  return k;
}
// FIX: a workbench with a vise under a tool wall (screwdriver, wrench, hammer).
function fixMask() {
  // the vise sits on the left end of the bench, under the fixer's hands; the tool wall is to the right
  const k = createMask(44, 30);
  mround(k, 12, 0, 32, 13, 1, 'N');
  mrect(k, 0, 14, 44, 4, 'l');
  mrect(k, 0, 18, 44, 2, 'G');
  mrect(k, 2, 20, 4, 10, 'g');
  mrect(k, 38, 20, 4, 10, 'g');
  mrect(k, 8, 23, 28, 3, 'G');
  mrect(k, 2, 9, 10, 5, 'g');
  mrect(k, 4, 6, 2, 4, 'S');
  mrect(k, 8, 6, 2, 4, 'S');
  mline(k, 17, 2, 17, 8, 'S');
  mrect(k, 16, 8, 3, 3, 'r');
  mrect(k, 22, 2, 3, 3, 'S');
  mline(k, 23, 5, 27, 9, 'S', 2);
  mrect(k, 32, 2, 7, 3, 'S');
  mrect(k, 34, 5, 2, 7, 'l');
  return k;
}
// PREP: a packing press over a roller bed, a box being packed, a control box.
function prepMask() {
  const k = createMask(42, 30);
  mrect(k, 4, 0, 26, 4, 'g');
  mrect(k, 6, 4, 4, 11, 'G');
  mrect(k, 24, 4, 4, 11, 'G');
  mrect(k, 12, 4, 10, 3, 'S');
  mrect(k, 11, 8, 12, 8, 'l');
  mrect(k, 0, 16, 42, 4, 'g');
  mrect(k, 0, 20, 42, 2, 'G');
  mrect(k, 3, 22, 4, 8, 'g');
  mrect(k, 35, 22, 4, 8, 'g');
  mrect(k, 11, 22, 20, 7, 'n');
  mrect(k, 13, 23, 9, 4, 'w');
  return k;
}

export function consoleSprite(type) {
  return once(`console:${type}`, () => {
    if (type === 'setup') {
      const s = shadeMask(setupMask(), MACHINE);
      for (let x = 21; x < 39; x += 3) for (let y = 17; y < 25; y += 1) s.data[y * s.w + x] = R.blue[0];
      for (let x = 24; x < 34; x += 1) s.data[20 * s.w + x] = R.steel[1];
      for (let i = 0; i < 5; i += 1) {
        s.data[(5 + i * 5) * s.w + 11] = R.gun[4];
        s.data[(5 + i * 5) * s.w + 12] = R.gun[4];
      }
      return s;
    }
    if (type === 'reviewer') {
      const s = shadeMask(reviewMask(), MACHINE);
      for (let r = 0; r < 3; r += 1) {
        for (let x = 4; x < 4 + 4 + ((r * 3) % 6); x += 1) s.data[(7 + r * 2) * s.w + x] = R.glass[2];
        for (let x = 18; x < 18 + 5 + ((r * 5) % 5); x += 1) s.data[(7 + r * 2) * s.w + x] = R.glass[2];
      }
      s.data[1 * s.w + 28] = R.glass[2];
      s.data[1 * s.w + 29] = R.glass[3];
      return s;
    }
    if (type === 'fixer') {
      const s = shadeMask(fixMask(), MACHINE);
      for (let y = 2; y < 12; y += 3) for (let x = 14; x < 43; x += 3) if (s.data[y * s.w + x] === R.panel[1] || s.data[y * s.w + x] === R.panel[2]) s.data[y * s.w + x] = R.panel[0];
      // a spare part clamped in the vise
      for (let x = 5; x < 9; x += 1) s.data[8 * s.w + x] = R.steel[3];
      for (let x = 1; x < 43; x += 5) s.data[16 * s.w + x] = R.leather[1];
      return s;
    }
    if (type === 'preparer') {
      const s = shadeMask(prepMask(), MACHINE);
      for (let y = 8; y < 16; y += 1) s.data[y * s.w + 17] = R.amber[3];
      for (let x = 2; x < 40; x += 4) s.data[18 * s.w + x] = R.gun[1];
      return s;
    }
    throw new Error(`no console ${type}`);
  });
}

/** Where each console sits relative to its station column x and the row deck (top-left). */
/** Consoles sit where the working hand of their role lands (about 59 px into the station). */
export const CONSOLE_AT = {
  setup: { dx: 56, dy: -28 },
  reviewer: { dx: 54, dy: -28 },
  fixer: { dx: 52, dy: -28 },
  preparer: { dx: 45, dy: -28 },
};

/**
 * Standby details of an idle console, drawn into the static layer: a dim amber standby lamp (steady,
 * never blinking: nothing is happening there) and the power cable that drops into the walkway.
 */
export function drawStandby(f, x, y, w, deck) {
  dot(f, x + w - 4, y + 2, R.amber[1]);
  dot(f, x + w - 4, y + 1, R.dusk[3]);
  vline(f, x + w - 2, y + 24, deck - (y + 24) + 3, R.gun[0]);
  vline(f, x + w - 1, y + 24, deck - (y + 24) + 3, R.gun[2]);
}

// ---------------------------------------------------------------- the row: back wall, rail, lamps
/** X of the lamp over station i of a row. */
export const lampX = (L, row, i) => stationGeometry(L, row, i).lamp;

/**
 * The static part of one lane row: back wall with ribbed panels, the overhead rail with a lamp over
 * each station, the walkway deck with grating, the front face with the conduit channel and LED strip,
 * and the station pads. `hue` is a laneColours() set.
 */
export function drawRowStatic(f, L, row, hue, index) {
  const x0 = L.station.x - 4;
  const x1 = L.station.x1;
  const top = row.y + 1;
  // back wall: alternating tone, ribbed panels every 26 px, darker towards the deck (occlusion)
  rect(f, x0, top, x1 - x0, row.deck - top, index % 2 === 0 ? R.void[2] : R.void[1]);
  for (let x = x0 + 13; x < x1; x += 26) {
    vline(f, x, top + 6, row.deck - top - 6, R.void[0]);
    vline(f, x + 1, top + 6, row.deck - top - 6, index % 2 === 0 ? R.void[3] : R.void[2]);
  }
  shadeRect(f, x0, row.deck - 4, x1 - x0, 4, 0);
  hline(f, x0, row.y, x1 - x0, R.void[0]);
  // overhead rail with brackets
  rect(f, x0, top + 1, x1 - x0, 3, R.gun[1]);
  hline(f, x0, top + 1, x1 - x0, R.gun[3]);
  hline(f, x0, top + 4, x1 - x0, R.void[0]);
  for (let x = x0 + 8; x < x1; x += 52) {
    rect(f, x, top, 2, 5, R.gun[2]);
    dot(f, x, top + 2, R.steel[0]);
  }
  // a lamp over each station: housing, dark lens
  const n = row.n || L.station.n;
  for (let i = 0; i < n; i += 1) {
    const lx = lampX(L, row, i);
    rect(f, lx - 5, top + 4, 11, 3, R.gun[2]);
    hline(f, lx - 5, top + 4, 11, R.gun[4]);
    hline(f, lx - 4, top + 7, 9, R.gun[1]);
    hline(f, lx - 3, top + 7, 7, R.void[0]);
  }
  // walkway top surface (deck .. deck+8): lit edge, steel grating with slots
  const d = row.deck;
  rect(f, x0, d, x1 - x0, 9, R.gun[2]);
  hline(f, x0, d, x1 - x0, R.gun[4]);
  hline(f, x0, d + 1, x1 - x0, R.gun[3]);
  for (let x = x0 + 2; x < x1 - 1; x += 4) {
    vline(f, x, d + 3, 4, R.gun[1]);
    dot(f, x + 1, d + 3, R.gun[3]);
  }
  hline(f, x0, d + 8, x1 - x0, R.gun[1]);
  // front face (face .. face+5): navy panel with the conduit channel and a dim LED strip
  const fy = row.face;
  rect(f, x0, fy, x1 - x0, 6, R.panel[1]);
  hline(f, x0, fy, x1 - x0, R.panel[3]);
  hline(f, x0, fy + 2, x1 - x0, R.glass[0]);
  hline(f, x0, fy + 3, x1 - x0, R.glass[1]);
  hline(f, x0, fy + 5, x1 - x0, R.panel[0]);
  for (let x = x0 + 6; x < x1 - 4; x += 8) dot(f, x, fy + 4, hue.dark);
  // panel joints every station with a rivet pair
  for (let i = 0; i <= n; i += 1) {
    const x = Math.min(x1, L.station.x + i * (row.sw || L.station.w)) - 2;
    vline(f, x, fy + 1, 1, R.panel[0]);
    vline(f, x, fy + 4, 1, R.panel[0]);
    dot(f, x - 2, fy + 1, R.steel[0]);
    dot(f, x + 2, fy + 1, R.steel[0]);
  }
  // shadow under the track
  hline(f, x0, fy + 6, x1 - x0, R.void[0]);
  shadeRect(f, x0, fy + 7, x1 - x0, 2, 1);
  // station pads
  for (let i = 0; i < n; i += 1) {
    const px = stationGeometry(L, row, i).pad.x;
    panel(f, px, d + 2, 52, 5, { fill: R.gun[3], hi: R.gun[4], lo: R.gun[1] });
    hline(f, px + 2, d + 4, 48, R.gun[2]);
    if (!L.perRow) rect(f, px + 22, fy + 1, 8, 1, R.panel[0]);
  }
}

/** The lane chip at the left of a row: a lit plate with the lane code, on its bus connector. */
export function drawChip(f, L, row, hue, label) {
  const c = row.chip;
  rect(f, L.bus.x + 2, c.y + 7, c.x + 4 - L.bus.x, 3, R.gun[1]);
  hline(f, L.bus.x + 2, c.y + 7, c.x + 4 - L.bus.x, R.gun[3]);
  rect(f, c.x - 1, c.y - 1, c.w + 2, c.h + 2, R.void[0]);
  panel(f, c.x, c.y, c.w, c.h, { fill: hue.mid, hi: hue.light, lo: hue.dark });
  hline(f, c.x + 1, c.y + 1, c.w - 3, hue.top);
  for (const [x, y] of [[c.x - 1, c.y - 1], [c.x + c.w, c.y - 1], [c.x - 1, c.y + c.h], [c.x + c.w, c.y + c.h]]) dot(f, x, y, R.void[1]);
  // screw heads at the plate ends
  dot(f, c.x + 2, c.y + 8, hue.dark);
  dot(f, c.x + c.w - 3, c.y + 8, hue.dark);
  // big labels on phones, unless the code is too long for the plate at twice the size
  const ts = (L.ts || 1) > 1 && textWidth(label, 1, L.ts) <= c.w - 4 ? L.ts : 1;
  const tw = textWidth(label, 1, ts);
  text(f, label, c.x + Math.floor((c.w - tw) / 2), c.y + Math.floor((c.h - 7 * ts) / 2) + (ts === 1 ? 0 : -1), R.void[1], { shadow: hue.light, scale: ts, shadowOffset: 1 });
  rect(f, c.x + c.w + 1, row.face + 1, L.station.x - 4 - (c.x + c.w + 1), 4, R.gun[1]);
  hline(f, c.x + c.w + 1, row.face + 1, L.station.x - 4 - (c.x + c.w + 1), R.gun[3]);
}

/** A pad and its socket light up in the lane hue under a working agent. */
export function drawPadLit(f, L, row, i, hue) {
  const px = stationGeometry(L, row, i).pad.x;
  hline(f, px + 2, row.deck + 4, 48, hue.mid);
  hline(f, px + 4, row.deck + 4, 44, hue.light);
  if (!L.perRow) {
    rect(f, px + 22, row.face + 1, 8, 1, hue.top);
    glow(f, px + 26, row.face + 1, [2, 4], hue.glow, { sy: 0.5, levels: [1, 0] });
  }
  lightRect(f, px, row.deck + 2, 52, 5, hue.glow, 0);
}

/** A station its lane has finished: a thin mint line along the pad's front edge and a dim mint lamp lens. */
export function drawPadDone(f, L, row, i) {
  const st = stationGeometry(L, row, i);
  hline(f, st.pad.x + 6, row.deck + 6, 40, R.mint[1]);
  hline(f, st.lamp - 3, row.y + 8, 7, R.mint[2]);
}

/** The text a station plate shows, cut to fit `maxW` pixels. */
export function stationLabelText(tag, maxW) {
  const s = fontText(tag).trim();
  if (!s) return '';
  if (textWidth(s) <= maxW) return s;
  const word = s.split(' ')[0];
  if (word && textWidth(word) <= maxW) return word;
  return s.slice(0, Math.max(1, Math.floor((maxW + 1) / 6)));
}

/**
 * The name plate of a station in a row that has its own stations (rows with different workflows): a
 * small dark plate on the walkway's front face, under the pad and clear of the agents' feet. It lights
 * in the lane hue while an agent works there, mint once the lane has finished the station, and stays
 * dim steel otherwise.
 */
export function drawStationLabel(f, L, row, i, tag, { state = 'idle', hue = null } = {}) {
  const st = stationGeometry(L, row, i);
  const room = Math.min(st.w - 6, 76);
  const s = stationLabelText(tag, room - 4);
  if (!s) return;
  const w = textWidth(s) + 4;
  const x = Math.round(st.pad.x + 26 - w / 2);
  const x0 = Math.max(st.x + 1, Math.min(x, st.x + st.w - w - 3));
  const y = row.face - 1;
  rect(f, x0 - 1, y - 1, w + 2, 10, R.void[0]);
  rect(f, x0, y, w, 8, R.panel[1]);
  const col = state === 'busy' && hue ? hue.light : state === 'done' ? R.mint[3] : R.steel[1];
  if (state === 'busy' && hue) hline(f, x0, y, w, hue.mid);
  else if (state === 'done') hline(f, x0, y, w, R.mint[1]);
  text(f, s, x0 + 2, y + 1, col);
}

/**
 * The station lamp is on while an agent works there: a lit lens and a stepped cone of warm light
 * falling onto the console, the agent and the walkway (two levels, no blur). Drawn after the agent.
 */
export function drawLampLight(f, L, row, i, light = 'amber') {
  const lx = lampX(L, row, i);
  const top = row.y + 8;
  const bottom = row.deck + 8;
  const lut0 = LIGHT[light][0];
  const lut1 = LIGHT[light][1];
  // the beam: one light step inside a widening trapezoid, its edge broken into a 2-px ordered stagger
  for (let y = top; y < row.deck; y += 1) {
    const k = (y - top) / (bottom - top);
    const half = Math.round(5 + k * 24);
    for (let x = lx - half; x <= lx + half; x += 1) {
      if (x < 0 || y < 0 || x >= f.w || y >= f.h) continue;
      if (Math.abs(x - lx) >= half - 1 && (x + y) % 2 === 0) continue;
      const i2 = y * f.w + x;
      f.px[i2] = lut0[f.px[i2]];
    }
  }
  // the pool on the walkway: two steps in the middle, one step at its rim
  for (let y = row.deck; y < bottom; y += 1) {
    const half = 30 - (y - row.deck);
    for (let x = lx - half; x <= lx + half; x += 1) {
      if (x < 0 || y < 0 || x >= f.w || y >= f.h) continue;
      const i2 = y * f.w + x;
      f.px[i2] = Math.abs(x - lx) < half - 10 ? lut1[f.px[i2]] : lut0[f.px[i2]];
    }
  }
  // the lens itself
  hline(f, lx - 3, row.y + 8, 7, R.amber[5]);
  hline(f, lx - 4, row.y + 8, 1, R.amber[3]);
  hline(f, lx + 4, row.y + 8, 1, R.amber[3]);
}

export { remap };
