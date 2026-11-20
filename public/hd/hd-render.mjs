// Agent Theater HD · hd-render.mjs
// Composes one indexed frame of the HD stage from the world, for any export shape (16:9, 1:1, 4:5, 9:16):
// the layered wall and floor, the controller and its dock, the lane rows with their own stations, every
// agent at work (lane agents at their stations, side agents on the dock, the merger at the machine), the
// queue column, the merge machine, the test pods, the develop vault, the remote, and the flows between
// them. Static layers are cached and rebuilt only when the rows or the shape change. Every coordinate
// is rounded to a whole pixel; every colour is a palette index. Pure.
import { blinkAt, batchProgress, clipFor, mergeState, pulsesAt, rolePose } from './hd-anim.mjs';
import { CANCHOR, CH, CW, charFrame } from './hd-chars.mjs';
import { drawController, drawDock } from './hd-controller.mjs';
import { FONT, FONT_H, FONT_W, fontText, textWidth } from './hd-font.mjs';
import { BAYER4, blit, clear, createFrame, dot, glow, hline, lightRect, rect, remap, shadeRect, text, vdash, vline } from './hd-gfx.mjs';
import { along, stationGeometry, windowBox } from './hd-layout.mjs';
import { drawFeeders, drawMergeDynamic, drawQueueStatic, drawRollers, mergeBody, parcelSprite } from './hd-merge.mjs';
import { LIGHT, R, RAMP_OF, SHADE, laneColours } from './hd-palette.mjs';
import { CONSOLE_AT, DESK_W, SCREEN, consoleSprite, deskSprite, drawChip, drawLampLight, drawPadDone, drawPadLit, drawRowStatic, drawStandby, drawStationLabel, monitorSprite } from './hd-stations.mjs';
import { PLANE_S, BEAM_S, beltMoving, planeAt } from './hd-world.mjs';
import { cloudSprite, drawCable, drawCloud, drawDish, drawPacket, drawPedestal, drawPipe, drawPipeFlow, drawPlane, drawPods, drawRackStatic, drawUplink, drawVault, vaultSprite } from './hd-yard.mjs';

// ---------------------------------------------------------------- background
/** The wall: dark panel tiles with seams, faint circuit traces, a service pipe, very low-contrast noise. */
export function drawBackground(f, L) {
  clear(f, R.void[1]);
  for (let y = 0; y < f.h; y += 1) for (let x = 0; x < f.w; x += 1) {
    const th = BAYER4[y & 3][x & 3];
    const n = ((x * 7 + y * 13) ^ ((x >> 3) * 5)) & 15;
    if (th === 0 && n < 5) f.px[y * f.w + x] = R.void[2];
    else if (th === 15 && n > 13) f.px[y * f.w + x] = R.void[0];
  }
  const tw = 120;
  const th2 = 90;
  for (let row = 0; row * th2 < f.h; row += 1) {
    const y = row * th2;
    hline(f, 0, y, f.w, R.void[0]);
    hline(f, 0, y + 1, f.w, R.void[2]);
    const off = row % 2 ? tw / 2 : 0;
    for (let x = off; x < f.w; x += tw) {
      vline(f, x, y + 1, th2 - 1, R.void[0]);
      vline(f, x + 1, y + 2, th2 - 2, R.void[2]);
      dot(f, x + 4, y + 5, R.void[3]);
      dot(f, x + tw - 5, y + 5, R.void[3]);
    }
  }
  // the yard wall: big structural columns behind the machines (very dark, so they stay behind)
  const yx = L.yard.x;
  const yy = L.yard.y;
  for (let x = yx + 30; x < f.w; x += 150) {
    rect(f, x, yy, 14, L.floorY - yy, R.void[2]);
    vline(f, x, yy, L.floorY - yy, R.void[3]);
    vline(f, x + 13, yy, L.floorY - yy, R.void[0]);
    for (let y = yy + 20; y < L.floorY; y += 40) {
      dot(f, x + 3, y, R.void[4]);
      dot(f, x + 10, y, R.void[4]);
    }
  }
  // service pipe along the top of the yard wall
  const py = L.wide ? 4 : yy + 4;
  const px0 = L.wide ? yx : 0;
  rect(f, px0, py, f.w - px0, 7, R.gun[1]);
  hline(f, px0, py, f.w - px0, R.gun[3]);
  hline(f, px0, py + 1, f.w - px0, R.gun[2]);
  hline(f, px0, py + 6, f.w - px0, R.void[0]);
  shadeRect(f, px0, py + 7, f.w - px0, 3, 1);
  for (let x = px0 + 20; x < f.w; x += 64) {
    rect(f, x, py - 1, 4, 9, R.gun[2]);
    vline(f, x, py - 1, 9, R.gun[4]);
    dot(f, x + 1, py + 3, R.steel[0]);
  }
  // the yard floor: plates with seams, lit front lip, darker towards the viewer
  const fx = L.wide ? yx : 0;
  const fy = L.floorY;
  rect(f, fx, fy, f.w - fx, f.h - fy, R.void[2]);
  hline(f, fx, fy, f.w - fx, R.void[4]);
  hline(f, fx, fy + 1, f.w - fx, R.void[3]);
  for (let x = fx + 30; x < f.w; x += 48) vline(f, x, fy + 2, f.h - fy - 2, R.void[1]);
  for (let y = fy + 16; y < f.h; y += 16) hline(f, fx, y, f.w - fx, R.void[1]);
  shadeRect(f, fx, fy + 18, f.w - fx, f.h - fy - 18, 0);
  // vignette: stepped darkening towards the corners
  for (let y = 0; y < f.h; y += 1) for (let x = 0; x < f.w; x += 1) {
    const dx = (x - f.w / 2) / (f.w / 2);
    const dy = (y - f.h / 2) / (f.h / 2);
    const d = dx * dx * 0.7 + dy * dy;
    if (d > 1.05 + (BAYER4[y & 3][x & 3] / 16) * 0.12) f.px[y * f.w + x] = R.void[0];
  }
}

