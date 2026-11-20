// Agent Theater HD · hd-layout.mjs
// Geometry of the HD stage for each export shape, drawn at an integer x2:
//   16:9  960x540  -> 1920x1080  the full composition: controller top left with the side-agent dock,
//         lane rows (each lane with its own 1 to 6 stations, from its workflow's phases), the queue column down the right of the lanes into the
//         MERGE machine, TEST pods above it, the DEVELOP vault to the right and REMOTE above the vault.
//   1:1   720x720  -> 1440x1440  and  4:5  720x900 -> 1440x1800: the same scene restacked for a feed
//         post. The lanes and the queue column keep their place; the machine yard (TEST, MERGE, DEVELOP,
//         REMOTE) sits under the lanes, so the merge machine is mirrored (intake on its right, outlet on
//         its left) and the pipe runs left into the vault. 1:1 shows up to 6 lane rows (rows with agents
//         first), 4:5 up to 8.
//   9:16  540x960  -> 1080x1920  the phone layout: narrower stations, up to 8 lane rows, and the yard
//         under the lanes in two columns: REMOTE over DEVELOP on the left, TEST over the mirrored MERGE
//         machine on the right, wired with vertical cables like the wide stage.
// Pure; every coordinate is a whole pixel.

export const SCALE = 2;
export const ASPECTS = Object.freeze({
  '16:9': { w: 960, h: 540 },
  '1:1': { w: 720, h: 720 },
  '4:5': { w: 720, h: 900 },
  '9:16': { w: 540, h: 960 },
});
export const MAX_ROWS_BY = { '16:9': 8, '1:1': 6, '4:5': 8, '9:16': 8 };
export const MAX_ROWS = 8;
export const W = 960;
export const H = 540;
import { DEFAULT_STATIONS, normalizeStations } from './hd-scene.mjs';

/** Nominal station count: the station area is five nominal stations wide; each row divides it by its own count. */
export const NOMINAL_STATIONS = 5;
export const MERGE_W = 156;
export const MERGE_H = 120;
export const PARCEL = { w: 16, h: 12 };

export const normAspect = (a) => (ASPECTS[a] ? a : ASPECTS[String(a || '').replace('x', ':')] ? String(a).replace('x', ':') : '16:9');

/** Output size in device pixels for an aspect. */
export function outputSize(aspect) {
  const a = ASPECTS[normAspect(aspect)];
  return { w: a.w * SCALE, h: a.h * SCALE };
}

/** The aspect that suits a window: wide windows get 16:9, phones held upright 9:16, tall ones 4:5, the rest 1:1. */
export function aspectForWindow(w, h) {
  const r = w / Math.max(1, h);
  if (r >= 1.4) return '16:9';
  if (r <= 0.7) return '9:16';
  if (r <= 0.9) return '4:5';
  return '1:1';
}

/**
 * How the canvas fills the screen, in device pixels (CSS pixels x devicePixelRatio): the largest whole
 * scale that fits, so every art pixel is a crisp block of device pixels. When even 1x does not fit
 * (a stage larger than the screen) it falls back to the largest fractional scale that fits, drawn
 * with nearest-neighbour sampling. The stage is centred; cssW/cssH are its size in CSS pixels.
 * When the whole scale leaves much of the screen empty (it uses less than `fill` of the width or the
 * height that a fractional scale would), the fractional scale is used too, so the stage uses the full
 * width on phones; `exact` says whether the scale is whole.
 */
export function fitScale(availCssW, availCssH, dpr, w, h, { fill = 0 } = {}) {
  const d = dpr > 0 ? dpr : 1;
  const devW = Math.max(1, Math.floor(availCssW * d));
  const devH = Math.max(1, Math.floor(availCssH * d));
  const best = Math.min(devW / w, devH / h);
  let scale = Math.floor(best);
  if (scale < 1 || (fill > 0 && scale / best < fill)) scale = best;
  const devCssW = Math.min(devW, Math.round(w * scale));
  const devCssH = Math.min(devH, Math.round(h * scale));
  return { scale, exact: Number.isInteger(scale), devW: devCssW, devH: devCssH, cssW: devCssW / d, cssH: devCssH / d };
}

