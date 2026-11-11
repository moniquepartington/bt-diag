// The five preset workouts from the build spec. Speeds are MPH, incline values are device levels, durations are
// written as m:ss exactly as in the spec. These are editable starting points, not manufacturer-certified settings.
// Targets here are NOT limited to what has been validated on the treadmill; the engine refuses any workout whose
// targets exceed the verified hardware limits (see limits.js), so presets cannot bypass them.
import { mmss } from './workout.js';

const iv = (category, time, speedMph, inclineLevel) => ({ category, durationSec: mmss(time), speedMph, inclineLevel });

export const PRESETS = Object.freeze([
  { id: 'hill-voltage', name: 'Hill Voltage', description: 'Hill intervals (ELECTRIC HILLS)', intervals: [
    iv('Warmup', '2:00', 2.0, 0), iv('Training', '1:55', 2.3, 2), iv('Training', '2:25', 2.2, 5), iv('Training', '2:25', 2.1, 7),
    iv('Recovery', '2:10', 2.4, 2), iv('Recovery', '2:15', 2.3, 1), iv('Training', '2:10', 2.2, 6), iv('Training', '2:00', 2.0, 8),
    iv('Cooldown', '1:20', 2.0, 1), iv('Cooldown', '1:20', 1.8, 0) ] },
  { id: 'house-party', name: 'House Party', description: 'Brisk cardio', intervals: [
    iv('Warmup', '2:00', 2.0, 0), iv('Warmup', '2:00', 2.3, 1), iv('Training', '3:35', 2.6, 1), iv('Training', '3:00', 2.7, 1),
    iv('Training', '3:00', 2.8, 1), iv('Training', '2:20', 2.8, 2), iv('Recovery', '2:00', 2.6, 1), iv('Cooldown', '2:05', 2.0, 0) ] },
  { id: 'night-walk', name: 'Night Walk', description: 'Recovery walk (MIDNIGHT WALK)', intervals: [
    iv('Warmup', '3:05', 1.9, 0), iv('Recovery', '3:50', 2.1, 0), iv('Recovery', '3:55', 2.2, 0), iv('Recovery', '3:05', 2.2, 1),
    iv('Recovery', '3:15', 2.0, 0), iv('Cooldown', '1:30', 1.9, 0), iv('Cooldown', '1:20', 1.8, 0) ] },
  { id: 'climb-mode', name: 'Climb Mode', description: 'Climbing endurance', intervals: [
    iv('Warmup', '2:00', 2.0, 0), iv('Training', '1:40', 2.2, 2), iv('Training', '2:40', 2.2, 3), iv('Training', '2:40', 2.1, 4),
    iv('Training', '4:15', 2.1, 5), iv('Training', '2:25', 2.0, 6), iv('Training', '1:20', 2.0, 5), iv('Cooldown', '1:30', 2.0, 1),
    iv('Cooldown', '1:30', 1.8, 0) ] },
  { id: 'no-skips', name: 'No Skips', description: 'Mixed challenge', intervals: [
    iv('Warmup', '2:00', 2.0, 0), iv('Warmup', '1:15', 2.4, 1), iv('Training', '2:00', 2.7, 1), iv('Recovery', '2:00', 2.3, 2),
    iv('Training', '1:40', 2.2, 5), iv('Recovery', '1:40', 2.5, 1), iv('Training', '2:05', 2.2, 5), iv('Recovery', '2:00', 2.6, 1),
    iv('Training', '3:20', 2.6, 2), iv('Cooldown', '2:00', 1.8, 0) ] },
]);
