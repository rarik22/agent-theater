// Agent Theater HD · hd-chars.mjs
// The character kit. Every agent is assembled from hand-authored and shaded parts:
//   - head: a hand-drawn 20x20 face (eyes with white, catchlight and iris, brows, nose light, blush,
//     mouth, ear), a hand-drawn hair style and a hand-drawn headwear piece, recoloured per look;
//   - body: an outfit torso (material mask + painted details, shaded by the pass), trousers and boots,
//     and arms and legs posed by a small two-bone skeleton (shoulder-elbow-wrist, hip-knee-ankle),
//     drawn as shaded fabric capsules, so every pose and every walk frame is consistent;
//   - hands (skin or gloves) and role props (wrench, stylus, clipboard, tablet, tape, lever grip).
// Roles have a fixed identity (outfit, headwear, prop, colour); skin, hair and coder outfits vary by a
// stable hash of the agent id. Frames are built once and cached. Pure.
import { createSprite, mapToSprite, stamp } from './hd-gfx.mjs';
import { R } from './hd-palette.mjs';
import { createMask, maskFromRows, mget, mrect, mset, shadeMask } from './hd-shade.mjs';

export const CW = 34;
export const CH = 47;
/** The point between the feet (ground contact) in sprite coordinates. */
export const CANCHOR = { x: 16, y: 46 };
const HEAD_AT = { x: 6, y: 1 };
const TORSO_AT = { x: 6, y: 19 };
const SHOULDER = { near: { x: 10, y: 22 }, far: { x: 24, y: 22 } };
const HIP = { near: { x: 13, y: 34 }, far: { x: 19, y: 34 } };
const ARM = [6.5, 6.5];
const LEG = [6, 6.2];

// ---------------------------------------------------------------- looks
export const SKINS = ['skin', 'tan', 'deep'];
export const HAIRS = ['hair', 'ink', 'blond', 'steel'];
const IRIS = [['blue', 1, 2], ['mint', 1, 2], ['leather', 1, 3], ['cyan', 1, 3]];

// ---------------------------------------------------------------- face (20 x 20, three-quarters right)
// K..L skin ramp, B brow (hair ramp), e lash/pupil, W eye white, w catchlight, u/U iris, q blush, m lip.
export const FACE = [
  '........KKKK........',
  '.....KKKSSSSKKK.....',
  '....KSSSSSSSSSSK....',
  '...KSSSSSSSSSSSSK...',
  '..KSSSSSSSSSSSSSSK..',
  '..KSSSSSSSSSSSSSSSK.',
  '.KSSSSSSSSSSSSSSSSK.',
  '.KSSSSSSSSSSSSSSSSSK',
  '.KSSSSSSSSSSSSSSSSSK',
  '.KsSSSSSSSSSSSSSSSSK',
  '.KsSSSSSSSBBBSSSBBSK',
  '.KsSksSSSSeeeSSSeeSK',
  '.KsSLkSSSSWwUSSSwULK',
  '.KssSkSSSSsueSSSueSK',
  '.KsSssSSSSSSSSSSSLSK',
  '..KsSSSSSSSqSSSSSkK.',
  '..KssSSSSSSSSSkmkK..',
  '...KssSSSSSSSSSsK...',
  '....KKssSSSSSSKK....',
  '......KKKKKKKK......',
];
// Eye variants (rows 11-13; near eye columns 10-12, far eye 16-17).
const EYES = {
  open: null,
  half: [['SSS', 'SS'], ['eee', 'ee'], ['Wue', 'ue']],
  shut: [['SSS', 'SS'], ['kee', 'ee'], ['SSS', 'SS']],
  up: [['eee', 'ee'], ['WUw', 'Uw'], ['sSS', 'SS']],
  side: [['eee', 'ee'], ['wUW', 'wU'], ['ueS', 'ue']],
  down: [['SSS', 'SS'], ['eee', 'ee'], ['Wue', 'ue']],
};

