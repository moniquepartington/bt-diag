// Run: node --test test/engine.test.mjs
// Workout engine tests. SIMULATOR ONLY: a simulated treadmill on a fake clock. Nothing physical, no Bluetooth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeRig, settle, run, until, flush } from './rig.js';
import { WorkoutEngine, STATE } from '../site/workout/engine.js';
import { PRESETS } from '../site/workout/presets.js';
import { VERIFIED_LIMITS } from '../site/workout/limits.js';
import { LIMITS as PHASE2_LIMITS } from '../site/control/protocol.js';
import { validateWorkout, checkAgainstLimits, totalSeconds, mmss, CATEGORIES } from '../site/workout/workout.js';

/** TEST-ONLY limits, looser than anything validated. Real runs use VERIFIED_LIMITS (2.8 mph, incline 8). */
const SIM_LIMITS = { maxMph: 5.0, maxInclineLevel: 12 };
const hexs = (b) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const mini = (...specs) => ({ name: 'mini', intervals: specs.map(([category, durationSec, speedMph, inclineLevel]) => ({ category, durationSec, speedMph, inclineLevel })) });
// 0.6 mph is the treadmill's minimum start speed, so the first interval needs no speed command.
const LONG = mini(['Warmup', 30, 0.6, 0], ['Training', 30, 1.0, 2], ['Cooldown', 30, 0.6, 0]);
const FAST = mini(['Warmup', 10, 1.0, 0], ['Training', 10, 1.5, 2], ['Cooldown', 10, 1.0, 0]);

function engineRig(faults = {}, { limits = SIM_LIMITS, config, controllerLimits = limits, ...rigOpts } = {}) {
  const rig = makeRig(faults, { limits: controllerLimits, ...rigOpts });
  rig.engine = new WorkoutEngine({ controller: rig.ctl, clock: rig.clock, limits, config });
  return rig;
}
const started = async (workout, faults, opts) => {
  const rig = engineRig(faults, opts);
  assert.equal(rig.engine.load(workout).ok, true);
  const r = await settle(rig, rig.engine.begin(), 40000);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(rig.engine.state, STATE.RUNNING);
  return rig;
};
const writesSince = (rig, n) => rig.written.slice(n).map(hexs);
const noRestart = (rig, from) => assert.ok(!rig.written.slice(from).some((w) => w[0] === 0x07), 'the belt must never be restarted automatically');

// ======================= data model and presets =======================
test('five presets: exactly 20:00 each, every duration a multiple of 5 s, all valid', () => {
  assert.equal(PRESETS.length, 5);
  assert.deepEqual(PRESETS.map((p) => p.name), ['Hill Voltage', 'House Party', 'Night Walk', 'Climb Mode', 'No Skips']);
  for (const p of PRESETS) {
    assert.equal(totalSeconds(p), 1200, `${p.name} must total exactly 20:00`);
    assert.ok(p.intervals.every((i) => i.durationSec % 5 === 0 && i.durationSec > 0), `${p.name}: every duration is a multiple of 5 s`);
    assert.ok(p.intervals.every((i) => CATEGORIES.includes(i.category)));
    assert.deepEqual(validateWorkout(p), [], p.name);
  }
});

test('preset interval counts and a few spot values match the spec', () => {
  assert.deepEqual(PRESETS.map((p) => p.intervals.length), [10, 8, 7, 9, 10]);
  assert.deepEqual(PRESETS[0].intervals[1], { category: 'Training', durationSec: 115, speedMph: 2.3, inclineLevel: 2 });
  assert.deepEqual(PRESETS[3].intervals[4], { category: 'Training', durationSec: 255, speedMph: 2.1, inclineLevel: 5 });
  assert.deepEqual(PRESETS[4].intervals[8], { category: 'Training', durationSec: 200, speedMph: 2.6, inclineLevel: 2 });
});

test('mmss parses and rejects', () => {
  assert.equal(mmss('1:55'), 115);
  assert.throws(() => mmss('1:5'), RangeError);
  assert.throws(() => mmss('abc'), RangeError);
});

test('validation rejects durations that are not multiples of 5 s, and other bad input', () => {
  const bad = (iv) => validateWorkout({ name: 'x', intervals: [{ category: 'Warmup', durationSec: 60, speedMph: 1, inclineLevel: 0, ...iv }] });
  assert.match(bad({ durationSec: 62 })[0], /multiple of 5/);
  assert.match(bad({ durationSec: 0 })[0], /positive/);
  assert.match(bad({ durationSec: 2.5 })[0], /whole number/);
  assert.match(bad({ category: 'Sprint' })[0], /category/);
  assert.match(bad({ speedMph: 0.85 })[0], /0\.1 mph/);
  assert.match(bad({ speedMph: -1 })[0], /positive/);
  assert.match(bad({ inclineLevel: 1.5 })[0], /whole number/);
  assert.ok(validateWorkout({ name: '', intervals: [] }).length >= 2);
  assert.deepEqual(bad({}), []);
});

