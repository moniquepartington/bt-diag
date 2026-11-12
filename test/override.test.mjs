// Run: node --test test/override.test.mjs
// Manual override ("nudge speed or incline until the next interval") in the workout engine. SIMULATOR ONLY.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRig, settle, run, until, flush } from './rig.js';
import { WorkoutEngine, STATE } from '../site/workout/engine.js';
import { VERIFIED_LIMITS } from '../site/workout/limits.js';

const hexs = (b) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const mini = (...specs) => ({ name: 'mini', intervals: specs.map(([category, durationSec, speedMph, inclineLevel]) => ({ category, durationSec, speedMph, inclineLevel })) });
const PLAN = mini(['Warmup', 30, 1.0, 1], ['Training', 30, 2.0, 3], ['Cooldown', 30, 1.0, 0]);

async function started(workout = PLAN, faults = {}, limits = VERIFIED_LIMITS) {
  const rig = makeRig(faults, { limits });
  rig.engine = new WorkoutEngine({ controller: rig.ctl, clock: rig.clock, limits });
  assert.equal(rig.engine.load(workout).ok, true);
  assert.equal((await settle(rig, rig.engine.begin(), 40000)).ok, true);
  await run(rig, 3000); // let the first interval settle
  return rig;
}
const sent = (rig, n) => rig.written.slice(n).map(hexs);

test('OVERRIDE: +0.1 mph sends exactly one speed command and shows as an override; repeated taps accumulate', async () => {
  const rig = await started();
  const n = rig.written.length;
  const r = await settle(rig, rig.engine.adjust({ speedDeltaMph: 0.1 }));
  assert.equal(r.ok, true);
  assert.deepEqual(sent(rig, n), ['02 b0 00'], '1.1 mph = 176 units');
  assert.deepEqual(rig.engine.snapshot().override, { speedMph: 1.1, inclineLevel: 1 });
  assert.equal((await settle(rig, rig.engine.adjust({ speedDeltaMph: 0.1 }))).ok, true);
  assert.deepEqual(rig.engine.snapshot().override, { speedMph: 1.2, inclineLevel: 1 });
  assert.deepEqual(sent(rig, n), ['02 b0 00', '02 c0 00']);
  assert.equal(rig.ctl.lock, null);
});

test('OVERRIDE: incline up and down by whole levels; a combined change sends speed first, then incline', async () => {
  const rig = await started();
  const n = rig.written.length;
  assert.equal((await settle(rig, rig.engine.adjust({ inclineDelta: 1 }))).ok, true);
  assert.equal((await settle(rig, rig.engine.adjust({ speedDeltaMph: -0.1, inclineDelta: 1 }))).ok, true);
  assert.deepEqual(sent(rig, n), ['03 14 00', '02 90 00', '03 1e 00']);
  assert.deepEqual(rig.engine.snapshot().override, { speedMph: 0.9, inclineLevel: 3 });
  assert.equal(rig.sim.state.inclinePct, 3);
});

test('OVERRIDE: lasts until the next interval, then the plan takes over and the override is cleared', async () => {
  const rig = await started();
  assert.equal((await settle(rig, rig.engine.adjust({ speedDeltaMph: 0.4, inclineDelta: 2 }))).ok, true); // 1.4 mph, incline 3
  const n = rig.written.length;
  await until(rig, () => rig.engine.snapshot().intervalIndex === 1, 60000);
  await run(rig, 4000);
  assert.equal(rig.engine.snapshot().override, null);
  assert.ok(rig.engine.events.some((l) => /override ended/i.test(l)));
  assert.deepEqual(sent(rig, n), ['02 40 01'], 'plan: 2.0 mph; the incline already equals the plan (3)');
  assert.ok(Math.abs(rig.sim.state.speedKmh - 3.22) < 0.01);
});

test('OVERRIDE: does not change the workout clock or the interval boundaries', async () => {
  const rig = await started();
  const before = rig.engine.snapshot().elapsedMs;
  await settle(rig, rig.engine.adjust({ speedDeltaMph: 0.3 }));
  const t0 = rig.clock.now();
  await run(rig, 10000);
  const after = rig.engine.snapshot().elapsedMs;
  assert.ok(after - before >= 10000 && after - before < 13000, `elapsed ${before} to ${after}`);
  assert.ok(rig.clock.now() - t0 === 10000);
});

