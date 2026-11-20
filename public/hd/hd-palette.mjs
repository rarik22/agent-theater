// Agent Theater HD · hd-palette.mjs
// The controlled palette of the high-fidelity stage: material ramps of 3 to 7 steps, dark to light, with
// hue shifting (shadows lean blue-violet, lights lean warm). The frame buffer holds palette indices only.
// Light LUTs map every colour to the palette colour it becomes under a coloured light (cyan screen glow,
// amber lamp, mint pass light ...), so glows are stepped and stay in the palette. Pure; browser and Node.

/** Material ramps, darkest first. Names are materials or signals, never screen roles. */
export const RAMPS = {
  void: ['#06060d', '#0a0b17', '#0e1021', '#13162c', '#191d38', '#212647', '#2b3159'],
  gun: ['#141520', '#1c1e2c', '#272a3c', '#34384e', '#454a64', '#5a6080'],
  steel: ['#6d7694', '#8892b0', '#a6b0c8', '#c7cfe0', '#eaeff6'],
  panel: ['#111a2f', '#172340', '#1e2c52', '#273a67', '#33497d'],
  glass: ['#05101c', '#09182a', '#0f263e', '#173856'],
  cyan: ['#0a2c3b', '#0d4858', '#107482', '#1ea8b2', '#5edcd8', '#c6fff4'],
  amber: ['#3a1b0e', '#6a3311', '#a65414', '#de871d', '#ffbd45', '#fff0b2'],
  violet: ['#1d1237', '#301c5a', '#482b85', '#6744b2', '#9277de', '#cbbbff'],
  mint: ['#0c3226', '#13583e', '#1e8f60', '#4ecf8d', '#b4fdd4'],
  red: ['#320c16', '#641525', '#a6233a', '#e3474c', '#ff998d'],
  blue: ['#12285c', '#1c4594', '#316ece', '#6ea4f3'],
  skin: ['#381c1b', '#7a3e32', '#b6684c', '#e19a73', '#f6caa2'],
  hair: ['#28101a', '#5c2119', '#9a3d1d', '#d6672b'],
  leather: ['#2a1913', '#543122', '#895533', '#c38c57'],
  dusk: ['#140e19', '#1e1420', '#2b1b26', '#3c242b', '#52302f'],
  tan: ['#2e1912', '#5e3324', '#8f5536', '#bd7e50', '#dca779'],
  deep: ['#1f100d', '#3d2119', '#62382a', '#8a5a40', '#ad7d5c'],
  ink: ['#0f0e18', '#211f31', '#36334e', '#545074'],
  blond: ['#3a2612', '#7a5524', '#c09a48', '#ead48a'],
};

const RAMP_NAMES = Object.keys(RAMPS);

/** Flat palette: [name, hex] in index order (ramp by ramp, dark to light). */
export const PALETTE = [];
/** R[ramp][step] = palette index. */
export const R = {};
for (const name of RAMP_NAMES) {
  R[name] = RAMPS[name].map((hex, i) => {
    PALETTE.push([`${name}${i}`, hex]);
    return PALETTE.length - 1;
  });
}
Object.freeze(PALETTE);

/** Index of ramp `name` at `step`, clamped to the ramp. */
export function ramp(name, step) {
  const r = R[name];
  if (!r) throw new Error(`unknown ramp ${name}`);
  return r[Math.max(0, Math.min(r.length - 1, Math.round(step)))];
}

/** Which ramp and step an index belongs to. */
export const RAMP_OF = PALETTE.map(([name]) => {
  const m = /^([a-z]+)(\d+)$/.exec(name);
  return { ramp: m[1], step: Number(m[2]) };
});

export const hexToRgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
export const RGB = PALETTE.map(([, hex]) => hexToRgb(hex));

/** Relative luminance (sRGB, 0..1). */
export function luminance([r, g, b]) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** OKLab of an sRGB triple, for perceptual nearest-colour search. */
export function oklab([r, g, b]) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const R0 = lin(r);
  const G0 = lin(g);
  const B0 = lin(b);
  const l = Math.cbrt(0.4122214708 * R0 + 0.5363325363 * G0 + 0.0514459929 * B0);
  const m = Math.cbrt(0.2119034982 * R0 + 0.6806995451 * G0 + 0.1073969566 * B0);
  const s = Math.cbrt(0.0883024619 * R0 + 0.2817188376 * G0 + 0.6299787005 * B0);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const LAB = RGB.map(oklab);

