// Run: node --test test/validate.test.mjs
// Staged limits-validation tests. SIMULATOR ONLY: nothing physical, no Bluetooth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeRig, settle, run, until } from './rig.js';
import { STAGES, ENABLED_STAGES, unlockStage } from '../site/validate/stages.js';
import { restartVerdict, TelemetryLog } from '../site/validate/observe.js';
import { VERIFIED_LIMITS } from '../site/workout/limits.js';
import { PRESETS } from '../site/workout/presets.js';
import { WorkoutEngine, STATE } from '../site/workout/engine.js';
import { validateWorkout, checkAgainstLimits, totalSeconds } from '../site/workout/workout.js';

const hexs = (b) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');

// ======================= stage definitions and the approval gate =======================
test('STAGES: limits are as approved, frozen, and the verified limits are untouched', () => {
  assert.deepEqual({ ...STAGES.A.limits }, { maxMph: 2.0, maxInclineLevel: 5 });
  assert.deepEqual({ ...STAGES.B.limits }, { maxMph: 2.8, maxInclineLevel: 8 });
  assert.ok(Object.isFrozen(STAGES) && Object.isFrozen(STAGES.A) && Object.isFrozen(STAGES.A.limits) && Object.isFrozen(STAGES.B.limits));
  assert.deepEqual({ ...VERIFIED_LIMITS }, { maxMph: 1.0, maxInclineLevel: 2 }, 'raising the verified limits is a separate, later step');
  assert.ok(STAGES.A.limits.maxMph > VERIFIED_LIMITS.maxMph && STAGES.B.limits.maxMph > STAGES.A.limits.maxMph);
});

test('STAGES: every manual speed and incline button sits inside its own stage limits', () => {
  for (const s of Object.values(STAGES)) {
    assert.ok(s.speedsMph.every((m) => m >= 0.6 && m <= s.limits.maxMph && Math.abs(m * 10 - Math.round(m * 10)) < 1e-9), `${s.label} speeds`);
    assert.ok(s.inclines.every((l) => Number.isInteger(l) && l >= 0 && l <= s.limits.maxInclineLevel), `${s.label} inclines`);
    assert.equal(Math.max(...s.speedsMph), s.limits.maxMph, 'the top button reaches the stage limit');
    assert.equal(Math.max(...s.inclines), s.limits.maxInclineLevel);
  }
});

test('STAGES: after Stage B every preset would be inside the validated range; Stage A alone is not enough', () => {
  assert.ok(PRESETS.every((p) => checkAgainstLimits(p, STAGES.B.limits).length === 0));
  assert.ok(PRESETS.some((p) => checkAgainstLimits(p, STAGES.A.limits).length > 0));
  assert.equal(Math.max(...PRESETS.flatMap((p) => p.intervals.map((i) => i.speedMph))), STAGES.B.limits.maxMph, 'B is exactly the preset maximum');
  assert.equal(Math.max(...PRESETS.flatMap((p) => p.intervals.map((i) => i.inclineLevel))), STAGES.B.limits.maxInclineLevel);
});

test('STAGE B workout: valid, multiples of 5 s, inside Stage B but beyond Stage A, and short', () => {
  const w = STAGES.B.workout;
  assert.deepEqual(validateWorkout(w), []);
  assert.deepEqual(checkAgainstLimits(w, STAGES.B.limits), []);
  assert.ok(checkAgainstLimits(w, STAGES.A.limits).length > 0);
  assert.equal(totalSeconds(w), 100);
  assert.equal(STAGES.A.workout, null);
});

test('GATE: this build (v2) enables exactly Stages A and B, nothing beyond them', () => {
  assert.deepEqual([...ENABLED_STAGES], ['A', 'B']);
  assert.deepEqual(Object.keys(STAGES), ['A', 'B'], 'no further stage exists');
  assert.equal(unlockStage('C', 'STAGE C').ok, false);
  assert.equal(unlockStage('C', 'STAGE C', ['A', 'B', 'C']).ok, false, 'an unknown stage cannot be unlocked even if listed');
});

test('GATE: each stage needs its OWN typed name; the other stage\'s phrase, yes, or nothing does not unlock it', () => {
  for (const id of ['A', 'B']) {
    const other = id === 'A' ? 'B' : 'A';
    assert.match(unlockStage(id, '').reason, new RegExp(`type STAGE ${id}`));
    assert.match(unlockStage(id, 'yes').reason, new RegExp(`type STAGE ${id}`));
    assert.match(unlockStage(id, `STAGE ${other}`).reason, new RegExp(`type STAGE ${id}`));
    assert.equal(unlockStage(id, `STAGE ${id}`).ok, true);
    assert.equal(unlockStage(id, `  stage ${id.toLowerCase()} `).stage, STAGES[id]);
  }
});

