// SIMULATED treadmill for testing the Phase 2 controller. Behaviour is modelled on the Bluetooth FTMS spec and on
// the read-only captures from the real module (3 s countdown after start, minimum belt speed 0.96 km/h, two
// Treadmill Data packet types, 0x80 <op> <result> indications). It is NOT the W400A; faults can be injected.
import { CHARS } from '../site/ftms.js';

const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
const s16 = (v) => u16(v & 0xffff);

/**
 * @param {{clock:{setTimeout:Function}, emit:(uuid:string, bytes:Uint8Array)=>void, faults?:object}} o
 * faults: noAck, badResult:{op,code}, writeThrows, ackDelayMs, takeControlStartsBelt, ignoreSpeed, ignoreIncline,
 *         inclineOffset, stopIgnored, overspeedOnStart, telemetryStopped, duplicateAck, wrongOpAck
 */
export function createSim({ clock, emit, faults = {} }) {
  const s = { control: false, running: false, speedKmh: 0, inclinePct: 0, training: 0x01, targetKmh: null, distance: 0, elapsed: 0, minKmh: 0.96, maxKmh: 8.05, maxIncline: 12 };
  const indicate = (op, result) => {
    if (faults.noAck || faults.noAckOp === op) return;
    const code = faults.badResult && faults.badResult.op === op ? faults.badResult.code : result;
    const sendOp = faults.wrongOpAck ? 0x7f : op;
    clock.setTimeout(() => {
      emit(CHARS.controlPoint, Uint8Array.of(0x80, sendOp, code));
      if (faults.duplicateAck) emit(CHARS.controlPoint, Uint8Array.of(0x80, sendOp, code));
    }, faults.ackDelayMs ?? 50);
  };
  const training = (code) => { s.training = code; emit(CHARS.trainingStatus, Uint8Array.of(0x01, code)); };
  const machine = (...b) => emit(CHARS.machineStatus, Uint8Array.from(b));

  function startSequence() {
    if (s.running || s.training === 0x0e) return;
    if (faults.startIgnored) return; // acknowledged, but the belt never starts
    machine(0x04);
    training(0x0e); // pre-workout countdown
    clock.setTimeout(() => {
      s.running = true;
      s.speedKmh = faults.startSpeedKmh ?? (faults.overspeedOnStart ? 3.0 : s.targetKmh ?? s.minKmh);
      training(0x0d);
      machine(0x04);
    }, 3000);
  }
  function stopSequence() {
    s.running = false;
    s.speedKmh = 0;
    // After a stop the belt starts again at its minimum (seen on the real treadmill across connections).
    // faults.rememberTarget models the OTHER possibility: restarting at the previous target speed (not yet seen on hardware).
    if (!faults.rememberTarget) s.targetKmh = null;
    machine(0x02, 0x01);
    training(0x0f);
  }

  function packets() {
    const dist = s.distance;
    const t1 = Uint8Array.from([0x8c, 0x05, ...u16(Math.round(s.speedKmh * 100)), dist & 0xff, (dist >> 8) & 0xff, (dist >> 16) & 0xff, ...s16(Math.round(s.inclinePct * 10)), 0, 0, 0, 0, 0xff, 0xff, 0xff, 0, ...u16(s.elapsed)]);
    const t2 = Uint8Array.from([0x01, 0x20, s.running ? 1 : 0, 0, 0]);
    return [t1, t2];
  }
  let ticking = true;
  const tick = () => {
    if (!ticking) return;
    if (s.running) { s.elapsed += 1; s.distance += Math.round(s.speedKmh * 1000 / 3600); }
    if (!faults.telemetryStopped) for (const p of packets()) emit(CHARS.treadmillData, p);
    clock.setTimeout(tick, 1000);
  };

  return {
    state: s,
    start() { clock.setTimeout(tick, 1000); },
    halt() { ticking = false; },
    /** What a Web Bluetooth writeValue() on the control point would do. */
    write(bytes) {
      if (faults.writeThrows) throw new Error('GATT write failed (simulated)');
      const op = bytes[0];
      if (op !== 0x00 && !s.control) return indicate(op, 0x05);
      switch (op) {
        case 0x00:
          s.control = true;
          indicate(op, 0x01);
          if (faults.takeControlRaisesSpeed && s.running) s.speedKmh += 0.5;
          if (faults.takeControlStartsBelt) startSequence();
          break;
        case 0x07:
          indicate(op, 0x01);
          startSequence();
          break;
        case 0x08:
          indicate(op, 0x01);
          if (!faults.stopIgnored) stopSequence();
          break;
        case 0x02: {
          const kmh = (bytes[1] | (bytes[2] << 8)) / 100;
          if (kmh < s.minKmh || kmh > s.maxKmh) return indicate(op, 0x03);
          s.targetKmh = kmh;
          if (s.running && !faults.ignoreSpeed) s.speedKmh = kmh;
          indicate(op, 0x01);
          break;
        }
        case 0x03: {
          const raw = bytes[1] | (bytes[2] << 8);
          const pct = (raw > 0x7fff ? raw - 0x10000 : raw) / 10;
          if (pct < 0 || pct > s.maxIncline) return indicate(op, 0x03);
          if (!faults.ignoreIncline) s.inclinePct = pct + (faults.inclineOffset ?? 0);
          indicate(op, 0x01);
          break;
        }
        default:
          indicate(op, 0x02); // op code not supported
      }
    },
    /** A new Bluetooth connection starts without control; the belt itself carries on (observed on the real treadmill). */
    dropControl() { s.control = false; },
    /** Things a person can do at the console. */
    remoteStart() { startSequence(); },
    remoteStop() { stopSequence(); },
  };
}
