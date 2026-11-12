// Run: node --test test/session.test.mjs
// The Bluetooth session and the screen wake lock, against a FAKE Bluetooth stack backed by the simulator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FakeClock, flush, settle, run } from './rig.js';
import { createFakeBluetooth } from './fake-bluetooth.js';
import { BleSession } from '../site/app/session.js';
import { ScreenWake } from '../site/app/wakelock.js';
import { Controller } from '../site/control/controller.js';
import { VERIFIED_LIMITS } from '../site/workout/limits.js';

function setup(opts = {}, sessionOpts = {}) {
  const clock = new FakeClock();
  const fake = createFakeBluetooth({ clock, ...opts });
  const logs = [];
  const session = new BleSession({ bluetooth: fake.bluetooth, secure: true, onLog: (l) => logs.push(l), ...sessionOpts });
  const ctl = new Controller({ transport: session.transport, clock, limits: VERIFIED_LIMITS });
  session.attach(ctl);
  ctl.setArmed(true);
  return { clock, fake, session, ctl, logs };
}
const rigLike = (s) => ({ clock: s.clock });

test('SESSION: unavailable without Web Bluetooth or without a secure page, with a clear reason', async () => {
  const a = new BleSession({ bluetooth: undefined, secure: true });
  assert.equal(a.availability().ok, false);
  assert.match((await a.connect()).reason, /Bluefy/);
  const b = new BleSession({ bluetooth: {}, secure: false });
  assert.match(b.availability().reason, /https/);
});

test('SESSION: connecting reads the limits, subscribes to all four notification sources, sends nothing, and reports the name', async () => {
  const s = setup();
  const r = await s.session.connect();
  assert.deepEqual(r, { ok: true, name: 'FS-FAKE' });
  assert.equal(s.ctl.link, true);
  assert.deepEqual(s.ctl.ranges, { speed: { minKmh: 0.96, maxKmh: 8.05 }, incline: { minPct: 0, maxPct: 12 } });
  assert.deepEqual(s.fake.calls.startNotifications.sort(), ['2AD9', '2ACD', '2AD3', '2ADA'].sort(), 'including the control-point responses');
  assert.equal(s.fake.writes.length, 0, 'connecting writes nothing to the treadmill');
});

test('SESSION: Bluefy-style short IDs and full IDs both route notifications into the controller', async () => {
  for (const shortUuids of [true, false]) {
    const s = setup({ shortUuids });
    await s.session.connect();
    s.clock.advance(1500);
    assert.equal(s.ctl.tele.speedKmh, 0, `readings arrive (shortUuids=${shortUuids})`);
    assert.equal(s.ctl.isFresh(), true);
  }
});

test('SESSION: a command goes out through the one transport call and is acknowledged through the subscribed responses', async () => {
  const s = setup();
  await s.session.connect();
  s.clock.advance(1500);
  const r = await settle(rigLike(s), s.ctl.takeControl());
  assert.equal(r.ok, true);
  assert.deepEqual(s.fake.writes, [[0x00]]);
  assert.equal(s.ctl.hasControl, true);
});

test('SESSION: if responses cannot be subscribed to, connecting fails and no command can ever be sent', async () => {
  const s = setup({ failCpNotify: true });
  const r = await s.session.connect();
  assert.equal(r.ok, false);
  assert.match(r.reason, /indications/);
  assert.equal(s.ctl.link, false);
  assert.equal(s.session.cp, null);
  assert.equal(s.fake.device.gatt.connected, false, 'the connection was dropped');
  s.clock.advance(1500);
  assert.equal((await s.ctl.takeControl()).sent, false);
  assert.equal(s.fake.writes.length, 0);
});

test('SESSION: nonsensical limits from the treadmill refuse the connection', async () => {
  const s = setup({ badSpeedRange: true });
  const r = await s.session.connect();
  assert.equal(r.ok, false);
  assert.match(r.reason, /limits could not be read/);
  assert.equal(s.ctl.link, false);
});

test('SESSION: cancelling the device chooser (the browser gives no details) is reported kindly', async () => {
  const s = setup({ chooserError: Object.assign(new Error(''), { name: 'NotFoundError' }) });
  const r = await s.session.connect();
  assert.equal(r.ok, false);
  assert.match(r.reason, /cancelled/);
  assert.equal(s.ctl.link, false);
});