function drawBay(f, L) {
  const x0 = 2;
  const y0 = L.headerY - 8;
  const x1 = L.station.x1 + 2;
  const last = L.rows[L.rows.length - 1];
  const y1 = Math.max(L.rowsTop + 40, last ? last.y + last.h + 2 : L.rowsTop + 40);
  rect(f, x0, y0, x1 - x0, y1 - y0, R.void[1]);
  hline(f, x0, y0, x1 - x0, R.void[4]);
  vline(f, x0, y0, y1 - y0, R.void[3]);
  hline(f, x0, y1 - 1, x1 - x0, R.void[0]);
  vline(f, x1 - 1, y0, y1 - y0, R.void[0]);
  hline(f, x0 + 1, y0 + 1, x1 - x0 - 2, R.void[0]);
  rect(f, x0 + 1, y0 + 2, x1 - x0 - 2, L.rowsTop - y0 - 3, R.void[2]);
  hline(f, x0 + 1, L.rowsTop - 2, x1 - x0 - 2, R.void[0]);
}

/** Station tags over the rows when every row has the same stations (rows with their own stations carry plates). */
function drawHeader(f, L) {
  const ts = L.ts || 1;
  for (const h of L.header) {
    const s = fontText(h.label);
    if (!s) continue;
    const w = textWidth(s, 1, ts);
    text(f, s, h.cx - Math.floor(w / 2), h.y, R.steel[0], { top: R.steel[2], shadow: R.void[0], scale: ts, topRows: 3 });
  }
  for (const x of L.headerSplits || []) vdash(f, x, L.headerY - 2, 2 + 7 * ts, R.void[3], 1, 1);
}

function drawBus(f, L) {
  const last = L.rows[L.rows.length - 1];
  const x = L.bus.x;
  const y0 = L.bus.y0;
  const y1 = last ? last.chip.y + 10 : y0 + 20;
  rect(f, x - 1, y0, 5, y1 - y0, R.gun[1]);
  vline(f, x - 1, y0, y1 - y0, R.gun[3]);
  vline(f, x + 1, y0, y1 - y0, R.glass[0]);
  vline(f, x + 3, y0, y1 - y0, R.gun[0]);
  for (let y = y0 + 6; y < y1; y += 16) {
    rect(f, x - 2, y, 7, 2, R.gun[3]);
    hline(f, x - 2, y, 7, R.steel[0]);
  }
}

function label(f, s, cx, y, ts = 1) {
  text(f, s, Math.round(cx - textWidth(s, 1, ts) / 2), y, R.steel[1], { top: R.steel[3], shadow: R.void[0], scale: ts });
}

// ---------------------------------------------------------------- the CODE station
const CODE_COLS = [R.violet[4], R.cyan[4], R.amber[4], R.steel[2], R.mint[3], R.steel[1]];

function lineTokens(seed, n) {
  let h = (seed * 2654435761) >>> 0;
  const rnd = () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return (h >>> 0) / 4294967296;
  };
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const indent = [0, 2, 2, 4, 4, 6][Math.floor(rnd() * 6)];
    const toks = [];
    let x = indent;
    const k = 1 + Math.floor(rnd() * 3);
    for (let j = 0; j < k && x < 16; j += 1) {
      const len = Math.min(16 - x, 2 + Math.floor(rnd() * 6));
      toks.push({ x, len, c: CODE_COLS[Math.floor(rnd() * CODE_COLS.length)] });
      x += len + 1;
    }
    out.push(toks);
  }
  return out;
}
const CODE = lineTokens(17, 64);

/** The monitor screen content for a clip at time t (inside the 20x13 screen at sx, sy). */
export function drawScreen(f, sx, sy, clip, t, seed, calm) {
  const { w, h } = SCREEN;
  rect(f, sx, sy, w, h, R.glass[1]);
  for (let y = 1; y < h; y += 2) hline(f, sx, sy + y, w, R.glass[0]);
  const T = calm ? 0 : t;
  if (clip === 'code' || clip === 'search' || clip === 'scroll') {
    const speed = clip === 'code' ? 0.5 : clip === 'scroll' ? 1.2 : 0.4;
    const pos = T * speed + seed;
    const top = Math.floor(pos);
    const rows = 6;
    for (let r = 0; r < rows; r += 1) {
      const line = CODE[(top + r) % CODE.length];
      const y = sy + 1 + r * 2;
      dot(f, sx + 1, y, R.panel[3]);
      for (const tok of line) {
        let len = tok.len;
        if (clip === 'code' && r === rows - 1) {
          const typed = Math.floor((pos - top) * 16);
          if (tok.x >= typed) continue;
          len = Math.min(len, typed - tok.x);
        }
        hline(f, sx + 3 + tok.x, y, len, tok.c);
      }
    }
    if (clip === 'code' && (calm || Math.floor(T * 3) % 2 === 0)) {
      const typed = Math.min(16, Math.floor((pos - top) * 16));
      rect(f, sx + 3 + typed, sy + 1 + (rows - 1) * 2 - 1, 1, 2, R.steel[4]);
    }
    if (clip === 'search') {
      rect(f, sx + 1, sy, w - 2, 1, R.amber[2]);
      const hit = Math.floor(T * 1.5) % 6;
      lightRect(f, sx, sy + 1 + hit * 2, w, 1, 'amber', 2);
    }
    if (clip === 'scroll') {
      const bar = Math.floor(T * 2) % (h - 3);
      vline(f, sx + w - 1, sy + 1 + bar, 3, R.steel[2]);
    }
  } else if (clip === 'terminal') {
    for (let r = 0; r < 3; r += 1) {
      dot(f, sx + 1, sy + 1 + r * 2, R.mint[3]);
      hline(f, sx + 3, sy + 1 + r * 2, 6 + ((r * 5 + seed) % 9), R.steel[1]);
    }
    const p = (T * 0.18 + seed * 0.01) % 1;
    rect(f, sx + 1, sy + 8, w - 2, 3, R.glass[0]);
    rect(f, sx + 2, sy + 9, Math.max(1, Math.round((w - 4) * p)), 1, R.cyan[4]);
    for (let i = 0; i < Math.floor(p * 9); i += 1) dot(f, sx + 2 + i * 2, sy + 12, R.mint[3]);
  } else if (clip === 'hourglass') {
    const cx = sx + 10;
    const cy = sy + 6;
    for (let i = 0; i < 4; i += 1) {
      hline(f, cx - 3 + i, cy - 4 + i, 7 - i * 2, R.amber[3]);
      hline(f, cx - 3 + i, cy + 4 - i, 7 - i * 2, R.amber[3]);
    }
    hline(f, cx - 3, cy - 5, 7, R.steel[2]);
    hline(f, cx - 3, cy + 5, 7, R.steel[2]);
    dot(f, cx, cy + 1 + (calm ? 0 : Math.floor(T * 2) % 3), R.amber[5]);
  } else {
    dot(f, sx + 1, sy + 1, R.mint[2]);
    if (calm || Math.floor(T * 1.5) % 2 === 0) rect(f, sx + 3, sy, 2, 3, R.steel[3]);
  }
  dot(f, sx, sy, R.glass[3]);
  dot(f, sx + 1, sy, R.glass[3]);
  dot(f, sx, sy + 1, R.glass[3]);
}

