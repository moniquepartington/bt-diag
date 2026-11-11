// Run: node --test test/controller.test.mjs
// Everything here runs against a SIMULATED treadmill on a fake clock. No Bluetooth, nothing physical.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeRig, settle, flush } from './rig.js';
import { encodeSetSpeedMph, encodeSetInclineLevel, encodeRequestControl, encodeStart, encodeStop, parseIndication, OP, LIMITS } from '../site/control/protocol.js';

const RANGES = { speed: { minKmh: 0.96, maxKmh: 8.05 }, incline: { minPct: 0, maxPct: 12 } };
const hexs = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');

async function toRunning(rig) {
  assert.equal((await settle(rig, rig.ctl.takeControl())).ok, true);
  assert.equal((await settle(rig, rig.ctl.start())).ok, true);
}

// ---------- encoders ----------
test('encoders produce exactly the documented bytes', () => {
  assert.equal(hexs(encodeRequestControl()), '00');
  assert.equal(hexs(encodeStart()), '07');
  assert.equal(hexs(encodeStop()), '08 01');
  assert.equal(hexs(encodeSetSpeedMph(0.8, RANGES).bytes), '02 80 00'); // 1.28 km/h
  assert.equal(hexs(encodeSetSpeedMph(1.0, RANGES).bytes), '02 a0 00'); // 1.60 km/h
  assert.equal(hexs(encodeSetSpeedMph(0.6, RANGES).bytes), '02 60 00'); // 0.96 km/h, matches the captured minimum
  assert.equal(hexs(encodeSetInclineLevel(2, RANGES).bytes), '03 14 00'); // 2.0 %
});

test('encoders refuse anything outside the Phase 2 limits or the device range', () => {
  for (const bad of [1.1, 0.5, 0.85, -0.6, NaN, Infinity, '0.8', null]) assert.throws(() => encodeSetSpeedMph(bad, RANGES), RangeError, String(bad));
  for (const bad of [3, -1, 1.5, NaN, '1']) assert.throws(() => encodeSetInclineLevel(bad, RANGES), RangeError, String(bad));
  assert.throws(() => encodeSetSpeedMph(0.8, null), RangeError);
  assert.throws(() => encodeSetSpeedMph(0.8, { speed: { minKmh: 1.5, maxKmh: 8 } }), /below the treadmill minimum/);
});

test('only five opcodes exist: request control, set speed, set incline, start, stop', () => {
  assert.deepEqual(Object.values(OP).sort(), [0x00, 0x02, 0x03, 0x07, 0x08]);
  assert.deepEqual(LIMITS, { maxMph: 1.0, maxInclineLevel: 2 });
});

test('indication parsing', () => {
  assert.deepEqual(parseIndication(Uint8Array.of(0x80, 0x07, 0x01)), { op: 7, result: 1, ok: true });
  assert.equal(parseIndication(Uint8Array.of(0x80, 0x07, 0x05)).ok, false);
  assert.equal(parseIndication(Uint8Array.of(0x12, 0x07, 0x01)), null);
  assert.equal(parseIndication(Uint8Array.of(0x80)), null);
});

// ---------- happy path ----------
test('full ladder on the simulator: take control, start, speeds, inclines, stop', async () => {
  const rig = makeRig();
  const { ctl, written, sim } = rig;
  await toRunning(rig);
  assert.equal(sim.state.running, true);
  assert.equal(ctl.hasControl, true);
  for (const mph of [0.8, 1.0]) assert.equal((await settle(rig, ctl.setSpeedMph(mph))).ok, true);
  for (const lvl of [1, 2]) assert.equal((await settle(rig, ctl.setInclineLevel(lvl))).ok, true);
  assert.equal((await settle(rig, ctl.stop())).ok, true);
  assert.equal(sim.state.running, false);
  assert.equal(ctl.lock, null);
  assert.deepEqual(written, [[0x00], [0x07], [0x02, 0x80, 0x00], [0x02, 0xa0, 0x00], [0x03, 0x0a, 0x00], [0x03, 0x14, 0x00], [0x08, 0x01]]);
});

