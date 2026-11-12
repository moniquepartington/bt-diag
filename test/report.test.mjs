// Run: node --test test/report.test.mjs
// The copyable activity report: useful for diagnosing a hardware run, and free of identifiers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../site/app/report.js';

const base = { build: 'a2', now: '2026-01-01T00:00:00Z', limits: { maxMph: 2.8, maxInclineLevel: 8 } };

test('REPORT: it is valid JSON with the build, limits, engine and controller state, events and readings', () => {
  const r = JSON.parse(buildReport({
    ...base, events: ['12:00:00  App loaded', '12:00:05  SEND start [07]'], telemetry: [[1.2, 0.96, 0, 13]],
    engine: { state: 'running', name: 'Check run', elapsedMs: 5000, totalMs: 60000, intervalIndex: 0, override: { speedMph: 1.1, inclineLevel: 0 } },
    controller: { link: true, hasControl: true, lock: null, recovery: false }, storagePersistent: true, wake: 'active',
  }));
  assert.equal(r.build, 'a2');
  assert.deepEqual(r.limits, { maxMph: 2.8, maxInclineLevel: 8 });
  assert.equal(r.engine.state, 'running');
  assert.equal(r.engine.workout, 'Check run');
  assert.deepEqual(r.engine.override, { speedMph: 1.1, inclineLevel: 0 });
  assert.equal(r.controller.connected, true);
  assert.equal(r.controller.lock, null);
  assert.equal(r.events.length, 2);
  assert.deepEqual(r.telemetry, [[1.2, 0.96, 0, 13]]);
  assert.equal(r.screenWake, 'active');
});

test('REPORT: a fault and a lockout are described, so a failed run can be understood', () => {
  const r = JSON.parse(buildReport({ ...base, engine: { state: 'faulted', fault: { reason: 'CONNECTION LOST', detail: 'Bluetooth was lost.', belt: 'The belt may still be running.', beltKnown: 'running', extra: 'ignored' } }, controller: { link: false, lock: { reason: 'CONNECTION LOST', detail: 'd', secret: 'x' }, recovery: false } }));
  assert.deepEqual(r.engine.fault, { reason: 'CONNECTION LOST', detail: 'Bluetooth was lost.', belt: 'The belt may still be running.', beltKnown: 'running' });
  assert.deepEqual(r.controller.lock, { reason: 'CONNECTION LOST', detail: 'd' });
  assert.equal(r.controller.connected, false);
});

test('REPORT: only the last 400 events are kept, and an empty report still works', () => {
  const events = Array.from({ length: 1000 }, (_, i) => `e${i}`);
  const r = JSON.parse(buildReport({ ...base, events }));
  assert.equal(r.events.length, 400);
  assert.equal(r.events[0], 'e600');
  const empty = JSON.parse(buildReport({ build: 'a2' }));
  assert.equal(empty.engine.state, null);
  assert.deepEqual(empty.events, []);
});

test('REPORT PRIVACY: the report builder never takes or emits a device name, address or serial number', () => {
  const text = buildReport({ ...base, events: ['Connected.'], engine: { state: 'ready' }, controller: { link: true } });
  assert.doesNotMatch(text, /FS-|serial|address|[0-9A-F]{2}(:[0-9A-F]{2}){5}|uuid/i);
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['build', 'controller', 'engine', 'events', 'generatedAt', 'limits', 'screenWake', 'storagePersistent', 'telemetry']);
});