// ---------------------------------------------------------------- hair styles (O a b c y on the hair ramp)
export const HAIR_STYLES = {
  spiky: [
    '.........O...OO.....',
    '.......OObO.ObbO....',
    '.....OObbbbOObcbO...',
    '....ObbbcccbbabcbO..',
    '...ObbccyccbbbabbbO.',
    '..ObcccbbbbcbbabbbbO',
    '..ObbcbbaabbcbbbabbO',
    '.ObabbbbbaabcbbbabbO',
    '.ObaabbaabbbabbbaabO',
    '.Oaaabaaba.bab.baab.',
    '.Oaaaa...a...a....a.',
    '.Oaa................',
    '.Oaa................',
    '.Oaa................',
    '.Oa.................',
    '..O.................',
  ],
  bob: [
    '.......OOOOOO.......',
    '.....OObbbbbbOO.....',
    '....ObbbccccbbbO....',
    '...ObbccyycccbbbO...',
    '..ObbcccccccbbbbbO..',
    '..ObbbcbbbbbbbbbbbO.',
    '.ObbbbbbbbbbbbbbbbO.',
    '.ObabbbbbbbbbbbbbbbO',
    '.ObaabbbbabbbbabbbbO',
    '.ObaaabbaabbaabbaabO',
    '.Obaaa..............',
    '.Obaaa..............',
    '.Obaaa..............',
    '.Obaaa..............',
    '.Obaaa..............',
    '.Obaaa..............',
    '.OObaa..............',
    '..OOaO..............',
  ],
  crop: [
    '........OOOO........',
    '.....OOObbbbOOO.....',
    '....ObbbbccbbbbO....',
    '...ObbbccyccbbbbO...',
    '..ObbbcccccbbbbbbO..',
    '..ObbbbbbbbbbbbbbbO.',
    '.ObabbbbbbbbbbbbbbO.',
    '.ObaabbbbbbabbbbbbbO',
    '.OaaabbaabbaabbbaabO',
    '.Oaaa...............',
    '.Oaa................',
    '.Oa.................',
    '.Oa.................',
    '..O.................',
  ],
  curly: [
    '......OO..OO.OO.....',
    '....OObbOObbObbO....',
    '...ObbcbbbcbbbcbO...',
    '..ObcyybbcyybbcbbO..',
    '.ObbccbbbccbbbbcbbO.',
    '.ObbbbabbbbabbbbbbbO',
    'ObcbbbbbcbbbbbcbbbbO',
    'ObbabbcbbbabbcbbabbO',
    'ObaabbbaabbbaabbbabO',
    'Obaaba.a.abaa.ab.aO.',
    'Obaab.........a.....',
    'Obaab...............',
    'Obaab...............',
    '.Oaab...............',
    '.OaaO...............',
    '..OO................',
  ],
  pony: [
    '........OOOOO.......',
    '......OObbbbbOO.....',
    '.....ObbbcccbbbO....',
    '....ObbccyycccbbO...',
    '...ObbbcccccbbbbbO..',
    '..ObbbbbbbbbbbbbbbO.',
    '.OObbbbabbbbbbbbbbO.',
    'ObbObabbbbbbbbbbbbbO',
    'ObbOaabbbbabbbbbbbbO',
    'ObbOaaaba...........',
    'ObbaOaa.............',
    'ObbaOa..............',
    'Obba.O..............',
    'Obba................',
    'Obba................',
    '.Oba................',
    '.Oba................',
    '..OO................',
  ],
  buzz: [
    '........OOOO........',
    '.....OOOaaaaOOO.....',
    '....OaaabaaabaaO....',
    '...OababaaabaaaaO...',
    '..OaaaaabaaaabaaaO..',
    '..OabaaaaababaaaaaO.',
    '.OaaaababaaaaabaaaO.',
    '.OabaaaaaaabaaaaaaaO',
    '.Oaaab..............',
    '.Oaa................',
    '.Oa.................',
    '..O.................',
  ],
};
const HAIR_KEYS = Object.keys(HAIR_STYLES);

