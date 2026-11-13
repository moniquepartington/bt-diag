// Run: node --test test/connect-log.test.mjs
// The treadmill status read at connect is written to the activity log (diagnostics only), with no identifiers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from './rig.js';
import { createFakeBluetooth } from './fake-bluetooth.js';
import { BleSession } from '../site/app/session.js';
import { Controller } from '../site/control/controller.js';
import { VERIFIED_LIMITS } from '../site/workout/limits.js';

test('CONNECT LOG: the status value read at connect is logged, and the log still has no device name', async () => {
  const clock = new FakeClock();
  const fake = createFakeBluetooth({ clock });
  const logs = [];
  const session = new BleSession({ bluetooth: fake.bluetooth, secure: true, onLog: (l) => logs.push(l) });
  session.attach(new Controller({ transport: session.transport, clock, limits: VERIFIED_LIMITS }));
  assert.equal((await session.connect()).ok, true);
  const line = logs.find((l) => /status read at connect/.test(l));
  assert.match(line, /0x1\b/, 'the idle status of the simulated treadmill');
  assert.doesNotMatch(logs.join(' | '), /FS-/);
});
