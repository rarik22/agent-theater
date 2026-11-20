// Agent Theater HD · hd-yard.mjs
// The machine yard around the merge machine: the TEST rack (four test pods for the live-check slots and
// the exclusive hold), the DEVELOP vault with its merge lock, the REMOTE cloud, and what connects them:
// the outlet pipe (merged parcels flow along it as a light), the cables from the merge machine to the
// rack, the uplink from the vault to the remote (a packet rises after each merge), the merger's lever
// pedestal and the red paper plane that carries a bounced job back to its lane. Static bodies are
// shaded once; states (holders, lock, flashes, flows) are drawn per frame from the world. Pure.
import { textWidth } from './hd-font.mjs';
import { box as frameBox, dot, glow, hline, lightRect, line, panel, rect, shadeRect, text, vline } from './hd-gfx.mjs';
import { along, pathLength, podBox } from './hd-layout.mjs';
import { R, laneColours } from './hd-palette.mjs';
import { createMask, mdisc, mrect, mround, shadeMask } from './hd-shade.mjs';
import { MACHINE } from './hd-stations.mjs';

const memo = new Map();
const once = (k, make) => {
  if (!memo.has(k)) memo.set(k, make());
  return memo.get(k);
};

// ---------------------------------------------------------------- pipes, cables, uplink
/** A 12 px pipe along an orthogonal polyline: lit top, glass flow slit, couplings, elbows. */
export function drawPipe(f, pts) {
  for (let i = 0; i + 1 < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    if (a.y === b.y) {
      const x0 = Math.min(a.x, b.x);
      const w = Math.abs(b.x - a.x) + (i + 2 < pts.length ? 6 : 0);
      const y = a.y - 6;
      shadeRect(f, x0, y + 13, w, 2, 1);
      rect(f, x0, y, w, 12, R.gun[2]);
      hline(f, x0, y, w, R.gun[4]);
      hline(f, x0, y + 1, w, R.steel[0]);
      hline(f, x0, y + 2, w, R.gun[3]);
      hline(f, x0, y + 9, w, R.gun[1]);
      hline(f, x0, y + 11, w, R.gun[0]);
      hline(f, x0 + 2, y + 5, w - 4, R.glass[1]);
      hline(f, x0 + 2, y + 6, w - 4, R.glass[0]);
      for (let x = x0 + 14; x < x0 + w - 6; x += 28) {
        rect(f, x, y - 1, 4, 14, R.gun[3]);
        vline(f, x, y - 1, 14, R.steel[1]);
        vline(f, x + 3, y - 1, 14, R.gun[1]);
      }
    } else {
      const y0 = Math.min(a.y, b.y) - 6;
      const h = Math.abs(b.y - a.y) + 6;
      const x = a.x - 6;
      shadeRect(f, x + 13, y0 + 2, 2, h, 1);
      rect(f, x, y0, 12, h, R.gun[2]);
      vline(f, x, y0, h, R.gun[4]);
      vline(f, x + 1, y0, h, R.steel[0]);
      vline(f, x + 2, y0, h, R.gun[3]);
      vline(f, x + 9, y0, h, R.gun[1]);
      vline(f, x + 11, y0, h, R.gun[0]);
      vline(f, x + 5, y0 + 2, h - 4, R.glass[1]);
      vline(f, x + 6, y0 + 2, h - 4, R.glass[0]);
      for (let y = y0 + 14; y < y0 + h - 6; y += 28) {
        rect(f, x - 1, y, 14, 4, R.gun[3]);
        hline(f, x - 1, y, 14, R.steel[1]);
        hline(f, x - 1, y + 3, 14, R.gun[1]);
      }
    }
  }
  // elbows: a bolted collar at each bend
  for (let i = 1; i + 1 < pts.length; i += 1) {
    const p = pts[i];
    rect(f, p.x - 8, p.y - 8, 16, 16, R.gun[3]);
    hline(f, p.x - 8, p.y - 8, 16, R.steel[1]);
    vline(f, p.x - 8, p.y - 8, 16, R.gun[4]);
    hline(f, p.x - 7, p.y + 7, 15, R.gun[1]);
    vline(f, p.x + 7, p.y - 7, 15, R.gun[1]);
    for (const [dx, dy] of [[-6, -6], [5, -6], [-6, 5], [5, 5]]) dot(f, p.x + dx, p.y + dy, R.steel[2]);
    rect(f, p.x - 2, p.y - 2, 4, 4, R.glass[0]);
  }
}