// ---------------------------------------------------------------- headwear (own legends)
// d dark outline, a b c light ramp steps, Y glint, g/G/j metal, x/X LED, w white
export const HEADWEAR = {
  phones: {
    rows: [
      '.....gggg...........',
      '...ggjJjjg..........',
      '..gjjgg.............',
      '..gjg...............',
      '.gjg................',
      '.gjg................',
      '.gjg................',
      '.gjg................',
      '.gjg................',
      'ggjjhg..............',
      'gjJjjhg.............',
      'gjxxjhg.............',
      'gjxXjhg.............',
      'gjjjjhg.............',
      'ghhhhqg.............',
      '.ggggg..............',
    ],
    legend: (c) => ({ g: R.gun[0], h: R.gun[2], j: R.gun[4], J: R.steel[2], q: R.gun[3], x: R[c][4], X: R[c][2] }),
  },
  defenders: {
    rows: [
      '.....ggggg..........',
      '...ggjJJjjg.........',
      '..gjjgg.............',
      '..gjg...............',
      '.gjg................',
      '.gjg................',
      '.gjg................',
      '.ddddd..............',
      'dbbcccd.............',
      'dbccYcd.............',
      'dbcccbd.............',
      'dbbcbbd.............',
      'dbbbbbd.............',
      'dabbbad.............',
      'daaaaad.............',
      '.ddddd..............',
    ],
    legend: () => ({ g: R.gun[0], j: R.gun[3], J: R.steel[1], d: R.amber[0], a: R.amber[1], b: R.amber[2], c: R.amber[3], Y: R.amber[5] }),
  },
  hardhat: {
    rows: [
      '.......adddda.........',
      '.....adbbccccda.......',
      '....dbbcccYYcccd......',
      '...dbbccccYcccccd.....',
      '..dbbbccccccccccbd....',
      '..dbbbbcccccccccbbd...',
      '.dbbbbbbbbcccccbbbbd..',
      '.daabbbbbbbbbbbbbbbd..',
      'ddaaaaaaaaaaaaaaaaaaddd',
      '.ddddddddddddddddddddd.',
    ],
    legend: () => ({ d: R.amber[0], a: R.amber[2], b: R.amber[3], c: R.amber[4], Y: R.amber[5] }),
  },
  cap: {
    rows: [
      '......................',
      '......................',
      '.......adddda.........',
      '.....adbbccccda.......',
      '....dbbccccccccd......',
      '...dbbbcccccwcccd.....',
      '..dbbbbbccccccccbd....',
      '..dbbbbbbbbbbbbbbbddddd',
      '..ddaaaaaaaaaaaaaaaaaad',
      '.....................dd',
    ],
    legend: (c) => ({ d: R[c][0], a: R[c][1], b: R[c][2], c: R[c][3], w: R.steel[4] }),
  },
  beanie: {
    rows: [
      '........addd........',
      '.....addbbbbdda.....',
      '....dbbbbccbbbbd....',
      '...dbcbcbcbcbcbbd...',
      '..dbbcbcbcbcbcbbbd..',
      '..dbcbcbcbcbcbcbbbd.',
      '.dbbcbcbcbcbcbcbbbd.',
      '.daaaaaaaaaaaaaaaaad',
      '.dawawawawawawawawad',
      '.ddddddddddddddddddd',
    ],
    legend: (c) => ({ d: R[c][0], a: R[c][1], b: R[c][2], c: R[c][3], w: R[c][4] }),
  },
  bandana: {
    rows: [
      '......................',
      '......................',
      '......................',
      '......................',
      '......................',
      '.....dddddddd.........',
      '..dddbbwbbbbwbdd......',
      'ddbbbbbbbwbbbbbbdd....',
      'dbdbwbbbbbbbbwbbbbd...',
      'dbdaaaaaaaaaaaaaaaad..',
      '.d.dddddddddddddddd...',
    ],
    legend: () => ({ d: R.red[0], a: R.red[1], b: R.red[2], w: R.red[4] }),
  },
  goggles: {
    rows: [
      '......................',
      '......................',
      '......................',
      '......................',
      '......................',
      '......................',
      '.ggggggggggggggggggg..',
      'gjjjjjjgGGGGGgGGGGgg..',
      'ggggggggGxXXGgGxXGg...',
      '........gGGGGgGGGg....',
      '.........ggggggggg....',
    ],
    legend: () => ({ g: R.gun[0], j: R.gun[2], G: R.steel[2], x: R.cyan[4], X: R.cyan[2] }),
  },
  glasses: {
    rows: [
      '', '', '', '', '', '', '', '', '', '', '',
      '.........hgggh.ghgh.',
      '.........g...gg...g.',
      '.........g...g.g..g.',
      '..........ggg...gg..',
    ],
    legend: () => ({ g: R.steel[1], h: R.steel[3] }),
  },
};

// ---------------------------------------------------------------- outfits
// Torso silhouette (22 x 15): x ranges per row.
const TORSO_ROWS = [[7, 13], [5, 15], [3, 18], [2, 19], [1, 20], [1, 20], [0, 21], [0, 21], [0, 21], [1, 20], [1, 20], [1, 20], [2, 19], [2, 19], [2, 19]];

function torsoBase() {
  const k = createMask(22, 15);
  TORSO_ROWS.forEach(([a, b], y) => mrect(k, a, y, b - a + 1, 1, 'h'));
  return k;
}

