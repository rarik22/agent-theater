// Agent Theater HD · hd-anim.mjs
// Pure mapping from real state to animation: which clip an agent plays for its action kind, the exact
// sprite frame parameters at time t (typing hands, blinks, breathing, head bob, eye direction), what its
// monitor shows, how often data pulses leave its station, and the merge machine's visual state.
// Nothing here invents activity: every output is a function of the state fields and the clock.

export const KINDS = ['edit', 'read', 'search', 'run', 'test', 'browser', 'docker', 'think', 'wait'];

/** Clip for an action kind: pose, typing speed, screen program and data-pulse period (s; 0 = none). */
export const CLIPS = {
  type: { pose: 'type', fps: 10, screen: 'code', pulse: 0.9 },
  search: { pose: 'type', fps: 6, screen: 'search', pulse: 1.3 },
  read: { pose: 'rest', fps: 0, screen: 'scroll', pulse: 1.6 },
  watch: { pose: 'rest', fps: 0, screen: 'terminal', pulse: 0.7 },
  think: { pose: 'rest', fps: 0, screen: 'idle', pulse: 0 },
  wait: { pose: 'rest', fps: 0, screen: 'hourglass', pulse: 0 },
};

export function clipName(kind) {
  if (kind === 'edit') return 'type';
  if (kind === 'search') return 'search';
  if (kind === 'read') return 'read';
  if (kind === 'run' || kind === 'test' || kind === 'docker' || kind === 'browser') return 'watch';
  if (kind === 'wait') return 'wait';
  return 'think';
}
export const clipFor = (kind) => CLIPS[clipName(kind)];

// Typing: a 6-step hand pattern, left/right alternating with a double tap, at the clip's fps.
export const TYPE_HANDS = [
  ['down', 'up'],
  ['up', 'down'],
  ['down', 'up'],
  ['up', 'up'],
  ['up', 'down'],
  ['down', 'down'],
];

const fract = (v) => v - Math.floor(v);

/** Blink state at time t for an agent seed: open most of the time, a 3-frame blink every ~3-4.5 s. */
export function blinkAt(t, seed = 0) {
  const period = 3.1 + (seed % 7) * 0.22;
  const p = fract((t + seed * 0.731) / period) * period;
  if (p < 0.05) return 'half';
  if (p < 0.13) return 'shut';
  if (p < 0.18) return 'half';
  return 'open';
}

/** Breathing: the torso is lifted 1 px for part of a 3.4 s cycle. */
export function breatheAt(t, seed = 0) {
  return fract((t + seed * 0.37) / 3.4) < 0.45 ? 1 : 0;
}

/**
 * The coder's frame parameters at time t for an action kind. `calm` freezes the hands and the bob
 * (reduced motion) but keeps the pose and the screen meaningful.
 */
export function coderPose(kind, t, seed = 0, calm = false) {
  const name = clipName(kind);
  const clip = CLIPS[name];
  const out = { clip: name, pose: clip.pose, eyes: 'open', breathe: 0, bob: 0, handL: 'down', handR: 'down', led: true };
  if (calm) return out;
  out.breathe = breatheAt(t, seed);
  out.eyes = blinkAt(t, seed);
  if (clip.pose === 'type') {
    const i = Math.floor(t * clip.fps + seed) % TYPE_HANDS.length;
    [out.handL, out.handR] = TYPE_HANDS[i];
    // a small nod now and then while typing
    out.bob = fract((t + seed * 0.13) / 2.3) < 0.1 ? 1 : 0;
  }
  if (out.eyes === 'open') {
    if (name === 'think') out.eyes = fract(t / 5) < 0.6 ? 'up' : 'open';
    else if (name === 'read') out.eyes = fract(t / 1.6) < 0.5 ? 'left' : 'open';
  }
  // headphone LEDs pulse slowly while working, stay steady otherwise
  out.led = name === 'think' || name === 'wait' ? true : fract(t / 1.2) < 0.75;
  return out;
}

/** Data pulses leaving a station: positions (0..1 along the run) of the pulses alive at t. */
export function pulsesAt(kind, t, seed = 0, travel = 1.6) {
  const period = clipFor(kind).pulse;
  if (!period) return [];
  const out = [];
  const phase = (seed % 11) * 0.07;
  const first = Math.floor((t - travel - phase) / period) + 1;
  for (let k = first; k * period + phase <= t; k += 1) {
    const age = t - (k * period + phase);
    if (age >= 0 && age <= travel) out.push(age / travel);
  }
  return out;
}

/**
 * Merge machine state from the scene: 'pass' right after a merge went through, 'fail' right after a
 * bounce, 'working' while a batch runs or parcels sit in its window, else 'idle'.
 */