/** Row height: rows share the lane area, 56 to 72 px each. */
export function rowHeight(n, top, bottom) {
  if (n <= 0) return 0;
  return Math.max(56, Math.min(72, Math.floor((bottom - top) / n)));
}

/**
 * Fixed geometry for an aspect (no rows yet). big: the phone build of the 16:9 stage (a phone held
 * sideways): big labels and the compact controller strip, with up to 7 lane rows.
 */
export function baseLayout(aspect = '16:9', { big = false } = {}) {
  const A = normAspect(aspect);
  const { w, h } = ASPECTS[A];
  const wide = A === '16:9';
  const narrow = A === '9:16';
  const bigWide = wide && Boolean(big);
  const L = { aspect: A, w, h, scale: SCALE, wide, narrow, big: narrow || bigWide, maxRows: bigWide ? 7 : MAX_ROWS_BY[A] };
  // ts: the scale of the scene's labels (headers, lane chips, yard names, clock and tags); the phone
  // builds draw them with the 5x7 font at twice its size so they stay legible on a phone screen
  L.ts = L.big ? 2 : 1;
  // the controller (hd-controller CTRL_GEOMS): the 236x46 unit with the dock beside it; on a phone held
  // upright the full-width strip with the dock under it; on a phone held sideways the compact strip
  // with the dock beside it
  L.ctrl = narrow ? { x: 6, y: 4, w: 528, h: 52, kind: 'strip' } : bigWide ? { x: 6, y: 4, w: 400, h: 52, kind: 'stripS' } : { x: 6, y: 4, w: 236, h: 46, kind: 'unit' };
  L.bus = { x: 14, y0: L.ctrl.y + L.ctrl.h };
  L.chip = L.big ? { x: 6, w: 42, h: 20 } : { x: 6, w: 38, h: 17 };
  L.station = { x: 50, w: wide ? 104 : narrow ? 88 : 120, n: NOMINAL_STATIONS };
  L.station.x1 = L.station.x + L.station.w * L.station.n;
  L.headerY = narrow ? 124 : bigWide ? 70 : 60;
  L.rowsTop = narrow ? 144 : bigWide ? 90 : 74;
  // side agents stand 48 px apart when there is room, so each one's tag plate fits under it
  L.dock = narrow ? { x: 30, x1: L.station.x1 - 8, y: 108, pitch: 48 } : { x: L.ctrl.x + L.ctrl.w + 18, x1: L.station.x1 - 8, y: L.ctrl.y + L.ctrl.h, pitch: 48 };
  L.queue = { x: L.station.x1 + 10, w: 26, y0: 66 };
  L.queue.x1 = L.queue.x + L.queue.w;
  if (wide) {
    L.rowsBottom = bigWide ? 512 : 524; // the phone build keeps its big corner tags clear of the last row
    L.merge = { x: 632, y: 392, w: MERGE_W, h: MERGE_H, flip: false };
    L.floorY = 508;
    L.yard = { x: L.station.x1 + 4, y: 0, w: w - L.station.x1 - 4, h };
    L.rack = { x: 640, y: 168, w: 148, h: 152 };
    L.vault = { x: 846, y: 246, w: 96, h: 96 };
    L.cloud = { x: 836, y: 52, w: 116, h: 66 };
    const oy = L.merge.y + 32;
    L.pipe = [{ x: L.merge.x + L.merge.w, y: oy }, { x: 818, y: oy }, { x: 818, y: L.vault.y + 70 }, { x: L.vault.x, y: L.vault.y + 70 }];
    L.merger = { x: L.merge.x + L.merge.w + 30, y: L.floorY + 3 };
    L.pedestal = { x: L.merge.x + L.merge.w + 6, y: L.floorY - 40 };
    L.labels = { test: { cx: L.rack.x + L.rack.w / 2, y: L.rack.y - (L.big ? 19 : 12) }, merge: { cx: L.merge.x + L.merge.w / 2, y: L.merge.y + L.merge.h + 6 }, develop: { cx: L.vault.x + L.vault.w / 2, y: L.vault.y + L.vault.h + 6 }, remote: { cx: L.cloud.x + L.cloud.w / 2, y: L.cloud.y - (L.big ? 20 : 13) } };
  } else if (narrow) {
    L.rowsBottom = h - 370;
    placeYard(L, L.rowsBottom);
  } else {
    const tall = A === '4:5';
    L.rowsBottom = L.rowsTop + 56 * L.maxRows;
    const yt = L.rowsBottom + 12; // top of the machine yard
    L.yard = { x: 0, y: yt, w, h: h - yt };
    L.floorY = tall ? 820 : h - 44;
    L.merge = { x: 488, y: L.floorY - MERGE_H + 4, w: MERGE_W, h: MERGE_H, flip: true };
    L.rack = { x: 286, y: L.floorY - 184, w: 148, h: 152 };
    L.vault = { x: 92, y: L.floorY - 104, w: 96, h: 96 };
    L.cloud = { x: 82, y: tall ? yt + 36 : yt + 22, w: 116, h: 66 };
    // the pipe drops from the outlet and runs left under the test rack into the vault's side
    const oy = L.merge.y + 32;
    const py = L.floorY - 20;
    L.pipe = [{ x: L.merge.x, y: oy }, { x: L.merge.x - 40, y: oy }, { x: L.merge.x - 40, y: py }, { x: L.vault.x + L.vault.w, y: py }];
    L.merger = { x: L.merge.x - 26, y: L.floorY + 3 };
    L.pedestal = { x: L.merge.x - 16, y: L.floorY - 40 };
    L.labels = { test: { cx: L.rack.x + L.rack.w / 2, y: L.rack.y - 12 }, merge: { cx: L.merge.x + L.merge.w / 2, y: L.merge.y + L.merge.h + 6 }, develop: { cx: L.vault.x + L.vault.w / 2, y: L.vault.y + L.vault.h + 6 }, remote: { cx: L.cloud.x + L.cloud.w / 2, y: L.cloud.y - 13 } };
  }
  L.tag = { x: 8, y: h - 12 };
  if (narrow) return L;
  // the queue column runs down to level with the merge intake, then the chute turns into the machine
  L.queue.y1 = L.merge.y + 78;
  L.chute = L.merge.flip
    ? { x: L.merge.x + L.merge.w - 6, y: L.queue.y1 - 20, w: L.queue.x1 - (L.merge.x + L.merge.w - 6), h: 20, dir: -1 }
    : { x: L.queue.x, y: L.queue.y1 - 20, w: L.merge.x + 6 - L.queue.x, h: 20, dir: 1 };
  L.uplink = [{ x: L.vault.x + L.vault.w / 2, y: L.vault.y }, { x: L.vault.x + L.vault.w / 2, y: L.cloud.y + L.cloud.h - 6 }];
  // cables from the merge machine to the test rack
  const mtop = { x: L.merge.x + L.merge.w / 2, y: L.merge.y + 16 };
  L.cables = wide
    ? [[{ x: mtop.x - 10, y: mtop.y }, { x: mtop.x - 10, y: L.rack.y + L.rack.h }], [{ x: mtop.x + 10, y: mtop.y }, { x: mtop.x + 10, y: L.rack.y + L.rack.h }]]
    : [[{ x: L.merge.x + 30, y: L.merge.y + 10 }, { x: L.merge.x + 10, y: L.merge.y - 6 }, { x: L.rack.x + L.rack.w, y: L.merge.y - 6 }], [{ x: L.merge.x + 40, y: L.merge.y + 10 }, { x: L.merge.x + 18, y: L.merge.y - 12 }, { x: L.rack.x + L.rack.w, y: L.merge.y - 12 }]];
  L.tag = { x: 8, y: h - 12 };
  return L;
}