/** Keyboard on the desk top: key caps in two staggered rows, a few lit under the fingers while typing. */
function drawKeyboard(f, kx, ky, typing, t, calm) {
  rect(f, kx, ky, 24, 3, R.gun[1]);
  hline(f, kx, ky - 1, 24, R.gun[0]);
  for (let r = 0; r < 2; r += 1) for (let c = 0; c < 11; c += 1) dot(f, kx + 1 + c * 2 + (r % 2), ky + r, R.gun[4]);
  if (typing && !calm) {
    const k1 = Math.floor(t * 9) % 11;
    const k2 = (Math.floor(t * 7) + 5) % 11;
    dot(f, kx + 1 + k1 * 2, ky, R.cyan[4]);
    dot(f, kx + 2 + k2 * 2, ky + 1, R.cyan[3]);
  }
  hline(f, kx, ky + 2, 24, R.gun[2]);
}

const deskAt = (ax, ay) => ({ x: ax - 16, y: ay - 17 });
const monitorAt = (ax, ay) => ({ x: ax + 12, y: ay - 39 });

function drawMug(f, d) {
  rect(f, d.x + 3, d.y - 3, 4, 4, R.steel[2]);
  hline(f, d.x + 3, d.y - 3, 4, R.steel[3]);
  dot(f, d.x + 4, d.y - 3, R.leather[1]);
  dot(f, d.x + 5, d.y - 3, R.leather[1]);
  vline(f, d.x + 7, d.y - 2, 2, R.steel[1]);
  vline(f, d.x + 6, d.y - 2, 3, R.steel[0]);
}

/** The empty CODE station (desk and dark monitor), drawn into the static layer. */
function drawCodeStationStatic(f, ax, ay) {
  const d = deskAt(ax, ay);
  const m = monitorAt(ax, ay);
  shadeRect(f, d.x + 2, d.y + 16, DESK_W, 2, 1);
  blit(f, monitorSprite(), m.x, m.y, { lut: SHADE[0] });
  blit(f, deskSprite(), d.x, d.y, { lut: SHADE[0] });
  drawKeyboard(f, d.x + 12, d.y + 1, false, 0, true);
  drawMug(f, d);
  // standby: a dim lamp on the monitor bezel and the dark screen's faint prompt
  dot(f, m.x + 21, m.y + 15, R.amber[1]);
  dot(f, m.x + SCREEN.x + 1, m.y + SCREEN.y + 1, R.glass[2]);
}



// ---------------------------------------------------------------- other consoles
/** The console of station i (null for a CODE desk, which is drawn with its coder). */
function consolePos(L, row, i) {
  const st = stationGeometry(L, row, i);
  const at = CONSOLE_AT[st.kind];
  return at ? { x: st.x + at.dx + st.shift, y: row.deck + at.dy + 2, role: st.kind } : null;
}
const isDesk = (L, row, i) => stationGeometry(L, row, i).kind === 'coder';

function drawConsoleLights(f, L, row, i, t, calm, kind) {
  const c = consolePos(L, row, i);
  if (!c) return;
  const busy = kind !== 'think' && kind !== 'wait';
  const blink = (k) => calm || !busy || Math.floor(t * 3 + k) % 4 !== 0;
  if (c.role === 'setup') {
    for (let k = 0; k < 5; k += 1) {
      dot(f, c.x + 4, c.y + 4 + k * 5, blink(k) ? R.mint[3] : R.mint[1]);
      dot(f, c.x + 6, c.y + 4 + k * 5, blink(k + 2) ? R.cyan[4] : R.cyan[1]);
    }
    dot(f, c.x + 38, c.y + 2, R.mint[3]);
  } else if (c.role === 'reviewer') {
    for (let r = 0; r < 3; r += 1) {
      const scroll = calm || !busy ? 0 : Math.floor(t * 1.5) % 3;
      hline(f, c.x + 4, c.y + 7 + r * 2, 3 + (((r + scroll) * 3) % 5), (r + scroll) % 3 === 1 ? R.red[3] : R.steel[1]);
      hline(f, c.x + 18, c.y + 7 + r * 2, 4 + (((r + scroll) * 5) % 5), (r + scroll) % 3 === 1 ? R.mint[3] : R.steel[1]);
    }
    dot(f, c.x + 29, c.y + 1, R.cyan[4]);
  } else if (c.role === 'fixer') {
    if (busy && !calm && Math.floor(t * 8) % 5 === 0) {
      dot(f, c.x + 6, c.y + 6, R.amber[5]);
      dot(f, c.x + 8, c.y + 4, R.amber[4]);
      dot(f, c.x + 3, c.y + 5, R.amber[4]);
    }
  } else if (c.role === 'preparer') {
    rect(f, c.x + 13, c.y + 23, 9, 4, R.glass[2]);
    hline(f, c.x + 14, c.y + 24, 1 + (calm || !busy ? 6 : Math.floor(t * 4) % 7), R.cyan[4]);
    // the press ram comes down onto the box while packing
    const ram = busy && !calm ? [0, 1, 2, 1][Math.floor(t * 4) % 4] : 0;
    rect(f, c.x + 12, c.y + 4 + ram, 10, 2, R.steel[2]);
  }
}

