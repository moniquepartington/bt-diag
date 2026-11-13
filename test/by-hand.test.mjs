// Run: node --test test/by-hand.test.mjs
// Closing a fault by hand when there is no connection (the user stopped the belt with the remote). SIMULATOR ONLY.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRig, settle, run } from './rig.js';
import { WorkoutEngine, STATE } from '../site/workout/engine.js';
import { VERIFIED_LIMITS as L } from '../site/workout/limits.js';
import { runView, closeFaultByHand } from '../site/app/workout-vm.js';

const LIVE = { speed: { minKmh: 0.96, maxKmh: 8.05 }, incline: { minPct: 0, maxPct: 12 } };
const mini = { name: 'mini', intervals: [{ category: 'Warmup', durationSec: 30, speedMph: 0.6, inclineLevel: 0 }, { category: 'Training', durationSec: 30, speedMph: 1.0, inclineLevel: 0 }] };

async function runningThenLost() {
  const rig = makeRig({}, { limits: L });
  rig.engine = new WorkoutEngine({ controller: rig.ctl, clock: rig.clock, limits: L });
  assert.equal(rig.engine.load(mini).ok, true);
  assert.equal((await settle(rig, rig.engine.begin(), 40000)).ok, true);
  await run(rig, 3000);
  rig.ctl.disconnected();
  assert.equal(rig.engine.state, STATE.FAULTED);
  return rig;
}
const view = (rig) => runView(rig.engine.snapshot(), rig.ctl.snapshot(), {});

test('BY HAND: with no connection the user can close the fault and the lockout; nothing is sent', async () => {
  const rig = await runningThenLost();
  const sent = rig.written.length;
  const v = view(rig);
  assert.equal(v.buttons.closeByHand.enabled, true);
  assert.equal(v.buttons.resetLock.enabled, false, 'the readings-based reset stays unavailable without a connection');
  assert.equal(closeFaultByHand(rig.engine, rig.ctl).ok, true);
  assert.equal(rig.engine.state, STATE.STOPPED);
  assert.equal(rig.ctl.lock, null);
  assert.equal(rig.written.length, sent, 'no command was sent');
  await run(rig, 60000);
  assert.equal(rig.written.length, sent, 'nothing restarted, nothing sent later');
  assert.equal((await rig.engine.resume()).ok, false, 'a closed run cannot be resumed');
});

test('BY HAND: while connected the button is unavailable and the function refuses (the readings-based path applies)', async () => {
  const rig = await runningThenLost();
  rig.ctl.connected(LIVE);
  rig.clock.advance(1500);
  const v = view(rig);
  assert.equal(v.buttons.closeByHand.enabled, false);
  assert.match(v.buttons.closeByHand.why, /connected/);
  const r = closeFaultByHand(rig.engine, rig.ctl);
  assert.equal(r.ok, false);
  assert.equal(rig.engine.state, STATE.FAULTED);
  assert.ok(rig.ctl.lock);
});

test('BY HAND: wrongly closing while the belt still runs is caught on reconnect: locked out again, recovery offered, nothing sent', async () => {
  const rig = await runningThenLost();
  assert.equal(rig.sim.state.running, true);
  const sent = rig.written.length;
  assert.equal(closeFaultByHand(rig.engine, rig.ctl).ok, true);
  rig.sim.dropControl();
  rig.ctl.connected(LIVE);
  rig.ctl.feedTraining(rig.sim.state.training);
  rig.clock.advance(3000);
  await Promise.resolve();
  assert.ok(rig.ctl.lock, 'the moving belt is noticed and locks the controller out');
  assert.equal(rig.ctl.snapshot().recovery, true);
  assert.equal(rig.written.length, sent, 'nothing sent');
  assert.equal(rig.ctl.canSend('start').ok, false, 'cannot start with the belt moving');
});

test('BY HAND: the engine refuses it when there is no fault', () => {
  const rig = makeRig({}, { limits: L });
  rig.engine = new WorkoutEngine({ controller: rig.ctl, clock: rig.clock, limits: L });
  assert.equal(rig.engine.acknowledgeFaultByUser().ok, false);
});

test('BY HAND: nothing to close when connected with no lock and no fault', () => {
  const rig = makeRig({}, { limits: L });
  rig.engine = new WorkoutEngine({ controller: rig.ctl, clock: rig.clock, limits: L });
  assert.equal(view(rig).buttons.closeByHand.enabled, false);
});
