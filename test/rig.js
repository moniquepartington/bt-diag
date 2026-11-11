// Test harness: Controller + simulated treadmill on a fake clock. No Bluetooth, nothing physical.
import { Controller } from '../site/control/controller.js';
import { routeNotification } from '../site/control/bridge.js';
import { createSim } from './sim-treadmill.js';

export class FakeClock {
  constructor() { this.t = 0; this.q = []; this.seq = 0; }
  now() { return this.t; }
  setTimeout(fn, ms) { const id = ++this.seq; this.q.push({ id, at: this.t + ms, fn }); return id; }
  clearTimeout(id) { this.q = this.q.filter((x) => x.id !== id); }
  advance(ms) {
    const end = this.t + ms;
    for (;;) {
      this.q.sort((a, b) => a.at - b.at || a.id - b.id);
      const n = this.q[0];
      if (!n || n.at > end) break;
      this.q.shift();
      this.t = Math.max(this.t, n.at); // never run backwards after skip()
      n.fn();
    }
    this.t = end;
  }
  /** Time passes but NO callback runs: what a suspended browser tab looks like. Overdue timers fire at the next advance(). */
  skip(ms) { this.t += ms; }
}

export const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

export function makeRig(faults = {}, { armed = true, warmup = true, beltRunning = false, limits } = {}) {
  const clock = new FakeClock();
  const written = [];
  const writtenAt = [];
  const logs = [];
  const rig = { clock, written, writtenAt, logs, maxInflight: 0 };
  let sim;
  let inflight = 0;
  const transport = {
    write: async (bytes) => {
      written.push(Array.from(bytes));
      writtenAt.push(clock.now());
      inflight += 1;
      rig.maxInflight = Math.max(rig.maxInflight, inflight);
      return sim.write(bytes);
    },
  };
  const ctl = new Controller({ transport, clock, limits, onLog: (l) => logs.push(l) });
  ctl.subscribe((snap) => { if (!snap.pending) inflight = 0; });
  sim = createSim({ clock, faults, emit: (uuid, bytes) => routeNotification(ctl, uuid, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)) });
  sim.start();
  if (beltRunning) Object.assign(sim.state, { running: true, speedKmh: 0.96, training: 0x0d }); // e.g. page reloaded while the belt runs
  ctl.connected({ speed: { minKmh: 0.96, maxKmh: 8.05 }, incline: { minPct: 0, maxPct: 12 } });
  ctl.feedTraining(sim.state.training);
  ctl.setArmed(armed);
  if (warmup) clock.advance(1100); // let telemetry arrive
  return Object.assign(rig, { sim, ctl, faults }); // faults can be changed mid-test
}

/** Run a command promise to completion by stepping the fake clock. */
export async function settle(rig, promise, maxMs = 30000) {
  let done = false;
  promise.then(() => { done = true; });
  await flush();
  for (let ms = 0; ms < maxMs && !done; ms += 100) {
    rig.clock.advance(100);
    await flush();
  }
  return promise;
}

/** Step the fake clock (with promise flushing) for a given time, e.g. to let a workout run. */
export async function run(rig, ms, step = 100) {
  for (let t = 0; t < ms; t += step) {
    rig.clock.advance(step);
    await flush();
  }
}

/** Step until a condition is true (or give up). Returns whether it became true. */
export async function until(rig, cond, maxMs = 60000, step = 100) {
  for (let t = 0; t < maxMs && !cond(); t += step) {
    rig.clock.advance(step);
    await flush();
  }
  return cond();
}