function drawLanePulse(f, x, y, hue) {
  hline(f, x - 5, y, 2, hue.mid);
  hline(f, x - 3, y, 3, hue.light);
  dot(f, x, y, hue.top);
  dot(f, x, y + 1, hue.light);
  glow(f, x, y, [2, 4], hue.glow, { levels: [1, 0], sy: 0.6 });
}

// ---------------------------------------------------------------- characters
/** Draw a character sprite pair at its anchor, mirrored when it faces left. */
function blitChar(f, s, ax, ay, facing, lut = null) {
  const x = facing < 0 ? ax - (CW - 1 - CANCHOR.x) : ax - CANCHOR.x;
  blit(f, s, x, ay - CANCHOR.y, { flip: facing < 0, lut });
}

/** Thought dots or an hourglass above an agent (think / wait). */
function drawBubble(f, ax, ay, kind, t, calm) {
  const x = ax + 6;
  const y = ay - 54;
  if (kind === 'think') {
    const n = calm ? 3 : 1 + (Math.floor(t * 2) % 3);
    rect(f, x - 1, y - 1, 13, 7, R.void[1]);
    hline(f, x, y - 1, 11, R.steel[1]);
    hline(f, x, y + 5, 11, R.steel[0]);
    vline(f, x - 1, y, 5, R.steel[1]);
    vline(f, x + 11, y, 5, R.steel[0]);
    dot(f, x - 2, y + 7, R.steel[0]);
    for (let i = 0; i < n; i += 1) rect(f, x + 1 + i * 4, y + 2, 2, 2, R.steel[3]);
  } else if (kind === 'wait') {
    rect(f, x, y - 2, 7, 1, R.steel[2]);
    rect(f, x, y + 7, 7, 1, R.steel[2]);
    for (let i = 0; i < 3; i += 1) {
      hline(f, x + 1 + i, y - 1 + i, 5 - i * 2, R.amber[3]);
      hline(f, x + 1 + i, y + 6 - i, 5 - i * 2, R.amber[2]);
    }
    dot(f, x + 3, y + 3 + (calm ? 0 : Math.floor(t * 2) % 3), R.amber[5]);
  }
}

/** The coder at the desk: body, monitor, desk, keys, hands, screen and the screen light on the face. */
function drawCoderAtDesk(f, e, P, t, calm) {
  const ax = Math.round(e.x);
  const ay = Math.round(e.y);
  const fr = charFrame(e.look, P);
  const clip = clipFor(e.kind);
  shadeRect(f, ax - 12, ay - 1, 26, 2, 1);
  blitChar(f, fr.body, ax, ay, 1);
  const d = deskAt(ax, ay);
  const m = monitorAt(ax, ay);
  blit(f, monitorSprite(), m.x, m.y);
  blit(f, deskSprite(), d.x, d.y);
  drawKeyboard(f, d.x + 12, d.y + 1, P.pose === 'type' && P.k !== 5, t, calm);
  blitChar(f, fr.front, ax, ay, 1);
  drawMug(f, d);
  drawScreen(f, m.x + SCREEN.x, m.y + SCREEN.y, clip.screen, t, e.seed % 64, calm);
  // the screen lights the face: one step on the side towards it, a cyan rim on its edge
  const ox = ax - CANCHOR.x;
  const oy = ay - CANCHOR.y;
  const cx = m.x + SCREEN.x - 2;
  const cy = m.y + SCREEN.y + 6;
  const lit = clip.screen !== 'idle' && clip.screen !== 'hourglass';
  const body = fr.body;
  for (let ly = 0; ly < 22; ly += 1) for (let lx = 0; lx < body.w; lx += 1) {
    const c = body.data[ly * body.w + lx];
    if (c < 0) continue;
    const x = ox + lx;
    const y = oy + ly;
    if (x < 0 || y < 0 || x >= f.w || y >= f.h) continue;
    const i = y * f.w + x;
    if (f.px[i] !== c) continue;
    const dist = Math.hypot(x - cx, (y - cy) / 0.9);
    if (dist > 19) continue;
    const edge = lx + 1 >= body.w || body.data[ly * body.w + lx + 1] < 0;
    if (edge && lit && dist < 17) f.px[i] = RAMP_OF[c].step >= 2 ? R.cyan[4] : R.cyan[2];
    else f.px[i] = LIGHT.cyan[lit && dist < 11 ? 1 : 0][c];
  }
  lightRect(f, d.x + 22, d.y, 24, 3, 'cyan', 0);
  dot(f, m.x + 21, m.y + 15, clip.pulse && !calm && Math.floor(t * 4) % 2 ? R.cyan[5] : R.cyan[3]);
}

/** Any agent: its pose for the role and action, the coder at its desk, bubbles over thinkers. */
function drawAgent(f, e, t, calm) {
  const P = rolePose(e.role, e.kind, t, e.seed, { walking: e.walking, calm });
  const ax = Math.round(e.x);
  const ay = Math.round(e.y);
  if (e.atDesk && !e.walking) drawCoderAtDesk(f, e, P, t, calm);
  else {
    const fr = charFrame(e.look, P);
    shadeRect(f, ax - 10, ay - 1, 22, 2, 1);
    blitChar(f, fr.body, ax, ay, e.facing);
    blitChar(f, fr.front, ax, ay, e.facing);
  }
  if (P.bubble && !e.walking) drawBubble(f, e.place === 'dock' ? ax + 10 : ax, e.place === 'dock' ? ay + 12 : ay, P.bubble, t, calm);
  return P;
}

/** A beam of light where an agent arrives or leaves (no character pops out of nothing). */
function drawBeam(f, b, t) {
  const age = (t - b.t0) / BEAM_S;
  const k = b.kind === 'in' ? 1 - age : age;
  const w = Math.max(1, Math.round(10 * (1 - Math.abs(0.5 - age) * 1.4)));
  const lv = k > 0.66 ? 2 : k > 0.33 ? 1 : 0;
  lightRect(f, b.x - (w >> 1), b.y - 46, w, 46, 'cyan', lv);
  hline(f, b.x - 8, b.y + 1, 17, R.cyan[3]);
}