/** Torso masks per outfit. Letters: h main, c collar/hood, b hem/rib, z placket, w shirt or trim, e mark, s strap, p pocket, r reflective. */
const OUTFITS = {
  hoodie(k) {
    for (let y = 0; y < 4; y += 1) for (let x = 0; x < 22; x += 1) if (mget(k, x, y) && Math.abs(x - 10.5) < 7 - y) mset(k, x, y, 'c');
    for (let y = 4; y < 13; y += 1) mset(k, 11, y, 'z');
    for (const [x, y] of [[10, 4], [10, 5], [10, 6], [13, 4], [13, 5], [13, 6]]) mset(k, x, y, 'n');
    mrect(k, 2, 13, 18, 2, 'b');
    for (const [x, y] of [[15, 7], [18, 7], [19, 7], [14, 8], [17, 8], [20, 8], [15, 9], [16, 9], [19, 9]]) mset(k, x, y, 'e');
  },
  jacket(k) {
    // open collar, shirt V, placket, chest pocket, hem
    for (let y = 0; y < 2; y += 1) for (let x = 0; x < 22; x += 1) if (mget(k, x, y)) mset(k, x, y, 'c');
    for (let y = 0; y < 7; y += 1) for (let x = 11 - (6 - y >> 1); x <= 11 + (6 - y >> 1); x += 1) if (mget(k, x, y)) mset(k, x, y, 'w');
    for (const [x, y] of [[7, 1], [8, 2], [9, 3], [15, 1], [14, 2], [13, 3]]) mset(k, x, y, 'c');
    for (let y = 7; y < 15; y += 1) mset(k, 11, y, 'z');
    mrect(k, 14, 7, 4, 3, 'p');
    mrect(k, 2, 14, 18, 1, 'b');
  },
  vest(k) {
    OUTFITS.jacket(k);
    // reflective bands across the vest
    for (const y of [8, 11]) for (let x = 0; x < 22; x += 1) if (mget(k, x, y) && mget(k, x, y) !== 'z') mset(k, x, y, 'r');
    mrect(k, 2, 13, 18, 2, 's'); // tool belt
    mrect(k, 4, 13, 3, 2, 'p');
    mrect(k, 15, 13, 3, 2, 'p');
  },
  overalls(k) {
    // shirt top (w), bib (h) with straps (s) and a pocket (p)
    for (let y = 0; y < 15; y += 1) for (let x = 0; x < 22; x += 1) if (mget(k, x, y)) mset(k, x, y, y < 5 || x < 5 || x > 17 ? 'w' : 'h');
    for (let y = 0; y < 6; y += 1) {
      mset(k, 6 + (y > 3 ? 1 : 0), y, 's');
      mset(k, 15 - (y > 3 ? 1 : 0), y, 's');
    }
    mrect(k, 9, 6, 5, 3, 'p');
    for (let y = 12; y < 15; y += 1) for (let x = 0; x < 22; x += 1) if (mget(k, x, y)) mset(k, x, y, 'h');
  },
  apron(k) {
    OUTFITS.jacket(k);
    for (let y = 3; y < 15; y += 1) for (let x = 5; x < 17; x += 1) if (mget(k, x, y) && Math.abs(x - 11) < 3 + y) mset(k, x, y, 'a');
    mset(k, 6, 1, 's');
    mset(k, 6, 2, 's');
    mset(k, 16, 1, 's');
    mset(k, 16, 2, 's');
    mrect(k, 9, 9, 5, 3, 'p');
  },
  coat(k) {
    OUTFITS.jacket(k);
    mrect(k, 4, 6, 3, 1, 'e'); // badge
  },
  heavy(k) {
    OUTFITS.jacket(k);
    for (let y = 2; y < 6; y += 1) for (let x = 0; x < 22; x += 1) if (mget(k, x, y) === 'h') mset(k, x, y, 'a'); // shoulder yoke
    for (let x = 0; x < 22; x += 1) if (mget(k, x, 10) === 'h') mset(k, x, 10, 'r');
  },
};

// Hand-placed cloth clusters over the shaded torso (22 x 15): '+' lifts a pixel one step, '-' drops it.
const CLOTH_MARKS = [
  '......................',
  '......................',
  '.....-..........-.....',
  '...++..........--.....',
  '..+++.........-.......',
  '..++.........-........',
  '.............-........',
  '............-.....-...',
  '...........-......-...',
  '..-.......--..........',
  '..-...--........--....',
  '.....--........--.....',
  '......................',
  '......................',
  '......................',
];

// Skirt overlays below the hem (coat tails, apron), drawn over the legs: rows from y 33.
const SKIRTS = {
  coat: (k) => {
    for (let y = 0; y < 9; y += 1) {
      const a = 2 - (y >> 2);
      const b = 19 + (y >> 2);
      for (let x = a; x <= b; x += 1) if (x !== 11) mset(k, x, y, 'h');
    }
  },
  apron: (k) => {
    for (let y = 0; y < 8; y += 1) for (let x = 6; x < 17; x += 1) mset(k, x, y, 'a');
  },
};

/** Material ramps for a look: role outfit colours plus the look's skin and hair. */
function clothMaterials(look) {
  const o = look.outfit;
  const m = (ramp, base, extra = {}) => ({ ramp, base, bevel: 3, k: 2.2, kl: 3, steps: [1, Math.min(R[ramp].length - 1, base + 1)], outline: R[ramp][0], vgrad: [0.2, 0.25], ...extra });
  return {
    h: m(o.main[0], o.main[1]),
    c: m(o.collar[0], o.collar[1], { bevel: 2 }),
    b: m(o.main[0], Math.max(1, o.main[1] - 1), { bevel: 1, k: 1.2 }),
    A: m(o.sleeve[0], o.sleeve[1], { bevel: 2, k: 2.6, kl: 4 }),
    w: { ramp: o.shirt[0], base: o.shirt[1], bevel: 2, k: 2, kl: 3, outline: null, seam: false },
    n: { ramp: 'steel', base: 3, flat: true, outline: null, seam: false },
    o: { ramp: 'gun', base: 1, flat: true, outline: null, seam: false },
    z: { ramp: 'gun', base: 2, flat: true, outline: null, seam: false },
    e: { ramp: o.mark[0], base: o.mark[1], flat: true, outline: null, seam: false },
    s: { ramp: o.strap[0], base: o.strap[1], flat: true, outline: null, seam: false },
    p: { ramp: o.main[0], base: Math.max(0, o.main[1] - 1), bevel: 1, k: 1, steps: [0, 4], outline: null },
    r: { ramp: 'steel', base: 3, flat: true, outline: null, seam: false },
    a: m(o.apron ? o.apron[0] : o.main[0], o.apron ? o.apron[1] : o.main[1]),
    P: m(o.pants[0], o.pants[1], { bevel: 2, kl: 3.5 }),
    Q: m(o.pants[0], Math.max(1, o.pants[1] - 1), { bevel: 2, kl: 3, group: 'farleg' }),
    t: { ramp: o.boots[0], base: o.boots[1], bevel: 1, k: 2, kl: 4, steps: [1, Math.min(R[o.boots[0]].length - 1, o.boots[1] + 1)], outline: R[o.boots[0]][0] },
    T: { ramp: o.boots[0], base: Math.max(1, o.boots[1] - 1), bevel: 1, k: 2, kl: 3, outline: R[o.boots[0]][0], group: 'farboot' },
  };
}

