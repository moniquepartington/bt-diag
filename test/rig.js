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
      this.t = n.at;
      n.fn();
    }
    this.t = end;
  }
}

export const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

export function makeRig(faults = {}, { armed = true, warmup = true, beltRunning = false } = {}) {
  const clock = new FakeClock();
  const written = [];
  const logs = [];
  let sim;
  const transport = { write: async (bytes) => { written.push(Array.from(bytes)); return sim.write(bytes); } };
  const ctl = new Controller({ transport, clock, onLog: (l) => logs.push(l) });
  sim = createSim({ clock, faults, emit: (uuid, bytes) => routeNotification(ctl, uuid, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)) });
  sim.start();
  if (beltRunning) Object.assign(sim.state, { running: true, speedKmh: 0.96, training: 0x0d }); // e.g. page reloaded while the belt runs
  ctl.connected({ speed: { minKmh: 0.96, maxKmh: 8.05 }, incline: { minPct: 0, maxPct: 12 } });
  ctl.feedTraining(sim.state.training);
  ctl.setArmed(armed);
  if (warmup) clock.advance(1100); // let telemetry arrive
  return { clock, sim, ctl, written, logs };
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