test('GATE: a stage left out of the enabled list cannot be unlocked, whatever is typed (the mechanism that held Stage B back in v1)', () => {
  for (const typed of ['STAGE B', 'stage b', ' Stage B ', 'B', '']) {
    const r = unlockStage('B', typed, ['A']);
    assert.equal(r.ok, false);
    assert.match(r.reason, /not enabled in this build/);
  }
  assert.equal(unlockStage('A', 'STAGE A', ['B']).ok, false);
});

test('OBSERVE: restart verdict distinguishes minimum, previous speed, and other', () => {
  assert.equal(restartVerdict(0.96, 0.96, 3.2).kind, 'minimum');
  assert.equal(restartVerdict(3.2, 0.96, 3.2).kind, 'previous');
  assert.equal(restartVerdict(2.0, 0.96, 3.2).kind, 'other');
  assert.equal(restartVerdict(0.97, 0.96, null).kind, 'minimum');
  assert.equal(restartVerdict(2.0, 0.96, null).kind, 'other');
});

test('OBSERVE: telemetry log keeps one reading per second, ignores missing speed, and is capped', () => {
  const log = new TelemetryLog(3);
  assert.equal(log.add(1000, 1.2, 0, 13), true);
  assert.equal(log.add(1400, 1.3, 0, 13), false, 'same second');
  assert.equal(log.add(2100, null, 0, 13), false, 'no speed');
  assert.equal(log.add(2200, 1.4, 2, 13), true);
  assert.equal(log.add(3300, 1.5, 2, 13), true);
  assert.equal(log.add(4400, 1.6, 2, 13), false, 'cap reached');
  assert.deepEqual(log.rows, [[1, 1.2, 0, 13], [2.2, 1.4, 2, 13], [3.3, 1.5, 2, 13]]);
});

// ======================= Stage A ladder on the simulator =======================
const stageRig = (stage, faults = {}) => makeRig(faults, { limits: STAGES[stage].limits });

async function toRunning(rig) {
  assert.equal((await settle(rig, rig.ctl.takeControl())).ok, true);
  assert.equal((await settle(rig, rig.ctl.start())).ok, true);
}

test('STAGE A ladder: jump from the minimum to 2.0 mph, steps both ways, incline 5, stop, restart (writes exactly the planned bytes)', async () => {
  const rig = stageRig('A');
  await toRunning(rig);
  for (const mph of [2.0, 1.0, 2.0]) assert.equal((await settle(rig, rig.ctl.setSpeedMph(mph))).ok, true, `speed ${mph}`);
  for (const lvl of [5, 2, 0]) assert.equal((await settle(rig, rig.ctl.setInclineLevel(lvl))).ok, true, `incline ${lvl}`);
  assert.equal((await settle(rig, rig.ctl.stop())).ok, true);
  assert.equal((await settle(rig, rig.ctl.start())).ok, true);
  assert.equal(rig.sim.state.speedKmh, 0.96, 'restarts at the minimum in the simulator');
  assert.equal((await settle(rig, rig.ctl.stop())).ok, true);
  assert.deepEqual(rig.written.map(hexs), ['00', '07', '02 40 01', '02 a0 00', '02 40 01', '03 32 00', '03 14 00', '03 00 00', '08 01', '07', '08 01']);
  assert.equal(rig.ctl.lock, null);
});

test('STAGE A limits are enforced: 2.1 mph and incline 6 are refused, 2.0 and 5 are accepted', async () => {
  const rig = stageRig('A');
  await toRunning(rig);
  const n = rig.written.length;
  for (const r of [await rig.ctl.setSpeedMph(2.1), await rig.ctl.setSpeedMph(2.8), await rig.ctl.setInclineLevel(6), await rig.ctl.setInclineLevel(8)]) {
    assert.equal(r.ok, false);
    assert.equal(r.sent, false);
  }
  assert.equal(rig.written.length, n);
  assert.equal((await settle(rig, rig.ctl.setSpeedMph(2.0))).ok, true);
  assert.equal((await settle(rig, rig.ctl.setInclineLevel(5))).ok, true);
});

test('the control layer on the REAL verified limits still refuses stage speeds (a stage cannot leak into other pages)', async () => {
  const rig = makeRig({});
  await toRunning(rig);
  assert.equal((await rig.ctl.setSpeedMph(2.0)).ok, false);
  assert.equal((await rig.ctl.setInclineLevel(5)).ok, false);
});

test('STAGE A: if the belt restarts at its PREVIOUS speed the observation shows it (and the manual ladder is not blocked)', async () => {
  const rig = stageRig('A', { rememberTarget: true });
  await toRunning(rig);
  assert.equal((await settle(rig, rig.ctl.setSpeedMph(2.0))).ok, true);
  assert.equal((await settle(rig, rig.ctl.stop())).ok, true);
  assert.equal((await settle(rig, rig.ctl.start())).ok, true);
  const kmh = rig.ctl.tele.speedKmh;
  assert.equal(kmh, 3.22); // 2.0 mph as the real treadmill reports it
  assert.equal(restartVerdict(kmh, rig.ctl.ranges.speed.minKmh, 2.0 * 1.6).kind, 'previous');
  assert.equal(rig.ctl.lock, null);
});