// ---------------------------------------------------------------- roles
const O = (main, sleeve, collar, shirt, mark, strap, pants, boots, apron = null) => ({ main, sleeve, collar, shirt, mark, strap, pants, boots, apron });
export const ROLE_LOOKS = {
  coder: { torso: 'hoodie', hats: ['phones', 'phones', 'beanie', null], glove: null, prop: null, light: 'cyan' },
  setup: { torso: 'vest', hats: ['hardhat'], glove: 'leather', prop: 'driver', outfit: O(['amber', 3], ['gun', 3], ['gun', 2], ['gun', 2], ['amber', 4], ['leather', 2], ['gun', 2], ['amber', 2]) },
  reviewer: { torso: 'jacket', hats: ['glasses'], glove: null, prop: 'stylus', outfit: O(['blue', 2], ['blue', 2], ['blue', 1], ['steel', 3], ['cyan', 3], ['cyan', 3], ['gun', 2], ['leather', 1]) },
  fixer: { torso: 'overalls', hats: ['bandana'], glove: 'leather', prop: 'wrench', outfit: O(['red', 2], ['gun', 3], ['gun', 3], ['gun', 3], ['amber', 3], ['red', 1], ['red', 2], ['leather', 2]) },
  preparer: { torso: 'apron', hats: [null], glove: 'amber', prop: 'tape', outfit: O(['mint', 2], ['mint', 2], ['mint', 1], ['mint', 3], ['amber', 3], ['leather', 1], ['gun', 2], ['leather', 2], ['leather', 2]) },
  verifier: { torso: 'coat', hats: ['goggles'], glove: null, prop: 'clipboard', skirt: 'coat', outfit: O(['steel', 3], ['steel', 3], ['steel', 2], ['violet', 3], ['mint', 3], ['steel', 1], ['gun', 2], ['gun', 3]) },
  helper: { torso: 'jacket', hats: ['cap'], glove: null, prop: 'tablet', outfit: O(['gun', 3], ['gun', 3], ['cyan', 2], ['cyan', 3], ['cyan', 3], ['cyan', 2], ['panel', 2], ['leather', 1]) },
  merger: { torso: 'heavy', hats: ['defenders'], glove: 'amber', prop: null, outfit: O(['gun', 3], ['gun', 3], ['gun', 2], ['gun', 2], ['amber', 3], ['amber', 2], ['gun', 2], ['leather', 2], ['amber', 3]) },
};
ROLE_LOOKS.preparer.skirt = 'apron';
const CODER_OUTFITS = [
  O(['violet', 3], ['violet', 4], ['violet', 2], ['steel', 3], ['cyan', 4], ['steel', 3], ['gun', 3], ['leather', 2]),
  O(['cyan', 2], ['cyan', 3], ['cyan', 1], ['steel', 3], ['amber', 4], ['steel', 3], ['gun', 2], ['gun', 3]),
  O(['red', 2], ['red', 3], ['red', 1], ['steel', 3], ['steel', 4], ['steel', 3], ['panel', 2], ['leather', 1]),
  O(['mint', 2], ['mint', 3], ['mint', 1], ['steel', 3], ['violet', 4], ['steel', 3], ['gun', 3], ['leather', 2]),
  O(['blue', 2], ['blue', 3], ['blue', 1], ['steel', 3], ['amber', 4], ['steel', 3], ['gun', 2], ['gun', 3]),
];
const CODER_HAIR = ['spiky', 'bob', 'curly', 'crop', 'pony'];
const ROLE_HAIR = { setup: ['crop', 'buzz'], reviewer: ['pony', 'bob', 'crop'], fixer: ['buzz', 'curly'], preparer: ['curly', 'bob', 'pony'], verifier: ['bob', 'crop'], helper: ['crop', 'spiky'], merger: ['buzz', 'crop'] };
const BEANIE = ['red', 'blue', 'mint', 'amber'];

/** A stable look for an agent: role identity plus per-id skin, hair and (for coders) outfit variants. */
export function lookFor(role, seed = 0) {
  const r = ROLE_LOOKS[role] ? role : 'helper';
  const def = ROLE_LOOKS[r];
  const pick = (list, salt) => list[Math.abs(Math.floor(seed / salt)) % list.length];
  const look = {
    role: r,
    skin: pick(SKINS, 1),
    hair: pick(HAIRS, 3),
    iris: pick(IRIS, 7),
    style: r === 'coder' ? pick(CODER_HAIR, 11) : pick(ROLE_HAIR[r] || ['crop'], 11),
    hat: pick(def.hats, 13),
    outfit: r === 'coder' ? pick(CODER_OUTFITS, 5) : def.outfit,
    torso: def.torso,
    skirt: def.skirt || null,
    glove: def.glove,
    prop: def.prop,
    hatColour: r === 'coder' ? pick(BEANIE, 17) : r === 'helper' ? 'cyan' : 'amber',
  };
  if (look.hat === 'beanie' && look.style === 'pony') look.style = 'crop';
  if (look.hat === 'hardhat' || look.hat === 'cap' || look.hat === 'bandana') look.style = look.style === 'curly' || look.style === 'pony' ? look.style : 'crop';
  look.key = `${look.role}|${look.skin}|${look.hair}|${look.iris[0]}|${look.style}|${look.hat}|${JSON.stringify(look.outfit.main)}|${JSON.stringify(look.outfit.sleeve)}|${look.hatColour}`;
  return look;
}