// ---------------------------------------------------------------- dock tags
/**
 * The tag a dock plate shows, shortened to fit `maxW` pixels: the whole tag, else its longest
 * dash-separated tail that fits (BUILD-SITE -> SITE, REL-1.2.0 -> 1.2.0), else its head cut to fit.
 */
export function dockTagText(tag, maxW) {
  const s = fontText(tag).replace(/\s+/g, '-');
  if (!s) return '';
  if (textWidth(s) <= maxW) return s;
  const parts = s.split('-');
  for (let i = 1; i < parts.length; i += 1) {
    const tail = parts.slice(i).join('-');
    if (tail && textWidth(tail) <= maxW) return tail;
  }
  return s.slice(0, Math.max(1, Math.floor((maxW + 1) / 6)));
}

/** A small name plate under each side agent on the dock: what it works on (its tag), in its role's colour. */
function drawDockTags(f, L, docked) {
  if (!docked.length) return;
  const xs = docked.map((e) => Math.round(e.x));
  docked.forEach((e, i) => {
    if (!e.tag || e.walking) return;
    const gapL = i > 0 ? xs[i] - xs[i - 1] : 99;
    const gapR = i + 1 < xs.length ? xs[i + 1] - xs[i] : 99;
    const room = Math.max(10, Math.min(gapL, gapR, 60) - 2);
    const s = dockTagText(e.tag, room - 4);
    if (!s) return;
    const w = textWidth(s) + 4;
    const x = Math.round(xs[i] - w / 2);
    const y = L.dock.y - 1; // on the catwalk edge, clear of the station headers below
    const col = ROLE_TAG_COLOUR[e.role] || 'steel';
    rect(f, x - 1, y - 1, w + 2, 11, R.void[0]);
    rect(f, x, y, w, 9, R.panel[1]);
    hline(f, x, y, w, R[col][2]);
    text(f, s, x + 2, y + 1, R[col][4] ?? R[col][3]);
  });
}
const ROLE_TAG_COLOUR = { coder: 'cyan', reviewer: 'violet', fixer: 'amber', preparer: 'mint', setup: 'blue', verifier: 'mint', helper: 'steel', merger: 'amber' };

// ---------------------------------------------------------------- export cards and tags
/** Text in the 5x7 font at twice its size (each font pixel 2x2 logical pixels): the card titles only. */
export function textBig(f, s, x, y, c, shadow = null) {
  const str = String(s);
  const pass = (ox, oy, col) => {
    for (let k = 0; k < str.length; k += 1) {
      const g = FONT[str[k]] || FONT[' '];
      for (let r = 0; r < FONT_H; r += 1) for (let i = 0; i < FONT_W; i += 1) if (g[r][i] === '1') rect(f, x + ox + k * 12 + i * 2, y + oy + r * 2, 2, 2, col);
    }
  };
  if (shadow !== null) pass(2, 2, shadow);
  pass(0, 0, c);
}
export const bigWidth = (s) => (String(s).length ? String(s).length * 12 - 2 : 0);

/** Card words split into lines that fit (at most five words, the font's characters only). */
export const CARD_WORDS = 5;
export function wrapCaption(caption, maxW) {
  const words = fontText(caption).split(' ').filter(Boolean).slice(0, CARD_WORDS);
  const lines = [];
  for (const w of words) {
    const lastLine = lines[lines.length - 1];
    if (lastLine && bigWidth(`${lastLine} ${w}`) <= maxW) lines[lines.length - 1] = `${lastLine} ${w}`;
    else lines.push(w.slice(0, Math.max(1, Math.floor((maxW + 2) / 12))));
  }
  return lines;
}

/** Title or end card over the stage: the scene dimmed, a plate with the words, a lit rule. */
export function drawCard(f, kind, p, { caption = '', sub = '', t = 0 } = {}) {
  const fade = kind === 'title' ? (p > 0.8 ? (1 - p) / 0.2 : 1) : p < 0.2 ? p / 0.2 : 1;
  const lv = fade > 0.66 ? 2 : fade > 0.33 ? 1 : 0;
  if (fade <= 0) return;
  for (let i = 0; i < f.px.length; i += 1) f.px[i] = SHADE[lv][f.px[i]];
  if (fade < 0.5) return;
  const lines = wrapCaption(caption, f.w - 80);
  const h = lines.length * 18 + 34;
  const w = Math.max(...lines.map(bigWidth), textWidth(sub)) + 48;
  const x = Math.round((f.w - w) / 2);
  const y = Math.round((f.h - h) / 2);
  rect(f, x - 2, y - 2, w + 4, h + 4, R.void[0]);
  rect(f, x, y, w, h, R.panel[1]);
  hline(f, x, y, w, R.panel[4]);
  hline(f, x, y + h - 1, w, R.panel[0]);
  for (const [cx, cy] of [[x + 3, y + 3], [x + w - 4, y + 3], [x + 3, y + h - 4], [x + w - 4, y + h - 4]]) dot(f, cx, cy, R.steel[2]);
  lines.forEach((ln, i) => textBig(f, ln, Math.round(x + (w - bigWidth(ln)) / 2), y + 12 + i * 18, R.steel[4], R.void[0]));
  const ry = y + 12 + lines.length * 18;
  const sweep = Math.floor((t * 120) % (w - 24));
  hline(f, x + 12, ry, w - 24, R.cyan[1]);
  hline(f, x + 12 + sweep, ry, Math.min(16, w - 24 - sweep), R.cyan[4]);
  text(f, sub, Math.round(x + (w - textWidth(sub)) / 2), ry + 4, R.amber[4]);
}

/**
 * Iris between the segments of a cut: everything outside a circle round the stage centre goes black,
 * with a lit rim. open: 0 (closed, all black) .. 1 (fully open). A stepped, whole-pixel circle, so the
 * frame stays in the palette and the pixels stay crisp.
 */
export function drawIris(f, open) {
  const o = Math.max(0, Math.min(1, open));
  if (o >= 1) return;
  const cx = f.w / 2;
  const cy = f.h / 2;
  const rMax = Math.hypot(cx, cy) + 2;
  const r = rMax * o;
  const r2 = r * r;
  const rim = (r - 2) * (r - 2);
  for (let y = 0; y < f.h; y += 1) {
    const dy = y + 0.5 - cy;
    for (let x = 0; x < f.w; x += 1) {
      const dx = x + 0.5 - cx;
      const d2 = dx * dx + dy * dy;
      if (d2 >= r2) f.px[y * f.w + x] = R.void[0];
      else if (r > 3 && d2 >= rim) f.px[y * f.w + x] = d2 >= (r - 1) * (r - 1) ? R.cyan[3] : R.cyan[1];
    }
  }
}

