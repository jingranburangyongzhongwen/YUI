/**
 * recenter-root-motion — strip baked horizontal drift from VRMA root motion.
 *
 * createVRMAnimationClip bakes the hips position track as a flat [x,y,z, ...]
 * buffer without recentering it, so idle clips carry a large horizontal ROOT
 * offset that drags the pet sideways. Recentering X/Z around their own mean
 * keeps the character on origin while preserving vertical bob and lively sway.
 *
 * Vertical motion is left alone by default — the bob is the point. A clip whose rise
 * IS the movement, like the climbs, has its whole hips-Y curve taken out instead and
 * kept beside the clip: the mover replays that curve by moving the window, so the two
 * compose to the authored motion exactly once. Leaving any of it in the track would
 * play it a second time on top.
 *
 * Horizontal motion is mean-recentered by default so idle sway stays balanced on origin.
 * A clip whose locomotion IS the movement, like an imported video dance, has its hips
 * X/Z pinned to the origin instead: the mover replays that floor path by translating
 * the OS window. Mean-recentering would leave relative XZ travel in the track and the
 * pet would walk off the canvas.
 */

import type { AnimationClip } from "three";

/** Recenter a flat [x,y,z, ...] buffer: subtract mean X and mean Z, keep Y. */
export function recenterRootTranslation(values: ArrayLike<number>): Float32Array {
  const out = new Float32Array(values);

  const count = Math.floor(values.length / 3);
  if (count === 0 || values.length % 3 !== 0) return out;

  let sumX = 0;
  let sumZ = 0;
  for (let i = 0; i < count; i++) {
    sumX += out[i * 3];
    sumZ += out[i * 3 + 2];
  }
  const meanX = sumX / count;
  const meanZ = sumZ / count;

  for (let i = 0; i < count; i++) {
    out[i * 3] -= meanX;
    out[i * 3 + 2] -= meanZ;
  }
  return out;
}

/** Recenter every translation (`*.position`) track of a clip in place. */
export function recenterClipRootMotion(clip: AnimationClip): void {
  for (const track of clip.tracks) {
    if (track.name.endsWith(".position")) {
      track.values = recenterRootTranslation(track.values);
    }
  }
}

/**
 * Level a track's vertical motion onto one height: `restY` when given, otherwise the
 * track's own first key. The whole authored curve comes out, so a mover replaying it
 * is the only thing that lifts the body, and a loop has no seam left to snap at.
 * `travel` is the rise removed end to end (signed metres) — what the mover has to
 * supply; `shift` is how far the track had to drop to reach `restY`.
 */
export function detrendRootY(
  times: ArrayLike<number>,
  values: ArrayLike<number>,
  restY?: number,
): { values: Float32Array; travel: number; shift: number } {
  const out = new Float32Array(values);
  const count = times.length;
  if (count < 1 || values.length !== count * 3) return { values: out, travel: 0, shift: 0 };

  const span = count > 1 ? times[count - 1] - times[0] : 0;
  const rise = count > 1 ? out[(count - 1) * 3 + 1] - out[1] : 0;
  const travel = span > 0 ? rise : 0;

  // A climb clip opens wherever its capture did — often a metre above standing — and
  // that offset would play out in the canvas. Rest the track on the body's own hips
  // height instead, so only what the mover supplies shows.
  const shift = restY === undefined ? 0 : restY - out[1];
  // Every key onto that one height: the mover replays the authored curve whole, so
  // anything left in the track would play on top of it a second time.
  const level = restY === undefined ? out[1] : restY;
  for (let i = 0; i < count; i++) out[i * 3 + 1] = level;
  return { values: out, travel, shift };
}

/** A clip's own travel over time on one axis: keyframe times, and metres from the first key. */
export interface RootYCurve {
  times: number[];
  values: number[];
}