// ---------- single outstanding command ----------
test('only one command may be outstanding: every button is refused while one is in progress, including stop', async () => {
  const rig = makeRig();
  const { ctl, written } = rig;
  const first = ctl.takeControl();
  await flush();
  assert.equal(written.length, 1);
  const snap = ctl.snapshot();
  for (const c of ['takeControl', 'start', 'setSpeed', 'setIncline', 'stop']) assert.equal(snap.buttons[c].ok, false, c);
  for (const attempt of [ctl.start(), ctl.stop(), ctl.setSpeedMph(0.8), ctl.setInclineLevel(1), ctl.takeControl()]) {
    const r = await attempt;
    assert.equal(r.ok, false);
    assert.equal(r.sent, false);
  }
  assert.equal(written.length, 1, 'nothing else may be written');
  assert.equal((await settle(rig, first)).ok, true);
  assert.equal(ctl.pending, null);
});

// ---------- pre-conditions ----------
test('nothing is sent when not armed, with stale telemetry, or without device limits', async () => {
  const a = makeRig({}, { armed: false });
  assert.equal((await a.ctl.takeControl()).ok, false);
  const b = makeRig();
  b.clock.advance(5000);
  b.sim.halt();
  b.clock.advance(5000); // telemetry now stale
  assert.equal((await b.ctl.takeControl()).ok, false);
  const c = makeRig();
  c.ctl.ranges = null;
  assert.equal((await c.ctl.takeControl()).ok, false);
  assert.equal(a.written.length + b.written.length + c.written.length, 0);
});

test('start, speed and incline are refused until control is taken and the belt state allows', async () => {
  const rig = makeRig();
  for (const r of [await rig.ctl.start(), await rig.ctl.setSpeedMph(0.8), await rig.ctl.setInclineLevel(1)]) assert.equal(r.ok, false);
  assert.equal(rig.written.length, 0);
  assert.equal((await settle(rig, rig.ctl.takeControl())).ok, true);
  assert.equal((await rig.ctl.setSpeedMph(0.8)).ok, false, 'belt not running');
  assert.equal(rig.written.length, 1);
});

test('stop is not offered at idle before control is taken, but is offered once control is held or anything fails', async () => {
  const rig = makeRig();
  assert.equal(rig.ctl.snapshot().buttons.stop.ok, false);
  assert.equal((await rig.ctl.stop()).sent, false);
  assert.equal(rig.written.length, 0);
  await settle(rig, rig.ctl.takeControl());
  assert.equal(rig.ctl.snapshot().buttons.stop.ok, true);
});

test('limits: 1.1 mph, 0.5 mph, 0.85 mph and incline 3 are refused before anything is written', async () => {
  const rig = makeRig();
  await toRunning(rig);
  const before = rig.written.length;
  for (const r of [await rig.ctl.setSpeedMph(1.1), await rig.ctl.setSpeedMph(0.5), await rig.ctl.setSpeedMph(0.85), await rig.ctl.setInclineLevel(3), await rig.ctl.setInclineLevel(-1)]) {
    assert.equal(r.ok, false);
    assert.equal(r.sent, false);
  }
  assert.equal(rig.written.length, before);
  assert.equal(rig.ctl.lock, null, 'a refused input is not a failure');
});

test('take control and start are refused if the belt is already active', async () => {
  const rig = makeRig({}, { warmup: false });
  rig.sim.remoteStart();
  rig.clock.advance(5000);
  assert.ok(rig.ctl.lock, 'unexpected belt activity locks the test');
  assert.equal((await rig.ctl.takeControl()).ok, false);
  assert.equal(rig.written.length, 0);
});

