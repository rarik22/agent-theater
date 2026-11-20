// Agent Theater HD · hd-bubbles.mjs
// Comic speech bubbles: every agent on stage says, in one short line, what it is doing right now. The
// words come from the state (`say`: a generic phrase in public mode, the agent's own summary in the
// private view); this module only shapes them: a capital first letter, how long the action has run in
// public mode, a cut to the room the bubble has. Bubbles sit above the head (beside it on the dock,
// where the frame ends above), never cover each other in a row, and stay inside the frame. A new line
// is lettered in at a typing pace. Pure; runs in the browser and in Node.
import { dot, hline, rect, shadeRect, vline } from './hd-gfx.mjs';
import { R } from './hd-palette.mjs';
import { TINY_H, tinyFit, tinyText, tinyWidth } from './hd-tiny.mjs';

export const BUBBLE_H = TINY_H + 4;
const PAD = 2;
/** A bubble's height at a lettering scale (the phone build letters at 2x). */
export const bubbleH = (scale = 1) => TINY_H * scale + 4;
const GAP = 3;
const TYPE_CPS = 45;
// a character's head: the sprite anchor is its feet; the head's top is 46 px above them
const HEAD = 46;

/** How long something has run, short: 45s, 3m, 1h20m. */
export function shortDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? `${m % 60}m` : ''}`;
}

/**
 * The line a bubble says: the state's `say` with a capital first letter; in public mode (generic
 * phrases) the time the action has run is added once it passes a minute.
 */
export function bubbleLine({ say, publicMode = true, sinceMs = null, nowMs = null, background = false }) {
  let s = String(say ?? '').replace(/\s+/g, ' ').trim();
  // a background bubble is coloured as such; the words need not say it again
  if (background) s = s.replace(/\s*\(background\)$/i, '');
  if (!s) return '';
  const line = s[0].toUpperCase() + s.slice(1);
  if (publicMode && Number.isFinite(sinceMs) && Number.isFinite(nowMs) && nowMs - sinceMs >= 60_000) return `${line} · ${shortDuration(nowMs - sinceMs)}`;
  return line;
}

/** The bubble's look for an action kind: thinking floats, waiting is amber, background work cyan. */
export function bubbleStyle(kind, background = false) {
  if (kind === 'think') return 'think';
  if (kind === 'wait') return 'wait';
  if (background) return 'background';
  return 'say';
}

/**
 * Place the bubbles of the given speakers ({ id, x, y (feet), text, place }) in a frame of size W x H.
 * Returns [{ id, x, y, w, h, text, tail: { x, y, dir } }]. A bubble goes above the head; on the dock
 * (just under the controller) below the name plate, where the strip above the lanes is free; right of
 * the head when neither fits. In each band, left to right, a bubble starts at its speaker and ends
 * before the next speaker's bubble; text that does not fit is cut with "…". At 2x (the phone build)
 * the bubble sits on the head's top row, so it reaches less into the row above.
 */
export function layoutBubbles(speakers, W, H, { maxW = 104, minW = 22, scale = 1 } = {}) {
  const items = [];
  const bh = bubbleH(scale);
  const lift = scale > 1 ? 0 : 2;
  for (const s of speakers) {
    if (!s.text) continue;
    const hx = Math.round(s.x) + 1;
    const feet = Math.round(s.y);
    const top = feet - HEAD;
    const below = feet + (scale > 1 ? 12 : 10);
    const side = s.place === 'dock' && below + bh + 2 <= H ? 'below' : top - lift - bh >= 1 ? 'up' : 'left';
    const want = Math.min(maxW, tinyWidth(s.text, scale) + 2 * PAD + 2);
    items.push({
      id: s.id,
      hx,
      y: side === 'up' ? top - lift - bh : side === 'below' ? below : Math.max(1, top + 2),
      pref: side === 'left' ? hx + 13 : hx - 8,
      side,
      want,
      text: s.text,
      selected: Boolean(s.selected),
      style: s.style || 'say',
    });
  }
  // bands: bubbles at the same height in the same placement compete for room
  const bands = new Map();
  for (const it of items) {
    const key = `${it.side}:${Math.round(it.y / 4)}`;
    if (!bands.has(key)) bands.set(key, []);
    bands.get(key).push(it);
  }
  const out = [];
  for (const band of bands.values()) {
    band.sort((a, b) => a.pref - b.pref);
    let right = 0;
    band.forEach((it, i) => {
      const next = band[i + 1];
      const low = Math.max(1, right + GAP);
      const limit = Math.min(W - 1, next ? next.pref - GAP : W - 1);
      let x = Math.max(low, it.pref);
      // short of room on the right: start further left (over free space, never past the last bubble);
      // a bubble beside the head keeps clear of it
      if (limit - x < it.want && it.side !== 'left') x = Math.max(low, Math.min(x, limit - it.want));
      let w = Math.min(it.want, limit - x);
      // crowded all the same: keep a few letters, reaching a little under the next bubble
      if (w < minW) w = Math.min(minW, it.want, W - 1 - x);
      x = Math.min(x, W - 1 - w);
      right = x + w;
      const text = tinyFit(it.text, w - 2 * PAD - 2, scale);
      const tx = Math.max(x + 3, Math.min(x + w - 4, it.hx));
      const tail = it.side === 'up' ? { x: tx, y: it.y + bh, dir: 'down' } : it.side === 'below' ? { x: tx, y: it.y - 1, dir: 'up' } : { x, y: it.y + Math.floor(bh / 2), dir: 'left' };
      out.push({ id: it.id, x, y: it.y, w, h: bh, text, tail, selected: it.selected, style: it.style, scale });
    });
  }
  return out.filter((b) => b.y >= 0 && b.y + b.h <= H);
}

const LOOK = {
  say: { paper: R.steel[4], ink: R.void[1], edge: R.void[0] },
  think: { paper: R.steel[3], ink: R.gun[2], edge: R.steel[0] },
  wait: { paper: R.amber[5], ink: R.amber[0], edge: R.amber[1] },
  background: { paper: R.cyan[5], ink: R.cyan[0], edge: R.cyan[1] },
};

/**
 * Draw placed bubbles. `typed(id)` gives how many characters of a bubble are lettered in so far
 * (all of them when it returns Infinity).
 */
export function drawBubbles(f, boxes, { typed = () => Infinity, t = 0 } = {}) {
  for (const b of boxes) {
    const L = LOOK[b.style] || LOOK.say;
    const edge = b.selected ? R.amber[4] : L.edge;
    const { x, y, w, h } = b;
    shadeRect(f, x + 1, y + h, w - 1, 1, 1);
    shadeRect(f, x + w, y + 1, 1, h - 1, 1);
    rect(f, x + 1, y + 1, w - 2, h - 2, L.paper);
    if (b.style === 'think') {
      // a thought: a soft, dotted outline
      for (let i = 1; i < w - 1; i += 1) if (i % 2) dot(f, x + i, y, edge), dot(f, x + i, y + h - 1, edge);
      for (let j = 1; j < h - 1; j += 1) if (j % 2) dot(f, x, y + j, edge), dot(f, x + w - 1, y + j, edge);
    } else {
      hline(f, x + 1, y, w - 2, edge);
      hline(f, x + 1, y + h - 1, w - 2, edge);
      vline(f, x, y + 1, h - 2, edge);
      vline(f, x + w - 1, y + 1, h - 2, edge);
    }
    const tl = b.tail;
    if (tl.dir === 'down') {
      if (b.style === 'think') {
        dot(f, tl.x, tl.y + 1, edge);
      } else {
        hline(f, tl.x - 1, tl.y - 1, 3, L.paper);
        dot(f, tl.x - 1, tl.y, edge);
        dot(f, tl.x, tl.y, L.paper);
        dot(f, tl.x + 1, tl.y, edge);
        dot(f, tl.x, tl.y + 1, edge);
      }
    } else if (tl.dir === 'up') {
      hline(f, tl.x - 1, tl.y + 1, 3, L.paper);
      dot(f, tl.x - 1, tl.y, edge);
      dot(f, tl.x, tl.y, L.paper);
      dot(f, tl.x + 1, tl.y, edge);
      dot(f, tl.x, tl.y - 1, edge);
    } else {
      vline(f, tl.x, tl.y - 1, 3, L.paper);
      dot(f, tl.x - 1, tl.y - 1, edge);
      dot(f, tl.x - 1, tl.y, L.paper);
      dot(f, tl.x - 1, tl.y + 1, edge);
      dot(f, tl.x - 2, tl.y, edge);
    }
    if (b.selected) {
      // the agent whose log is open: a lit frame round its bubble
      hline(f, x, y - 1, w, R.amber[3]);
      hline(f, x, y + h, w, R.amber[3]);
    }
    const n = typed(b.id);
    const k = b.scale || 1;
    const shown = Number.isFinite(n) ? b.text.slice(0, Math.max(0, n)) : b.text;
    tinyText(f, shown, x + 1 + PAD, y + 2, L.ink, k);
    if (Number.isFinite(n) && n < b.text.length && Math.floor(t * 4) % 2 === 0) {
      // the lettering pen while it writes
      rect(f, x + 1 + PAD + tinyWidth(shown, k) + k, y + 2, k, TINY_H * k - k, L.ink);
    }
  }
}

/** How many characters of a line are lettered in `dt` seconds after it appeared. */
export const typedChars = (dt) => Math.floor(Math.max(0, dt) * TYPE_CPS);

/**
 * The agent at a point of the frame (logical px), for a click: a bubble first, then a character's
 * body (x - 16 .. x + 17, y - 47 .. y), the front-most (lowest on screen) one winning. Null for none.
 */
export function agentAt(px, py, agents, boxes = []) {
  for (let i = boxes.length - 1; i >= 0; i -= 1) {
    const b = boxes[i];
    if (px >= b.x - 1 && px <= b.x + b.w && py >= b.y - 1 && py <= b.y + b.h + 2) return b.id;
  }
  let best = null;
  for (const e of agents) {
    if (e.state === 'out') continue;
    const x = Math.round(e.x);
    const y = Math.round(e.y);
    if (px >= x - 16 && px <= x + 17 && py >= y - 47 && py <= y + 1 && (!best || y > best.y)) best = { id: e.id, y };
  }
  return best ? best.id : null;
}