/**
 * The clock card shown while the iris is closed between segments: the next segment's time big in the
 * middle of the black frame, a small label under it (for example UTC) and a lit rule.
 */
export function drawSegmentCard(f, time, sub = '', t = 0) {
  const s = String(time).replace(/[^0-9:]/g, '').slice(0, 5);
  const w = bigWidth(s);
  const x = Math.round((f.w - w) / 2);
  const y = Math.round(f.h / 2 - 16);
  textBig(f, s, x, y, R.steel[4], R.void[2]);
  const rw = Math.max(w, textWidth(sub)) + 24;
  const rx = Math.round((f.w - rw) / 2);
  hline(f, rx, y + 20, rw, R.cyan[1]);
  const sweep = Math.floor((t * 90) % Math.max(1, rw - 12));
  hline(f, rx + sweep, y + 20, Math.min(12, rw - sweep), R.cyan[4]);
  if (sub) text(f, fontText(sub), Math.round((f.w - textWidth(fontText(sub))) / 2), y + 25, R.amber[4]);
}

/** The replayed clock of a time-lapse (HH:MM), bottom right on a small plate with a dial icon. */
export function drawClock(f, L, label) {
  const ts = L.ts || 1;
  const s = String(label).replace(/[^0-9:]/g, '').slice(0, 5);
  const ph = 4 + 7 * ts; // plate height
  const w = textWidth(s, 1, ts) + 20;
  const x = L.w - w - 8;
  const y = L.h - ph - 5;
  rect(f, x - 1, y - 1, w + 2, ph + 2, R.void[0]);
  rect(f, x, y, w, ph, R.panel[1]);
  hline(f, x, y, w, R.panel[3]);
  hline(f, x, y + ph - 1, w, R.panel[0]);
  // a small clock dial
  const cy = y + Math.floor(ph / 2);
  for (let dy = -3; dy <= 3; dy += 1) for (let dx = -3; dx <= 3; dx += 1) {
    const d = Math.hypot(dx, dy);
    if (d > 2.6 && d <= 3.4) dot(f, x + 6 + dx, cy + dy, R.cyan[3]);
  }
  vline(f, x + 6, cy - 2, 3, R.steel[3]);
  hline(f, x + 6, cy, 2, R.steel[3]);
  text(f, s, x + 13, y + 2, R.steel[4], { scale: ts });
}

/** Corner tags bottom left: SAMPLE, TIME-LAPSE, OFFLINE. */
export function drawTags(f, L, tags) {
  const ts = L.ts || 1;
  const ph = 4 + 7 * ts;
  let x = L.tag.x;
  for (const tag of tags) {
    const col = tag === 'SAMPLE' ? 'amber' : tag === 'OFFLINE' ? 'red' : 'cyan';
    const w = textWidth(tag, 1, ts) + 8;
    const y = L.h - ph - 5;
    rect(f, x - 1, y - 1, w + 2, ph + 2, R.void[0]);
    rect(f, x, y, w, ph, R[col][3]);
    hline(f, x, y, w, R[col][4]);
    hline(f, x, y + ph - 1, w, R[col][2]);
    text(f, tag, x + 4, y + 2, R.void[1], { scale: ts });
    x += w + 6;
  }
}

// ---------------------------------------------------------------- layers
function buildStatic(world) {
  const L = world.layout;
  const f = createFrame(L.w, L.h);
  drawBackground(f, L);
  drawBay(f, L);
  drawDock(f, L);
  drawHeader(f, L);
  drawBus(f, L);
  L.rows.forEach((row, idx) => {
    const hue = laneColours(world.hues.get(row.id));
    drawRowStatic(f, L, row, hue, idx);
    for (let i = 0; i < row.n; i += 1) {
      if (isDesk(L, row, i)) {
        const st = stationGeometry(L, row, i);
        drawCodeStationStatic(f, st.agent.x, st.agent.y);
        continue;
      }
      const c = consolePos(L, row, i);
      if (!c) continue;
      const sp = consoleSprite(c.role);
      shadeRect(f, c.x + 2, row.deck + 3, sp.w, 2, 1);
      blit(f, sp, c.x, c.y, { lut: SHADE[0] });
      drawStandby(f, c.x, c.y, sp.w, row.deck);
    }
    drawChip(f, L, row, hue, row.id);
  });
  drawQueueStatic(f, L);
  drawFeeders(f, L, L.rows, world.hues, new Set());
  for (const cable of L.cables) drawCable(f, cable);
  drawUplink(f, L.uplink);
  drawPipe(f, L.pipe);
  drawRackStatic(f, L);
  shadeRect(f, L.vault.x + 6, L.vault.y + L.vault.h, L.vault.w, 3, 2);
  blit(f, vaultSprite(), L.vault.x, L.vault.y);
  drawDish(f, L);
  shadeRect(f, L.merge.x + (L.merge.flip ? -6 : 6), L.merge.y + L.merge.h - 2, L.merge.w, 4, 2);
  blit(f, mergeBody(L.merge.flip), L.merge.x, L.merge.y);
  const Y = world.yardLabels || YARD_LABELS;
  label(f, Y.test, L.labels.test.cx, L.labels.test.y, L.ts);
  label(f, Y.merge, L.labels.merge.cx, L.labels.merge.y, L.ts);
  label(f, Y.develop, L.labels.develop.cx, L.labels.develop.y, L.ts);
  label(f, Y.remote, L.labels.remote.cx, L.labels.remote.y, L.ts);
  void cloudSprite;
  return f;
}

/** The yard's plate words when the state names none. */
export const YARD_LABELS = Object.freeze({ test: 'TEST', merge: 'MERGE', develop: 'DEVELOP', remote: 'REMOTE' });

export function createRenderer() {
  return { frame: null, base: null, baseKey: '' };
}

