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

// The diagnostic report the user can copy from Settings after a hardware run. Pure function. It holds the app's own
// activity log, once-a-second readings, and the engine and controller state: no device name, no Bluetooth address,
// no serial number, nothing about the person.
export function buildReport({ build, now = new Date().toISOString(), events = [], telemetry = [], engine = {}, controller = {}, limits = {}, storagePersistent = null, wake = null }) {
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
  }, null, 2);
}