// ---------- failures lock out; nothing retried ----------
async function assertLockedAndNoRetry(rig, expectedWrites, reasonPattern) {
  const writesAtFailure = rig.written.length;
  assert.equal(writesAtFailure, expectedWrites);
  assert.match(rig.ctl.lock.reason, reasonPattern);
  rig.clock.advance(60000);
  await flush();
  assert.equal(rig.written.length, writesAtFailure, 'never retries automatically');
  const snap = rig.ctl.snapshot();
  for (const c of ['takeControl', 'start', 'setSpeed', 'setIncline']) assert.equal(snap.buttons[c].ok, false, `${c} must be locked`);
  assert.equal((await rig.ctl.takeControl()).sent, false);
}

test('no acknowledgment: locks out after the timeout and never retries', async () => {
  const rig = makeRig({ noAck: true });
  const r = await settle(rig, rig.ctl.takeControl());
  assert.equal(r.ok, false);
  assert.match(r.reason, /NO ACKNOWLEDGMENT/);
  await assertLockedAndNoRetry(rig, 1, /NO ACKNOWLEDGMENT/);
});

test('error result code from the treadmill: locks out, never retries', async () => {
  const rig = makeRig({ badResult: { op: 0x00, code: 0x04 } });
  const r = await settle(rig, rig.ctl.takeControl());
  assert.equal(r.ok, false);
  await assertLockedAndNoRetry(rig, 1, /REJECTED/);
});

test('write failure: locks out, never retries', async () => {
  const rig = makeRig({ writeThrows: true });
  const r = await settle(rig, rig.ctl.takeControl());
  assert.equal(r.ok, false);
  await assertLockedAndNoRetry(rig, 1, /WRITE FAILED/);
});

test('response for a different opcode, duplicate response, or unsolicited response all lock out', async () => {
  const wrong = makeRig({ wrongOpAck: true });
  await settle(wrong, wrong.ctl.takeControl());
  assert.match(wrong.ctl.lock.reason, /DIFFERENT COMMAND/);
  const dup = makeRig({ duplicateAck: true });
  await settle(dup, dup.ctl.takeControl());
  assert.match(dup.ctl.lock.reason, /DUPLICATE/);
  const idle = makeRig();
  idle.ctl.feedIndication(Uint8Array.of(0x80, 0x07, 0x01));
  assert.match(idle.ctl.lock.reason, /UNEXPECTED RESPONSE/);
});

test('acknowledged but telemetry never shows the speed: locks out after the confirm timeout', async () => {
  const rig = makeRig({ ignoreSpeed: true });
  await toRunning(rig);
  const r = await settle(rig, rig.ctl.setSpeedMph(1.0));
  assert.equal(r.ok, false);
  assert.match(r.reason, /NOT CONFIRMED/);
  assert.equal(rig.written.length, 3);
  await assertLockedAndNoRetry(rig, 3, /NOT CONFIRMED/);
});

test('incline readback that does not match the request locks out', async () => {
  const rig = makeRig({ inclineOffset: 1 });
  await toRunning(rig);
  const r = await settle(rig, rig.ctl.setInclineLevel(1));
  assert.equal(r.ok, false);
  assert.match(r.reason, /NOT CONFIRMED/);
});

test('start that is acknowledged but never reaches running locks out', async () => {
  const rig = makeRig();
  await settle(rig, rig.ctl.takeControl());
  rig.sim.state.control = true;
  // sim ignores nothing here, so emulate a treadmill that acknowledges and then does nothing
  rig.sim.write = (b) => { rig.clock.setTimeout(() => rig.ctl.feedIndication(Uint8Array.of(0x80, b[0], 0x01)), 50); };
  const r = await settle(rig, rig.ctl.start());
  assert.equal(r.ok, false);
  assert.match(r.reason, /NOT CONFIRMED/);
});

test('overspeed telemetry locks out immediately', async () => {
  const rig = makeRig({ overspeedOnStart: true });
  await settle(rig, rig.ctl.takeControl());
  const r = await settle(rig, rig.ctl.start());
  assert.equal(r.ok, false);
  assert.match(rig.ctl.lock.reason, /OVERSPEED/);
});