// ======================= hardware limits are separate from presets =======================
test('LIMITS: the verified limits are the validated Stage B ceiling, frozen, and exactly the top of the presets', () => {
  assert.deepEqual({ ...VERIFIED_LIMITS }, { maxMph: 2.8, maxInclineLevel: 8 });
  assert.ok(Object.isFrozen(VERIFIED_LIMITS));
  assert.equal(Math.max(...PRESETS.flatMap((p) => p.intervals.map((i) => i.speedMph))), VERIFIED_LIMITS.maxMph);
  assert.equal(Math.max(...PRESETS.flatMap((p) => p.intervals.map((i) => i.inclineLevel))), VERIFIED_LIMITS.maxInclineLevel);
  for (const p of PRESETS) assert.deepEqual(checkAgainstLimits(p, VERIFIED_LIMITS), [], `${p.name} is inside the verified limits`);
});

test('LIMITS: the Phase 2 control page keeps its own, lower caps, which every preset exceeds', () => {
  assert.deepEqual({ ...PHASE2_LIMITS }, { maxMph: 1.0, maxInclineLevel: 2 });
  assert.ok(PHASE2_LIMITS.maxMph < VERIFIED_LIMITS.maxMph && PHASE2_LIMITS.maxInclineLevel < VERIFIED_LIMITS.maxInclineLevel);
  for (const p of PRESETS) assert.ok(checkAgainstLimits(p, PHASE2_LIMITS).length > 0, p.name);
});

test('LIMITS: on the verified limits all five presets load, and loading sends nothing', () => {
  const rig = engineRig({}, { limits: VERIFIED_LIMITS });
  for (const p of PRESETS) {
    assert.equal(rig.engine.load(p).ok, true, p.name);
    assert.equal(rig.engine.state, STATE.READY);
  }
  assert.equal(rig.written.length, 0);
});

test('LIMITS: a workout above the verified limits is refused, never clamped, and nothing is sent', async () => {
  const rig = engineRig({}, { limits: VERIFIED_LIMITS });
  const r1 = rig.engine.load(mini(['Warmup', 10, 2.9, 0]));
  assert.deepEqual(r1.violations, [{ interval: 1, field: 'speedMph', value: 2.9, limit: 2.8 }]);
  const r2 = rig.engine.load(mini(['Warmup', 10, 2.8, 9]));
  assert.deepEqual(r2.violations, [{ interval: 1, field: 'inclineLevel', value: 9, limit: 8 }]);
  const r3 = rig.engine.load(mini(['Warmup', 10, 3.5, 12], ['Training', 10, 1.0, 0]));
  assert.equal(r3.violations.length, 2);
  assert.equal(rig.engine.state, STATE.IDLE);
  assert.equal((await rig.engine.begin()).ok, false, 'cannot start a refused workout');
  assert.equal(rig.written.length, 0);
});

test('LIMITS: a workout exactly at the verified limits is accepted and runs to completion', async () => {
  const top = mini(['Warmup', 10, 2.8, 8], ['Cooldown', 10, 0.6, 0]);
  const rig = engineRig({}, { limits: VERIFIED_LIMITS });
  assert.equal(rig.engine.load(top).ok, true);
  assert.equal((await settle(rig, rig.engine.begin(), 40000)).ok, true);
  assert.equal(await until(rig, () => rig.engine.state === STATE.COMPLETED, 60000), true);
  assert.equal(rig.ctl.lock, null);
});

test('LIMITS: the engine cannot be configured looser than the control layer', () => {
  const phase2 = makeRig({}); // a control layer on the Phase 2 caps
  assert.throws(() => new WorkoutEngine({ controller: phase2.ctl, clock: phase2.clock }), /looser than the control layer/, 'the default (verified) limits are looser than the Phase 2 caps');
  assert.throws(() => new WorkoutEngine({ controller: phase2.ctl, clock: phase2.clock, limits: SIM_LIMITS }), /looser than the control layer/);
  const real = makeRig({}, { limits: VERIFIED_LIMITS });
  assert.throws(() => new WorkoutEngine({ controller: real.ctl, clock: real.clock, limits: SIM_LIMITS }), /looser than the control layer/);
  assert.doesNotThrow(() => new WorkoutEngine({ controller: real.ctl, clock: real.clock }), 'a controller on the verified limits works with the default');
});

