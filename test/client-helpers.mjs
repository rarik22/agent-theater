// Helpers for the stage tests: neutral states in schema v2, and a small OCR for the 5x7 font.
import { FONT } from '../public/hd/hd-font.mjs';

/** A neutral three-station workflow. */
export const NEUTRAL = [
  ['PLAN', 'setup'],
  ['BUILD', 'coder'],
  ['REVIEW', 'reviewer'],
];

/** A pipeline lane: id, stations as [tag, kind] pairs, and any extra fields. */
export function lane(id, stations, extra = {}) {
  return { id, tag: 'BUILD-SITE', stations: stations.map(([tag, kind]) => ({ tag, kind })), current: 0, done: 0, status: 'running', show: true, active: true, ...extra };
}

/** A minimal live state in schema v2. */
export function stateWith({ lanes = [], agents = [], queue = null, events = [], slots = [], project = null, yard = null, now = '2026-11-19T12:00:00.000Z' } = {}) {
  const s = {
    now,
    mode: 'live',
    sample: false,
    public: true,
    project: project || { name: null, done: null, total: null, features: null },
    pipeline: { stations: NEUTRAL.map(([tag, kind]) => ({ tag, kind })), lanes },
    agents,
    queue: queue || { entries: [], batch: null, lastBatch: null },
    slots,
    exclusive: null,
    lock: null,
    events,
    sources: {},
  };
  if (yard) s.yard = yard;
  return s;
}

/** Read 5x7 glyphs drawn in the ink colours inside a band of the frame, as words split at wide gaps. */
export function ocr(f, x0, x1, y0, y1, inks) {
  const ink = new Set(inks);
  const on = (x, y) => ink.has(f.px[y * f.w + x]);
  const words = [];
  let word = '';
  let gap = 0;
  for (let x = x0; x <= x1 - 5; ) {
    let hit = null;
    for (let y = y0; y <= y1 - 7 && hit === null; y += 1) {
      for (const [ch, rows] of Object.entries(FONT)) {
        if (ch === ' ') continue;
        let ok = true;
        for (let r = 0; r < 7 && ok; r += 1) for (let i = 0; i < 5 && ok; i += 1) if ((rows[r][i] === '1') !== on(x + i, y + r)) ok = false;
        // the columns either side of a glyph are clear in its rows
        for (let r = 0; r < 7 && ok; r += 1) if (on(x - 1, y + r) || on(x + 5, y + r)) ok = false;
        if (ok) {
          hit = ch;
          break;
        }
      }
    }
    if (hit !== null) {
      if (gap > 6 && word) {
        words.push(word);
        word = '';
      }
      word += hit;
      gap = 0;
      x += 6;
    } else {
      gap += 1;
      x += 1;
    }
  }
  if (word) words.push(word);
  return words;
}