test('STAGE A: the engine REFUSES to continue a resume if the belt restarts at the previous speed (fails safe, sends no speed or incline)', async () => {
  const rig = stageRig('A', { rememberTarget: true });
  const w = { name: 't', intervals: [{ category: 'Warmup', durationSec: 30, speedMph: 1.0, inclineLevel: 0 }, { category: 'Training', durationSec: 30, speedMph: 2.0, inclineLevel: 2 }, { category: 'Cooldown', durationSec: 30, speedMph: 1.0, inclineLevel: 0 }] };
  const eng = new WorkoutEngine({ controller: rig.ctl, clock: rig.clock, limits: STAGES.A.limits });
  assert.equal(eng.load(w).ok, true);
  assert.equal((await settle(rig, eng.begin(), 40000)).ok, true);
  await run(rig, 40000); // into the 2.0 mph interval
  assert.equal((await settle(rig, eng.pause())).ok, true);
  const n = rig.written.length;
  const r = await settle(rig, eng.resume(), 40000);
  assert.equal(r.ok, false);
  assert.match(eng.fault.reason, /UNEXPECTED STATE AFTER RESTART/);
  assert.deepEqual(rig.written.slice(n).map(hexs), ['07'], 'only the restart; speed and incline were not touched');
});

// ======================= Stage B (built and simulator-tested, locked in this build) =======================
test('STAGE B workout runs on the simulator with a pause and resume, inside Stage B limits only', async () => {
  const rig = stageRig('B');
  const eng = new WorkoutEngine({ controller: rig.ctl, clock: rig.clock, limits: STAGES.B.limits });
  assert.equal(eng.load(STAGES.B.workout).ok, true);
  assert.equal((await settle(rig, eng.begin(), 40000)).ok, true);
  await run(rig, 25000); // into interval 2: 2.8 mph, incline 8
  assert.ok(Math.abs(rig.sim.state.speedKmh - 4.50) < 1e-9); // 2.8 mph as the real treadmill reports it
  assert.equal(rig.sim.state.inclinePct, 8);
  assert.equal((await settle(rig, eng.pause())).ok, true);
  assert.equal(rig.sim.state.running, false);
  assert.equal((await settle(rig, eng.resume(), 40000)).ok, true);
  assert.equal(eng.state, STATE.RUNNING);
  assert.equal(await until(rig, () => eng.state === STATE.COMPLETED, 200000), true);
  assert.equal(rig.ctl.lock, null);
  assert.equal(rig.maxInflight, 1);
  assert.ok(rig.written.every((w) => w[0] !== 0x02 || (w[1] | (w[2] << 8)) <= 448), 'no speed above 2.8 mph (4.48 km/h) was ever sent');
});

test('the same Stage B workout is REFUSED by an engine on Stage A limits (and on the verified limits)', () => {
  const rig = stageRig('A');
  const eng = new WorkoutEngine({ controller: rig.ctl, clock: rig.clock, limits: STAGES.A.limits });
  assert.equal(eng.load(STAGES.B.workout).ok, false);
  const real = makeRig({});
  assert.equal(new WorkoutEngine({ controller: real.ctl, clock: real.clock }).load(STAGES.B.workout).ok, false);
});

// ======================= page guards =======================
test('GUARD: the validation page writes through one transport call, builds no bytes by hand, and cannot touch the verified limits', () => {
  const app = readFileSync(new URL('../site/validate/app.js', import.meta.url), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.equal((app.match(/writeValue\w*/g) ?? []).length, 1, 'exactly one write call site');
  assert.match(app, /transport\s*=\s*\{[^}]*writeValue/s);
  assert.doesNotMatch(app, /new Uint8Array\(\[|Uint8Array\.of\(|\.writeValue\(\s*\[/);
  assert.match(app, /new Controller\(\{[^}]*limits: stage\.limits/s, 'the controller gets the stage limits and nothing else');
  assert.doesNotMatch(app, /VERIFIED_LIMITS|workout\/limits|LIMITS\s*=/);
  const stages = readFileSync(new URL('../site/validate/stages.js', import.meta.url), 'utf8');
  assert.doesNotMatch(stages.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'), /VERIFIED_LIMITS/);
});

test('GUARD: the read-only diagnostic and the validated control page are unchanged by this stage work (no new write sites)', () => {
  const diag = readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(diag, /writeValue/);
  const ctrl = readFileSync(new URL('../site/control/app.js', import.meta.url), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.equal((ctrl.match(/writeValue\w*/g) ?? []).length, 1);
  assert.doesNotMatch(ctrl, /stages|validate/i);
});
