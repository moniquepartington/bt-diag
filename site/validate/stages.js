// Staged hardware-validation definitions. These are the values the stages exist to
// test, on a dedicated page, belt empty. VERIFIED_LIMITS (workout/limits.js) is raised only after a stage has been run,
// recorded and approved. Stages A and B have been, so it now equals Stage B's limits.
//
// Each stage needs its own approval. That is enforced here: a stage that is not listed in ENABLED_STAGES cannot be
// unlocked by the page. ENABLED_STAGES is changed (and the page redeployed) only after the previous stage's results
// have been reviewed.
import { mmss } from '../workout/workout.js';

const iv = (category, time, speedMph, inclineLevel) => ({ category, durationSec: mmss(time), speedMph, inclineLevel });

export const STAGES = Object.freeze({
  A: Object.freeze({
    id: 'A',
    label: 'Stage A',
    summary: 'up to 2.0 mph and incline 5: the jump from the minimum speed, speed steps both ways, incline steps, and what speed the belt restarts at after a stop',
    limits: Object.freeze({ maxMph: 2.0, maxInclineLevel: 5 }),
    speedsMph: Object.freeze([0.6, 1.0, 1.4, 2.0]),
    inclines: Object.freeze([0, 2, 5]),
    workout: null,
  }),
  B: Object.freeze({
    id: 'B',
    label: 'Stage B',
    summary: 'up to 2.8 mph and incline 8, plus a short workout run by the engine with a pause and resume',
    limits: Object.freeze({ maxMph: 2.8, maxInclineLevel: 8 }),
    speedsMph: Object.freeze([0.6, 1.0, 1.4, 2.0, 2.4, 2.8]),
    inclines: Object.freeze([0, 2, 5, 8]),
    workout: Object.freeze({
      name: 'Validation run (Stage B)',
      description: 'Short interval run covering the preset range. Not one of the five presets.',
      intervals: Object.freeze([
        iv('Warmup', '0:20', 2.0, 0), iv('Training', '0:20', 2.8, 8), iv('Recovery', '0:20', 2.0, 2), iv('Training', '0:20', 2.4, 5), iv('Cooldown', '0:20', 1.8, 0),
      ]),
    }),
  }),
});

/**
 * Stages unlockable in THIS build. Stage A was run and recorded on hardware, then Stage B was approved, so build v2
 * lists both. A stage is added here only after its own explicit approval; any later stage stays out until then.
 */
export const ENABLED_STAGES = Object.freeze(['A', 'B']);

export const unlockPhrase = (id) => `STAGE ${id}`;

/** The user must type the stage name; a stage that is not enabled in this build cannot be unlocked at all. */
export function unlockStage(id, typed, enabled = ENABLED_STAGES) {
  const stage = STAGES[id];
  if (!stage) return { ok: false, reason: 'unknown stage' };
  if (!enabled.includes(id)) return { ok: false, reason: `${stage.label} is not enabled in this build; it needs separate approval` };
  if (String(typed ?? '').trim().toUpperCase() !== unlockPhrase(id)) return { ok: false, reason: `type ${unlockPhrase(id)} to unlock` };
  return { ok: true, stage };
}
