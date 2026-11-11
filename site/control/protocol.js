// FTMS Fitness Machine Control Point encoders for the Phase 2 belt-empty test.
// Only these five opcodes can ever be encoded. Reset (0x01), pause (0x08 0x02) and every other target are
// deliberately absent. Opcodes and layouts are from the Bluetooth FTMS spec and the reference project
// (aradix85/fitshow-treadmill-accessible); none has been exercised on a W400A yet.

export const OP = Object.freeze({ REQUEST_CONTROL: 0x00, SET_SPEED: 0x02, SET_INCLINE: 0x03, START: 0x07, STOP: 0x08 });

export const RESULT_TEXT = Object.freeze({ 1: 'success', 2: 'op code not supported', 3: 'invalid parameter', 4: 'operation failed', 5: 'control not permitted' });

/**
 * Hard caps for the Phase 2 control page (belt-empty test). Not user-editable on the page. The workout engine's
 * validated ceiling is separate and higher: see workout/limits.js (VERIFIED_LIMITS).
 */
export const LIMITS = Object.freeze({ maxMph: 1.0, maxInclineLevel: 2 });

/**
 * The treadmill's own speed grid: 0.6, 0.7, 0.8, 0.9 mph were reported as 0.96, 1.12, 1.28, 1.44 km/h
 * (build b5 capture), i.e. 1.6 km/h per mph. INFERRED from that capture, not documented.
 */
export const MPH_TO_KMH = 1.6;
export const capKmh = (limits = LIMITS) => limits.maxMph * MPH_TO_KMH;

/**
 * For DISPLAY and for reading the treadmill's own speed back as mph. Observed on the real treadmill (Stage A): it
 * reports 1.0, 1.4 and 2.0 mph as 1.61, 2.25 and 3.22 km/h, and 0.6 to 0.9 mph as 0.96 to 1.44 km/h, which is a
 * factor of 1.61 (floored). Commands still use MPH_TO_KMH above: the treadmill snaps them to its own 0.1 mph grid.
 */
export const KMH_PER_MPH_DISPLAY = 1.61;
export const kmhToMph = (kmh) => kmh / KMH_PER_MPH_DISPLAY;

export const encodeRequestControl = () => Uint8Array.of(OP.REQUEST_CONTROL);
export const encodeStart = () => Uint8Array.of(OP.START);
export const encodeStop = () => Uint8Array.of(OP.STOP, 0x01); // 0x01 = stop (0x02 would be pause)

/** @returns {{bytes: Uint8Array, kmh: number}} or throws RangeError with a human-readable reason. */
export function encodeSetSpeedMph(mph, ranges, limits = LIMITS) {
  if (!ranges?.speed) throw new RangeError("the treadmill's speed range has not been read");
  if (typeof mph !== 'number' || !Number.isFinite(mph)) throw new RangeError('speed is not a number');
  const tenths = Math.round(mph * 10);
  if (Math.abs(mph * 10 - tenths) > 1e-6) throw new RangeError('speed must be a multiple of 0.1 mph');
  if (mph > limits.maxMph + 1e-9) throw new RangeError(`speed ${mph} mph is above the test limit of ${limits.maxMph} mph`);
  const centiKmh = tenths * 16; // integer maths: 0.1 mph = 0.16 km/h = 16 units of 0.01 km/h
  const kmh = centiKmh / 100;
  if (kmh < ranges.speed.minKmh - 1e-6) throw new RangeError(`speed ${mph} mph is below the treadmill minimum (${ranges.speed.minKmh} km/h)`);
  if (kmh > ranges.speed.maxKmh + 1e-6) throw new RangeError(`speed ${mph} mph is above the treadmill maximum (${ranges.speed.maxKmh} km/h)`);
  return { bytes: Uint8Array.of(OP.SET_SPEED, centiKmh & 0xff, (centiKmh >> 8) & 0xff), kmh };
}

/**
 * Incline "level" is sent as the same number in percent (level 2 = 2.0 %). That mapping is an
 * inference from matching 0-12 ranges and is checked by reading the incline back after every command.
 */
export function encodeSetInclineLevel(level, ranges, limits = LIMITS) {
  if (!ranges?.incline) throw new RangeError("the treadmill's incline range has not been read");
  if (!Number.isInteger(level)) throw new RangeError('incline must be a whole number');
  if (level < 0 || level > limits.maxInclineLevel) throw new RangeError(`incline ${level} is outside the test limit 0 to ${limits.maxInclineLevel}`);
  if (level < ranges.incline.minPct || level > ranges.incline.maxPct) throw new RangeError(`incline ${level} is outside the treadmill range`);
  const tenthsPct = level * 10;
  return { bytes: Uint8Array.of(OP.SET_INCLINE, tenthsPct & 0xff, (tenthsPct >> 8) & 0xff), pct: level };
}

/** Control Point indication: 0x80, request opcode, result code. */
export function parseIndication(bytes) {
  if (!bytes || bytes.length < 3 || bytes[0] !== 0x80) return null;
  return { op: bytes[1], result: bytes[2], ok: bytes[2] === 0x01 };
}