/** A flow light in the pipe's glass slit at distance d along it. */
export function drawPipeFlow(f, pts, d, colour = 'mint') {
  const p = along(pts, d);
  const q = along(pts, Math.max(0, d - 6));
  const r = R[colour];
  line(f, q.x, q.y, p.x, p.y, r[r.length - 2]);
  dot(f, p.x, p.y, r[r.length - 1]);
  glow(f, p.x, p.y, [3, 6], colour, { levels: [2, 0] });
}

/** A bundled cable (2 px with a highlight) along a polyline. */
export function drawCable(f, pts) {
  for (let i = 0; i + 1 < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    line(f, a.x + 1, a.y + 1, b.x + 1, b.y + 1, R.void[0]);
    line(f, a.x, a.y, b.x, b.y, R.gun[1]);
    line(f, a.x, a.y - (a.y === b.y ? 1 : 0), b.x - (a.x === b.x ? 1 : 0), b.y - (a.y === b.y ? 1 : 0), R.gun[3]);
  }
  for (const p of [pts[0], pts[pts.length - 1]]) {
    rect(f, p.x - 2, p.y - 2, 5, 5, R.gun[3]);
    dot(f, p.x - 1, p.y - 1, R.steel[1]);
  }
}

/** The uplink mast from the vault to the remote: a thin conduit with insulators. */
export function drawUplink(f, pts) {
  const [a, b] = pts;
  const x = Math.round(a.x);
  vline(f, x - 1, b.y, a.y - b.y, R.gun[1]);
  vline(f, x, b.y, a.y - b.y, R.gun[3]);
  vline(f, x + 1, b.y, a.y - b.y, R.void[0]);
  for (let y = b.y + 8; y < a.y - 4; y += 14) {
    rect(f, x - 3, y, 7, 3, R.panel[2]);
    hline(f, x - 3, y, 7, R.panel[4]);
  }
}

// ---------------------------------------------------------------- test pods
function podMask() {
  const k = createMask(62, 66);
  mrect(k, 1, 10, 7, 40, 'G'); // pillars
  mrect(k, 54, 10, 7, 40, 'G');
  mround(k, 9, 2, 44, 48, 18, 'S'); // capsule frame
  mround(k, 13, 6, 36, 42, 15, 'w'); // glass
  mround(k, 20, 0, 22, 6, 2, 'g'); // vented cap
  mrect(k, 0, 46, 62, 20, 'g'); // base
  mrect(k, 4, 50, 54, 8, 'n'); // display panel
  mrect(k, 2, 62, 58, 4, 'G');
  return k;
}
export function podSprite() {
  return once('pod', () => {
    const s = shadeMask(podMask(), { ...MACHINE, S: { ...MACHINE.S, bevel: 2, base: 2 } });
    const set = (x, y, c) => {
      if (s.data[y * s.w + x] >= 0) s.data[y * s.w + x] = c;
    };
    // glass reflections: a long vertical streak on the capsule's left and a glint on its shoulder
    for (let y = 14; y < 40; y += 1) set(16, y, R.glass[3]);
    for (let y = 18; y < 34; y += 1) set(18, y, R.glass[2]);
    for (const [x, y] of [[20, 9], [21, 8], [22, 8], [23, 7]]) set(x, y, R.glass[3]);
    // cap vents and pillar status lamps
    for (let x = 23; x < 40; x += 3) set(x, 3, R.void[0]);
    for (const x of [4, 57]) for (let y = 14; y < 46; y += 8) set(x, y, R.panel[3]);
    // ribs on the frame and a pedestal inside
    for (let x = 22; x < 40; x += 1) set(x, 44, R.gun[3]);
    for (let x = 24; x < 38; x += 1) set(x, 43, R.gun[4]);
    for (const x of [6, 55]) for (let y = 48; y < 62; y += 4) set(x, y, R.steel[2]);
    return s;
  });
}

