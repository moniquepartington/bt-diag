// Run: node --test test/
// Fixtures are SYNTHETIC (built from the Bluetooth FTMS spec layout), not captured from a W400A.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTreadmillData, parseFeature, parseSpeedRange, parseInclineRange, parseTrainingStatus, parseMachineStatus, uuid16, hex } from '../diag/ftms.js';

const dv = (...bytes) => new DataView(new Uint8Array(bytes).buffer);

test('uuid16 expands to a full UUID', () => {
  assert.equal(uuid16(0x1826), '00001826-0000-1000-8000-00805f9b34fb');
  assert.equal(uuid16(0x2ad9), '00002ad9-0000-1000-8000-00805f9b34fb');
});

test('treadmill data, flags 0x058c: speed, distance, incline+ramp, energy, HR, elapsed', () => {
  const d = parseTreadmillData(dv(
    0x8c, 0x05,             // flags
    0xc8, 0x00,             // speed 2.00 km/h
    0x10, 0x27, 0x00,       // distance 10000 m
    0x32, 0x00, 0x00, 0x00, // incline 5.0 %, ramp 0.0
    0x0a, 0x00, 0xff, 0xff, 0xff, // energy 10 kcal, per hour/min unknown
    0x78,                   // HR 120
    0x2c, 0x01,             // elapsed 300 s
  ));
  assert.deepEqual(d.warnings, []);
  assert.equal(d.fields.speedKmh, 2);
  assert.ok(Math.abs(d.fields.speedMph - 1.242742) < 1e-6);
  assert.equal(d.fields.distanceM, 10000);
  assert.equal(d.fields.inclinePct, 5);
  assert.equal(d.fields.energyKcal, 10);
  assert.equal(d.fields.energyPerHour, null);
  assert.equal(d.fields.energyPerMin, null);
  assert.equal(d.fields.heartRate, 120);
  assert.equal(d.fields.elapsedS, 300);
});

test('flags bit 0 set means NO speed field (spec inversion)', () => {
  const d = parseTreadmillData(dv(0x01, 0x00));
  assert.equal(d.fields.speedKmh, undefined);
  assert.deepEqual(d.warnings, []);
});

test('negative incline is signed', () => {
  const d = parseTreadmillData(dv(0x08, 0x00, 0x64, 0x00, 0xce, 0xff, 0x00, 0x00));
  assert.equal(d.fields.inclinePct, -5);
});

test('truncated and empty payloads warn instead of throwing', () => {
  assert.match(parseTreadmillData(dv(0x8c, 0x05, 0xc8)).warnings[0], /truncated/);
  assert.match(parseTreadmillData(dv()).warnings[0], /shorter/);
});

test('unparsed trailing bytes are reported', () => {
  assert.match(parseTreadmillData(dv(0x01, 0x00, 0xaa)).warnings[0], /trailing/);
});

test('feature bits decode to names', () => {
  const f = parseFeature(dv(0x0c, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00));
  assert.deepEqual(f.machineFeatures, ['Total distance', 'Inclination']);
  assert.deepEqual(f.targetSettings, ['Speed target', 'Inclination target']);
});

test('speed and incline ranges', () => {
  const s = parseSpeedRange(dv(0x64, 0x00, 0xb0, 0x04, 0x0a, 0x00)); // 1.00..12.00 step 0.10
  assert.deepEqual([s.minKmh, s.maxKmh, s.stepKmh], [1, 12, 0.1]);
  const i = parseInclineRange(dv(0x00, 0x00, 0x78, 0x00, 0x0a, 0x00)); // 0..12.0 step 1.0
  assert.deepEqual([i.minPct, i.maxPct, i.stepPct], [0, 12, 1]);
});

test('training and machine status use spec names', () => {
  assert.equal(parseTrainingStatus(dv(0x00, 0x0d)).name, 'Manual mode (quick start)');
  assert.equal(parseTrainingStatus(dv(0x00, 0x01)).name, 'Idle');
  const m = parseMachineStatus(dv(0x02, 0x01));
  assert.equal(m.name, 'Stopped or paused by user');
  assert.equal(m.detail, 'stop');
});

test('hex formatting', () => {
  assert.equal(hex(dv(0x00, 0xab)), '00 ab');
});

test('READ-ONLY GUARD: app source contains no GATT write calls and never touches the control point', () => {
  const src = readFileSync(new URL('../diag/app.js', import.meta.url), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(src, /writeValue|writeValueWith|\.writeValue/);
  assert.doesNotMatch(src, /getCharacteristic\([^)]*controlPoint/);
  assert.doesNotMatch(src, /startNotifications\([^)]*controlPoint/);
  assert.doesNotMatch(src, /requestControl|setTargetSpeed/i);
});