test('OVERRIDE: pause drops it, and resume restores the PLAN (not the override)', async () => {
  const rig = await started();
  await settle(rig, rig.engine.adjust({ speedDeltaMph: 0.4, inclineDelta: 1 })); // 1.4 mph, incline 2
  await settle(rig, rig.engine.pause());
  assert.equal(rig.engine.snapshot().override, null);
  const n = rig.written.length;
  assert.equal((await settle(rig, rig.engine.resume(), 30000)).ok, true);
  assert.deepEqual(sent(rig, n), ['07', '02 a0 00', '03 0a 00'], 'restart, then the plan: 1.0 mph, incline 1');
  assert.equal(rig.engine.snapshot().override, null);
});

test('OVERRIDE: refused (nothing sent) unless the workout is running', async () => {
  const rig = makeRig({}, { limits: VERIFIED_LIMITS });
  const eng = new WorkoutEngine({ controller: rig.ctl, clock: rig.clock, limits: VERIFIED_LIMITS });
  assert.equal((await eng.adjust({ speedDeltaMph: 0.1 })).ok, false, 'idle');
  eng.load(PLAN);
  assert.equal((await eng.adjust({ speedDeltaMph: 0.1 })).ok, false, 'ready');
  assert.equal(rig.written.length, 0);
  rig.engine = eng;
  await settle(rig, eng.begin(), 40000);
  await settle(rig, eng.pause());
  const n = rig.written.length;
  assert.equal((await eng.adjust({ speedDeltaMph: 0.1 })).ok, false, 'paused');
  await settle(rig, eng.stop());
  assert.equal((await eng.adjust({ speedDeltaMph: 0.1 })).ok, false, 'stopped');
  assert.equal(rig.written.length, n);
});

test('OVERRIDE: refused at every limit, with no command sent and no fault', async () => {
  const rig = await started(mini(['Warmup', 60, 0.6, 0], ['Cooldown', 30, 2.8, 8]));
  const n = rig.written.length;
  for (const [change, why] of [[{ speedDeltaMph: -0.1 }, /minimum speed/], [{ inclineDelta: -1 }, /incline is already 0/]]) {
    const r = await rig.engine.adjust(change);
    assert.equal(r.ok, false);
    assert.equal(r.sent, false);
    assert.match(r.reason, why);
  }
  await until(rig, () => rig.engine.snapshot().intervalIndex === 1, 90000);
  await run(rig, 5000);
  for (const [change, why] of [[{ speedDeltaMph: 0.1 }, /speed limit/], [{ inclineDelta: 1 }, /incline limit/]]) {
    const r = await rig.engine.adjust(change);
    assert.equal(r.ok, false);
    assert.match(r.reason, why);
  }
  assert.equal(rig.engine.state, STATE.RUNNING);
  assert.equal(rig.ctl.lock, null);
  assert.ok(!sent(rig, n).some((w) => w.startsWith('02 c1') || w.startsWith('03 5a')), 'nothing above 2.8 mph or incline 8 was ever sent');
});

test('OVERRIDE: nonsense steps and no-op requests are refused', async () => {
  const rig = await started();
  const n = rig.written.length;
  for (const change of [{ speedDeltaMph: 0.05 }, { inclineDelta: 0.5 }, { speedDeltaMph: 0, inclineDelta: 0 }, {}]) {
    const r = await rig.engine.adjust(change);
    assert.equal(r.ok, false, JSON.stringify(change));
  }
  assert.equal(rig.written.length, n);
});

test('OVERRIDE: the top of the verified range is reachable one step at a time (2.7 to 2.8 mph, incline 7 to 8)', async () => {
  const rig = await started(mini(['Warmup', 60, 2.7, 7]));
  assert.equal((await settle(rig, rig.engine.adjust({ speedDeltaMph: 0.1, inclineDelta: 1 }))).ok, true);
  assert.deepEqual(rig.engine.snapshot().override, { speedMph: 2.8, inclineLevel: 8 });
  assert.equal((await rig.engine.adjust({ speedDeltaMph: 0.1 })).ok, false);
});

test('OVERRIDE: one change at a time, a second tap while one is in flight is refused', async () => {
  const rig = await started(PLAN, { ackDelayMs: 1500 });
  const n = rig.written.length;
  const first = rig.engine.adjust({ speedDeltaMph: 0.1 });
  await flush();
  assert.equal(rig.engine.snapshot().busy, true);
  const second = await rig.engine.adjust({ speedDeltaMph: 0.1 });
  assert.equal(second.ok, false);
  assert.match(second.reason, /already in progress/);
  assert.equal((await settle(rig, first)).ok, true);
  assert.equal(rig.maxInflight, 1);
  assert.deepEqual(sent(rig, n), ['02 b0 00'], 'only the first change was sent');
  assert.equal(rig.engine.snapshot().busy, false);
});

