// Run: node --test test/
// Fixtures are SYNTHETIC (built from the Bluetooth FTMS spec layout), not captured from a W400A.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeUuid, parseTreadmillData, parseFeature, parseSpeedRange, parseInclineRange, parseTrainingStatus, parseMachineStatus, uuid16, hex } from '../site/ftms.js';

const dv = (...bytes) => new DataView(new Uint8Array(bytes).buffer);

test('uuid16 expands to a full UUID', () => {
  assert.equal(uuid16(0x1826), '00001826-0000-1000-8000-00805f9b34fb');
  assert.equal(uuid16(0x2ad9), '00002ad9-0000-1000-8000-00805f9b34fb');
});

test('normalizeUuid accepts Bluefy short IDs and full IDs', () => {
  assert.equal(normalizeUuid('2ACC'), '00002acc-0000-1000-8000-00805f9b34fb');
  assert.equal(normalizeUuid('00002ACC-0000-1000-8000-00805F9B34FB'), '00002acc-0000-1000-8000-00805f9b34fb');
  assert.equal(normalizeUuid('0000fff1'), '0000fff1-0000-1000-8000-00805f9b34fb');
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

// Packets below were captured from a real FS-BT-C1 (belt idle) in the b4 diagnostic report.
test('captured idle packet 1 (flags 0x058c) parses with no warnings', () => {
  const d = parseTreadmillData(dv(0x8c, 0x05, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0, 0, 0));
  assert.deepEqual(d.warnings, []);
  assert.equal(d.fields.speedKmh, 0);
  assert.equal(d.fields.inclinePct, 0);
  assert.equal(d.fields.elapsedS, 0);
});

test('captured idle packet 2 (flags 0x2001) is kept raw as a vendor extension, not a warning', () => {
  const d = parseTreadmillData(dv(0x01, 0x20, 0, 0, 0));
  assert.deepEqual(d.warnings, []);
  assert.deepEqual(d.fields, {});
  assert.equal(d.vendorExtension.bytes, '00 00 00');
  assert.equal(d.vendorExtension.reservedFlags, '0x2000');
});

// Captured from the real module while the belt ran (empty belt, started and adjusted from the treadmill's own remote).
test('captured moving packet: 1.44 km/h, 14 m, 2.0 %, 1 kcal, 44 s', () => {
  const d = parseTreadmillData(dv(0x8c, 0x05, 0x90, 0x00, 0x0e, 0x00, 0x00, 0x14, 0x00, 0x00, 0x00, 0x01, 0x00, 0xff, 0xff, 0xff, 0x00, 0x2c, 0x00));
  assert.deepEqual(d.warnings, []);
  assert.equal(d.fields.speedKmh, 1.44);
  assert.equal(d.fields.distanceM, 14);
  assert.equal(d.fields.inclinePct, 2);
  assert.equal(d.fields.energyKcal, 1);
  assert.equal(d.fields.elapsedS, 44);
  assert.ok(Math.abs(d.fields.speedMph - 0.895) < 0.001); // about 0.9 mph
});

test('captured speed steps 0x60,0x70,0x80,0x90 are about 0.1 mph apart', () => {
  const mph = [0x60, 0x70, 0x80, 0x90].map((b) => parseTreadmillData(dv(0x8c, 0x05, b, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0, 0, 0)).fields.speedMph);
  for (let i = 1; i < mph.length; i++) assert.ok(Math.abs(mph[i] - mph[i - 1] - 0.1) < 0.005);
});

test('captured running-state vendor bytes and training/machine status codes', () => {
  assert.equal(parseTreadmillData(dv(0x01, 0x20, 0x01, 0, 0)).vendorExtension.bytes, '01 00 00');
  assert.equal(parseTrainingStatus(dv(0x01, 0x0e)).name, 'Pre-workout');
  assert.equal(parseTrainingStatus(dv(0x01, 0x0f)).name, 'Post-workout');
  assert.equal(parseMachineStatus(dv(0x04)).name, 'Started or resumed by user');
});

test('captured speed/incline ranges and idle training status', () => {
  const s = parseSpeedRange(dv(0x60, 0x00, 0x25, 0x03, 0x0a, 0x00));
  assert.deepEqual([s.minKmh, s.maxKmh, s.stepKmh], [0.96, 8.05, 0.1]);
  assert.ok(Math.abs(s.maxMph - 5.0) < 0.01);
  assert.equal(parseTrainingStatus(dv(0x01, 0x01)).name, 'Idle');
  const f = parseFeature(dv(0xdc, 0x56, 0, 0, 0x0f, 0, 0, 0));
  assert.deepEqual(f.targetSettings, ['Speed target', 'Inclination target', 'Resistance target', 'Power target']);
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
  const src = readFileSync(new URL('../site/app.js', import.meta.url), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(src, /writeValue|writeValueWith|\.writeValue/);
  assert.doesNotMatch(src, /getCharacteristic\([^)]*controlPoint/);
  assert.doesNotMatch(src, /startNotifications\([^)]*controlPoint/);
  assert.doesNotMatch(src, /requestControl|setTargetSpeed/i);
});