test('LIMITS: presets carry no limits and do not import them; the limits object is frozen', () => {
  const src = readFileSync(new URL('../site/workout/presets.js', import.meta.url), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(src, /limits|VERIFIED|protocol/i);
  assert.ok(Object.isFrozen(PRESETS));
  assert.ok(PRESETS.every((p) => !('limits' in p)));
  assert.throws(() => { 'use strict'; VERIFIED_LIMITS.maxMph = 5; }, TypeError);
});

test('LIMITS: the control layer on the verified limits still refuses over-limit commands if the engine were bypassed', async () => {
  const rig = makeRig({}, { limits: VERIFIED_LIMITS });
  assert.equal((await settle(rig, rig.ctl.takeControl())).ok, true);
  assert.equal((await settle(rig, rig.ctl.start())).ok, true);
  const n = rig.written.length;
  assert.equal((await rig.ctl.setSpeedMph(2.9)).sent, false);
  assert.equal((await rig.ctl.setInclineLevel(9)).sent, false);
  assert.equal(rig.written.length, n);
  assert.equal((await settle(rig, rig.ctl.setSpeedMph(2.8))).ok, true);
  assert.equal((await settle(rig, rig.ctl.setInclineLevel(8))).ok, true);
});

test('LIMITS: a controller on the Phase 2 caps still refuses engine-level targets', async () => {
  const rig = makeRig({});
  assert.equal((await rig.ctl.setSpeedMph(2.0)).ok, false);
  assert.equal((await rig.ctl.setInclineLevel(5)).ok, false);
  assert.equal(rig.written.length, 0);
});

// ======================= running a workout =======================
test('RUN: take control, start, targets, boundaries on time, final stop; exact command sequence', async () => {
  const rig = engineRig();
  rig.engine.load(FAST);
  await settle(rig, rig.engine.begin(), 40000);
  const t0 = rig.clock.now();
  const n0 = rig.written.length;
  await until(rig, () => rig.engine.state === STATE.COMPLETED, 60000);
  assert.deepEqual(rig.written.map(hexs), ['00', '07', '02 a0 00', '02 f0 00', '03 14 00', '02 a0 00', '03 00 00', '08 01']);
  const at = (k) => rig.writtenAt[n0 + k] - t0;
  assert.ok(at(0) >= 10000 && at(0) < 10700, `interval 2 speed at ${at(0)}`); // boundary at 10 s
  assert.ok(at(2) >= 20000 && at(2) < 20700, `interval 3 speed at ${at(2)}`); // boundary at 20 s
  assert.ok(at(4) >= 30000 && at(4) < 30700, `final stop at ${at(4)}`); // end at 30 s
  assert.equal(rig.sim.state.running, false);
  assert.equal(rig.engine.beltKnown, 'stopped');
});

test('RUN: the workout clock starts when the belt is verified running, not at the tap', async () => {
  const rig = engineRig();
  rig.engine.load(FAST);
  const tTap = rig.clock.now();
  await settle(rig, rig.engine.begin(), 40000);
  assert.ok(rig.engine.snapshot().elapsedMs < 1500, 'startup time (take control, countdown) is not workout time');
  assert.ok(rig.clock.now() - tTap > 8000);
});

test('RUN: every command is serialized, and each boundary sends its commands exactly once', async () => {
  const rig = await started(FAST, { ackDelayMs: 1500 });
  await until(rig, () => rig.engine.state === STATE.COMPLETED, 80000);
  assert.equal(rig.maxInflight, 1, 'never more than one command outstanding');
  assert.deepEqual(rig.written.map(hexs), ['00', '07', '02 a0 00', '02 f0 00', '03 14 00', '02 a0 00', '03 00 00', '08 01']);
});

test('RUN: all five presets run to completion on the simulator in 20:00, in order, with no duplicate commands', async () => {
  for (const preset of PRESETS) {
    const rig = engineRig({}, { limits: VERIFIED_LIMITS }); // the presets run on the REAL verified limits
    rig.engine.load(preset);
    await settle(rig, rig.engine.begin(), 40000);
    const tStart = rig.clock.now();
    assert.equal(await until(rig, () => rig.engine.state === STATE.COMPLETED, 1300000, 250), true, preset.name);
    const total = rig.clock.now() - tStart;
    assert.ok(total >= 1200000 && total < 1210000, `${preset.name}: ran ${total} ms`);
    assert.equal(rig.ctl.lock, null);
    assert.equal(rig.maxInflight, 1);
    // expected commands computed independently from the table: only changes are sent
    const speeds = [], inclines = [];
    let s = 0.6, inc = 0;
    for (const i of preset.intervals) {
      if (Math.abs(i.speedMph - s) > 0.05) speeds.push(Math.round(i.speedMph * 160));
      if (i.inclineLevel !== inc) inclines.push(i.inclineLevel * 10);
      s = i.speedMph; inc = i.inclineLevel;
    }
    const sentSpeeds = rig.written.filter((w) => w[0] === 0x02).map((w) => w[1] | (w[2] << 8));
    const sentInclines = rig.written.filter((w) => w[0] === 0x03).map((w) => w[1] | (w[2] << 8));
    assert.deepEqual(sentSpeeds, speeds, `${preset.name} speeds`);
    assert.deepEqual(sentInclines, inclines, `${preset.name} inclines`);
    assert.equal(rig.written.filter((w) => w[0] === 0x08).length, 1, 'one final stop');
  }
});

// ======================= pause and resume =======================
test('PAUSE: stops the belt, freezes the clock, enters the distinct PAUSED state; time while paused is not counted', async () => {
  const rig = await started(LONG);
  await run(rig, 40000); // into interval 2
  const r = await settle(rig, rig.engine.pause());
  assert.equal(r.ok, true);
  assert.equal(rig.engine.state, STATE.PAUSED);
  assert.equal(rig.sim.state.running, false);
  const e1 = rig.engine.snapshot().elapsedMs;
  assert.ok(e1 >= 39000 && e1 < 41500, `elapsed ${e1}`);
  await run(rig, 120000);
  assert.equal(rig.engine.snapshot().elapsedMs, e1, 'the clock stays frozen while paused');
  assert.equal(rig.engine.state, STATE.PAUSED);
  noRestart(rig, 0 + rig.written.findIndex((w) => w[0] === 0x07) + 1);
});

test('RESUME: tap, 3 s countdown with nothing sent, restart, verified state, THEN speed and incline restored', async () => {
  const rig = await started(LONG);
  await run(rig, 40000);
  await settle(rig, rig.engine.pause());
  const n = rig.written.length;
  const tTap = rig.clock.now();
  const p = rig.engine.resume();
  await flush();
  assert.equal(rig.engine.state, STATE.RESUMING);
  assert.equal(rig.engine.snapshot().countdownEndsAt, tTap + 3000);
  await run(rig, 2900);
  assert.equal(rig.written.length, n, 'nothing is sent during the countdown');
  assert.equal(rig.engine.state, STATE.RESUMING);
  const r = await settle(rig, p, 30000);
  assert.equal(r.ok, true);
  assert.equal(rig.engine.state, STATE.RUNNING);
  const sent = rig.written.slice(n).map(hexs);
  assert.deepEqual(sent, ['07', '02 a0 00', '03 14 00'], 'restart first, then speed and incline (a Stop lowers the incline to 0 on the real treadmill)');
  const iStart = n, iSpeed = n + 1;
  assert.ok(rig.writtenAt[iStart] - tTap >= 3000, 'start waited for the countdown');
  assert.ok(rig.writtenAt[iSpeed] - rig.writtenAt[iStart] >= 3000, 'speed was set only after the belt was verified running (treadmill countdown)');
  assert.equal(rig.sim.state.speedKmh, 1.61); // 1.0 mph as the real treadmill reports it
});

test('PAUSE lowers the incline to 0 (as seen on hardware) and RESUME raises it again, after the restart is verified', async () => {
  const rig = await started(LONG);
  await run(rig, 40000); // interval 2: 1.0 mph, incline 2
  assert.equal(rig.sim.state.inclinePct, 2);
  await settle(rig, rig.engine.pause());
  assert.equal(rig.sim.state.inclinePct, 0, 'the stop lowered the incline');
  const n = rig.written.length;
  assert.equal((await settle(rig, rig.engine.resume(), 30000)).ok, true);
  assert.equal(rig.sim.state.inclinePct, 2, 'incline restored');
  assert.deepEqual(rig.written.slice(n).map(hexs), ['07', '02 a0 00', '03 14 00']);
  assert.ok(rig.writtenAt[n + 2] > rig.writtenAt[n + 1] && rig.writtenAt[n + 1] >= rig.writtenAt[n] + 3000, 'incline only after the speed, speed only after the verified restart');
});

test('RESUME also works on a treadmill that KEEPS the incline across a stop: only the speed is restored', async () => {
  const rig = await started(LONG, { keepInclineOnStop: true });
  await run(rig, 40000);
  await settle(rig, rig.engine.pause());
  assert.equal(rig.sim.state.inclinePct, 2);
  const n = rig.written.length;
  assert.equal((await settle(rig, rig.engine.resume(), 30000)).ok, true);
  assert.deepEqual(rig.written.slice(n).map(hexs), ['07', '02 a0 00']);
});

test('STOP at the end of a workout leaves the incline at 0 and the belt stopped', async () => {
  const w = mini(['Warmup', 10, 1.0, 0], ['Training', 10, 1.5, 4]);
  const rig = await started(w);
  await until(rig, () => rig.engine.state === STATE.COMPLETED, 60000);
  assert.equal(rig.sim.state.inclinePct, 0);
  assert.equal(rig.sim.state.running, false);
});

test('RESUME: the clock restarts only after the targets are restored and continues from the paused position', async () => {
  const rig = await started(LONG);
  await run(rig, 40000);
  await settle(rig, rig.engine.pause());
  const e1 = rig.engine.snapshot().elapsedMs;
  await run(rig, 30000);
  await settle(rig, rig.engine.resume(), 30000);
  const e2 = rig.engine.snapshot().elapsedMs;
  assert.ok(e2 >= e1 && e2 - e1 < 600, `elapsed continues from ${e1}, got ${e2}`);
  assert.equal(await until(rig, () => rig.engine.state === STATE.COMPLETED, 80000), true);
});

test('RESUME: refused unless paused; a stopped or running workout cannot be resumed', async () => {
  const rig = await started(LONG);
  assert.equal((await rig.engine.resume()).ok, false, 'running');
  await settle(rig, rig.engine.stop());
  const n = rig.written.length;
  const r = await rig.engine.resume();
  assert.equal(r.ok, false);
  assert.match(r.reason, /stopped/);
  assert.equal(rig.written.length, n);
});

test('RESUME: the restart is not verified (acknowledged but the belt never starts): fault, and NO speed or incline sent', async () => {
  const rig = await started(LONG);
  await run(rig, 40000);
  await settle(rig, rig.engine.pause());
  rig.faults.startIgnored = true;
  const n = rig.written.length;
  const r = await settle(rig, rig.engine.resume(), 40000);
  assert.equal(r.ok, false);
  assert.equal(rig.engine.state, STATE.FAULTED);
  assert.deepEqual(rig.written.slice(n).map(hexs), ['07'], 'only the restart was sent');
  await run(rig, 300000);
  assert.equal(rig.written.length, n + 1, 'no retry, nothing further');
});

test('RESUME: treadmill in the wrong state after restart (not at minimum speed): fault before any speed or incline command', async () => {
  const rig = await started(LONG);
  await run(rig, 40000);
  await settle(rig, rig.engine.pause());
  rig.faults.startSpeedKmh = 1.4; // restarted at 1.4 km/h instead of the 0.96 minimum
  const n = rig.written.length;
  const r = await settle(rig, rig.engine.resume(), 40000);
  assert.equal(r.ok, false);
  assert.equal(rig.engine.state, STATE.FAULTED);
  assert.match(rig.engine.fault.reason, /UNEXPECTED STATE AFTER RESTART/);
  assert.deepEqual(rig.written.slice(n).map(hexs), ['07'], 'speed and incline were not touched');
});

test('RESUME: cancelled during the countdown by Stop: nothing is sent and the workout ends', async () => {
  const rig = await started(LONG);
  await settle(rig, rig.engine.pause());
  const n = rig.written.length;
  const p = rig.engine.resume();
  await run(rig, 1000);
  const s = await settle(rig, rig.engine.stop());
  assert.equal(s.ok, true);
  assert.equal(rig.engine.state, STATE.STOPPED);
  await p;
  await run(rig, 60000);
  assert.equal(rig.written.length, n, 'no start was ever sent');
});

test('RESUME: refused (nothing sent) when the connection is down; resumable after a manual reconnect and reset', async () => {
  const rig = await started(LONG);
  await settle(rig, rig.engine.pause());
  rig.ctl.disconnected();
  assert.equal(rig.engine.state, STATE.PAUSED, 'a paused workout survives a disconnect');
  const n = rig.written.length;
  assert.equal((await rig.engine.resume()).ok, false);
  assert.equal(rig.written.length, n);
  rig.sim.dropControl();
  rig.ctl.connected({ speed: { minKmh: 0.96, maxKmh: 8.05 }, incline: { minPct: 0, maxPct: 12 } });
  rig.ctl.feedTraining(rig.sim.state.training);
  rig.ctl.resetLock();
  rig.clock.advance(1500);
  await flush();
  const takeover = await settle(rig, rig.ctl.takeControl());
  assert.equal(takeover.ok, true);
  const r = await settle(rig, rig.engine.resume(), 30000);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(rig.engine.state, STATE.RUNNING);
});

test('PAUSE failure (the belt is not confirmed stopped): fault, belt reported as possibly running, no retry', async () => {
  const rig = await started(LONG);
  rig.faults.stopIgnored = true;
  const n = rig.written.length;
  const r = await settle(rig, rig.engine.pause(), 40000);
  assert.equal(r.ok, false);
  assert.equal(rig.engine.state, STATE.FAULTED);
  assert.match(rig.engine.fault.reason, /PAUSE FAILED/);
  assert.notEqual(rig.engine.fault.beltKnown, 'stopped');
  await run(rig, 120000);
  assert.equal(rig.written.length, n + 1, 'a single stop attempt, never retried');
});

// ======================= stop is terminal and distinct from pause =======================
test('STOP: ends the workout (distinct from paused); it cannot be resumed or restarted without loading again', async () => {
  const rig = await started(LONG);
  await run(rig, 10000);
  const r = await settle(rig, rig.engine.stop());
  assert.equal(r.ok, true);
  assert.equal(rig.engine.state, STATE.STOPPED);
  assert.notEqual(rig.engine.state, STATE.PAUSED);
  assert.equal(rig.sim.state.running, false);
  const n = rig.written.length;
  assert.equal((await rig.engine.resume()).ok, false);
  assert.equal((await rig.engine.begin()).ok, false);
  await run(rig, 600000); // ten minutes of timers
  assert.equal(rig.written.length, n, 'nothing is ever sent after Stop');
  assert.equal(rig.engine.state, STATE.STOPPED);
  // only an explicit new load makes a new run possible
  assert.equal(rig.engine.load(LONG).ok, true);
  assert.equal(rig.engine.state, STATE.READY);
});

test('STOP from PAUSED: ends the workout without sending anything (the belt is already stopped), and it cannot be resumed', async () => {
  const rig = await started(LONG);
  await settle(rig, rig.engine.pause());
  const n = rig.written.length;
  const r = await rig.engine.stop();
  assert.equal(r.ok, true);
  assert.equal(rig.engine.state, STATE.STOPPED);
  assert.equal(rig.written.length, n);
  assert.equal((await rig.engine.resume()).ok, false);
});

test('STOP is idempotent and safe when there is nothing to stop', async () => {
  const rig = await started(LONG);
  const a = rig.engine.stop();
  const b = rig.engine.stop();
  await settle(rig, a);
  await b;
  assert.equal(rig.written.filter((w) => w[0] === 0x08).length, 1, 'one stop command');
  assert.equal((await rig.engine.stop()).already, true);
  const idle = engineRig();
  assert.equal((await idle.engine.stop()).ok, true);
  assert.equal(idle.written.length, 0);
});

test('STOP while a speed command is in flight: queued commands are cancelled, the stop follows, nothing is sent after it', async () => {
  const rig = await started(LONG, { ackDelayMs: 1500 });
  await until(rig, () => rig.ctl.pending?.cmd === 'setSpeed', 60000);
  const n = rig.written.length;
  const p = rig.engine.stop();
  const r = await settle(rig, p, 40000);
  assert.equal(r.ok, true);
  const after = rig.written.slice(n).map(hexs);
  assert.deepEqual(after, ['08 01'], 'the in-flight command finished; the queued incline command was cancelled; then the stop');
  await run(rig, 120000);
  assert.equal(rig.written.length, n + 1);
});

test('STOP failure (belt not confirmed stopped): fault, no retry', async () => {
  const rig = await started(LONG);
  rig.faults.stopIgnored = true;
  const n = rig.written.length;
  const r = await settle(rig, rig.engine.stop(), 40000);
  assert.equal(r.ok, false);
  assert.equal(rig.engine.state, STATE.FAULTED);
  assert.match(rig.engine.fault.reason, /STOP FAILED/);
  await run(rig, 120000);
  assert.equal(rig.written.length, n + 1);
});

test('REMOTE: the belt stopped from the remote while running becomes a PAUSE (never more commands to a stopped belt)', async () => {
  const rig = await started(LONG);
  await run(rig, 5000);
  rig.sim.remoteStop();
  await run(rig, 3000);
  assert.equal(rig.engine.state, STATE.PAUSED);
  assert.equal(rig.engine.snapshot().notice.kind, 'external-stop');
  const n = rig.written.length;
  await run(rig, 120000);
  assert.equal(rig.written.length, n);
  assert.equal((await settle(rig, rig.engine.resume(), 30000)).ok, true, 'resumable by an explicit tap');
});

// ======================= Bluetooth disconnections =======================
test('DISCONNECT while running: fault, the belt is reported as possibly running, nothing sent, nothing restarted', async () => {
  const rig = await started(LONG);
  await run(rig, 5000);
  const n = rig.written.length;
  rig.ctl.disconnected();
  assert.equal(rig.engine.state, STATE.FAULTED);
  assert.match(rig.engine.fault.reason, /CONNECTION LOST/);
  assert.equal(rig.engine.fault.beltKnown, 'running');
  assert.match(rig.engine.fault.belt, /may still be running/);
  assert.equal(rig.sim.state.running, true, 'the simulated belt keeps going, as the real one does');
  await run(rig, 600000);
  assert.equal(rig.written.length, n, 'no commands after a disconnect');
  noRestart(rig, n);
});

test('DISCONNECT, then recovery through the control layer, then the engine is closed only once the belt is verified stopped', async () => {
  const rig = await started(LONG);
  rig.ctl.disconnected();
  rig.sim.dropControl();
  rig.ctl.connected({ speed: { minKmh: 0.96, maxKmh: 8.05 }, incline: { minPct: 0, maxPct: 12 } });
  rig.ctl.feedTraining(rig.sim.state.training);
  rig.clock.advance(1500);
  await flush();
  assert.equal(rig.engine.acknowledgeFault().ok, false, 'belt is still moving: cannot close the workout');
  assert.equal((await settle(rig, rig.ctl.takeControl())).ok, true);
  assert.equal((await settle(rig, rig.ctl.stop())).ok, true);
  rig.clock.advance(1500);
  assert.equal(rig.engine.acknowledgeFault().ok, true);
  assert.equal(rig.engine.state, STATE.STOPPED);
  assert.equal((await rig.engine.resume()).ok, false);
});

test('DISCONNECT during the resume countdown: fault with the belt known to be stopped; no start is ever sent', async () => {
  const rig = await started(LONG);
  await settle(rig, rig.engine.pause());
  const n = rig.written.length;
  const p = rig.engine.resume();
  await run(rig, 1000);
  rig.ctl.disconnected();
  assert.equal(rig.engine.state, STATE.FAULTED);
  assert.equal(rig.engine.fault.beltKnown, 'stopped');
  await p;
  await run(rig, 60000);
  assert.equal(rig.written.length, n);
});

test('DISCONNECT in the middle of a pause (stop in flight): fault, outcome unknown, no retry', async () => {
  const rig = await started(LONG, { ackDelayMs: 1500 });
  const n = rig.written.length;
  const p = rig.engine.pause();
  await run(rig, 300);
  rig.ctl.disconnected();
  await p;
  assert.equal(rig.engine.state, STATE.FAULTED);
  await run(rig, 120000);
  assert.equal(rig.written.length, n + 1);
});

test('DISCONNECT while a transition command is in flight: fault, no further commands', async () => {
  const rig = await started(LONG, { ackDelayMs: 1500 });
  await until(rig, () => rig.ctl.pending?.cmd === 'setSpeed', 60000);
  const n = rig.written.length;
  rig.ctl.disconnected();
  await flush();
  assert.equal(rig.engine.state, STATE.FAULTED);
  await run(rig, 120000);
  assert.equal(rig.written.length, n);
});

// ======================= browser suspension and delayed callbacks =======================
test('SUSPENSION: the page leaving the screen while running faults the workout and sends nothing', async () => {
  const rig = await started(LONG);
  const n = rig.written.length;
  rig.ctl.pageHidden();
  assert.equal(rig.engine.state, STATE.FAULTED);
  assert.match(rig.engine.fault.reason, /PAGE LEFT THE SCREEN/);
  await run(rig, 300000);
  assert.equal(rig.written.length, n);
  noRestart(rig, n);
});

test('SUSPENSION: a long timer gap faults the workout; the missed boundaries are NOT replayed', async () => {
  const rig = await started(LONG);
  await run(rig, 5000);
  const n = rig.written.length;
  rig.clock.skip(45000); // the tab slept through the interval 2 boundary and more
  rig.engine._tick(); // the first timer callback after waking
  assert.equal(rig.engine.state, STATE.FAULTED);
  assert.match(rig.engine.fault.reason, /TIMER GAP/);
  await run(rig, 60000);
  assert.equal(rig.written.length, n, 'no catch-up commands of any kind');
  noRestart(rig, n);
});

test('SUSPENSION: a long gap while the clock is real (all timers overdue at once) ends in a fault, never in catch-up', async () => {
  const rig = await started(LONG);
  await run(rig, 5000);
  const n = rig.written.length;
  rig.clock.skip(45000);
  rig.clock.advance(300);
  await flush();
  assert.equal(rig.engine.state, STATE.FAULTED);
  assert.equal(rig.written.length, n);
});

test('DELAY: a late timer (1.2 s) across a boundary applies the new interval once, with no fault', async () => {
  const rig = await started(FAST);
  await run(rig, 9000);
  rig.clock.skip(1200); // callbacks arrive late
  await run(rig, 1500);
  assert.equal(rig.engine.state, STATE.RUNNING);
  assert.equal(rig.ctl.lock, null);
  await until(rig, () => rig.engine.state === STATE.COMPLETED, 60000);
  assert.deepEqual(rig.written.map(hexs), ['00', '07', '02 a0 00', '02 f0 00', '03 14 00', '02 a0 00', '03 00 00', '08 01']);
});

test('MISSED BOUNDARIES: when several boundaries pass before the timer runs, only the CURRENT interval is applied', async () => {
  const w = mini(['Warmup', 10, 1.0, 0], ['Training', 5, 1.5, 3], ['Training', 5, 2.0, 4], ['Cooldown', 30, 1.2, 1]);
  const rig = await started(w, {}, { config: { maxTickGapMs: 20000 } });
  const eng = rig.engine;
  const n = rig.written.length;
  eng._stopTicking(); // the interval timer goes quiet while the clock keeps running (a late timer)
  await run(rig, 22000); // intervals 2 (10-15 s) and 3 (15-20 s) are entered and left with no timer running
  eng.lastTickAt = rig.clock.now() - 250; // the late timer finally fires (gap check passes: a delay, not a suspension)
  eng._schedule();
  await run(rig, 3000);
  assert.equal(eng.state, STATE.RUNNING);
  const sent = writesSince(rig, n);
  assert.ok(!sent.includes('02 f0 00') && !sent.includes('03 1e 00'), 'interval 2 targets (1.5 mph, incline 3) must never be sent');
  assert.ok(!sent.includes('02 40 01') && !sent.includes('03 28 00'), 'interval 3 targets (2.0 mph, incline 4) must never be sent');
  assert.deepEqual(sent, ['02 c0 00', '03 0a 00'], 'interval 4 (1.2 mph, incline 1) applied directly');
  assert.ok(eng.events.some((l) => /Boundaries missed/.test(l)));
});

test('DELAY: slow acknowledgments never overlap commands, even across several boundaries', async () => {
  const w = mini(['Warmup', 10, 1.0, 0], ['Training', 5, 1.5, 3], ['Training', 5, 2.0, 4], ['Cooldown', 15, 1.2, 1]);
  const rig = await started(w, { ackDelayMs: 2000 });
  await until(rig, () => rig.engine.state === STATE.COMPLETED || rig.engine.state === STATE.FAULTED, 90000);
  assert.equal(rig.engine.state, STATE.COMPLETED);
  assert.equal(rig.maxInflight, 1);
  assert.equal(rig.written[rig.written.length - 1][0], 0x08);
});

// ======================= failed acknowledgments =======================
test('FAILED ACK: no acknowledgment for a speed change mid-run: fault, no retry, no restart', async () => {
  const rig = await started(LONG, { noAckOp: 0x02 });
  const n = rig.written.length;
  await until(rig, () => rig.engine.state === STATE.FAULTED, 90000);
  assert.equal(rig.engine.state, STATE.FAULTED);
  assert.match(rig.engine.fault.belt, /may still be running/);
  await run(rig, 300000);
  assert.equal(rig.written.length, n + 1, 'a single attempt');
  noRestart(rig, n);
});

test('FAILED ACK: an error result for an incline change: fault, no retry', async () => {
  const rig = await started(LONG, { badResult: { op: 0x03, code: 0x04 } });
  const n = rig.written.length;
  await until(rig, () => rig.engine.state === STATE.FAULTED, 90000);
  assert.equal(rig.engine.state, STATE.FAULTED);
  await run(rig, 300000);
  assert.equal(rig.written.length, n + 2, 'speed, then the rejected incline; nothing else');
});

test('FAILED ACK: take control not acknowledged at the start: fault, belt stopped, no start sent', async () => {
  const rig = engineRig({ noAckOp: 0x00 });
  rig.engine.load(LONG);
  const r = await settle(rig, rig.engine.begin(), 40000);
  assert.equal(r.ok, false);
  assert.equal(rig.engine.state, STATE.FAULTED);
  assert.equal(rig.engine.fault.beltKnown, 'stopped');
  assert.deepEqual(rig.written.map(hexs), ['00']);
  await run(rig, 120000);
  assert.equal(rig.written.length, 1);
});

test('FAILED ACK: start not acknowledged: fault with the belt state unknown, no speed or incline sent', async () => {
  const rig = engineRig({ noAckOp: 0x07 });
  rig.engine.load(LONG);
  const r = await settle(rig, rig.engine.begin(), 40000);
  assert.equal(r.ok, false);
  assert.equal(rig.engine.state, STATE.FAULTED);
  assert.equal(rig.engine.fault.beltKnown, 'unknown');
  assert.deepEqual(rig.written.map(hexs), ['00', '07']);
});

test('FAILED ACK: first interval speed rejected at the start: fault, belt reported as running at minimum, no retry', async () => {
  const rig = engineRig({ badResult: { op: 0x02, code: 0x03 } });
  rig.engine.load(FAST);
  const r = await settle(rig, rig.engine.begin(), 40000);
  assert.equal(r.ok, false);
  assert.equal(rig.engine.state, STATE.FAULTED);
  assert.equal(rig.engine.fault.beltKnown, 'running');
  await run(rig, 120000);
  assert.deepEqual(rig.written.map(hexs), ['00', '07', '02 a0 00']);
});

test('FAILED ACK: end-of-workout stop not confirmed: fault, no retry', async () => {
  const rig = await started(FAST);
  rig.faults.stopIgnored = true;
  await until(rig, () => rig.engine.state === STATE.FAULTED || rig.engine.state === STATE.COMPLETED, 90000);
  assert.equal(rig.engine.state, STATE.FAULTED);
  assert.match(rig.engine.fault.reason, /END-OF-WORKOUT STOP FAILED/);
});

test('REFUSALS (nothing sent) before the start leave the workout ready, not faulted', async () => {
  const rig = engineRig({}, { armed: false });
  rig.engine.load(FAST);
  const r = await rig.engine.begin();
  assert.equal(r.ok, false);
  assert.equal(rig.engine.state, STATE.READY);
  assert.equal(rig.written.length, 0);
});

test('DISCONNECT right after Start was sent (before it was acknowledged): the belt is reported as UNKNOWN, not stopped', async () => {
  const rig = engineRig({ ackDelayMs: 1500 });
  rig.engine.load(LONG);
  const p = rig.engine.begin();
  await until(rig, () => rig.ctl.pending?.cmd === 'start', 40000);
  rig.ctl.disconnected();
  await p;
  assert.equal(rig.engine.state, STATE.FAULTED);
  assert.equal(rig.engine.fault.beltKnown, 'unknown');
  assert.match(rig.engine.fault.belt, /unknown/);
  const n = rig.written.length;
  await run(rig, 120000);
  assert.equal(rig.written.length, n);
});

test('REFUSAL mid-run (nothing sent) is a fault, not a retry loop', { timeout: 30000 }, async () => {
  const rig = await started(LONG);
  rig.ctl.setArmed(false); // the next interval command will be refused by the control layer
  const n = rig.written.length;
  await until(rig, () => rig.engine.state === STATE.FAULTED, 60000);
  assert.equal(rig.engine.state, STATE.FAULTED);
  assert.match(rig.engine.fault.reason, /COULD NOT APPLY INTERVAL/);
  assert.equal(rig.written.length, n, 'nothing was sent');
  assert.equal(rig.logs.filter((l) => /REFUSED setSpeed/.test(l)).length, 1, 'asked once, never retried');
});

test('HYGIENE: a normal run never even attempts a command the control layer would refuse', async () => {
  const rig = await started(FAST);
  await until(rig, () => rig.engine.state === STATE.COMPLETED, 60000);
  assert.deepEqual(rig.logs.filter((l) => /REFUSED/.test(l)), []);
  const rig2 = await started(LONG);
  await run(rig2, 40000);
  await settle(rig2, rig2.engine.pause());
  await settle(rig2, rig2.engine.resume(), 30000);
  await settle(rig2, rig2.engine.stop());
  assert.deepEqual(rig2.logs.filter((l) => /REFUSED/.test(l)), []);
});

// ======================= structural guards =======================
test('GUARD: the engine only uses the controller\'s public, verified commands and never touches Bluetooth', () => {
  const src = readFileSync(new URL('../site/workout/engine.js', import.meta.url), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(src, /writeValue|encode\w*\(|_issue|transport|navigator/);
  const used = new Set([...src.matchAll(/this\.ctl\.(\w+)/g)].map((m) => m[1]));
  const allowed = new Set(['takeControl', 'start', 'stop', 'setSpeedMph', 'setInclineLevel', 'canSend', 'snapshot', 'subscribe', 'limits', 'ranges', 'hasControl', 'isFresh', 'hasPending']);
  for (const name of used) assert.ok(allowed.has(name), `engine uses ctl.${name}`);
});