function rackMask(w, h) {
  const k = createMask(w, h);
  mrect(k, 0, 0, w, 6, 'g');
  mrect(k, 0, h - 8, w, 8, 'G');
  mrect(k, 0, 0, 4, h, 'g');
  mrect(k, w - 4, 0, 4, h, 'g');
  mrect(k, (w >> 1) - 2, 6, 4, h - 14, 'G');
  return k;
}
export function rackSprite(w, h) {
  return once(`rack:${w}x${h}`, () => {
    const s = shadeMask(rackMask(w, h), MACHINE);
    for (let x = 6; x < w - 6; x += 10) s.data[2 * s.w + x] = R.steel[2];
    return s;
  });
}

/** The rack with its pods (static). */
export function drawRackStatic(f, L) {
  const r = L.rack;
  shadeRect(f, r.x + 4, r.y + r.h, r.w, 3, 1);
  rect(f, r.x + 4, r.y + 6, r.w - 8, r.h - 14, R.void[0]);
  for (let y = r.y + 10; y < r.y + r.h - 8; y += 6) hline(f, r.x + 4, y, r.w - 8, R.void[1]);
  f && blitSprite(f, rackSprite(r.w, r.h), r.x, r.y);
  for (let n = 0; n < 4; n += 1) {
    const b = podBox(L, n);
    blitSprite(f, podSprite(), b.x, b.y);
  }
}

function blitSprite(f, s, x, y) {
  for (let r = 0; r < s.h; r += 1) for (let i = 0; i < s.w; i += 1) {
    const c = s.data[r * s.w + i];
    if (c >= 0) dot(f, x + i, y + r, c);
  }
}

/** A lane-coloured data crate floating in a pod while its slot is held (a small hologram of the work). */
function podHologram(f, cx, cy, hue, t, calm) {
  const bob = calm ? 0 : Math.round(Math.sin(t * 2) * 1.5);
  const y = cy - 6 + bob;
  rect(f, cx - 7, y, 14, 4, hue.light);
  rect(f, cx - 7, y + 4, 14, 8, hue.mid);
  hline(f, cx - 7, y, 14, hue.top);
  vline(f, cx - 1, y, 12, R.gun[2]);
  vline(f, cx, y, 12, R.gun[3]);
  for (let i = 0; i < 3; i += 1) hline(f, cx - 5 + i * 2, y + 14 + i * 2, 10 - i * 4, hue.dark);
}

/**
 * Pods by state: free (dark glass, standby LED), held (holder's crate floating, scan beam, chasing
 * LEDs, holder code on the display), pass/fail flash (mint/red light) after the merge it was testing.
 */