// ---------------------------------------------------------------- head assembly
function headSprite(look, eyes) {
  const sk = R[look.skin];
  const hr = R[look.hair];
  const ir = R[look.iris[0]];
  const legend = {
    K: sk[0], k: sk[1], s: sk[2], S: sk[3], L: sk[4],
    B: hr[Math.min(1, hr.length - 1)], e: R.gun[0], W: R.steel[3], w: R.steel[4],
    u: ir[look.iris[1]], U: ir[look.iris[2]], q: R.red[4], m: R.red[1],
  };
  const rows = FACE.map((r) => r.split(''));
  const ev = EYES[eyes];
  if (ev) for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) rows[11 + i][10 + j] = ev[i][0][j];
    for (let j = 0; j < 2; j += 1) rows[11 + i][16 + j] = ev[i][1][j];
  }
  const s = createSprite(24, 22);
  stamp(s, mapToSprite(rows.map((r) => r.join('')), legend), 0, 0);
  const hairLegend = { O: hr[0], a: hr[1], b: hr[2], c: hr[3], y: look.hair === 'steel' ? R.steel[4] : look.hair === 'blond' ? R.amber[5] : look.hair === 'ink' ? R.violet[3] : R.amber[3] };
  stamp(s, mapToSprite(HAIR_STYLES[look.style], hairLegend), 0, 0);
  if (look.hat) {
    const hw = HEADWEAR[look.hat];
    const rows2 = hw.rows.map((r) => r || '.');
    stamp(s, mapToSprite(rows2, hw.legend(look.role === 'coder' && look.hat === 'phones' ? 'cyan' : look.hatColour)), 0, 0);
  }
  return s;
}

// ---------------------------------------------------------------- skeleton
/** Two-bone IK: elbow/knee for a limb from a to b with lengths l1, l2; `bend` +1/-1 picks the side. */
export function solveLimb(a, b, l1, l2, bend) {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let d = Math.hypot(dx, dy);
  const max = l1 + l2 - 0.01;
  if (d > max) {
    dx *= max / d;
    dy *= max / d;
    d = max;
  }
  const end = { x: a.x + dx, y: a.y + dy };
  const cos = Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * Math.max(d, 0.01))));
  const ang = Math.atan2(dy, dx) + bend * Math.acos(cos);
  return { mid: { x: a.x + Math.cos(ang) * l1, y: a.y + Math.sin(ang) * l1 }, end };
}

/** Paint a capsule (segment with round ends) into a mask. */
export function mcapsule(k, a, b, r, v) {
  const x0 = Math.floor(Math.min(a.x, b.x) - r - 1);
  const x1 = Math.ceil(Math.max(a.x, b.x) + r + 1);
  const y0 = Math.floor(Math.min(a.y, b.y) - r - 1);
  const y1 = Math.ceil(Math.max(a.y, b.y) + r + 1);
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const L2 = vx * vx + vy * vy || 1;
  for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) {
    const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / L2));
    const px = a.x + vx * t - x;
    const py = a.y + vy * t - y;
    if (px * px + py * py <= r * r) mset(k, x, y, v);
  }
}

// Boots (7 x 4) pointing right; heel at column 1.
const BOOT = ['.tttt..', 'ttttttt', 'ttttttt', 'ooooooo'];

function limbsMask(pose, look, part) {
  // part: 'far' (far arm + far leg, behind the torso), 'legs' (near leg), 'near' (near arm)
  const k = createMask(CW, CH);
  const bob = pose.bob || 0;
  if (part === 'legs' || part === 'farleg') {
    const which = part === 'legs' ? 'near' : 'far';
    const hip = { x: HIP[which].x, y: HIP[which].y + bob };
    const ankle = pose.feet[which];
    const { mid, end } = solveLimb(hip, ankle, LEG[0], LEG[1], which === 'near' ? -1 : -1);
    const P = which === 'near' ? 'P' : 'Q';
    mcapsule(k, hip, mid, 2.7, P);
    mcapsule(k, mid, end, 2.3, P);
    const T = which === 'near' ? 't' : 'T';
    BOOT.forEach((row, y) => [...row].forEach((ch, x) => {
      if (ch === '.') return;
      mset(k, Math.round(end.x) - 1 + x, Math.round(end.y) - 1 + y, ch === 'o' ? 'o' : T);
    }));
  } else {
    const which = part === 'near' ? 'near' : 'far';
    const sh = { x: SHOULDER[which].x, y: SHOULDER[which].y + bob };
    const hand = pose.hands[which];
    const { mid, end } = solveLimb(sh, { x: hand.x, y: hand.y + bob }, ARM[0], ARM[1], 1);
    mcapsule(k, sh, mid, 2.6, 'A');
    mcapsule(k, mid, end, 2.2, 'A');
    // cuff at the wrist
    const cx = end.x - (end.x - mid.x) * 0.22;
    const cy = end.y - (end.y - mid.y) * 0.22;
    mcapsule(k, { x: cx, y: cy }, end, 2.2, 'b');
    pose[`_${which}End`] = end;
  }
  return k;
}