/**
 * Stacked shapes: put the machine yard (remote over develop, the test rack, the mirrored merge machine)
 * under the last lane row, so there is no dead band between the lanes and the machines.
 */
function placeYard(L, lanesBottom) {
  if (L.narrow) return placeYardNarrow(L, lanesBottom);
  const tall = L.aspect === '4:5';
  const yt = lanesBottom + 12;
  L.yard = { x: 0, y: yt, w: L.w, h: L.h - yt };
  L.floorY = Math.min(L.h - 44, yt + (tall ? 272 : 254));
  L.merge = { x: 488, y: L.floorY - MERGE_H + 4, w: MERGE_W, h: MERGE_H, flip: true };
  L.rack = { x: 286, y: L.floorY - 184, w: 148, h: 152 };
  L.vault = { x: 92, y: L.floorY - 104, w: 96, h: 96 };
  L.cloud = { x: 82, y: Math.max(yt + 22, L.vault.y - 120), w: 116, h: 66 };
  const oy = L.merge.y + 32;
  const py = L.floorY - 20;
  L.pipe = [{ x: L.merge.x, y: oy }, { x: L.merge.x - 40, y: oy }, { x: L.merge.x - 40, y: py }, { x: L.vault.x + L.vault.w, y: py }];
  L.merger = { x: L.merge.x - 26, y: L.floorY + 3 };
  L.pedestal = { x: L.merge.x - 16, y: L.floorY - 40 };
  L.labels = { test: { cx: L.rack.x + L.rack.w / 2, y: L.rack.y - 12 }, merge: { cx: L.merge.x + L.merge.w / 2, y: L.merge.y + L.merge.h + 6 }, develop: { cx: L.vault.x + L.vault.w / 2, y: L.vault.y + L.vault.h + 6 }, remote: { cx: L.cloud.x + L.cloud.w / 2, y: L.cloud.y - 13 } };
  L.queue.y1 = L.merge.y + 78;
  L.chute = { x: L.merge.x + L.merge.w - 6, y: L.queue.y1 - 20, w: L.queue.x1 - (L.merge.x + L.merge.w - 6), h: 20, dir: -1 };
  L.uplink = [{ x: L.vault.x + L.vault.w / 2, y: L.vault.y }, { x: L.vault.x + L.vault.w / 2, y: L.cloud.y + L.cloud.h - 6 }];
  L.cables = [[{ x: L.merge.x + 30, y: L.merge.y + 10 }, { x: L.merge.x + 10, y: L.merge.y - 6 }, { x: L.rack.x + L.rack.w, y: L.merge.y - 6 }], [{ x: L.merge.x + 40, y: L.merge.y + 10 }, { x: L.merge.x + 18, y: L.merge.y - 12 }, { x: L.rack.x + L.rack.w, y: L.merge.y - 12 }]];
}