test('telemetry that stops while the belt runs locks out', async () => {
  const rig = makeRig();
  await toRunning(rig);
  rig.sim.halt();
  rig.clock.advance(6000);
  assert.match(rig.ctl.lock.reason, /TELEMETRY LOST/);
});

test('disconnect: locks out, drops control, stop is unavailable, nothing further is sent', async () => {
  const rig = makeRig();
  await toRunning(rig);
  const before = rig.written.length;
  rig.ctl.disconnected();
  assert.match(rig.ctl.lock.reason, /CONNECTION LOST/);
  assert.equal(rig.ctl.hasControl, false);
  for (const c of ['takeControl', 'start', 'setSpeed', 'setIncline', 'stop']) assert.equal(rig.ctl.snapshot().buttons[c].ok, false, c);
  assert.equal((await rig.ctl.stop()).sent, false);
  assert.equal(rig.written.length, before);
});

test('disconnect mid-command settles the command as failed', async () => {
  const rig = makeRig({ noAck: true });
  const p = rig.ctl.takeControl();
  await flush();
  rig.ctl.disconnected();
  const r = await p;
  assert.equal(r.ok, false);
  assert.match(r.reason, /CONNECTION LOST/);
});

test('page leaving the screen while active locks out', async () => {
  const rig = makeRig();
  await toRunning(rig);
  rig.ctl.pageHidden();
  assert.match(rig.ctl.lock.reason, /PAGE LEFT/);
});

test('control permission lost status locks out', async () => {
  const rig = makeRig();
  await toRunning(rig);
  rig.ctl.feedMachineStatus(0xff);
  assert.match(rig.ctl.lock.reason, /CONTROL PERMISSION LOST/);
  assert.equal(rig.ctl.hasControl, false);
});

// ---------- the Take Control tripwire ----------
test('TRIPWIRE: if Take Control starts the belt, motion is detected within the watch window and everything locks', async () => {
  const rig = makeRig({ takeControlStartsBelt: true });
  const r = await settle(rig, rig.ctl.takeControl());
  assert.equal(r.ok, false);
  assert.match(r.reason, /MOTION AFTER TAKE CONTROL/);
  assert.equal(rig.written.length, 1, 'only the Take Control byte was ever written');
  assert.equal(rig.ctl.snapshot().buttons.start.ok, false);
  assert.equal(rig.ctl.snapshot().buttons.stop.ok, true, 'stop stays available in a lockout');
});

test('Take Control on a well-behaved treadmill: no motion during the 6 s watch, then resolved', async () => {
  const rig = makeRig();
  const p = rig.ctl.takeControl();
  await flush();
  rig.clock.advance(2000);
  await flush();
  assert.equal(rig.ctl.pending?.cmd, 'takeControl', 'still held during the watch window (buttons stay disabled)');
  const r = await settle(rig, p);
  assert.equal(r.ok, true);
  assert.equal(rig.sim.state.running, false);
});

// ---------- lockout semantics ----------
test('lockout permits Stop (when no command is outstanding) and nothing else; reset is manual and refused while pending', async () => {
  const rig = makeRig({ ignoreSpeed: true });
  await toRunning(rig);
  await settle(rig, rig.ctl.setSpeedMph(1.0)); // fails and locks
  assert.ok(rig.ctl.lock);
  assert.equal(rig.ctl.snapshot().buttons.stop.ok, true);
  const p = rig.ctl.stop();
  await flush();
  assert.deepEqual(rig.ctl.resetLock(), { ok: false, reason: 'a command is still in progress' });
  assert.equal((await settle(rig, p)).ok, true);
  assert.ok(rig.ctl.lock, 'a successful stop does not clear the lock');
  assert.equal(rig.ctl.resetLock().ok, true);
  assert.equal(rig.ctl.lock, null);
});