// Hands (5 x 4) seen from the side, fingers towards the facing direction.
const HAND_MAPS = {
  open: ['.KKK.', 'KSLSK', 'KsSSK', '.KkK.'],
  grip: ['.KKK.', 'KSLLK', 'KkSsK', '.KKK.'],
  point: ['.KKKK', 'KSLLL', 'KsSK.', '.KK..'],
};
function handSprite(look, kind) {
  const r = look.glove ? R[look.glove] : R[look.skin];
  const legend = { K: r[0], k: r[1], s: r[2], S: r[look.glove ? 2 : 3], L: r[look.glove ? 3 : 4] };
  return mapToSprite(HAND_MAPS[kind] || HAND_MAPS.open, legend);
}

// Props, drawn at the far hand (or between both hands for flat items).
const PROPS = {
  wrench: { rows: ['..gg..', '.g..g.', '.gGGg.', '..gG..', '..gG..', '..gG..', '..gG..'], legend: { g: R.steel[1], G: R.steel[3] }, at: { x: -2, y: -6 } },
  driver: { rows: ['.G', '.G', '.G', 'rr', 'rr'], legend: { G: R.steel[3], r: R.amber[3] }, at: { x: 2, y: -4 } },
  stylus: { rows: ['w...', '.G..', '..G.', '...G'], legend: { w: R.cyan[4], G: R.steel[2] }, at: { x: 3, y: -3 } },
  clipboard: { rows: ['..gg...', 'lwwwwwl', 'lwkkwwl', 'lwwwwwl', 'lwkkkwl', 'lwwwwwl', 'lllllll'], legend: { g: R.steel[2], l: R.leather[2], w: R.steel[4], k: R.gun[2] }, at: { x: -6, y: -2 } },
  tablet: { rows: ['gggggg', 'gxxXxg', 'gxXxxg', 'gxxxXg', 'gggggg'], legend: { g: R.gun[1], x: R.cyan[2], X: R.cyan[4] }, at: { x: -5, y: -2 } },
  tape: { rows: ['.aaa.', 'aGGGa', 'aG.Ga', 'aGGGa', '.aaa.'], legend: { a: R.amber[3], G: R.gun[2] }, at: { x: 2, y: -2 } },
};

// ---------------------------------------------------------------- poses
const ankle = (x, lift = 0) => ({ x, y: 43 - lift });
const TYPE_LIFT = [[0, 1], [1, 0], [0, 1], [1, 1], [1, 0], [0, 0]];
export const STAND_FEET = { near: ankle(12), far: ankle(19) };
const REST_HANDS = { near: { x: 9, y: 33 }, far: { x: 25, y: 33 } };

/** Walk cycle frame k of 6: feet stride and lift, arms swing against the legs, body bobs at contact. */
export function walkPose(k) {
  const ph = (k / 6) * Math.PI * 2;
  const foot = (p, cx) => ankle(cx + Math.round(4.5 * Math.cos(p)), Math.max(0, Math.round(-Math.sin(p) * 2.5)));
  return {
    feet: { near: foot(ph, 15), far: foot(ph + Math.PI, 17) },
    hands: { near: { x: 10 + Math.round(-4 * Math.cos(ph)), y: 32 }, far: { x: 24 + Math.round(-4 * Math.cos(ph + Math.PI)), y: 32 } },
    bob: k % 3 === 0 ? 1 : 0,
    handKind: { near: 'open', far: 'open' },
  };
}

/**
 * Work poses by name and frame. Hand targets are in sprite coordinates (character facing right; the far
 * arm reaches to the console at the right, the near arm crosses in front).
 */
