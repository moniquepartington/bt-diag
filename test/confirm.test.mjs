// Run: node --test test/confirm.test.mjs
// The non-blocking two-step confirmation, and a guard that no page uses the blocking dialog again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { FakeClock } from './rig.js';
import { TwoStepConfirm } from '../site/control/confirm.js';

function make(windowMs = 8000) {
  const clock = new FakeClock();
  const calls = { confirmed: 0, armed: 0, disarmed: 0 };
  const step = new TwoStepConfirm({ clock, windowMs, onConfirm: () => calls.confirmed++, onArm: () => calls.armed++, onDisarm: () => calls.disarmed++ });
  return { clock, calls, step };
}

test('CONFIRM: the first tap only arms; nothing runs', () => {
  const { step, calls } = make();
  assert.equal(step.tap(), 'armed');
  assert.deepEqual({ ...calls }, { confirmed: 0, armed: 1, disarmed: 0 });
  assert.equal(step.armed, true);
});

test('CONFIRM: a second tap inside the window confirms exactly once and disarms', () => {
  const { step, calls, clock } = make();
  step.tap();
  clock.advance(3000);
  assert.equal(step.tap(), 'confirmed');
  assert.deepEqual({ ...calls }, { confirmed: 1, armed: 1, disarmed: 1 });
  assert.equal(step.armed, false);
  clock.advance(60000);
  assert.equal(calls.confirmed, 1, 'the old timer does not fire anything later');
});

test('CONFIRM: doing nothing cancels after the window, and the next tap arms again rather than confirming', () => {
  const { step, calls, clock } = make(8000);
  step.tap();
  clock.advance(7900);
  assert.equal(step.armed, true);
  clock.advance(200);
  assert.equal(step.armed, false);
  assert.equal(calls.confirmed, 0);
  assert.equal(step.tap(), 'armed', 'after a timeout a single tap can never start the belt');
  assert.equal(calls.confirmed, 0);
});

test('CONFIRM: cancel() disarms (used when the action stops being allowed) and is harmless when not armed', () => {
  const { step, calls } = make();
  step.cancel();
  assert.equal(calls.disarmed, 0);
  step.tap();
  step.cancel();
  assert.equal(step.armed, false);
  assert.equal(calls.disarmed, 1);
  assert.equal(step.tap(), 'armed');
});

test('CONFIRM: rapid triple tap fires once; the third tap starts a fresh arming', () => {
  const { step, calls } = make();
  step.tap();
  step.tap();
  assert.equal(step.tap(), 'armed');
  assert.equal(calls.confirmed, 1);
});

test('GUARD: no page or module uses the page-blocking confirm()/alert()/prompt() dialogs', () => {
  const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = `${dir}/${n}`; return statSync(p).isDirectory() ? walk(p) : [p]; });
  const files = walk(new URL('../site', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/%20/g, ' ')).filter((f) => /\.(js|html)$/.test(f));
  assert.ok(files.length >= 15);
  for (const f of files) {
    const src = readFileSync(f, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(src, /\b(window\.)?(confirm|alert|prompt)\s*\(/, `${f} must not use a blocking dialog`);
  }
});