test('stop that is acknowledged but the belt keeps moving locks out and says so', async () => {
  const rig = makeRig({ stopIgnored: true });
  await toRunning(rig);
  const r = await settle(rig, rig.ctl.stop());
  assert.equal(r.ok, false);
  assert.match(r.reason, /NOT CONFIRMED/);
});

test('belt stopped from the remote while idle is noted, not an error', async () => {
  const rig = makeRig();
  await toRunning(rig);
  rig.sim.remoteStop();
  rig.clock.advance(2000);
  assert.equal(rig.ctl.lock, null);
  assert.equal(rig.ctl.expect, 'stopped');
});

test('belt stopped from the remote while a speed command is in progress locks out', async () => {
  const rig = makeRig({ ackDelayMs: 1500 });
  await toRunning(rig);
  const p = rig.ctl.setSpeedMph(1.0);
  await flush();
  rig.sim.remoteStop();
  const r = await settle(rig, p);
  assert.equal(r.ok, false);
  assert.match(r.reason, /BELT STOPPED DURING A COMMAND|NOT CONFIRMED/);
});

test('TRIPWIRE variant: belt starts 2 s AFTER the Take Control acknowledgment, still inside the watch window', async () => {
  const rig = makeRig();
  const p = rig.ctl.takeControl();
  await flush();
  rig.clock.advance(200); // acknowledged
  assert.equal(rig.ctl.pending.acked, true);
  rig.clock.advance(1800);
  rig.sim.remoteStart(); // stands in for a module that starts the belt late
  const r = await settle(rig, p);
  assert.equal(r.ok, false);
  assert.match(r.reason, /MOTION AFTER TAKE CONTROL/);
  assert.equal(rig.written.length, 1);
});

test('belt started by someone else while the page is idle locks out', async () => {
  const rig = makeRig();
  rig.sim.remoteStart();
  rig.clock.advance(5000);
  assert.match(rig.ctl.lock.reason, /UNEXPECTEDLY|SOMETHING ELSE/);
});

// ---------- structural guards ----------
test('GUARD: the only code that writes to the device is the controller transport, via the five encoders', () => {
  const app = readFileSync(new URL('../site/control/app.js', import.meta.url), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const writes = app.match(/writeValue\w*/g) ?? [];
  assert.equal(writes.length, 1, 'exactly one write call site');
  assert.match(app, /transport\s*=\s*\{[^}]*writeValue/s);
  assert.doesNotMatch(app, /new Uint8Array\(\[|Uint8Array\.of\(|\.writeValue\(\s*\[/, 'no hand-built byte arrays in the page');
});

test('a late acknowledgment of an abandoned command is ignored once and does not fail a later Stop', async () => {
  const rig = makeRig({ noAck: true });
  await settle(rig, rig.ctl.takeControl()); // no ack within 3 s: locked out, command abandoned
  assert.match(rig.ctl.lock.reason, /NO ACKNOWLEDGMENT/);
  const p = rig.ctl.stop();
  await flush();
  rig.ctl.feedIndication(Uint8Array.of(0x80, 0x00, 0x01)); // the old Take Control answer finally arrives
  assert.equal(rig.ctl.pending?.cmd, 'stop', 'the Stop is unaffected');
  assert.equal(rig.ctl.hasControl, true);
  rig.ctl.feedIndication(Uint8Array.of(0x80, 0x08, 0x01));
  const r = await settle(rig, p);
  assert.equal(r.ok, true);
  rig.ctl.feedIndication(Uint8Array.of(0x80, 0x00, 0x01)); // a second copy is NOT expected
  assert.match(rig.ctl.lock.reason, /NO ACKNOWLEDGMENT/, 'original lock reason is kept');
  assert.ok(rig.logs.some((l) => /UNEXPECTED RESPONSE/.test(l)));
});

test('GUARD: the read-only diagnostic still contains no writes', () => {
  const src = readFileSync(new URL('../site/app.js', import.meta.url), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(src, /writeValue/);
});