const RELEASE_WORK = new Set(['integrating', 'checking', 'merging', 'working']);

/**
 * The merge machine's state: fail (a bounce just landed), pass (a merge just landed), working, fixing
 * (release trains: the machine's release is being fixed, or has an open failure) or idle. With release
 * trains the machine works while the runner integrates, checks or merges a release (the machine's own,
 * or the next one taking entries); entries waiting in a release do not keep it busy.
 */
export function mergeState({ batchRunning = false, windowCount = 0, sinceMerged = Infinity, sinceBounced = Infinity, release = null } = {}, holdS = 3) {
  // a bounce shows red only when it is the latest news; merges landing in the same update show green
  if (sinceBounced < holdS && sinceBounced < sinceMerged) return 'fail';
  if (sinceMerged < holdS) return 'pass';
  if (release) {
    if (RELEASE_WORK.has(release.activity) || RELEASE_WORK.has(release.next?.activity)) return 'working';
    if (release.activity === 'fixing' || release.openFailure) return 'fixing';
    return 'idle';
  }
  if (batchRunning || windowCount > 0) return 'working';
  return 'idle';
}

/** Batch progress 0..1 shown on the machine's gauge: elapsed time over a nominal 10 minute run, capped. */
export function batchProgress(startedAtMs, nowMs, nominalMs = 600_000) {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, Math.min(0.97, (nowMs - startedAtMs) / nominalMs));
}

/** Stable small hash of an id (0..996), for per-agent animation offsets. */
export function seedOf(id) {
  let h = 2166136261;
  for (const ch of String(id)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0) % 997;
}

// ---------------------------------------------------------------- every role
/** Each role's work pose (see hd-chars workPose) and its frame rate while busy. */
export const ROLE_WORK = {
  coder: { pose: 'type', fps: 10 },
  setup: { pose: 'press', fps: 4 },
  reviewer: { pose: 'reach', fps: 2 },
  fixer: { pose: 'low', fps: 6 },
  preparer: { pose: 'tape', fps: 4 },
  merger: { pose: 'lever', fps: 3 },
  verifier: { pose: 'hold', fps: 3 },
  helper: { pose: 'hold', fps: 2 },
};
const FRAMES = { type: 6, press: 4, reach: 2, low: 4, tape: 4, lever: 6, hold: 4, walk: 6 };

/**
 * The pose an agent shows: walking between spots, working (the role's pose, slower while reading or
 * searching), thinking (hand to chin, a thought bubble) or waiting (standing, an hourglass bubble).
 * Returns { pose, k, eyes, breathe, bubble } for hd-chars charFrame.
 */
export function rolePose(role, kind, t, seed = 0, { walking = false, calm = false } = {}) {
  const work = ROLE_WORK[role] || ROLE_WORK.helper;
  const out = { pose: work.pose, k: 0, eyes: 'open', breathe: 0, bubble: null };
  if (walking) {
    out.pose = 'walk';
    out.k = calm ? 0 : Math.floor(t * 9 + seed) % FRAMES.walk;
    return out;
  }
  const clip = clipName(kind);
  if (clip === 'think') {
    out.pose = 'think';
    out.bubble = 'think';
  } else if (clip === 'wait') {
    out.pose = role === 'coder' ? 'type' : 'stand';
    // a waiting agent shifts its weight now and then
    out.k = role === 'coder' ? 5 : !calm && fract((t + seed * 0.31) / 4.6) < 0.22 ? 1 : 0;
    out.bubble = 'wait';
  } else {
    const slow = clip === 'read' || clip === 'search';
    let fps = slow ? work.fps / 2 : work.fps;
    if (role === 'coder' && (clip === 'read' || clip === 'watch')) fps = 0; // hands rest on the keys, eyes on the screen
    out.k = calm || fps === 0 ? (role === 'coder' ? 5 : 0) : Math.floor(t * fps + seed) % (FRAMES[work.pose] || 4);
  }
  if (calm) return out;
  out.breathe = breatheAt(t, seed);
  out.eyes = blinkAt(t, seed);
  if (out.eyes === 'open') {
    if (clip === 'think') out.eyes = fract(t / 5) < 0.6 ? 'up' : fract(t / 5) < 0.75 ? 'side' : 'open';
    else if (clip === 'wait') out.eyes = fract((t + seed) / 3.7) < 0.25 ? 'side' : 'open';
    else if (clip === 'read' || clip === 'search') out.eyes = fract(t / 1.6) < 0.5 ? 'side' : 'open';
    else if (role === 'fixer' || role === 'preparer') out.eyes = 'down';
  }
  return out;
}