/**
 * The phone yard (9:16): two columns under the lanes. Right: the TEST rack over the mirrored MERGE
 * machine (the queue column runs down beside them into its intake), wired with vertical cables.
 * Left: REMOTE over the DEVELOP vault, joined by the uplink; the pipe leaves the machine's outlet,
 * drops behind the merger and runs left into the vault.
 */
function placeYardNarrow(L, lanesBottom) {
  const yt = lanesBottom + 12;
  L.yard = { x: 0, y: yt, w: L.w, h: L.h - yt };
  L.floorY = Math.min(L.h - 42, yt + 320);
  const mx = L.queue.x - 172;
  L.merge = { x: mx, y: L.floorY - MERGE_H + 4, w: MERGE_W, h: MERGE_H, flip: true };
  L.rack = { x: mx + 4, y: Math.max(yt + 18, L.merge.y - 34 - 152), w: 148, h: 152 };
  L.vault = { x: Math.max(12, mx - 268), y: L.floorY - 104, w: 96, h: 96 };
  L.cloud = { x: L.vault.x - 10, y: Math.max(yt + 18, L.rack.y), w: 116, h: 66 };
  const oy = L.merge.y + 32;
  const py = L.floorY - 20;
  L.pipe = [{ x: L.merge.x, y: oy }, { x: L.merge.x - 40, y: oy }, { x: L.merge.x - 40, y: py }, { x: L.vault.x + L.vault.w, y: py }];
  L.merger = { x: L.merge.x - 26, y: L.floorY + 3 };
  L.pedestal = { x: L.merge.x - 16, y: L.floorY - 40 };
  L.labels = { test: { cx: L.rack.x + L.rack.w / 2, y: L.rack.y - 19 }, merge: { cx: L.merge.x + L.merge.w / 2, y: L.merge.y + L.merge.h + 6 }, develop: { cx: L.vault.x + L.vault.w / 2, y: L.vault.y + L.vault.h + 6 }, remote: { cx: L.cloud.x + L.cloud.w / 2, y: L.cloud.y - 20 } };
  L.queue.y1 = L.merge.y + 78;
  L.chute = { x: L.merge.x + L.merge.w - 6, y: L.queue.y1 - 20, w: L.queue.x1 - (L.merge.x + L.merge.w - 6), h: 20, dir: -1 };
  L.uplink = [{ x: L.vault.x + L.vault.w / 2, y: L.vault.y }, { x: L.vault.x + L.vault.w / 2, y: L.cloud.y + L.cloud.h - 6 }];
  const mtop = { x: L.merge.x + L.merge.w / 2, y: L.merge.y + 16 };
  L.cables = [[{ x: mtop.x - 10, y: mtop.y }, { x: mtop.x - 10, y: L.rack.y + L.rack.h }], [{ x: mtop.x + 10, y: mtop.y }, { x: mtop.x + 10, y: L.rack.y + L.rack.h }]];
}

