/**
 * One row per real speed reading from the treadmill (not one per whole second), so the record shows the true
 * timing of the readings. Rows are [seconds since the page loaded, speed km/h, incline %, status code].
 */
export class PacketLog {
  constructor(cap = 4000) { this.cap = cap; this.rows = []; this.lastAt = null; }
  /** @param at the reading's own timestamp (ms): a new value means a new packet arrived. */
  add(at, speedKmh, inclinePct, training) {
    if (speedKmh == null || at === this.lastAt || this.rows.length >= this.cap) return false;
    this.lastAt = at;
    this.rows.push([+(at / 1000).toFixed(1), speedKmh, inclinePct ?? null, training ?? null]);
    return true;
  }
}

/**
 * Shrinks a run of readings for storage: keeps a row only when speed, incline or status changed, and keeps both rows
 * either side of any gap longer than gapSec, so changes and dropouts stay visible without thousands of identical rows.
 */
export function compactTelemetry(rows, gapSec = 1.6) {
  const out = [];
  let kept = null;
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    const changed = !kept || r[1] !== kept[1] || r[2] !== kept[2] || r[3] !== kept[3];
    const gap = prev && r[0] - prev[0] > gapSec;
    if (changed || gap || i === rows.length - 1) {
      if (gap && out[out.length - 1] !== prev) out.push(prev);
      out.push(r);
      kept = r;
    }
  });
  return out;
}

// The diagnostic report the user can copy from Settings (or the workout screen) after a hardware run. Pure function.
// It holds the app's own activity log, once-a-second readings, and the engine and controller state: no device name,
// no Bluetooth address, no serial number, nothing about the person. `previous` is the saved log of earlier page loads
// (a reload would otherwise erase the record of a run that went wrong).
export function buildReport({ build, now = new Date().toISOString(), events = [], telemetry = [], engine = {}, controller = {}, limits = {}, storagePersistent = null, wake = null, previous = [] }) {
  return JSON.stringify({
    build,
    generatedAt: now,
    limits,
    engine: {
      state: engine.state ?? null,
      workout: engine.name ?? null,
      elapsedMs: engine.elapsedMs ?? null,
      totalMs: engine.totalMs ?? null,
      intervalIndex: engine.intervalIndex ?? null,
      override: engine.override ?? null,
      fault: engine.fault ? { reason: engine.fault.reason, detail: engine.fault.detail, belt: engine.fault.belt, beltKnown: engine.fault.beltKnown } : null,
    },
    controller: {
      connected: !!controller.link,
      hasControl: !!controller.hasControl,
      lock: controller.lock ? { reason: controller.lock.reason, detail: controller.lock.detail } : null,
      recovery: !!controller.recovery,
    },
    storagePersistent,
    screenWake: wake,
    events: events.slice(-400),
    telemetry, // [seconds since load, speed km/h, incline %, status code]
    previousSessions: previous, // earlier page loads on this phone: { savedAt, events, telemetry (changes only) }
  }, null, 2);
}