test('OVERRIDE: refused while an interval change is being applied', async () => {
  const rig = await started(mini(['Warmup', 10, 1.0, 0], ['Training', 20, 2.0, 2]), { ackDelayMs: 1000 });
  await until(rig, () => rig.engine.snapshot().intervalIndex === 1, 30000);
  await run(rig, 300);
  assert.equal(rig.engine.snapshot().busy, true, 'the boundary change is in flight');
  const r = await rig.engine.adjust({ speedDeltaMph: 0.1 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /already in progress/);
});

test('OVERRIDE: if the next interval starts while a change is in flight, the plan wins and no stale override is kept', async () => {
  const rig = await started(mini(['Warmup', 10, 1.0, 0], ['Training', 20, 2.0, 2]), { ackDelayMs: 1500 });
  const t = rig.engine.snapshot().elapsedMs;
  await run(rig, 10000 - t - 400); // 0.4 s before the boundary
  const p = rig.engine.adjust({ speedDeltaMph: 0.1 });
  const r = await settle(rig, p, 20000);
  assert.equal(r.ok, true);
  assert.equal(r.superseded, true);
  assert.equal(rig.engine.snapshot().override, null);
  await run(rig, 6000);
  assert.ok(Math.abs(rig.sim.state.speedKmh - 3.22) < 0.01, 'the belt ends at the plan: 2.0 mph');
  assert.equal(rig.engine.state, STATE.RUNNING);
});

test('OVERRIDE: a refusal by the control layer (nothing sent) does not fault the workout', async () => {
  const rig = await started();
  rig.ctl.setArmed(false); // the control layer will now refuse commands
  const n = rig.written.length;
  const r = await rig.engine.adjust({ speedDeltaMph: 0.1 });
  assert.equal(r.ok, false);
  assert.equal(r.sent, false);
  assert.equal(rig.engine.state, STATE.RUNNING, 'still running; nothing was sent');
  assert.equal(rig.engine.snapshot().override, null);
  assert.equal(rig.written.length, n);
});

test('OVERRIDE FAILURE: no acknowledgment for the change faults the workout, says the belt may be running, never retries', async () => {
  const rig = await started();
  rig.faults.noAckOp = 0x02;
  const n = rig.written.length;
  const r = await settle(rig, rig.engine.adjust({ speedDeltaMph: 0.1 }), 40000);
  assert.equal(r.ok, false);
  assert.equal(rig.engine.state, STATE.FAULTED);
  assert.match(rig.engine.fault.belt, /may still be running/);
  await run(rig, 300000);
  assert.equal(rig.written.length, n + 1, 'a single attempt');
  assert.ok(!rig.written.slice(n).some((w) => w[0] === 0x07), 'the belt is never restarted');
});

test('OVERRIDE FAILURE: an error result for an incline change faults the workout', async () => {
  const rig = await started();
  rig.faults.badResult = { op: 0x03, code: 0x04 };
  const r = await settle(rig, rig.engine.adjust({ inclineDelta: 1 }), 40000);
  assert.equal(r.ok, false);
  assert.equal(rig.engine.state, STATE.FAULTED);
  assert.equal(rig.engine.snapshot().override, null);
});

test('OVERRIDE: a disconnect while a change is in flight faults the workout; nothing more is sent', async () => {
  const rig = await started(PLAN, { ackDelayMs: 1500 });
  const n = rig.written.length;
  const p = rig.engine.adjust({ speedDeltaMph: 0.1 });
  await run(rig, 300);
  rig.ctl.disconnected();
  await p;
  assert.equal(rig.engine.state, STATE.FAULTED);
  await run(rig, 120000);
  assert.equal(rig.written.length, n + 1);
});

test('OVERRIDE: after the workout ends nothing is left over', async () => {
  const rig = await started(mini(['Warmup', 10, 1.0, 0], ['Cooldown', 10, 1.0, 0]));
  await settle(rig, rig.engine.adjust({ speedDeltaMph: 0.2 }));
  await until(rig, () => rig.engine.state === STATE.COMPLETED, 60000);
  assert.equal(rig.engine.snapshot().override, null);
  assert.equal((await rig.engine.adjust({ speedDeltaMph: 0.1 })).ok, false);
});
