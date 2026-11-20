// HD stage: the command-line video tool's options and its crisp-pixel measure (no browser needed).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crispness, parseArgs } from '../tools/render-video.mjs';

test('render-video options: a past window or the live view, validated', () => {
  const o = parseArgs(['--from', '2026-11-19T10:00:00Z', '--to', '2026-11-19T13:30:00Z', '--duration', '45', '--aspect', '1:1', '--title', 'AGENTS AT WORK', '--out', 'x.mp4']);
  assert.equal(o.aspect, '1:1');
  assert.equal(o.duration, 45);
  assert.equal(o.live, false);
  assert.equal(parseArgs(['--live', '--duration', '20', '--out', 'live.mp4']).live, true);
  assert.equal(parseArgs(['--live', '--aspect', '4x5', '--out', 'p.mp4']).aspect, '4:5');
  assert.throws(() => parseArgs(['--from', '2026-11-19T10:00:00Z', '--to', '2026-11-19T13:30:00Z']), /--out/);
  assert.throws(() => parseArgs(['--out', 'x.mp4']), /--from/);
  assert.throws(() => parseArgs(['--from', '2026-11-19T13:00:00Z', '--to', '2026-11-19T12:00:00Z', '--out', 'x.mp4']), /after/);
  assert.throws(() => parseArgs(['--live', '--duration', '2', '--out', 'x.mp4']), /duration/);
  assert.throws(() => parseArgs(['--live', '--wat', '--out', 'x.mp4']), /unknown option/);
});

test('crispness is 1 for clean 2x2 pixel blocks and drops for blurred ones', () => {
  const w = 8;
  const h = 8;
  const crisp = { w, h, data: new Uint8ClampedArray(w * h * 4) };
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const v = ((x >> 1) + (y >> 1)) % 2 ? 255 : 0;
    crisp.data.set([v, v, v, 255], (y * w + x) * 4);
  }
  assert.equal(crispness(crisp), 1);
  const blur = { w, h, data: new Uint8ClampedArray(crisp.data) };
  for (let i = 0; i < blur.data.length; i += 8) blur.data[i] = 128; // every other pixel smeared
  assert.ok(crispness(blur) < 0.5);
});

test('render-video segments: UTC windows on a date, in order, stitched into one timeline', async () => {
  const { parseSegments } = await import('../tools/render-video.mjs');
  const { cutTimeline, IRIS } = await import('../public/hd/hd-recorder.mjs');
  const o = parseArgs(['--date', '2026-11-19', '--segments', '10:20-10:32,12:05-12:20,17:20-17:35', '--duration', '56', '--aspect', '9:16', '--title', 'AI agents building the website', '--out', 'cut.mp4']);
  assert.equal(o.aspect, '9:16');
  assert.deepEqual(o.segments[0], { from: '2026-11-19T10:20:00.000Z', to: '2026-11-19T10:32:00.000Z' });
  assert.equal(o.from, '2026-11-19T10:20:00.000Z');
  assert.equal(o.to, '2026-11-19T17:35:00.000Z');
  assert.throws(() => parseSegments('12:00-11:00', '2026-11-19'), /end after/);
  assert.throws(() => parseSegments('12:00-12:30,12:10-12:40', '2026-11-19'), /overlap/);
  assert.throws(() => parseSegments('noon', '2026-11-19'), /HH:MM/);
  assert.throws(() => parseSegments('10:00-10:30', '19/11/2026'), /--date/);
  // the timeline: title, segments with an iris between them, end card; it adds up to the duration
  const tl = cutTimeline(o.segments, 56, { titleS: 3, endS: 3 });
  assert.equal(tl.segments.length, 3);
  assert.equal(tl.transitions.length, 2);
  const tr = IRIS.close + IRIS.hold + IRIS.open;
  const last = tl.segments.at(-1);
  assert.ok(Math.abs(last.playAt + last.dur - (56 - 3)) < 1e-6, 'the last window ends as the end card starts');
  for (let i = 1; i < tl.segments.length; i += 1) {
    const s = tl.segments[i];
    const t = tl.transitions[i - 1];
    // the next window is loaded while the iris is closed and plays as it opens
    assert.ok(s.start > t.at + IRIS.close - 1e-6 && s.start < t.at + IRIS.close + IRIS.hold);
    assert.ok(Math.abs(s.playAt - (t.at + IRIS.close + IRIS.hold)) < 1e-6);
    assert.ok(Math.abs(t.at - (tl.segments[i - 1].playAt + tl.segments[i - 1].dur)) < 1e-6, 'the iris closes as the previous window ends');
  }
  assert.ok(tl.segments.every((s) => s.dur >= 5));
  assert.ok(tr > 1 && tr < 2.5);
  assert.throws(() => cutTimeline(o.segments, 12), /too short/);
});
