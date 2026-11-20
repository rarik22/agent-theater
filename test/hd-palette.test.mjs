// HD slice: the controlled palette, its material ramps and the stepped light/shadow tables.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LANE_RAMPS, LIGHT, LIGHTS, LIGHT_TINT, PALETTE, R, RAMPS, RAMP_OF, RGB, SHADE, laneColours, luminance, ramp } from '../public/hd/hd-palette.mjs';

test('the palette is a controlled set of unique colours built only from material ramps', () => {
  assert.ok(PALETTE.length >= 48 && PALETTE.length <= 96, `palette has ${PALETTE.length} colours`);
  const hex = PALETTE.map(([, h]) => h.toLowerCase());
  assert.equal(new Set(hex).size, hex.length, 'no duplicate colours');
  assert.ok(!hex.includes('#000000'), 'no pure black: outlines are coloured');
  assert.equal(PALETTE.length, Object.values(RAMPS).reduce((n, r) => n + r.length, 0));
  assert.ok(PALETTE.length < 256, 'fits the Uint8 frame buffer');
});

test('every ramp has 3 to 7 steps and runs dark to light', () => {
  for (const [name, steps] of Object.entries(RAMPS)) {
    assert.ok(steps.length >= 3 && steps.length <= 7, `${name} has ${steps.length} steps`);
    for (let i = 1; i < steps.length; i += 1) {
      assert.ok(luminance(RGB[R[name][i]]) > luminance(RGB[R[name][i - 1]]), `${name} step ${i} is lighter than step ${i - 1}`);
    }
  }
  const materials = ['void', 'gun', 'steel', 'panel', 'glass', 'cyan', 'amber', 'violet', 'mint', 'red', 'skin', 'hair', 'leather'];
  for (const m of materials) assert.ok(RAMPS[m], `material ramp ${m}`);
  assert.ok(RAMPS.skin.length >= 4 && RAMPS.violet.length >= 4 && RAMPS.hair.length >= 4, 'character materials have 4+ shading steps');
});

test('ramp() clamps and RAMP_OF inverts it', () => {
  assert.equal(ramp('gun', -3), R.gun[0]);
  assert.equal(ramp('gun', 99), R.gun[R.gun.length - 1]);
  assert.throws(() => ramp('nope', 1));
  for (let i = 0; i < PALETTE.length; i += 1) assert.equal(R[RAMP_OF[i].ramp][RAMP_OF[i].step], i);
});

test('lights are stepped, never darken, and keep colours in their family or the light tint', () => {
  for (const name of LIGHTS) {
    assert.equal(LIGHT[name].length, 3, `${name} has 3 levels`);
    LIGHT[name].forEach((lut, level) => {
      assert.equal(lut.length, PALETTE.length);
      lut.forEach((j, i) => {
        assert.ok(Number.isInteger(j) && j >= 0 && j < PALETTE.length);
        assert.ok(luminance(RGB[j]) + 1e-9 >= luminance(RGB[i]), `${name}[${level}] darkens ${PALETTE[i][0]}`);
        const own = RAMP_OF[i].ramp;
        const to = RAMP_OF[j].ramp;
        assert.ok(to === own || to === LIGHT_TINT[name][own], `${name} moves ${PALETTE[i][0]} to unrelated ${PALETTE[j][0]}`);
      });
    });
  }
  // an amber lamp on the dark wall warms it through the dusk ramp, it does not jump to orange
  assert.equal(RAMP_OF[LIGHT.amber[0][R.void[2]]].ramp, 'dusk');
  // the merge chamber glass under cyan light becomes teal, not grey
  assert.equal(RAMP_OF[LIGHT.cyan[1][R.glass[1]]].ramp, 'cyan');
});

test('cast shadow never lightens', () => {
  for (const lut of SHADE) lut.forEach((j, i) => assert.ok(luminance(RGB[j]) <= luminance(RGB[i]) + 1e-9));
});

test('each of the eight lane hues gets its own chip colours', () => {
  const mids = Object.keys(LANE_RAMPS).map((h) => laneColours(h).mid);
  assert.equal(new Set(mids).size, 8);
  const c = laneColours('unknown');
  assert.ok(c.mid >= 0 && c.light >= 0, 'unknown hue falls back to steel');
});
