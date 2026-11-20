// HD stage: the character kit (faces, hair, headwear, outfits, skeleton poses, walk cycle, variants).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CANCHOR, CH, CW, FACE, HAIR_STYLES, HEADWEAR, ROLE_LOOKS, charFrame, lookFor, opaqueHeight, solveLimb, walkPose } from '../public/hd/hd-chars.mjs';
import { PALETTE, R, RAMP_OF } from '../public/hd/hd-palette.mjs';

const ROLES = ['coder', 'setup', 'reviewer', 'fixer', 'preparer', 'verifier', 'helper', 'merger'];
const WORK = { coder: 'type', setup: 'press', reviewer: 'reach', fixer: 'low', preparer: 'tape', verifier: 'hold', helper: 'hold', merger: 'lever' };

test('hand-drawn maps are rectangular and fit the head box', () => {
  assert.equal(FACE.length, 20);
  for (const row of FACE) assert.equal(row.length, 20, `face row "${row}"`);
  for (const [name, rows] of Object.entries(HAIR_STYLES)) for (const row of rows) assert.ok(row.length === 20, `${name} row "${row}"`);
  for (const [name, hw] of Object.entries(HEADWEAR)) for (const row of hw.rows) assert.ok(row.length <= 23, `${name} row too wide`);
});

test('every role builds standing, working and walking frames, 36-56 px tall, palette only', () => {
  for (const role of ROLES) for (let seed = 0; seed < 40; seed += 7) {
    const look = lookFor(role, seed);
    for (const f of [{ pose: 'stand' }, { pose: WORK[role], k: 1 }, { pose: 'think' }, ...[0, 1, 2, 3, 4, 5].map((k) => ({ pose: 'walk', k }))]) {
      const fr = charFrame(look, f);
      assert.equal(fr.body.w, CW);
      assert.equal(fr.body.h, CH);
      const h = opaqueHeight(fr.body);
      assert.ok(h >= 36 && h <= 56, `${role} ${f.pose} is ${h} px tall`);
      for (const v of fr.body.data) assert.ok(v === -1 || (v >= 0 && v < PALETTE.length));
      for (const v of fr.front.data) assert.ok(v === -1 || (v >= 0 && v < PALETTE.length));
    }
  }
  assert.equal(CANCHOR.y, CH - 1, 'anchored at the feet');
});

test('roles are distinct: headwear, outfit colour and prop give each role its identity', () => {
  const sig = new Set();
  for (const role of ROLES) {
    const look = lookFor(role, 3);
    sig.add(`${look.hat}|${JSON.stringify(look.outfit.main)}|${look.prop}|${look.torso}`);
  }
  assert.equal(sig.size, ROLES.length);
  assert.ok(ROLE_LOOKS.setup.hats.includes('hardhat'));
  assert.equal(ROLE_LOOKS.fixer.prop, 'wrench');
  assert.equal(ROLE_LOOKS.verifier.prop, 'clipboard');
});

test('looks are stable per agent id and concurrent coders look different', () => {
  assert.deepEqual(lookFor('coder', 123), lookFor('coder', 123));
  const keys = new Set(Array.from({ length: 24 }, (_, i) => lookFor('coder', i * 41).key));
  assert.ok(keys.size >= 8, `${keys.size} distinct coder looks`);
  const skins = new Set(Array.from({ length: 24 }, (_, i) => lookFor('coder', i * 41).skin));
  assert.ok(skins.size >= 3, 'three skin tones');
  assert.equal(lookFor('nonsense', 5).role, 'helper');
});

test('materials have 4+ shading steps and coloured outlines (no near-black void)', () => {
  const fr = charFrame(lookFor('coder', 0), { pose: 'stand' });
  const used = new Set([...fr.body.data].filter((v) => v >= 0));
  const steps = (ramp) => [...used].filter((i) => RAMP_OF[i].ramp === ramp).length;
  const look = lookFor('coder', 0);
  assert.ok(steps(look.outfit.main[0]) >= 4, 'hoodie');
  assert.ok(steps(look.skin) >= 4, 'skin');
  assert.ok(steps(look.hair === 'steel' ? 'steel' : look.hair) >= 3, 'hair');
  assert.ok(!used.has(R.void[0]));
});

test('blinking changes only the eyes; breathing lifts the upper body', () => {
  const look = lookFor('reviewer', 2);
  const open = charFrame(look, { pose: 'stand', eyes: 'open' }).body;
  const shut = charFrame(look, { pose: 'stand', eyes: 'shut' }).body;
  const diff = [];
  for (let i = 0; i < open.data.length; i += 1) if (open.data[i] !== shut.data[i]) diff.push([i % open.w, Math.floor(i / open.w)]);
  assert.ok(diff.length > 0 && diff.length <= 15, `${diff.length} pixels`);
  assert.ok(diff.every(([, y]) => y >= 12 && y <= 15), 'eye rows only');
  const top = (s) => {
    for (let y = 0; y < s.h; y += 1) for (let x = 0; x < s.w; x += 1) if (s.data[y * s.w + x] >= 0) return y;
    return -1;
  };
  assert.equal(top(charFrame(look, { pose: 'stand', breathe: 1 }).body), top(open) - 1);
});

test('the skeleton reaches its targets and the walk cycle alternates the feet', () => {
  const a = { x: 10, y: 22 };
  const { mid, end } = solveLimb(a, { x: 20, y: 28 }, 6.5, 6.5, 1);
  assert.ok(Math.abs(Math.hypot(mid.x - a.x, mid.y - a.y) - 6.5) < 0.01, 'upper bone keeps its length');
  assert.ok(Math.abs(end.x - 20) < 0.01 && Math.abs(end.y - 28) < 0.01, 'reaches the target');
  const far = solveLimb(a, { x: 60, y: 22 }, 6.5, 6.5, 1);
  assert.ok(far.end.x <= a.x + 13, 'a target out of reach is clamped');
  const xs = [0, 1, 2, 3, 4, 5].map((k) => walkPose(k).feet.near.x - walkPose(k).feet.far.x);
  assert.ok(Math.max(...xs) > 0 && Math.min(...xs) < 0, 'the near foot leads, then the far foot');
  const frames = new Set([0, 1, 2, 3, 4, 5].map((k) => [...charFrame(lookFor('fixer', 1), { pose: 'walk', k }).body.data].join(',')));
  assert.equal(frames.size, 6, 'six different walk frames');
});