export function drawPods(f, L, pods, hues, { t = 0, calm = false, flash = null, exclusive = null } = {}) {
  pods.forEach((pod, n) => {
    const b = podBox(L, n);
    const cx = b.x + 31;
    const glassBox = { x: b.x + 14, y: b.y + 7, w: 34, h: 40 };
    const held = Boolean(pod.holder);
    const hue = pod.holder && pod.holder.kind === 'lane' ? laneColours(hues.get(pod.holder.lane)) : pod.holder && pod.holder.kind === 'merge' ? laneColours('gold') : laneColours('none');
    if (held) {
      lightRect(f, glassBox.x, glassBox.y, glassBox.w, glassBox.h, hue.glow, 0);
      podHologram(f, cx, b.y + 26, hue, t + n, calm);
      if (!calm) {
        const sy = glassBox.y + 3 + (Math.floor(t * 18 + n * 7) % (glassBox.h - 6));
        hline(f, glassBox.x + 3, sy, glassBox.w - 6, hue.light);
      }
    }
    const fl = flash && flash.pods.has(n) ? flash.kind : null;
    if (fl) lightRect(f, glassBox.x, glassBox.y, glassBox.w, glassBox.h, fl === 'pass' ? 'mint' : 'red', 1);
    // display: holder code or a dash
    const code = pod.label || (held ? '...' : '--');
    rect(f, b.x + 6, b.y + 51, 50, 6, R.glass[0]);
    text(f, code.slice(0, 7), b.x + 31 - Math.floor(textWidth(code.slice(0, 7)) / 2), b.y + 50, held ? hue.light : R.panel[3], { spacing: 1 });
    // LEDs on the base
    for (let i = 0; i < 4; i += 1) {
      const on = held && (calm || Math.floor(t * 6 + n) % 4 === i);
      const standby = !held && i === (Math.floor(t * 0.7 + n) % 4) && Math.sin(t * 2 + n) > 0;
      dot(f, b.x + 22 + i * 5, b.y + 60, fl === 'pass' ? R.mint[4] : fl === 'fail' ? R.red[4] : on ? hue.top : held ? hue.dark : standby ? R.cyan[1] : R.gun[1]);
    }
    if (pod.unavailable) {
      // a slot the server could not read: shuttered
      for (let y = glassBox.y + 8; y < glassBox.y + glassBox.h; y += 4) hline(f, glassBox.x + 4, y, glassBox.w - 8, R.gun[2]);
    }
  });
  if (exclusive) {
    // the exclusive hold: an amber hazard frame around the rack with a padlock
    const r = L.rack;
    const hue = exclusive.kind === 'lane' ? laneColours(hues.get(exclusive.lane)) : laneColours('gold');
    for (let i = 0; i < r.w + 8; i += 1) {
      const c = ((i >> 2) % 2 === 0) ? R.amber[3] : R.gun[0];
      dot(f, r.x - 4 + i, r.y - 4, c);
      dot(f, r.x - 4 + i, r.y + r.h + 3, c);
    }
    for (let i = 0; i < r.h + 8; i += 1) {
      const c = ((i >> 2) % 2 === 0) ? R.amber[3] : R.gun[0];
      dot(f, r.x - 4, r.y - 4 + i, c);
      dot(f, r.x + r.w + 3, r.y - 4 + i, c);
    }
    drawPadlock(f, r.x + r.w - 12, r.y - 17, true, hue);
  }
}

/** A 10 x 11 padlock; closed or open; body tinted by the holder. */
export function drawPadlock(f, x, y, closed, hue) {
  x = Math.round(x);
  y = Math.round(y);
  const sh = closed ? 0 : -2;
  vline(f, x + 2, y + sh, 5, R.steel[2]);
  vline(f, x + 7, y + (closed ? 0 : 2), 5, R.steel[1]);
  hline(f, x + 3, y + sh, 4, R.steel[3]);
  rect(f, x, y + 4, 10, 7, hue ? hue.mid : R.amber[3]);
  hline(f, x, y + 4, 10, hue ? hue.light : R.amber[4]);
  hline(f, x, y + 10, 10, hue ? hue.dark : R.amber[2]);
  dot(f, x + 4, y + 6, R.gun[0]);
  dot(f, x + 5, y + 6, R.gun[0]);
  vline(f, x + 5, y + 7, 2, R.gun[0]);
}

