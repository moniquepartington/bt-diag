// Pure helpers for reading standard Bluetooth FTMS (Fitness Machine Service) data.
// No Bluetooth access happens here, so everything in this file can be unit-tested.
// Layouts follow the Bluetooth SIG FTMS spec; none of this has been verified on a W400A yet.

export const KMH_TO_MPH = 0.621371;

/** Expand a 16-bit Bluetooth UUID (e.g. 0x1826) into the full 128-bit string. */
export const uuid16 = (n) => `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;

export const SERVICES = {
  fitnessMachine: uuid16(0x1826),
  deviceInfo: uuid16(0x180a),
  battery: uuid16(0x180f),
  runningSpeedCadence: uuid16(0x1814),
  vendorFff0: uuid16(0xfff0), // vendor service documented by aradix85/fitshow-treadmill-accessible
};

export const CHARS = {
  ftmsFeature: uuid16(0x2acc),
  treadmillData: uuid16(0x2acd),
  trainingStatus: uuid16(0x2ad3),
  speedRange: uuid16(0x2ad4),
  inclineRange: uuid16(0x2ad5),
  controlPoint: uuid16(0x2ad9), // NEVER touched by the diagnostic page
  machineStatus: uuid16(0x2ada),
  vendorFff1: uuid16(0xfff1),
};

/** Characteristics the page is allowed to READ (name shown in the report). */
export const READABLE = new Map([
  [uuid16(0x2a29), 'Manufacturer name'],
  [uuid16(0x2a24), 'Model number'],
  [uuid16(0x2a25), 'Serial number'],
  [uuid16(0x2a26), 'Firmware revision'],
  [uuid16(0x2a27), 'Hardware revision'],
  [uuid16(0x2a28), 'Software revision'],
  [uuid16(0x2a19), 'Battery level'],
  [CHARS.ftmsFeature, 'FTMS feature'],
  [CHARS.speedRange, 'Supported speed range'],
  [CHARS.inclineRange, 'Supported incline range'],
]);

/** Characteristics the page subscribes to by default (notifications only). */
export const NOTIFY_DEFAULT = [CHARS.treadmillData, CHARS.trainingStatus, CHARS.machineStatus];

export function hex(dv) {
  return Array.from(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength), (b) => b.toString(16).padStart(2, '0')).join(' ');
}

export function text(dv) {
  return new TextDecoder('utf-8').decode(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)).replace(/\0+$/, '');
}

const u24 = (dv, o) => dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16);

// ---------- Treadmill Data (0x2ACD) ----------
// Flags bit0 is inverted: speed is present when bit0 == 0.
export function parseTreadmillData(dv) {
  const out = { raw: hex(dv), fields: {}, warnings: [] };
  try {
    if (dv.byteLength < 2) throw new RangeError('shorter than the 2-byte flags field');
    const flags = dv.getUint16(0, true);
    out.flags = '0x' + flags.toString(16).padStart(4, '0');
    let o = 2;
    const f = out.fields;
    const need = (n, what) => {
      if (o + n > dv.byteLength) throw new RangeError(`truncated while reading ${what}`);
    };
    const bit = (n) => (flags >> n) & 1;

    if (!bit(0)) { need(2, 'speed'); f.speedKmh = dv.getUint16(o, true) / 100; f.speedMph = f.speedKmh * KMH_TO_MPH; o += 2; }
    if (bit(1)) { need(2, 'average speed'); f.avgSpeedKmh = dv.getUint16(o, true) / 100; o += 2; }
    if (bit(2)) { need(3, 'distance'); f.distanceM = u24(dv, o); o += 3; }
    if (bit(3)) {
      need(4, 'incline');
      f.inclinePct = dv.getInt16(o, true) / 10;
      f.rampAngleDeg = dv.getInt16(o + 2, true) / 10;
      o += 4;
    }
    if (bit(4)) { need(4, 'elevation gain'); f.elevGainPosM = dv.getUint16(o, true) / 10; f.elevGainNegM = dv.getUint16(o + 2, true) / 10; o += 4; }
    if (bit(5)) { need(1, 'pace'); f.paceMinPerKm = dv.getUint8(o) / 10; o += 1; }
    if (bit(6)) { need(1, 'average pace'); f.avgPaceMinPerKm = dv.getUint8(o) / 10; o += 1; }
    if (bit(7)) {
      need(5, 'energy');
      f.energyKcal = dv.getUint16(o, true);
      const perHour = dv.getUint16(o + 2, true);
      const perMin = dv.getUint8(o + 4);
      f.energyPerHour = perHour === 0xffff ? null : perHour; // 0xFFFF = not available
      f.energyPerMin = perMin === 0xff ? null : perMin; // 0xFF = not available
      o += 5;
    }
    if (bit(8)) { need(1, 'heart rate'); f.heartRate = dv.getUint8(o); o += 1; }
    if (bit(9)) { need(1, 'MET'); f.met = dv.getUint8(o) / 10; o += 1; }
    if (bit(10)) { need(2, 'elapsed time'); f.elapsedS = dv.getUint16(o, true); o += 2; }
    if (bit(11)) { need(2, 'remaining time'); f.remainingS = dv.getUint16(o, true); o += 2; }
    if (bit(12)) { need(4, 'force/power'); f.forceN = dv.getInt16(o, true); f.powerW = dv.getInt16(o + 2, true); o += 4; }

    if (o !== dv.byteLength) out.warnings.push(`${dv.byteLength - o} unparsed trailing byte(s)`);
  } catch (e) {
    out.warnings.push(e.message);
  }
  return out;
}

// ---------- Fitness Machine Feature (0x2ACC) ----------
const FEATURE_BITS = ['Average speed', 'Cadence', 'Total distance', 'Inclination', 'Elevation gain', 'Pace', 'Step count', 'Resistance level', 'Stride count', 'Expended energy', 'Heart rate', 'Metabolic equivalent', 'Elapsed time', 'Remaining time', 'Power measurement', 'Force on belt / power output', 'User data retention'];
const TARGET_BITS = ['Speed target', 'Inclination target', 'Resistance target', 'Power target', 'Heart-rate target', 'Target energy', 'Target steps', 'Target strides', 'Target distance', 'Target training time', 'Target time in two HR zones', 'Target time in three HR zones', 'Target time in five HR zones', 'Indoor bike simulation', 'Wheel circumference', 'Spin down', 'Target cadence'];

const setBits = (value, names) => names.filter((_, i) => (value >>> i) & 1);

export function parseFeature(dv) {
  if (dv.byteLength < 8) return { raw: hex(dv), warnings: ['expected 8 bytes'] };
  const machine = dv.getUint32(0, true);
  const target = dv.getUint32(4, true);
  return { raw: hex(dv), machineFeatures: setBits(machine, FEATURE_BITS), targetSettings: setBits(target, TARGET_BITS), warnings: [] };
}

// ---------- Supported ranges (0x2AD4, 0x2AD5) ----------
export function parseSpeedRange(dv) {
  if (dv.byteLength < 6) return { raw: hex(dv), warnings: ['expected 6 bytes'] };
  const min = dv.getUint16(0, true) / 100, max = dv.getUint16(2, true) / 100, step = dv.getUint16(4, true) / 100;
  return { raw: hex(dv), minKmh: min, maxKmh: max, stepKmh: step, minMph: min * KMH_TO_MPH, maxMph: max * KMH_TO_MPH, warnings: [] };
}

export function parseInclineRange(dv) {
  if (dv.byteLength < 6) return { raw: hex(dv), warnings: ['expected 6 bytes'] };
  return { raw: hex(dv), minPct: dv.getInt16(0, true) / 10, maxPct: dv.getInt16(2, true) / 10, stepPct: dv.getUint16(4, true) / 10, warnings: [] };
}

// ---------- Training Status (0x2AD3) ----------
const TRAINING_STATUS = ['Other', 'Idle', 'Warming up', 'Low-intensity interval', 'High-intensity interval', 'Recovery interval', 'Isometric', 'Heart-rate control', 'Fitness test', 'Speed too low', 'Speed too high', 'Cool down', 'Watt control', 'Manual mode (quick start)', 'Pre-workout', 'Post-workout'];

export function parseTrainingStatus(dv) {
  if (dv.byteLength < 2) return { raw: hex(dv), warnings: ['expected at least 2 bytes'] };
  const code = dv.getUint8(1);
  return { raw: hex(dv), code, name: TRAINING_STATUS[code] ?? `Unknown (0x${code.toString(16)})`, warnings: [] };
}

// ---------- Machine Status (0x2ADA) ----------
const MACHINE_STATUS = { 0x01: 'Reset', 0x02: 'Stopped or paused by user', 0x03: 'Stopped by safety key', 0x04: 'Started or resumed by user', 0x05: 'Target speed changed', 0x06: 'Target incline changed', 0xff: 'Control permission lost' };

export function parseMachineStatus(dv) {
  if (dv.byteLength < 1) return { raw: hex(dv), warnings: ['empty'] };
  const code = dv.getUint8(0);
  const out = { raw: hex(dv), code, name: MACHINE_STATUS[code] ?? `Other (0x${code.toString(16)})`, warnings: [] };
  if (code === 0x02 && dv.byteLength >= 2) out.detail = dv.getUint8(1) === 1 ? 'stop' : dv.getUint8(1) === 2 ? 'pause' : `param ${dv.getUint8(1)}`;
  if (code === 0x05 && dv.byteLength >= 3) out.detail = `${dv.getUint16(1, true) / 100} km/h`;
  if (code === 0x06 && dv.byteLength >= 3) out.detail = `${dv.getInt16(1, true) / 10} %`;
  return out;
}

/** Pick the right decoder for a characteristic UUID; returns null if we have none. */
export function decode(uuid, dv) {
  switch (uuid) {
    case CHARS.treadmillData: return parseTreadmillData(dv);
    case CHARS.ftmsFeature: return parseFeature(dv);
    case CHARS.speedRange: return parseSpeedRange(dv);
    case CHARS.inclineRange: return parseInclineRange(dv);
    case CHARS.trainingStatus: return parseTrainingStatus(dv);
    case CHARS.machineStatus: return parseMachineStatus(dv);
    default: return null;
  }
}