/** Nearest palette index to an sRGB triple (OKLab distance), optionally among `allowed` indices. */
export function nearest(rgb, allowed = null) {
  const q = oklab(rgb);
  let best = 0;
  let bd = Infinity;
  const list = allowed || LAB.map((_, i) => i);
  for (const i of list) {
    const p = LAB[i];
    const d = (p[0] - q[0]) ** 2 * 1.4 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

// ---------------------------------------------------------------- coloured light
// Hand-ruled lighting, the way a pixel artist relights a sprite: a light at level L moves a colour
// L+1 steps up its own ramp; dark neutral materials (void, gun, panel, glass) instead shift into the
// light's tint ramp at the matching brightness, so a cyan screen tints the wall teal and an amber lamp
// warms it through the dusk ramp, never jumping to an unrelated hue. A light never darkens.
export const LIGHT_TINT = {
  cyan: { void: 'glass', gun: 'glass', panel: 'glass', glass: 'cyan' },
  amber: { void: 'dusk', dusk: 'leather' },
  mint: { void: 'mint', gun: 'mint', panel: 'mint', glass: 'mint' },
  red: { void: 'red', gun: 'red', panel: 'red', glass: 'red' },
  violet: { void: 'violet', gun: 'violet', panel: 'violet', glass: 'violet' },
  white: {},
};
export const LIGHTS = Object.keys(LIGHT_TINT);
const LUM = RGB.map(luminance);

function litIndex(i, light, level) {
  const { ramp: own, step } = RAMP_OF[i];
  const r = R[own];
  const up = r[Math.min(r.length - 1, step + level + 1)];
  const target = up !== i ? LUM[up] : LUM[i] * 1.35 ** (level + 1) + 0.002;
  const tint = LIGHT_TINT[light][own];
  if (!tint) return up;
  // the tint colour closest in brightness to the target, if it is near enough (within x2.2)
  let best = -1;
  let bd = Infinity;
  for (const j of R[tint]) {
    if (LUM[j] + 1e-6 < LUM[i]) continue;
    const d = Math.abs(Math.log((LUM[j] + 1e-4) / (target + 1e-4)));
    if (d < bd) {
      bd = d;
      best = j;
    }
  }
  return best >= 0 && bd < Math.log(2.2) ? best : up;
}

/** LIGHT[name][level 0..2][index] = lit index. */
export const LIGHT = Object.fromEntries(LIGHTS.map((n) => [n, [0, 1, 2].map((lv) => RGB.map((_, i) => litIndex(i, n, lv)))]));

const TECH = new Set(['void', 'gun', 'steel', 'panel', 'glass', 'cyan', 'amber', 'violet', 'mint', 'red', 'blue', 'dusk']);

/** SHADE[level 0..2][index] = the colour in cast shadow (darker, bluer), staying in its own family. */
export const SHADE = [0.78, 0.6, 0.42].map((k) =>
  RGB.map((c, i) => {
    const tint = [c[0] * k * 0.92, c[1] * k * 0.95, c[2] * k * 1.05 + 4];
    const own = RAMP_OF[i].ramp;
    const allowed = TECH.has(own) ? PALETTE.map((_, j) => j).filter((j) => ['void', 'gun', 'panel', 'glass', own].includes(RAMP_OF[j].ramp)) : R[own];
    const n = nearest(tint, allowed);
    return luminance(RGB[n]) <= luminance(c) + 1e-6 ? n : i;
  }),
);

/** RGBA as one little-endian uint32 per index, for fast ImageData writes. */
export const RGBA32 = new Uint32Array(RGB.map(([r, g, b]) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0));

/** The eight lane hues of the old stage, mapped to HD ramps: [chip dark, chip mid, chip light, glow]. */
export const LANE_RAMPS = {
  ember: { ramp: 'amber', steps: [1, 2, 3], light: 'amber' },
  gold: { ramp: 'amber', steps: [2, 4, 5], light: 'amber' },
  moss: { ramp: 'mint', steps: [1, 2, 3], light: 'mint' },
  jade: { ramp: 'cyan', steps: [1, 3, 4], light: 'cyan' },
  sky: { ramp: 'blue', steps: [1, 2, 3], light: 'cyan' },
  lilac: { ramp: 'violet', steps: [2, 3, 4], light: 'violet' },
  rose: { ramp: 'red', steps: [1, 2, 3], light: 'red' },
  sand: { ramp: 'leather', steps: [1, 2, 3], light: 'amber' },
};

/** Lane colour set for a hue name: dark, mid and light indices plus the light used for its glows. */
export function laneColours(hue) {
  const l = LANE_RAMPS[hue] || { ramp: 'steel', steps: [0, 2, 4], light: 'white' };
  return { dark: ramp(l.ramp, l.steps[0]), mid: ramp(l.ramp, l.steps[1]), light: ramp(l.ramp, l.steps[2]), top: ramp(l.ramp, l.steps[2] + 1), ramp: l.ramp, glow: l.light };
}
