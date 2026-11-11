// Hardware limits that have actually been VALIDATED on the real treadmill, kept apart from workout targets.
// Presets (presets.js) deliberately do not import this file. Raising these numbers is only allowed after a
// separately approved, belt-empty hardware test at the new values, and the control layer (control/protocol.js)
// enforces the same numbers a second time at the moment a command is encoded.
import { LIMITS } from '../control/protocol.js';

export const VERIFIED_LIMITS = LIMITS; // frozen: { maxMph: 1.0, maxInclineLevel: 2 } (Phase 2 hardware validation)