// ---------------------------------------------------------------- the develop vault
function vaultMask() {
  const k = createMask(96, 96);
  mround(k, 0, 6, 96, 90, 4, 'g'); // body
  mrect(k, 30, 0, 36, 8, 'G'); // roof block with the antenna mount
  mdisc(k, 48, 52, 33, 'S'); // door ring
  mdisc(k, 48, 52, 28, 'n'); // door
  mrect(k, 4, 30, 8, 44, 'G'); // hinge
  mrect(k, 10, 88, 76, 8, 'G'); // plinth
  return k;
}
export function vaultSprite() {
  return once('vault', () => {
    const s = shadeMask(vaultMask(), { ...MACHINE, S: { ...MACHINE.S, bevel: 3, base: 2 }, n: { ...MACHINE.n, bevel: 4, base: 2, vgrad: null } });
    const set = (x, y, c) => {
      if (s.data[y * s.w + x] >= 0) s.data[y * s.w + x] = c;
    };
    // bolts round the door ring and an anti-aliased outer edge of the ring
    for (let a = 0; a < 12; a += 1) {
      const ang = (a / 12) * Math.PI * 2;
      const x = 48 + Math.round(Math.cos(ang) * 30.5);
      const y = 52 + Math.round(Math.sin(ang) * 30.5);
      set(x, y, R.steel[4]);
      set(x + 1, y + 1, R.gun[1]);
    }
    for (let dy = -35; dy <= 35; dy += 1) for (let dx = -35; dx <= 35; dx += 1) {
      const d = Math.hypot(dx, dy);
      if (d > 33.2 && d <= 33.9) set(48 + dx, 52 + dy, dx + dy < 0 ? R.steel[0] : R.gun[1]);
    }
    // hinge pins
    for (const y of [36, 50, 64]) {
      set(7, y, R.steel[3]);
      set(8, y, R.steel[2]);
      set(7, y + 1, R.gun[1]);
    }
    // rivet line on the body
    for (let x = 8; x < 90; x += 8) set(x, 10, R.steel[2]);
    for (let x = 14; x < 84; x += 8) set(x, 84, R.steel[1]);
    return s;
  });
}

/** The vault door wheel: six spokes, rotated by `a`. */
function drawWheel(f, cx, cy, a) {
  for (let k = 0; k < 6; k += 1) {
    const ang = a + (k * Math.PI) / 3;
    line(f, cx, cy, cx + Math.round(Math.cos(ang) * 13), cy + Math.round(Math.sin(ang) * 13), R.steel[2]);
    dot(f, cx + Math.round(Math.cos(ang) * 14), cy + Math.round(Math.sin(ang) * 14), R.steel[4]);
  }
  for (let dy = -15; dy <= 15; dy += 1) for (let dx = -15; dx <= 15; dx += 1) {
    const d = Math.hypot(dx, dy);
    if (d > 13.4 && d <= 14.6) dot(f, cx + dx, cy + dy, dx + dy < 0 ? R.steel[3] : R.steel[1]);
  }
  rect(f, cx - 3, cy - 3, 6, 6, R.gun[3]);
  rect(f, cx - 2, cy - 2, 4, 4, R.steel[2]);
  dot(f, cx - 1, cy - 1, R.steel[4]);
}

/**
 * The vault by state: the merge lock (bolts out, amber lamp, holder code) or open (bolts in, mint lamp),
 * the door wheel turning while a merged parcel is taken in, and the intake flash.
 */