export function workPose(name, k = 0) {
  const p = { feet: STAND_FEET, hands: REST_HANDS, bob: 0, handKind: { near: 'open', far: 'open' }, prop: null };
  if (name === 'reach') return { ...p, hands: { near: { x: 21, y: 29 }, far: { x: 31, y: 23 + (k % 2) } }, handKind: { near: 'grip', far: 'point' } };
  if (name === 'press') return { ...p, hands: { near: { x: 21, y: 29 }, far: { x: 31, y: [22, 24, 26, 24][k % 4] } }, handKind: { near: 'grip', far: 'grip' } };
  if (name === 'lever') return { ...p, hands: { near: { x: 20, y: 30 }, far: { x: 31, y: [18, 20, 23, 26, 23, 20][k % 6] } }, handKind: { near: 'open', far: 'grip' } };
  if (name === 'low') return { ...p, hands: { near: { x: [22, 23, 24, 23][k % 4], y: 30 }, far: { x: 31, y: [29, 28, 29, 30][k % 4] } }, handKind: { near: 'grip', far: 'grip' } };
  if (name === 'tape') return { ...p, hands: { near: { x: 23, y: 30 }, far: { x: [27, 29, 31, 33][k % 4], y: 28 } }, handKind: { near: 'open', far: 'grip' } };
  if (name === 'hold') return { ...p, hands: { near: { x: 21, y: 28 }, far: { x: [27, 28, 27, 26][k % 4], y: [26, 27, 26, 27][k % 4] } }, handKind: { near: 'grip', far: 'grip' } };
  if (name === 'type') {
    const [l, r] = TYPE_LIFT[k % TYPE_LIFT.length];
    return { ...p, hands: { near: { x: 17, y: 29 - l }, far: { x: 29, y: 29 - r } }, handKind: { near: l ? 'open' : 'grip', far: r ? 'open' : 'grip' } };
  }
  if (name === 'stand' && k % 2 === 1) return { ...p, hands: { near: { x: 12, y: 31 }, far: { x: 25, y: 32 } }, bob: 0 };
  if (name === 'think') return { ...p, hands: { near: { x: 21, y: 20 }, far: REST_HANDS.far }, handKind: { near: 'grip', far: 'open' } };
  return p;
}

// ---------------------------------------------------------------- frames
const cache = new Map();

/**
 * Build one frame of a character: { body, front } sprites (front = hands and props, drawn over a desk).
 * f: { pose: 'stand'|'walk'|'reach'|'press'|'lever'|'low'|'tape'|'hold'|'think'|'type', k, eyes, breathe }.
 */
export function charFrame(look, f = {}) {
  const pose = f.pose || 'stand';
  const k = f.k || 0;
  const eyes = f.eyes || 'open';
  const breathe = f.breathe ? 1 : 0;
  const key = `${look.key}|${pose}|${k}|${eyes}|${breathe}`;
  if (cache.has(key)) return cache.get(key);
  const P = pose === 'walk' ? walkPose(k) : workPose(pose, k);
  const mats = clothMaterials(look);
  const body = createSprite(CW, CH);
  const front = createSprite(CW, CH);
  const lift = -breathe + (P.bob || 0);
  const shade = (mask) => shadeMask(mask, mats);
  // far arm and far leg behind everything
  stamp(body, shade(limbsMask(P, look, 'far')), 0, lift - (P.bob || 0));
  stamp(body, shade(limbsMask(P, look, 'farleg')), 0, 0);
  stamp(body, shade(limbsMask(P, look, 'legs')), 0, 0);
  // torso (with the outfit's details), skirts over the thighs
  const tk = torsoBase();
  OUTFITS[look.torso](tk);
  const torso = shadeMask(tk, mats, { marks: CLOTH_MARKS });
  if (look.skirt) {
    const sk = createMask(22, 9);
    SKIRTS[look.skirt](sk);
    stamp(body, shadeMask(sk, mats), TORSO_AT.x, TORSO_AT.y + 14 + lift);
  }
  stamp(body, torso, TORSO_AT.x, TORSO_AT.y + lift);
  // head
  stamp(body, headSprite(look, eyes), HEAD_AT.x, HEAD_AT.y + lift);
  // near arm in front of the torso
  {
    stamp(body, shade(limbsMask(P, look, 'near')), 0, lift - (P.bob || 0));
    for (const which of ['far', 'near']) {
      const end = P[`_${which}End`];
      if (!end) continue;
      const h = handSprite(look, P.handKind[which]);
      stamp(front, h, Math.round(end.x) - 2, Math.round(end.y) - 2 + lift);
    }
    const prop = look.prop && PROPS[look.prop];
    const at = P._farEnd;
    const showProp = prop && at && (pose === 'reach' || pose === 'low' || pose === 'hold' || pose === 'tape' || pose === 'press' || (pose === 'stand' && (look.prop === 'clipboard' || look.prop === 'tablet')));
    if (showProp) {
      const ps = mapToSprite(prop.rows, prop.legend);
      const base = look.prop === 'clipboard' || look.prop === 'tablet' ? P._nearEnd || at : at;
      stamp(front, ps, Math.round(base.x) + prop.at.x, Math.round(base.y) + prop.at.y + lift);
      if (look.prop === 'clipboard' || look.prop === 'tablet') stamp(front, handSprite(look, 'grip'), Math.round(at.x) - 2, Math.round(at.y) - 2 + lift);
    }
  }
  const out = { body, front, P };
  cache.set(key, out);
  return out;
}

/** Height in pixels of the opaque part of a sprite (for tests and layout checks). */
export function opaqueHeight(s) {
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < s.h; y += 1) for (let x = 0; x < s.w; x += 1) if (s.data[y * s.w + x] >= 0) {
    if (top < 0) top = y;
    bottom = y;
  }
  return top < 0 ? 0 : bottom - top + 1;
}

export { HEAD_AT, TORSO_AT, maskFromRows };
