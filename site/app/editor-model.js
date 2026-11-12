// Pure editing operations on a workout. Every function returns a NEW workout and never changes its input, so the UI can
// keep "saved" and "being edited" copies side by side. Durations move in 5 second steps, speed in 0.1 mph steps and
// incline in whole levels, all clamped to the limits the caller passes in (the verified hardware limits).
import { validateWorkout, checkAgainstLimits, totalSeconds, CATEGORIES, DURATION_STEP_SEC } from '../workout/workout.js';

export const MIN_SPEED_MPH = 0.6; // the treadmill's minimum speed (seen on hardware)
export const MAX_INTERVAL_SEC = 3 * 3600;
export { CATEGORIES, DURATION_STEP_SEC, totalSeconds };

const clone = (w) => structuredClone(w);
const inRange = (w, i) => Number.isInteger(i) && i >= 0 && i < w.intervals.length;
const snap = (sec) => Math.min(MAX_INTERVAL_SEC, Math.max(DURATION_STEP_SEC, Math.round(sec / DURATION_STEP_SEC) * DURATION_STEP_SEC));

export const newInterval = (over = {}) => ({ category: 'Training', durationSec: 60, speedMph: 1.0, inclineLevel: 0, ...over });

export function newWorkout() {
  return { name: 'New workout', description: '', intervals: [newInterval({ category: 'Warmup', durationSec: 300 })] };
}

export function setName(w, name) { const c = clone(w); c.name = String(name); return c; }
export function setDescription(w, text) { const c = clone(w); c.description = String(text); return c; }

/** Adds an interval after the given position (default: at the end), copying that interval's values. */
export function addInterval(w, afterIndex = w.intervals.length - 1) {
  const c = clone(w);
  const at = inRange(c, afterIndex) ? afterIndex : c.intervals.length - 1;
  const ref = c.intervals[at];
  c.intervals.splice(at + 1, 0, newInterval(ref ? { durationSec: ref.durationSec, speedMph: ref.speedMph, inclineLevel: ref.inclineLevel } : {}));
  return c;
}

export function duplicateInterval(w, i) {
  if (!inRange(w, i)) return w;
  const c = clone(w);
  c.intervals.splice(i + 1, 0, { ...c.intervals[i] });
  return c;
}

/** A workout always keeps at least one interval, so deleting the last one does nothing. */
export function deleteInterval(w, i) {
  if (!inRange(w, i) || w.intervals.length <= 1) return w;
  const c = clone(w);
  c.intervals.splice(i, 1);
  return c;
}

/** dir is -1 (earlier) or +1 (later). Out-of-range moves do nothing. */
export function moveInterval(w, i, dir) {
  const j = i + dir;
  if (!inRange(w, i) || !inRange(w, j) || Math.abs(dir) !== 1) return w;
  const c = clone(w);
  [c.intervals[i], c.intervals[j]] = [c.intervals[j], c.intervals[i]];
  return c;
}

export function setCategory(w, i, category) {
  if (!inRange(w, i) || !CATEGORIES.includes(category)) return w;
  const c = clone(w);
  c.intervals[i].category = category;
  return c;
}

export function setDuration(w, i, { minutes = 0, seconds = 0 }) {
  if (!inRange(w, i)) return w;
  const c = clone(w);
  c.intervals[i].durationSec = snap(Number(minutes) * 60 + Number(seconds));
  return c;
}

export const nudgeDuration = (w, i, deltaSec) => (inRange(w, i) ? setDuration(w, i, { seconds: w.intervals[i].durationSec + deltaSec }) : w);

/** deltaTenths: +1 is +0.1 mph. Integer maths, so 1.0 + 0.1 is exactly 1.1. */
export function nudgeSpeed(w, i, deltaTenths, limits) {
  if (!inRange(w, i)) return w;
  const c = clone(w);
  const tenths = Math.round(c.intervals[i].speedMph * 10) + Math.round(deltaTenths);
  c.intervals[i].speedMph = Math.min(Math.round(limits.maxMph * 10), Math.max(Math.round(MIN_SPEED_MPH * 10), tenths)) / 10;
  return c;
}

export function nudgeIncline(w, i, delta, limits) {
  if (!inRange(w, i)) return w;
  const c = clone(w);
  c.intervals[i].inclineLevel = Math.min(limits.maxInclineLevel, Math.max(0, Math.round(c.intervals[i].inclineLevel + delta)));
  return c;
}

/** Everything the editor must show before it lets the user save. */
export function problems(w, limits) {
  const errors = validateWorkout(w);
  const violations = errors.length ? [] : checkAgainstLimits(w, limits);
  return { ok: errors.length === 0 && violations.length === 0, errors, violations };
}

export function summary(w) {
  const speeds = w.intervals.map((i) => i.speedMph);
  return {
    totalSec: totalSeconds(w),
    count: w.intervals.length,
    minSpeedMph: Math.min(...speeds),
    maxSpeedMph: Math.max(...speeds),
    maxIncline: Math.max(...w.intervals.map((i) => i.inclineLevel)),
  };
}