export function drawVault(f, L, { lock = null, label = '', hues, t = 0, calm = false, intake = 0 } = {}) {
  const v = L.vault;
  const cx = v.x + 48;
  const cy = v.y + 52;
  const locked = Boolean(lock);
  const hue = lock && lock.kind === 'lane' ? laneColours(hues.get(lock.lane)) : laneColours('gold');
  // bolts: three on the latch side slide into the frame when locked
  for (let i = 0; i < 3; i += 1) {
    const by = cy - 14 + i * 14;
    const out = locked ? 6 : 0;
    rect(f, v.x + 78 + out - 6, by, 10, 4, R.steel[2]);
    hline(f, v.x + 78 + out - 6, by, 10, R.steel[4]);
    hline(f, v.x + 78 + out - 6, by + 3, 10, R.gun[1]);
  }
  drawWheel(f, cx, cy, calm ? 0 : intake > 0 ? t * 6 : locked ? 0.4 : 0);
  if (intake > 0) lightRect(f, cx - 24, cy - 24, 48, 48, 'mint', intake > 0.5 ? 1 : 0);
  // lamp and display on the roof block
  const lamp = locked ? (calm || Math.floor(t * 2) % 2 ? R.amber[4] : R.amber[3]) : Math.sin(t * 1.3) > 0 ? R.mint[3] : R.mint[2];
  rect(f, v.x + 34, v.y + 1, 6, 5, lamp);
  dot(f, v.x + 35, v.y + 2, locked ? R.amber[5] : R.mint[4]);
  glow(f, v.x + 37, v.y + 3, [4, 6], locked ? 'amber' : 'mint', { levels: [1, 0] });
  const code = locked ? (label === 'MERGE' ? 'MRG' : label || 'LOCK') : 'OPEN';
  rect(f, v.x + 42, v.y + 1, 22, 6, R.glass[0]);
  text(f, code.slice(0, 4), v.x + 43, v.y, locked ? hue.light : R.mint[3], { spacing: 0 });
  drawPadlock(f, v.x + 70, v.y + 18, locked, locked ? hue : null);
}

/** The roof dish of the vault that sends packets to the remote. */
export function drawDish(f, L) {
  const x = Math.round(L.uplink[0].x);
  const y = L.vault.y - 2;
  rect(f, x - 1, y - 6, 3, 7, R.gun[3]);
  for (let i = 0; i < 9; i += 1) {
    const yy = y - 8 - Math.round(Math.abs(i - 4) * 0.6);
    dot(f, x - 4 + i, yy, i < 4 ? R.steel[3] : R.steel[1]);
    dot(f, x - 4 + i, yy + 1, R.gun[2]);
  }
  dot(f, x, y - 12, R.cyan[3]);
}

// ---------------------------------------------------------------- the remote
const CLOUD_PUFFS = [
  [22, 40, 16], [44, 28, 20], [70, 26, 21], [92, 38, 17], [58, 44, 18], [34, 48, 14], [82, 48, 14],
];
function cloudMask(w, h) {
  const k = createMask(w, h);
  for (const [x, y, r] of CLOUD_PUFFS) mdisc(k, x, y, r, 'c');
  mrect(k, 14, 48, w - 28, 14, 'c');
  return k;
}
export function cloudSprite(w = 116, h = 66) {
  return once(`cloud:${w}`, () => {
    const s = shadeMask(cloudMask(w, h), { c: { ramp: 'steel', base: 2, bevel: 6, k: 2, kl: 4, steps: [0, 4], outline: R.panel[3], outlineLit: R.steel[0], vgrad: [0.25, 0.3] } });
    // a dark underside band and lit rims on each puff's top-left
    for (const [x, y, r] of CLOUD_PUFFS) for (let a = 0; a < 10; a += 1) {
      const ang = Math.PI * (1.05 + a * 0.05);
      const px = x + Math.round(Math.cos(ang) * (r - 2));
      const py = y + Math.round(Math.sin(ang) * (r - 2));
      if (s.data[py * s.w + px] >= 0 && s.data[py * s.w + px] !== R.panel[3]) s.data[py * s.w + px] = R.steel[4];
    }
    return s;
  });
}