test('SESSION: a connection that never completes times out instead of hanging', async () => {
  const s = setup({ connectHangs: true }, { connectTimeoutMs: 30 });
  const r = await s.session.connect();
  assert.equal(r.ok, false);
  assert.match(r.reason, /timed out/);
  assert.equal(s.ctl.link, false);
});

test('SESSION: losing the connection locks the controller out (the belt may still be moving)', async () => {
  const s = setup();
  await s.session.connect();
  s.clock.advance(1500);
  s.fake.device.gatt.disconnect();
  assert.equal(s.ctl.link, false);
  assert.match(s.ctl.lock.reason, /CONNECTION LOST/);
  assert.equal(s.ctl.canSend('takeControl').ok, false);
});

test('SESSION: disconnect() from the app has the same effect', async () => {
  const s = setup();
  await s.session.connect();
  s.session.disconnect();
  assert.match(s.ctl.lock.reason, /CONNECTION LOST/);
});

test('SESSION: reconnecting on the SAME device object never double-counts an acknowledgment', async () => {
  const s = setup();
  await s.session.connect();
  s.session.disconnect();
  s.ctl.resetLock();
  assert.equal((await s.session.connect()).ok, true);
  s.clock.advance(1500);
  const r = await settle(rigLike(s), s.ctl.takeControl());
  assert.equal(r.ok, true, 'one acknowledgment, counted once');
  assert.equal(s.ctl.lock, null, 'no DUPLICATE RESPONSE lockout');
  assert.deepEqual(s.fake.writes, [[0x00]]);
  assert.equal(s.fake.calls.requestDevice, 2);
});

test('SESSION: a belt that keeps running through a disconnect is recoverable from a new session (take control, then stop)', async () => {
  const s = setup();
  await s.session.connect();
  s.clock.advance(1500);
  await settle(rigLike(s), s.ctl.takeControl());
  await settle(rigLike(s), s.ctl.start());
  s.session.disconnect();
  s.fake.sim.dropControl();
  s.clock.advance(5000);
  assert.equal(s.fake.sim.state.running, true);
  assert.equal((await s.session.connect()).ok, true);
  s.clock.advance(1500);
  assert.equal(s.ctl.snapshot().recovery, true);
  assert.equal((await settle(rigLike(s), s.ctl.takeControl())).ok, true);
  assert.equal((await settle(rigLike(s), s.ctl.stop())).ok, true);
  assert.equal(s.fake.sim.state.running, false);
});

test('SESSION GUARD: the app has exactly one write call site, and builds no command bytes by hand', () => {
  const dir = new URL('../site/app/', import.meta.url);
  const files = ['session.js', 'wakelock.js', 'storage.js', 'editor-model.js', 'workout-vm.js', 'format.js'];
  let writes = 0;
  for (const f of files) {
    const src = readFileSync(new URL(f, dir), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    writes += (src.match(/writeValue\w*/g) ?? []).length;
    assert.doesNotMatch(src, /Uint8Array\.of\(|new Uint8Array\(\[/, `${f} builds no bytes`);
  }
  assert.equal(writes, 1);
});

// ======================= screen wake lock =======================
test('WAKE: unsupported browsers are reported plainly', async () => {
  const w = new ScreenWake({ nav: {} });
  assert.equal(w.supported, false);
  assert.equal(w.status, 'unsupported');
  assert.equal((await w.acquire()).ok, false);
  assert.match(w.describe(), /Auto-Lock to Never/);
});

test('WAKE: acquire, notice when the system releases it, and release', async () => {
  let release;
  const sentinel = { addEventListener: (ev, fn) => { if (ev === 'release') release = fn; }, release: async () => {} };
  const changes = [];
  const w = new ScreenWake({ nav: { wakeLock: { request: async () => sentinel } }, onChange: (s) => changes.push(s) });
  assert.equal(w.status, 'idle');
  assert.equal((await w.acquire()).ok, true);
  assert.equal(w.status, 'active');
  release();
  assert.equal(w.status, 'lost');
  assert.match(w.describe(), /may lock/);
  await w.release();
  assert.equal(w.status, 'idle');
  assert.deepEqual(changes, ['active', 'lost', 'idle']);
});

test('WAKE: a refusal by the browser is reported and does not throw', async () => {
  const w = new ScreenWake({ nav: { wakeLock: { request: async () => { throw new Error('NotAllowedError'); } } } });
  const r = await w.acquire();
  assert.equal(r.ok, false);
  assert.equal(w.status, 'denied');
  assert.match(w.describe(), /Auto-Lock/);
});
