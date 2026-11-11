// Helpers that turn raw readings into the facts the stages are meant to establish. Pure functions.

/** What speed did the belt restart at after a Stop? The workout engine assumes the minimum. */
export function restartVerdict(restartKmh, minKmh, previousTargetKmh) {
  const near = (a, b) => b != null && Math.abs(a - b) <= 0.08;
  if (near(restartKmh, minKmh)) return { kind: 'minimum', text: `restarted at the minimum (${restartKmh.toFixed(2)} km/h)` };
  if (near(restartKmh, previousTargetKmh)) return { kind: 'previous', text: `restarted at the PREVIOUS speed (${restartKmh.toFixed(2)} km/h), not the minimum` };
  return { kind: 'other', text: `restarted at ${restartKmh.toFixed(2)} km/h, which is neither the minimum nor the previous speed` };
}

/** Compact record of readings for the report: one sample per second, capped. */
export class TelemetryLog {
  constructor(cap = 900) { this.cap = cap; this.rows = []; this.lastSecond = -1; }
  add(nowMs, speedKmh, inclinePct, training) {
    const sec = Math.floor(nowMs / 1000);
    if (sec === this.lastSecond || this.rows.length >= this.cap || speedKmh == null) return false;
    this.lastSecond = sec;
    this.rows.push([+(nowMs / 1000).toFixed(1), speedKmh, inclinePct ?? null, training ?? null]);
    return true;
  }
}