/** The cloud brightens with a cyan rim when a packet lands; small server lights inside. */
export function drawCloud(f, L, { flash = 0, t = 0, calm = false } = {}) {
  const c = L.cloud;
  const s = cloudSprite(c.w, c.h);
  for (let r = 0; r < s.h; r += 1) for (let i = 0; i < s.w; i += 1) {
    const v = s.data[r * s.w + i];
    if (v >= 0) dot(f, c.x + i, c.y + r, v);
  }
  // server slots seen through the cloud: three dim LEDs that pulse slowly
  for (let i = 0; i < 3; i += 1) {
    const on = !calm && Math.floor(t * 1.5 + i) % 3 === 0;
    rect(f, c.x + 42 + i * 12, c.y + 46, 8, 3, R.panel[1]);
    dot(f, c.x + 43 + i * 12, c.y + 47, on || flash > 0 ? R.cyan[4] : R.cyan[1]);
  }
  if (flash > 0) {
    lightRect(f, c.x, c.y, c.w, c.h, 'cyan', flash > 0.5 ? 1 : 0);
    glow(f, c.x + c.w / 2, c.y + c.h - 4, [6, 12], 'cyan', { levels: [1, 0], sy: 0.5 });
  }
}

/** A data packet rising up the uplink. */
export function drawPacket(f, x, y) {
  x = Math.round(x);
  y = Math.round(y);
  rect(f, x - 2, y - 2, 5, 5, R.mint[3]);
  hline(f, x - 2, y - 2, 5, R.mint[4]);
  dot(f, x - 1, y - 1, R.steel[4]);
  vline(f, x + 2, y - 1, 4, R.mint[2]);
  glow(f, x, y, [4, 7], 'mint', { levels: [1, 0] });
}

// ---------------------------------------------------------------- merger's lever pedestal
export function drawPedestal(f, L, lever = 0) {
  const p = L.pedestal;
  const x = p.x;
  const y = p.y;
  shadeRect(f, x + 2, L.floorY, 14, 3, 1);
  panel(f, x, y + 10, 12, 30, { fill: R.gun[2], hi: R.gun[4], lo: R.gun[1], outline: R.gun[0] });
  panel(f, x - 2, y + 4, 16, 8, { fill: R.panel[2], hi: R.panel[4], lo: R.panel[0], outline: R.gun[0] });
  dot(f, x + 2, y + 7, R.amber[4]);
  dot(f, x + 5, y + 7, R.mint[3]);
  dot(f, x + 8, y + 7, R.cyan[3]);
  // the lever: its grip moves with the merger's pull (0 = up, 1 = down)
  const gy = y - 6 + Math.round(lever * 10);
  const gx = L.merge.flip ? x + 12 : x;
  line(f, x + 6, y + 4, gx, gy, R.steel[2]);
  rect(f, gx - 2, gy - 2, 5, 4, R.red[2]);
  hline(f, gx - 2, gy - 2, 5, R.red[3]);
}

// ---------------------------------------------------------------- the bounce plane
// A folded paper plane, 13 x 7, nose to the left: outline (o), lit upper wing (R, W fold), shaded
// lower wing (d). Two wing frames give it a flutter.
const PLANE = [
  ['.......oo....', '....ooRRo....', '.ooRRWWRo....', 'oRRWWWWRRoo..', '.ooddRRRRRRoo', '...oddddooo..', '.....oo......'],
  ['.............', '.....ooRo....', '.ooRRWWRRo...', 'oRRWWWWRRRoo.', '.ooddRRRRRRoo', '...oddddoo...', '....ooo......'],
];
/** A red paper plane facing left (dir -1) or right (dir 1), wing frame k. */
export function drawPlane(f, x, y, dir, k) {
  x = Math.round(x);
  y = Math.round(y);
  PLANE[k % 2].forEach((row, j) => [...row].forEach((ch, i) => {
    if (ch === '.') return;
    const c = ch === 'o' ? R.red[1] : ch === 'R' ? R.red[3] : ch === 'W' ? R.red[4] : R.red[2];
    dot(f, dir < 0 ? x + i : x + 12 - i, y + j, c);
  }));
}

export { frameBox };