/**
 * Draw the world at its animation time. opts: { calm, sample, timelapse, offline, speed }.
 * Returns the indexed frame (L.w x L.h).
 */
export function renderFrame(rd, world, opts = {}) {
  const t = world.t;
  const calm = Boolean(opts.calm);
  const L = world.layout;
  const Y = world.yardLabels || YARD_LABELS;
  const key = `${L.aspect}|${L.big}|${world.rowsKey}|${[...world.hues.entries()].join(';')}|${Y.test}|${Y.merge}|${Y.develop}|${Y.remote}`;
  if (!rd.base || rd.baseKey !== key) {
    rd.base = buildStatic(world);
    rd.baseKey = key;
    rd.frame = createFrame(L.w, L.h);
  }
  const f = rd.frame;
  f.px.set(rd.base.px);
  const agents = [...world.agents.values()];
  const laneAgents = agents.filter((e) => e.place === 'lane' && L.rowById.has(e.row));
  for (const e of agents) e.atDesk = e.place === 'lane' && L.rowById.has(e.row) && isDesk(L, L.rowById.get(e.row), e.station);
  // the belt always crawls; it runs fast while a parcel rides it
  drawRollers(f, L, t * (beltMoving(world) && !calm ? 16 : 2.5));
  const feeding = new Set();
  for (const p of world.parcels.values()) if ((p.mode === 'belt' || p.mode === 'merging') && p.path.length && p.x < L.queue.x && p.lane) feeding.add(p.lane);
  if (feeding.size) drawFeeders(f, L, L.rows.filter((r) => feeding.has(r.id)), world.hues, feeding);
  // controller bus pulses into active lanes; chips glow while their lane works (red after a bounce)
  const activeRows = new Set(laneAgents.map((e) => e.row));
  // ambient: a dim carrier light drifts along every lane's conduit (slow, no glow: not a work pulse)
  L.rows.forEach((row, ri) => {
    const hue = laneColours(world.hues.get(row.id));
    const span = L.station.x1 - L.station.x;
    const p = ((t * 0.18 + ri * 0.37) % 1 + 1) % 1;
    const x = L.station.x + Math.round(p * span);
    hline(f, x - 6, row.face + 3, 4, hue.dark);
    dot(f, x - 2, row.face + 3, hue.mid);
  });
  // ambient: idle consoles breathe their standby lamp; the pipe glass and the uplink shimmer
  const busyAt = new Set(laneAgents.filter((e) => !e.walking).map((e) => `${e.row}:${e.station}`));
  L.rows.forEach((row, ri) => {
    for (let i = 0; i < row.n; i += 1) {
      if (busyAt.has(`${row.id}:${i}`)) continue;
      const on = Math.sin(t * 1.4 + ri * 0.9 + i * 1.7) > 0.2;
      if (isDesk(L, row, i)) {
        const st = stationGeometry(L, row, i);
        dot(f, st.agent.x + 33, st.agent.y - 24, on ? R.amber[2] : R.amber[1]);
        continue;
      }
      const c = consolePos(L, row, i);
      if (c) dot(f, c.x + consoleSprite(c.role).w - 4, c.y + 2, on ? R.amber[2] : R.amber[1]);
    }
  });
  if (!world.flows.length) {
    const len = L.pipe.slice(1).reduce((s, b, i) => s + Math.hypot(b.x - L.pipe[i].x, b.y - L.pipe[i].y), 0);
    const q = along(L.pipe, ((t * 22) % (len + 60)) - 30);
    if (q) dot(f, q.x, q.y, R.glass[3]);
  }
  {
    const len = L.uplink[0].y - L.uplink[1].y;
    const y = L.uplink[0].y - Math.round((t * 9) % Math.max(1, len));
    dot(f, Math.round(L.uplink[0].x), y, R.cyan[1]);
  }
  for (const row of L.rows) {
    const hue = laneColours(world.hues.get(row.id));
    const flashAt = world.chipFlash.get(row.id);
    if (flashAt !== undefined && t - flashAt < 1.5) {
      lightRect(f, row.chip.x, row.chip.y, row.chip.w, row.chip.h, 'red', 1);
      glow(f, row.chip.x + row.chip.w / 2, row.chip.y + 8, [6, 10], 'red', { levels: [1, 0] });
    }
    if (!activeRows.has(row.id)) continue;
    if (!calm) {
      const span = row.chip.y + 8 - L.bus.y0;
      const p = (t * 0.8) % 1.5;
      if (p < span / 60) {
        const y = L.bus.y0 + Math.round((p / (span / 60)) * span);
        dot(f, L.bus.x + 1, y, hue.top);
        dot(f, L.bus.x + 1, y - 1, hue.light);
        glow(f, L.bus.x + 1, y, [2, 3], hue.glow, { levels: [1, 0] });
      }
    }
    glow(f, row.chip.x + row.chip.w, row.chip.y + 8, [3, 5], hue.glow, { levels: [1, 0] });
  }
  // stations a lane has finished; station plates of rows that have their own stations
  for (const row of L.rows) {
    const info = world.rowInfo ? world.rowInfo.get(row.id) : null;
    const done = info ? Math.min(row.n, info.done) : 0;
    const hue = laneColours(world.hues.get(row.id));
    for (let i = 0; i < row.n; i += 1) {
      const busy = busyAt.has(`${row.id}:${i}`);
      if (i < done && !busy) drawPadDone(f, L, row, i);
      if (L.perRow) drawStationLabel(f, L, row, i, row.stations[i].tag, { state: busy ? 'busy' : i < done ? 'done' : 'idle', hue });
    }
  }
  for (const e of laneAgents) {
    if (e.walking || e.state === 'out') continue;
    const row = L.rowById.get(e.row);
    const hue = laneColours(world.hues.get(e.row));
    if (!e.atDesk) {
      const c = consolePos(L, row, e.station);
      if (c) blit(f, consoleSprite(c.role), c.x, c.y);
    }
    drawPadLit(f, L, row, e.station, hue);
    if (!calm) {
      const startX = stationGeometry(L, row, e.station).pad.x + 52;
      const endX = L.station.x1 - 2;
      for (const p of pulsesAt(e.kind, t, e.seed, (endX - startX) / 70)) drawLanePulse(f, Math.round(startX + p * (endX - startX)), row.face + 2, hue);
    }
  }
  // lanes, top to bottom so lower rows overlap upper ones; station lamps light what is under them
  for (const row of L.rows) {
    const here = laneAgents.filter((e) => e.row === row.id).sort((a, b) => a.x - b.x);
    for (const e of here) {
      if (e.state === 'out') continue;
      if (!e.atDesk && !e.walking) drawConsoleLights(f, L, row, e.station, t, calm, e.kind);
      drawAgent(f, e, t, calm);
    }
    for (const e of here) if (!e.walking && e.state !== 'out') drawLampLight(f, L, row, e.station, 'amber');
  }
  // the controller and the side agents on its dock
  const onStage = agents.filter((e) => e.state !== 'out');
  rd.readout = drawController(f, L, { rows: L.rows, hues: world.hues, agents: onStage.map((e) => ({ row: e.place === 'lane' ? e.row : null, station: e.place === 'lane' ? e.station : null, kind: e.kind, lane: e.lane, place: e.place })), lanes: world.lanes || [], project: world.project, batch: world.batchN, labels: world.project.labels, t, calm, events: t - world.beacon < 1 ? 1 : 0 });
  const docked = agents.filter((a) => a.place === 'dock' && a.state !== 'out').sort((a, b) => a.x - b.x);
  for (const e of docked) drawAgent(f, e, t, calm);
  drawDockTags(f, L, docked);
  // machine yard: cables live while the merge holds test pods, the rack, the vault, the remote
  const held = world.podsHeldByMerge && world.podsHeldByMerge.length > 0;
  if (held && !calm) for (const cable of L.cables) {
    const len = cable.slice(1).reduce((s, b, i) => s + Math.hypot(b.x - cable[i].x, b.y - cable[i].y), 0);
    const p = along(cable, (t * 50) % len);
    dot(f, p.x, p.y, R.cyan[4]);
    glow(f, p.x, p.y, [2, 4], 'cyan', { levels: [1, 0] });
  }
  drawPods(f, L, world.pods || [], world.hues, { t, calm, flash: world.podFlash, exclusive: world.scene ? world.scene.exclusive : null });
  drawVault(f, L, { lock: world.scene ? world.scene.lock : null, label: world.lockLabel, hues: world.hues, t, calm, intake: Math.max(0, 1 - (t - world.vaultIntake) / 1.2) });
  drawCloud(f, L, { flash: Math.max(0, 1 - (t - world.cloudFlash) / 1.2), t, calm });
  for (const fl of world.flows) drawPipeFlow(f, L.pipe, fl.d);
  for (const pk of world.packets) {
    const p = along(L.uplink, pk.d);
    drawPacket(f, p.x, p.y);
  }
  // parcels: on the column, in the chamber (seen through the glass), leaving it after a merge
  const scene = world.scene;
  const ms = mergeState({ batchRunning: Boolean(scene?.batchRunning), windowCount: scene ? scene.window.length : 0, sinceMerged: t - world.lastMerged, sinceBounced: t - world.lastBounced });
  const nowMs = world.nowMs + (t - world.nowAt) * 1000;
  const win = windowBox(L);
  for (const p of world.parcels.values()) {
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    const s = parcelSprite(world.hues.get(p.lane) || 'none');
    const inMachine = L.merge.flip ? x < L.merge.x + L.merge.w - 6 && x + 16 > L.merge.x : x + 16 > L.merge.x + 6;
    if ((p.mode === 'window' || p.mode === 'merging') && inMachine) {
      blit(f, s, x, y, { clip: win });
      continue;
    }
    shadeRect(f, x + 1, y + 12, 15, 1, 1);
    blit(f, s, x, y);
  }
  drawMergeDynamic(f, L, { state: ms, progress: batchProgress(world.batchStartedMs, nowMs), t, calm, count: scene ? scene.window.length : 0, gearAng: world.gearAng, needle: world.needle, ease: world.mergeEase });
  // the merger at the lever pedestal
  const mergers = agents.filter((a) => a.place === 'merge' && a.state !== 'out');
  let lever = 0;
  for (const e of mergers) {
    const P = rolePose(e.role, e.kind, t, e.seed, { walking: e.walking, calm });
    if (P.pose === 'lever') lever = ([0, 2, 5, 8, 5, 2][P.k % 6] || 0) / 8;
  }
  drawPedestal(f, L, lever);
  for (const e of mergers) drawAgent(f, e, t, calm);
  // agents arriving or leaving, bounced jobs flying home, puffs
  for (const b of world.beams) drawBeam(f, b, t);
  for (const pl of world.planes) {
    const q = planeAt(world, pl, opts.speed || 1);
    // a dotted trail along the arc behind it
    for (let k = 1; k <= 7; k += 1) {
      const back = planeAt(world, { ...pl, t0: pl.t0 + (k * 0.05) / (opts.speed || 1) }, opts.speed || 1);
      if (back.u > 0 && k % 2) rect(f, back.x + (q.dir < 0 ? 6 : -6), back.y, 2, 1, k < 4 ? R.red[3] : R.red[1]);
    }
    glow(f, q.x, q.y + 3, [4], 'red', { levels: [0], sy: 0.6 });
    drawPlane(f, q.x - 6, q.y, q.dir, Math.floor(t * 8));
  }
  for (const p of world.puffs) {
    const k = Math.floor(((t - p.t0) / 0.5) * 3);
    const c = p.colour === 'red' ? R.red[3] : R.steel[2];
    for (let a = 0; a < 8; a += 1) dot(f, p.x + Math.round(Math.cos(a * 0.785) * (3 + k * 2)), p.y + Math.round(Math.sin(a * 0.785) * (2 + k)), c);
  }
  const tags = [];
  if (opts.sample) tags.push('SAMPLE');
  if (opts.timelapse) tags.push('TIME-LAPSE');
  if (opts.offline) tags.push('OFFLINE');
  if (tags.length) drawTags(f, L, tags);
  if (opts.clock) drawClock(f, L, opts.clock);
  void PLANE_S;
  void blinkAt;
  void remap;
  return f;
}