/** One translation channel as a curve from its first key. null when it has none. */
function rootChannelCurve(
  times: ArrayLike<number>,
  values: ArrayLike<number>,
  channel: 0 | 1 | 2,
): RootYCurve | null {
  const count = times.length;
  if (count < 2 || values.length !== count * 3) return null;
  const out: RootYCurve = { times: [], values: [] };
  const origin = values[channel];
  for (let i = 0; i < count; i++) {
    out.times.push(times[i]);
    out.values.push(values[i * 3 + channel] - origin);
  }
  return out;
}

/** The rise a translation track carries, as a curve from its first key. null when it has none. */
export function rootYCurve(times: ArrayLike<number>, values: ArrayLike<number>): RootYCurve | null {
  return rootChannelCurve(times, values, 1);
}

/** The curve's value at a clip time, interpolated between keys and clamped at both ends. */
export function sampleRootYCurve(curve: RootYCurve, timeS: number): number {
  const { times, values } = curve;
  const last = times.length - 1;
  if (last < 0) return 0;
  if (timeS <= times[0]) return values[0];
  if (timeS >= times[last]) return values[last];
  let i = 1;
  while (i < last && times[i] < timeS) i++;
  const span = times[i] - times[i - 1];
  if (!(span > 0)) return values[i];
  const t = (timeS - times[i - 1]) / span;
  return values[i - 1] + (values[i] - values[i - 1]) * t;
}

/**
 * Level every translation track of a clip in place, and hand back the curve that came
 * out so a mover can replay it. The largest travel wins — a VRMA carries one hips
 * track, so that is the clip's own.
 */
export function detrendClipRootY(
  clip: AnimationClip,
  restY?: number,
): { travel: number; shift: number; curve: RootYCurve | null } {
  let travel = 0;
  let shift = 0;
  let curve: RootYCurve | null = null;
  for (const track of clip.tracks) {
    if (!track.name.endsWith(".position")) continue;
    // Read the rise before levelling the track — it is what the mover has to supply.
    const own = rootYCurve(track.times, track.values);
    const detrended = detrendRootY(track.times, track.values, restY);
    track.values = detrended.values;
    if (Math.abs(detrended.travel) > Math.abs(travel)) {
      travel = detrended.travel;
      shift = detrended.shift;
      curve = own;
    } else if (curve === null) {
      shift = detrended.shift;
      curve = own;
    }
  }
  return { travel, shift, curve };
}

/**
 * Pin a track's horizontal motion to the origin: every X and Z key onto 0, Y untouched.
 * The authored X path comes out as a curve so a mover replaying it is the only thing
 * that translates the body. Depth is pinned, not replayed — desktop pets keep a stable size.
 */
export function detrendRootXZ(
  times: ArrayLike<number>,
  values: ArrayLike<number>,
): { values: Float32Array; travelX: number } {
  const out = new Float32Array(values);
  const count = times.length;
  if (count < 1 || values.length !== count * 3) return { values: out, travelX: 0 };

  const span = count > 1 ? times[count - 1] - times[0] : 0;
  const travelX = span > 0 ? out[(count - 1) * 3] - out[0] : 0;

  for (let i = 0; i < count; i++) {
    out[i * 3] = 0;
    out[i * 3 + 2] = 0;
  }
  return { values: out, travelX };
}

/**
 * Pin every translation track of a clip to the origin in X/Z, and hand back the
 * lateral X curve so a mover can replay it. The largest |X| travel wins — a VRMA
 * carries one hips track, so that is the clip's own.
 */
export function detrendClipRootXZ(clip: AnimationClip): {
  travelX: number;
  curve: RootYCurve | null;
} {
  let travelX = 0;
  let curve: RootYCurve | null = null;
  for (const track of clip.tracks) {
    if (!track.name.endsWith(".position")) continue;
    const own = rootChannelCurve(track.times, track.values, 0);
    const detrended = detrendRootXZ(track.times, track.values);
    track.values = detrended.values;
    if (Math.abs(detrended.travelX) > Math.abs(travelX)) {
      travelX = detrended.travelX;
      curve = own;
    } else if (curve === null) {
      curve = own;
    }
  }
  return { travelX, curve };
}