/** Geometry of one lane row (its stations are added by computeLayout). */
export function rowGeometry(L, y, h) {
  const deck = y + h - 20; // top of the walkway
  return { y, h, deck, face: deck + 9, feet: deck + 6, chip: { x: L.chip.x, y: deck - 2, w: L.chip.w, h: L.chip.h } };
}

/**
 * How far a station's content (pad, agent, console, lamp) moves from where it sits in a 104 px station:
 * centred in wider stations; in narrower ones pulled left just enough that the widest console (it ends
 * 98 px into the station) stays inside the lane, clear of the queue column.
 */
export function stationShift(sw) {
  if (sw > 104) return Math.round((sw - 104) / 2);
  return Math.min(0, sw - 96);
}

/** A row's stations: count, width and shift (the station area divided by the row's own station count). */
export function rowStations(L, stations) {
  const list = normalizeStations(stations);
  const span = L.station.x1 - L.station.x;
  const sw = Math.floor(span / list.length);
  return { stations: list, n: list.length, sw, shift: stationShift(sw) };
}

/** Station i of a row: its column, pad, lamp, label centre and agent anchor (feet centre). */
export function stationGeometry(L, row, i) {
  const sw = row.sw || L.station.w;
  const sh = row.shift ?? 0;
  const x = L.station.x + i * sw;
  return {
    i,
    x,
    w: sw,
    shift: sh,
    pad: { x: x + 18 + sh, y: row.deck + 2, w: 52, h: 5 },
    agent: { x: x + 44 + sh, y: row.feet },
    lamp: x + 66 + sh,
    cx: x + Math.min(52, Math.floor(sw / 2)) + Math.max(0, sh),
    kind: row.stations ? row.stations[Math.min(i, row.stations.length - 1)].kind : DEFAULT_STATIONS[Math.min(i, DEFAULT_STATIONS.length - 1)].kind,
  };
}

const stationKey = (stations) => stations.map((s) => `${s.tag}/${s.kind}`).join('|');

/**
 * Full layout for an aspect and a list of rows: lane objects { id, stations } (or bare ids, which get
 * the default stations); big: the phone build (see baseLayout); stations: the pipeline's default
 * stations, used for the header when there are no rows. When every row has the same stations their
 * tags go in the header over the rows; otherwise each row carries its own labels (L.perRow).
 */
