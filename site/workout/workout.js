// Workout data model: validation, totals, and checking against hardware limits. Pure functions, no Bluetooth.

export const CATEGORIES = Object.freeze(['Warmup', 'Training', 'Recovery', 'Cooldown']);
export const DURATION_STEP_SEC = 5;

/** "m:ss" to seconds. Used only to write presets in the same form as the spec. */
export const mmss = (text) => {
  const m = /^(\d+):([0-5]\d)$/.exec(text);
  if (!m) throw new RangeError(`bad duration "${text}"`);
  return Number(m[1]) * 60 + Number(m[2]);
};

export const totalSeconds = (workout) => workout.intervals.reduce((sum, i) => sum + i.durationSec, 0);

/** Returns a list of problems (empty = valid). Does not know about hardware limits. */
export function validateWorkout(workout) {
  const errors = [];
  if (!workout || typeof workout !== 'object') return ['workout is missing'];
  if (typeof workout.name !== 'string' || !workout.name.trim()) errors.push('name is empty');
  if (!Array.isArray(workout.intervals) || workout.intervals.length === 0) return [...errors, 'a workout needs at least one interval'];
  workout.intervals.forEach((iv, n) => {
    const at = `interval ${n + 1}`;
    if (!CATEGORIES.includes(iv.category)) errors.push(`${at}: unknown category "${iv.category}"`);
    if (!Number.isInteger(iv.durationSec) || iv.durationSec <= 0) errors.push(`${at}: duration must be a positive whole number of seconds`);
    else if (iv.durationSec % DURATION_STEP_SEC !== 0) errors.push(`${at}: duration ${iv.durationSec}s is not a multiple of ${DURATION_STEP_SEC}s`);
    if (typeof iv.speedMph !== 'number' || !Number.isFinite(iv.speedMph) || iv.speedMph <= 0) errors.push(`${at}: speed must be a positive number`);
    else if (Math.abs(iv.speedMph * 10 - Math.round(iv.speedMph * 10)) > 1e-6) errors.push(`${at}: speed ${iv.speedMph} is not a multiple of 0.1 mph`);
    if (!Number.isInteger(iv.inclineLevel) || iv.inclineLevel < 0) errors.push(`${at}: incline must be a whole number, 0 or more`);
  });
  return errors;
}

/**
 * Checks every interval against hardware limits. NEVER clamps: a target outside the limits is reported, and the
 * workout is refused. The limits come from outside the workout, so a preset cannot raise them.
 */
export function checkAgainstLimits(workout, limits) {
  const violations = [];
  workout.intervals.forEach((iv, n) => {
    if (iv.speedMph > limits.maxMph + 1e-9) violations.push({ interval: n + 1, field: 'speedMph', value: iv.speedMph, limit: limits.maxMph });
    if (iv.inclineLevel > limits.maxInclineLevel) violations.push({ interval: n + 1, field: 'inclineLevel', value: iv.inclineLevel, limit: limits.maxInclineLevel });
  });
  return violations;
}
