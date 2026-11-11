// Hardware limits that have actually been VALIDATED on the real treadmill, kept apart from workout targets.
//
// Provenance: belt-empty validation on the real treadmill, both stages recorded in PHASE3.md.
//   Stage A: speeds up to 2.0 mph, incline up to 5.   Stage B: speeds up to 2.8 mph, incline up to 8.
// Stage B's ceiling is the validated range, and it is exactly the top of the five presets.
//
// Presets (presets.js) deliberately do not import this file. The workout engine checks every interval against
// these numbers before a workout can start and refuses (never clamps) anything above them. The control layer
// enforces the same numbers a second time at the moment a command is encoded, as long as the Controller is created
// with them. The Phase 2 control page keeps its own, lower caps (control/protocol.js LIMITS).
//
// Raising these numbers again requires a separately approved, belt-empty hardware test at the new values.
export const VERIFIED_LIMITS = Object.freeze({ maxMph: 2.8, maxInclineLevel: 8 });