export function computeLayout(rows = [], aspect = '16:9', { big = false, stations = DEFAULT_STATIONS } = {}) {
  const L = baseLayout(aspect, { big });
  const list = rows.slice(0, L.maxRows).map((r) => (typeof r === 'string' ? { id: r, stations: DEFAULT_STATIONS } : r));
  const h = rowHeight(list.length, L.rowsTop, L.rowsBottom);
  L.rows = list.map((r, i) => ({ id: r.id, ...rowGeometry(L, L.rowsTop + i * h, h), ...rowStations(L, r.stations) }));
  if (!L.wide) placeYard(L, list.length ? L.rowsTop + list.length * h : L.rowsTop + 120);
  L.rowById = new Map(L.rows.map((r) => [r.id, r]));
  const keys = new Set(L.rows.map((r) => stationKey(r.stations)));
  L.perRow = keys.size > 1;
  const headRow = L.rows[0] || { ...rowStations(L, stations), deck: 0, feet: 0 };
  L.header = L.perRow ? [] : headRow.stations.map((s, i) => ({ label: s.tag, cx: stationGeometry(L, headRow, i).cx, y: L.headerY }));
  L.headerSplits = L.perRow ? [] : headRow.stations.slice(1).map((_, i) => L.station.x + (i + 1) * headRow.sw - 2);
  return L;
}

/** Top-left of queue slot k (0 = lowest, next into the merge). Slots stack up the column. */
export function queueSlot(L, k, count) {
  const bottom = L.chute.y - PARCEL.h - 2;
  const top = L.queue.y0 + 8;
  const span = bottom - top;
  const pitch = count > 1 ? Math.max(4, Math.min(PARCEL.h + 3, Math.floor(span / (count - 1)))) : PARCEL.h + 3;
  return { x: L.queue.x + 5, y: Math.max(top, bottom - k * pitch) };
}

/** Local x of the machine (0..MERGE_W) to a scene x, honouring the mirror. */
export const mergeX = (L, lx, w = 1) => (L.merge.flip ? L.merge.x + L.merge.w - lx - w : L.merge.x + lx);

/** Top-left of merge-window slot j (2x2 grid inside the machine's inspection window). */
export function windowSlot(L, j) {
  const c = j % 2;
  const r = Math.floor(j / 2) % 2;
  return { x: mergeX(L, 60 + c * 19, PARCEL.w), y: L.merge.y + 50 + r * 15 };
}

/** The inspection window (glass) as a scene box. */
export function windowBox(L) {
  return { x: mergeX(L, 54, 48), y: L.merge.y + 44, w: 48, h: 36 };
}

/** Where a lane hands a parcel to the queue: the end of its track, level with the walkway. */
export function laneExit(L, row) {
  return { x: L.station.x1 - 14, y: row.deck - 6 };
}

/** Parcel path points (top-left corners, whole pixels). */
export function parcelPaths(L) {
  const qx = L.queue.x + 5;
  const bend = { x: qx, y: L.chute.y + 4 };
  const intake = { x: L.merge.flip ? L.merge.x + L.merge.w - 20 : L.merge.x + 4, y: L.chute.y + 4 };
  const win = windowBox(L);
  const exitX = L.merge.flip ? win.x - PARCEL.w - 2 : win.x + win.w + 2;
  return { qx, bend, intake, exitX };
}

/** Slot of the i-th of n side agents on the dock next to the controller. */
export function dockSlot(L, i, n) {
  const room = L.dock.x1 - L.dock.x - 20;
  const pitch = n > 1 ? Math.max(14, Math.min(L.dock.pitch, Math.floor(room / (n - 1)))) : L.dock.pitch;
  return { x: L.dock.x + 16 + i * pitch, y: L.dock.y };
}

/** Test pod n (0..3) inside the rack: 2x2 capsules. */
export function podBox(L, n) {
  const c = n % 2;
  const r = Math.floor(n / 2);
  return { x: L.rack.x + 8 + c * 70, y: L.rack.y + 10 + r * 72, w: 62, h: 66 };
}

/** Points along a polyline at distance d (for pulses and packets). */
export function along(points, d) {
  let left = d;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= len) return { x: Math.round(a.x + ((b.x - a.x) * left) / (len || 1)), y: Math.round(a.y + ((b.y - a.y) * left) / (len || 1)) };
    left -= len;
  }
  const z = points[points.length - 1];
  return { x: Math.round(z.x), y: Math.round(z.y) };
}

export const pathLength = (points) => points.slice(1).reduce((s, b, i) => s + Math.hypot(b.x - points[i].x, b.y - points[i].y), 0);

export const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
