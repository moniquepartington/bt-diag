// Run: node --test test/app-logic.test.mjs
// The app's pure logic: display formatting, editor operations, the workout library, and the workout screen's view model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, formatCountdown, formatElapsed, parseDuration, mphText, describeInterval } from '../site/app/format.js';
import * as ed from '../site/app/editor-model.js';
import { WorkoutLibrary, STORAGE_KEY, MAX_NAME_LENGTH } from '../site/app/storage.js';
import { runView, isActive, SAFETY_REMINDER } from '../site/app/workout-vm.js';
import { PRESETS } from '../site/workout/presets.js';
import { VERIFIED_LIMITS } from '../site/workout/limits.js';
import { validateWorkout, checkAgainstLimits, totalSeconds } from '../site/workout/workout.js';
import { WorkoutEngine, STATE } from '../site/workout/engine.js';
import { makeRig, settle, run } from './rig.js';

const L = VERIFIED_LIMITS;

// ======================= format =======================
test('FORMAT: durations and clocks', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(115), '1:55');
  assert.equal(formatDuration(1200), '20:00');
  assert.equal(formatDuration(3600), '1:00:00');
  assert.equal(formatDuration(3725), '1:02:05');
  assert.equal(formatDuration(-5), '0:00');
  assert.equal(formatCountdown(0), '0:00');
  assert.equal(formatCountdown(1), '0:01', 'a countdown never shows 0:00 while time remains');
  assert.equal(formatCountdown(1000), '0:01');
  assert.equal(formatCountdown(1001), '0:02');
  assert.equal(formatElapsed(999), '0:00');
  assert.equal(formatElapsed(61999), '1:01');
  assert.equal(mphText(2), '2.0 mph');
  assert.equal(describeInterval({ category: 'Training', durationSec: 115, speedMph: 2.3, inclineLevel: 2 }), 'Training · 1:55 · 2.3 mph · incline 2');
});

test('FORMAT: parseDuration accepts m:ss and h:mm:ss only', () => {
  assert.equal(parseDuration('1:55'), 115);
  assert.equal(parseDuration(' 20:00 '), 1200);
  assert.equal(parseDuration('0:05'), 5);
  assert.equal(parseDuration('1:00:00'), 3600);
  for (const bad of ['1:5', '1:60', 'abc', '', '5', '-1:00', '1:2:3:4']) assert.equal(parseDuration(bad), null, bad);
  for (const s of [5, 115, 1200, 3605]) assert.equal(parseDuration(formatDuration(s)), s, 'round trip');
});

// ======================= editor model =======================
test('EDITOR: a new workout is valid and inside the limits', () => {
  const w = ed.newWorkout();
  assert.equal(ed.problems(w, L).ok, true);
  assert.equal(w.intervals.length, 1);
});

test('EDITOR: operations return new workouts and never change their input', () => {
  const w = ed.addInterval(ed.newWorkout());
  const frozen = JSON.stringify(w);
  for (const next of [ed.addInterval(w), ed.duplicateInterval(w, 0), ed.deleteInterval(w, 0), ed.moveInterval(w, 0, 1), ed.setName(w, 'x'), ed.setDescription(w, 'y'), ed.setCategory(w, 0, 'Recovery'), ed.nudgeDuration(w, 0, 5), ed.nudgeSpeed(w, 0, 1, L), ed.nudgeIncline(w, 0, 1, L)]) assert.notEqual(next, w);
  assert.equal(JSON.stringify(w), frozen);
});

test('EDITOR: add, duplicate, delete and reorder intervals', () => {
  let w = ed.newWorkout();
  w = ed.setCategory(ed.nudgeSpeed(w, 0, 4, L), 0, 'Warmup'); // 1.4 mph
  w = ed.addInterval(w); // copies the last interval's values
  assert.equal(w.intervals.length, 2);
  assert.equal(w.intervals[1].speedMph, 1.4);
  assert.equal(w.intervals[1].category, 'Training');
  w = ed.nudgeIncline(w, 1, 3, L);
  w = ed.duplicateInterval(w, 1);
  assert.deepEqual(w.intervals[2], w.intervals[1]);
  w = ed.moveInterval(w, 2, -1);
  assert.equal(w.intervals.length, 3);
  const first = w.intervals[0];
  w = ed.moveInterval(w, 0, 1);
  assert.deepEqual(w.intervals[1], first, 'moved down one place');
  assert.equal(ed.moveInterval(w, 0, -1), w, 'moving above the top does nothing');
  assert.equal(ed.moveInterval(w, 2, 1), w, 'moving below the bottom does nothing');
  assert.equal(ed.moveInterval(w, 0, 2), w, 'only one step at a time');
  w = ed.deleteInterval(w, 0);
  assert.equal(w.intervals.length, 2);
  w = ed.deleteInterval(ed.deleteInterval(w, 0), 0);
  assert.equal(w.intervals.length, 1, 'the last interval cannot be deleted');
  assert.equal(ed.deleteInterval(w, 5), w);
  assert.equal(ed.duplicateInterval(w, 9), w);
});

test('EDITOR: durations move in 5 s steps and are kept between 5 s and 3 h', () => {
  let w = ed.newWorkout();
  w = ed.setDuration(w, 0, { minutes: 1, seconds: 57 });
  assert.equal(w.intervals[0].durationSec, 115, '117 s snaps to the nearest 5 s step');
  w = ed.setDuration(w, 0, { minutes: 0, seconds: 0 });
  assert.equal(w.intervals[0].durationSec, 5, 'never below 5 s');
  w = ed.setDuration(w, 0, { minutes: 999, seconds: 0 });
  assert.equal(w.intervals[0].durationSec, ed.MAX_INTERVAL_SEC);
  w = ed.setDuration(w, 0, { minutes: 2, seconds: 0 });
  assert.equal(ed.nudgeDuration(w, 0, 5).intervals[0].durationSec, 125);
  assert.equal(ed.nudgeDuration(w, 0, -5).intervals[0].durationSec, 115);
  assert.equal(ed.nudgeDuration(ed.setDuration(w, 0, { seconds: 5 }), 0, -5).intervals[0].durationSec, 5);
});

test('EDITOR: speed moves in exact 0.1 mph steps within the minimum and the limit; incline in whole levels', () => {
  let w = ed.newWorkout();
  assert.equal(ed.nudgeSpeed(w, 0, 1, L).intervals[0].speedMph, 1.1, 'integer maths: exactly 1.1');
  for (let i = 0; i < 40; i++) w = ed.nudgeSpeed(w, 0, 1, L);
  assert.equal(w.intervals[0].speedMph, 2.8, 'stops at the limit');
  for (let i = 0; i < 40; i++) w = ed.nudgeSpeed(w, 0, -1, L);
  assert.equal(w.intervals[0].speedMph, 0.6, 'stops at the treadmill minimum');
  for (let i = 0; i < 20; i++) w = ed.nudgeIncline(w, 0, 1, L);
  assert.equal(w.intervals[0].inclineLevel, 8);
  for (let i = 0; i < 20; i++) w = ed.nudgeIncline(w, 0, -1, L);
  assert.equal(w.intervals[0].inclineLevel, 0);
  assert.equal(ed.nudgeSpeed(ed.newWorkout(), 0, 1, { maxMph: 1.0, maxInclineLevel: 2 }).intervals[0].speedMph, 1.0, 'tighter limits are honoured');
});

test('EDITOR: invalid categories are ignored; problems() reports errors and limit violations', () => {
  const w = ed.newWorkout();
  assert.equal(ed.setCategory(w, 0, 'Sprint'), w);
  assert.equal(ed.problems(ed.setName(w, '   '), L).ok, false);
  const over = { name: 'x', intervals: [{ category: 'Warmup', durationSec: 60, speedMph: 3.0, inclineLevel: 9 }] };
  const p = ed.problems(over, L);
  assert.equal(p.ok, false);
  assert.equal(p.violations.length, 2);
  assert.equal(ed.problems({ name: 'x', intervals: [{ category: 'Warmup', durationSec: 62, speedMph: 1, inclineLevel: 0 }] }, L).errors.length, 1);
  const s = ed.summary(ed.addInterval(w));
  assert.deepEqual(s, { totalSec: 600, count: 2, minSpeedMph: 1, maxSpeedMph: 1, maxIncline: 0 });
});

test('EDITOR (property): 600 random edits never produce an invalid or over-limit workout', () => {
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  let w = ed.newWorkout();
  const ops = [
    () => (w = ed.addInterval(w, rnd(w.intervals.length))),
    () => (w = ed.duplicateInterval(w, rnd(w.intervals.length))),
    () => (w = ed.deleteInterval(w, rnd(w.intervals.length))),
    () => (w = ed.moveInterval(w, rnd(w.intervals.length), rnd(2) ? 1 : -1)),
    () => (w = ed.nudgeDuration(w, rnd(w.intervals.length), (rnd(41) - 20) * 5)),
    () => (w = ed.setDuration(w, rnd(w.intervals.length), { minutes: rnd(30), seconds: rnd(60) })),
    () => (w = ed.nudgeSpeed(w, rnd(w.intervals.length), rnd(61) - 30, L)),
    () => (w = ed.nudgeIncline(w, rnd(w.intervals.length), rnd(21) - 10, L)),
    () => (w = ed.setCategory(w, rnd(w.intervals.length), ed.CATEGORIES[rnd(4)])),
  ];
  for (let k = 0; k < 600; k++) {
    ops[rnd(ops.length)]();
    assert.deepEqual(validateWorkout(w), [], `after edit ${k}`);
    assert.deepEqual(checkAgainstLimits(w, L), [], `after edit ${k}`);
    assert.ok(w.intervals.length >= 1);
    assert.ok(w.intervals.every((i) => i.durationSec % 5 === 0 && i.speedMph >= 0.6));
    assert.equal(totalSeconds(w) % 5, 0);
  }
});

// ======================= library =======================
class FakeStorage {
  constructor() { this.map = new Map(); this.fail = false; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { if (this.fail) throw new Error('QuotaExceededError'); this.map.set(k, String(v)); }
}
let idn = 0;
const lib = (storage = new FakeStorage(), extra = {}) => { const l = new WorkoutLibrary({ storage, makeId: () => `id${++idn}`, now: () => '2026-01-01T00:00:00Z', ...extra }); l.load(); return l; };
const ok = (name = 'Mine', durationSec = 60) => ({ name, description: '', intervals: [{ category: 'Warmup', durationSec, speedMph: 1.0, inclineLevel: 0 }] });

test('LIBRARY: first run seeds the five presets as ordinary editable workouts, each exactly 20:00', () => {
  const l = lib();
  const all = l.list();
  assert.equal(all.length, 5);
  assert.deepEqual(all.map((w) => w.name), ['Hill Voltage', 'House Party', 'Night Walk', 'Climb Mode', 'No Skips']);
  for (const w of all) { assert.equal(totalSeconds(w), 1200); assert.ok(w.presetId); assert.deepEqual(validateWorkout(w), []); }
  assert.equal(new Set(all.map((w) => w.id)).size, 5, 'unique ids');
});

test('LIBRARY: everything persists and reloads identically', () => {
  const s = new FakeStorage();
  const a = lib(s);
  const made = a.save(ok('Walk', 300)).workout;
  const b = new WorkoutLibrary({ storage: s, makeId: () => `r${++idn}` });
  assert.deepEqual(b.load(), []);
  assert.deepEqual(b.list(), a.list());
  assert.deepEqual(b.get(made.id), made);
  assert.equal(b.persistent, true);
});

test('LIBRARY: unlimited workouts (500 saved, all kept) and no tiny name limit', () => {
  const l = lib();
  for (let i = 0; i < 500; i++) assert.equal(l.save(ok(`Workout number ${i} with a long and descriptive name`)).ok, true);
  assert.equal(l.list().length, 505);
  assert.equal(l.save(ok('x'.repeat(MAX_NAME_LENGTH))).ok, true);
  assert.equal(l.save(ok('x'.repeat(MAX_NAME_LENGTH + 1))).ok, false);
});

test('LIBRARY: saving validates; invalid and over-limit workouts are refused with a reason and nothing is stored', () => {
  const l = lib();
  const n = l.list().length;
  const bad = [
    [ok('', 60), /name/], [ok('x', 62), /multiple of 5/], [ok('x', 0), /positive/],
    [{ name: 'x', description: '', intervals: [] }, /at least one interval/],
    [{ name: 'x', description: '', intervals: [{ category: 'Warmup', durationSec: 60, speedMph: 2.9, inclineLevel: 0 }] }, /above the verified limit 2\.8/],
    [{ name: 'x', description: '', intervals: [{ category: 'Warmup', durationSec: 60, speedMph: 1, inclineLevel: 9 }] }, /above the verified limit 8/],
    [{ name: 'x', description: '', intervals: [{ category: 'Sprint', durationSec: 60, speedMph: 1, inclineLevel: 0 }] }, /category/],
  ];
  for (const [w, why] of bad) { const r = l.save(w); assert.equal(r.ok, false); assert.match(r.reason, why); }
  assert.equal(l.list().length, n);
});

test('LIBRARY: editing a preset keeps it a preset; a new or duplicated workout is never a preset', () => {
  const l = lib();
  const hill = l.list()[0];
  const edited = { ...hill, name: 'Hill Voltage (mine)' };
  const r = l.save(edited);
  assert.equal(r.workout.presetId, hill.presetId);
  assert.equal(l.get(hill.id).name, 'Hill Voltage (mine)');
  assert.equal(l.list().length, 5, 'replaced, not added');
  const brand = l.save({ ...ok('Fresh'), presetId: 'hill-voltage' });
  assert.equal(brand.workout.presetId, undefined);
  const copy = l.duplicate(hill.id).workout;
  assert.equal(copy.name, 'Hill Voltage (mine) (copy)');
  assert.equal(copy.presetId, undefined);
  assert.notEqual(copy.id, hill.id);
  assert.equal(l.list().findIndex((w) => w.id === copy.id), l.list().findIndex((w) => w.id === hill.id) + 1, 'the copy sits right after the original');
});

test('LIBRARY: delete, reorder, and unknown ids', () => {
  const l = lib();
  const ids = l.list().map((w) => w.id);
  assert.equal(l.move(ids[0], 1).ok, true);
  assert.deepEqual(l.list().map((w) => w.id).slice(0, 2), [ids[1], ids[0]]);
  assert.equal(l.move(ids[1], -1).ok, false, 'already first');
  assert.equal(l.move(ids[4], 1).ok, false, 'already last');
  assert.equal(l.remove(ids[2]).ok, true);
  assert.equal(l.list().length, 4);
  assert.equal(l.remove('nope').ok, false);
  assert.equal(l.duplicate('nope').ok, false);
  assert.equal(l.get('nope'), null);
});

test('LIBRARY: restorePresets resets edited presets, brings back deleted ones, and leaves other workouts alone', () => {
  const l = lib();
  const [hill, party] = l.list();
  l.save({ ...hill, name: 'Changed', intervals: [{ category: 'Warmup', durationSec: 60, speedMph: 1, inclineLevel: 0 }] });
  l.remove(party.id);
  const mine = l.save(ok('Keep me')).workout;
  assert.equal(l.restorePresets().ok, true);
  const all = l.list();
  assert.equal(all.length, 6);
  assert.equal(all.find((w) => w.presetId === 'hill-voltage').name, 'Hill Voltage');
  assert.equal(totalSeconds(all.find((w) => w.presetId === 'hill-voltage')), 1200);
  assert.ok(all.find((w) => w.presetId === 'house-party'));
  assert.deepEqual(l.get(mine.id), mine);
  assert.equal(l.get(hill.id).id, hill.id, 'a restored preset keeps its id');
});

test('LIBRARY: export then import round-trips as NEW workouts; nothing is overwritten', () => {
  const a = lib();
  a.save(ok('Walk', 300));
  const json = a.exportJson();
  const parsed = JSON.parse(json);
  assert.equal(parsed.format, 'treadmill-workouts');
  assert.equal(parsed.workouts.length, 6);
  assert.ok(parsed.workouts.every((w) => !('presetId' in w)), 'exports carry no internal preset marker');
  const b = lib();
  const before = b.list().length;
  const r = b.importJson(json);
  assert.equal(r.ok, true);
  assert.equal(r.added, 6);
  assert.deepEqual(r.rejected, []);
  assert.equal(b.list().length, before + 6);
  assert.ok(b.list().slice(before).every((w) => !w.presetId));
  assert.equal(new Set(b.list().map((w) => w.id)).size, b.list().length, 'every imported workout got a fresh id');
});

test('LIBRARY: import lists what it refuses and why, still adds the good ones, and rejects bad files outright', () => {
  const l = lib();
  const file = JSON.stringify({ format: 'treadmill-workouts', version: 1, workouts: [ok('Good'), ok('Bad length', 62), { name: 'Too fast', intervals: [{ category: 'Warmup', durationSec: 60, speedMph: 4, inclineLevel: 0 }] }, 'junk', null] });
  const r = l.importJson(file);
  assert.equal(r.ok, true);
  assert.equal(r.added, 1);
  assert.equal(r.rejected.length, 4);
  assert.match(r.rejected[0].reason, /multiple of 5/);
  assert.match(r.rejected[1].reason, /verified limit/);
  assert.equal(l.list().length, 6);
  assert.equal(l.importJson('{not json').ok, false);
  assert.equal(l.importJson('{"workouts": 5}').ok, false);
  assert.match(l.importJson('{"format":"other","workouts":[]}').reason, /unrecognised/);
  assert.match(l.importJson('{"format":"treadmill-workouts","version":99,"workouts":[]}').reason, /newer version/);
  assert.equal(l.importJson(JSON.stringify([ok('A bare list is fine')])).added, 1);
  assert.equal(l.list().length, 7);
});

test('LIBRARY: a corrupted stored library is backed up, not destroyed, and the presets come back with a notice', () => {
  const s = new FakeStorage();
  s.setItem(STORAGE_KEY, '{"workouts": [ broken');
  const l = new WorkoutLibrary({ storage: s, makeId: () => `c${++idn}` });
  const notices = l.load();
  assert.equal(notices.length, 1);
  assert.match(notices[0], /could not be read/);
  assert.equal(l.list().length, 5);
  const backups = [...s.map.keys()].filter((k) => k.startsWith(`${STORAGE_KEY}.corrupt.`));
  assert.equal(backups.length, 1);
  assert.equal(s.getItem(backups[0]), '{"workouts": [ broken');
});

test('LIBRARY: stored workouts that no longer pass the checks are set aside (kept and shown), never run or silently deleted', () => {
  const s = new FakeStorage();
  lib(s);
  const tight = new WorkoutLibrary({ storage: s, limits: { maxMph: 1.0, maxInclineLevel: 2 }, makeId: () => `t${++idn}` });
  const notices = tight.load();
  assert.equal(tight.list().length, 0);
  assert.equal(tight.quarantine.length, 5);
  assert.match(notices[0], /5 saved workout\(s\) did not pass/);
  assert.match(tight.quarantine[0].problem, /verified limit/);
  assert.equal(tight.removeQuarantined(0).ok, true);
  assert.equal(tight.quarantine.length, 4);
  assert.equal(tight.removeQuarantined(99).ok, false);
  const again = new WorkoutLibrary({ storage: s, limits: { maxMph: 1.0, maxInclineLevel: 2 }, makeId: () => `u${++idn}` });
  again.load();
  assert.equal(again.quarantine.length, 4 + 0, 'the set-aside items persist');
});

test('LIBRARY: without usable storage it keeps working in memory and says so; a full or blocked store keeps the data', () => {
  const none = lib(null);
  assert.equal(none.persistent, false);
  assert.equal(none.list().length, 5);
  assert.equal(none.save(ok('Temp')).ok, true);
  const full = new FakeStorage();
  const l = lib(full);
  full.fail = true;
  const r = l.save(ok('Not stored'));
  assert.equal(r.ok, true);
  assert.equal(l.persistent, false);
  assert.ok(l.notices.some((n) => /Could not save/.test(n)));
  assert.equal(l.list().length, 6, 'still held in memory');
  const throwsOnRead = { getItem() { throw new Error('blocked'); }, setItem() {} };
  const blocked = new WorkoutLibrary({ storage: throwsOnRead });
  assert.match(blocked.load()[0], /cannot be read/);
  assert.equal(blocked.list().length, 5);
});

test('LIBRARY: resetAll restores just the five presets', () => {
  const l = lib();
  l.save(ok('x'));
  l.resetAll();
  assert.equal(l.list().length, 5);
  assert.equal(l.quarantine.length, 0);
});

// ======================= workout screen view model =======================
const eng0 = { state: STATE.READY, name: 'W', elapsedMs: 0, totalMs: 100000, remainingMs: 100000, intervalIndex: null, interval: null, next: null, beltKnown: 'stopped', countdownEndsAt: null, fault: null, notice: null, override: null, busy: false };
const ctl0 = { link: true, hasControl: false, armed: true, lock: null, recovery: false, buttons: { takeControl: { ok: true, why: '' }, start: { ok: true, why: '' }, setSpeed: { ok: false }, setIncline: { ok: false }, stop: { ok: false, why: 'nothing to stop yet' } } };
const view = (e = {}, c = {}, ctx = { checklistOk: true, nowMs: 0 }) => runView({ ...eng0, ...e }, { ...ctl0, ...c, buttons: { ...ctl0.buttons, ...(c.buttons ?? {}) } }, ctx);

test('VM: Start is enabled only when ready, connected, checklist ticked, not locked out and the control layer agrees', () => {
  assert.equal(view().buttons.start.enabled, true);
  assert.match(view({}, { link: false }).buttons.start.why, /connect/);
  assert.match(view({}, {}, { checklistOk: false }).buttons.start.why, /safety boxes/);
  assert.match(view({}, { lock: { reason: 'NO ACKNOWLEDGMENT', detail: '' } }).buttons.start.why, /locked out/);
  assert.match(view({}, { buttons: { takeControl: { ok: false, why: 'the belt must be stopped and idle' } } }).buttons.start.why, /stopped and idle/);
  assert.equal(view({}, { hasControl: true, buttons: { start: { ok: true, why: '' }, takeControl: { ok: false, why: 'already' } } }).buttons.start.enabled, true, 'with control held the Start gate is used');
  for (const s of [STATE.IDLE, STATE.RUNNING, STATE.PAUSED, STATE.FAULTED, STATE.STARTING]) assert.equal(view({ state: s }).buttons.start.enabled, false, s);
  assert.match(view({ state: STATE.STOPPED }).buttons.start.why, /over/);
  assert.match(view({ state: STATE.COMPLETED }).buttons.start.why, /over/);
});

test('VM: pause, resume, stop and fault buttons follow the state', () => {
  const t = { [STATE.RUNNING]: { pause: 1, stop: 1 }, [STATE.PAUSED]: { resume: 1, stop: 1 }, [STATE.RESUMING]: { stop: 1 }, [STATE.PAUSING]: { stop: 1 }, [STATE.STARTING]: { stop: 1 }, [STATE.FAULTED]: { stop: 1, acknowledgeFault: 1 }, [STATE.STOPPED]: {}, [STATE.COMPLETED]: {}, [STATE.READY]: {}, [STATE.IDLE]: {} };
  for (const [state, on] of Object.entries(t)) {
    const b = view({ state, fault: state === STATE.FAULTED ? { reason: 'X', detail: 'd', belt: 'b', beltKnown: 'running' } : null }).buttons;
    for (const k of ['pause', 'resume', 'stop', 'acknowledgeFault']) assert.equal(b[k].enabled, !!on[k], `${state}: ${k}`);
  }
  assert.match(view({ state: STATE.PAUSED }, { link: false }).buttons.resume.why, /reconnect/);
  assert.match(view({ state: STATE.PAUSED }, { lock: { reason: 'CONNECTION LOST', detail: '' } }).buttons.resume.why, /locked out/);
});

test('VM: manual adjustment is available only while running and not busy', () => {
  const run1 = view({ state: STATE.RUNNING, interval: { category: 'Training', durationSec: 60, speedMph: 2, inclineLevel: 2 }, intervalIndex: 0 });
  for (const k of ['speedUp', 'speedDown', 'inclineUp', 'inclineDown']) assert.equal(run1.buttons[k].enabled, true, k);
  const busy = view({ state: STATE.RUNNING, busy: true });
  assert.equal(busy.buttons.speedUp.enabled, false);
  assert.match(busy.buttons.speedUp.why, /wait/);
  for (const s of [STATE.PAUSED, STATE.READY, STATE.FAULTED, STATE.STOPPED]) assert.equal(view({ state: s }).buttons.speedUp.enabled, false, s);
});

test('VM: clocks, progress, the interval, the override and the next interval', () => {
  const v = view({ state: STATE.RUNNING, elapsedMs: 61500, totalMs: 120000, remainingMs: 58500, intervalIndex: 1, interval: { category: 'Training', durationSec: 60, speedMph: 2.3, inclineLevel: 2 }, next: { category: 'Cooldown', durationSec: 60, speedMph: 1.0, inclineLevel: 0 }, override: { speedMph: 2.5, inclineLevel: 2 } });
  assert.equal(v.remainingText, '0:59');
  assert.equal(v.elapsedText, '1:01');
  assert.equal(v.totalText, '2:00');
  assert.equal(v.progressPct, 51.3);
  assert.equal(v.intervalText, '2. Training · 1:00 · 2.3 mph · incline 2');
  assert.equal(v.targetText, '2.5 mph · incline 2');
  assert.match(v.overrideText, /until the next interval: 2\.5 mph/);
  assert.equal(v.nextText, 'Cooldown · 1:00 · 1.0 mph · incline 0');
  assert.equal(v.banner.level, 'info');
  assert.equal(view({ state: STATE.RUNNING, intervalIndex: 0, interval: { category: 'Cooldown', durationSec: 5, speedMph: 1, inclineLevel: 0 } }).nextText, 'Last interval');
});

test('VM: banners tell the truth about faults, lockouts and the belt', () => {
  const fault = view({ state: STATE.FAULTED, fault: { reason: 'CONNECTION LOST', detail: 'Bluetooth was lost.', belt: 'The belt may still be running at about 2 mph. Use the remote.', beltKnown: 'running' } });
  assert.equal(fault.banner.level, 'danger');
  assert.match(fault.banner.title, /CONNECTION LOST/);
  assert.match(fault.banner.text, /may still be running/);
  assert.equal(fault.beltMayBeRunning, true);
  const stopped = view({ state: STATE.FAULTED, fault: { reason: 'X', detail: 'd', belt: 'The belt is stopped.', beltKnown: 'stopped' } });
  assert.equal(stopped.beltMayBeRunning, false);
  const lock = view({ state: STATE.READY }, { lock: { reason: 'NO ACKNOWLEDGMENT', detail: 'Outcome unknown.' } });
  assert.equal(lock.banner.level, 'danger');
  assert.match(lock.banner.title, /LOCKED OUT/);
  assert.equal(view({ state: STATE.RESUMING, countdownEndsAt: 5000 }, {}, { checklistOk: true, nowMs: 2500 }).banner.title, 'Resuming in 3…');
  assert.equal(view({ state: STATE.PAUSED }).banner.level, 'warn');
  assert.equal(view({ state: STATE.COMPLETED }).banner.level, 'ok');
  assert.match(view({ state: STATE.STOPPED }).banner.text, /cannot be resumed/);
  assert.equal(view({ state: STATE.RUNNING }).banner, null);
});

test('VM: the lockout can be reset only once the belt is CONFIRMED stopped and the connection is back', () => {
  const lock = { reason: 'CONNECTION LOST', detail: '' };
  const r = (c) => view({ state: STATE.FAULTED, fault: { reason: 'X', detail: '', belt: '', beltKnown: 'running' } }, c).buttons.resetLock;
  assert.equal(view().buttons.resetLock.enabled, false, 'no lockout, nothing to reset');
  assert.match(view().buttons.resetLock.why, /no lockout/);
  assert.match(r({ lock, tele: { speedKmh: 0.96, inclinePct: 0, at: 0 }, training: 0x0d }).why, /still moving/);
  assert.match(r({ lock, tele: { speedKmh: 0, inclinePct: 0, at: 0 }, training: 0x0e }).why, /still moving/, 'a countdown counts as moving');
  assert.match(r({ lock, link: false, tele: { speedKmh: 0, inclinePct: 0, at: 0 }, training: 0x01 }).why, /reconnect/);
  assert.match(r({ lock, tele: { speedKmh: 0, inclinePct: 0, at: 0 }, training: 0x01, pending: { cmd: 'stop' } }).why, /in progress/);
  const ok = r({ lock, tele: { speedKmh: 0, inclinePct: 0, at: 0 }, training: 0x01 });
  assert.equal(ok.enabled, true);
});

test('VM: the recovery controls appear only while recovering, and the reminder is explicit', () => {
  assert.equal(view().buttons.takeControl.enabled, false);
  assert.equal(view().buttons.recoveryStop.enabled, false);
  const r = view({ state: STATE.FAULTED, fault: { reason: 'X', detail: '', belt: '', beltMayBeRunning: true } }, { recovery: true, lock: { reason: 'CONNECTION LOST', detail: '' }, buttons: { takeControl: { ok: true, why: '' }, stop: { ok: true, why: '' } } });
  assert.equal(r.recovery, true);
  assert.equal(r.buttons.takeControl.enabled, true);
  assert.equal(r.buttons.recoveryStop.enabled, true);
  assert.match(SAFETY_REMINDER, /remote or safety key/);
  assert.match(SAFETY_REMINDER, /not an emergency stop/);
  assert.equal(isActive(STATE.RUNNING), true);
  assert.equal(isActive(STATE.PAUSED), true);
  assert.equal(isActive(STATE.READY), false);
  assert.equal(isActive(STATE.COMPLETED), false);
});

test('VM + REAL ENGINE: the view model follows a real run on the simulator (start, override, pause, resume, fault)', async () => {
  const rig = makeRig({}, { limits: L });
  const engine = new WorkoutEngine({ controller: rig.ctl, clock: rig.clock, limits: L });
  const snap = () => runView(engine.snapshot(), rig.ctl.snapshot(), { checklistOk: true, nowMs: rig.clock.now() });
  const w = { name: 'T', intervals: [{ category: 'Warmup', durationSec: 30, speedMph: 1.0, inclineLevel: 1 }, { category: 'Training', durationSec: 30, speedMph: 2.0, inclineLevel: 3 }] };
  assert.equal(snap().buttons.start.enabled, false, 'nothing loaded');
  engine.load(w);
  assert.equal(snap().buttons.start.enabled, true);
  assert.equal(snap().remainingText, '1:00');
  await settle(rig, engine.begin(), 40000);
  await run(rig, 5000);
  let v = snap();
  assert.equal(v.stateLabel, 'Running');
  assert.equal(v.buttons.pause.enabled, true);
  assert.equal(v.buttons.speedUp.enabled, true);
  assert.match(v.intervalText, /^1\. Warmup/);
  await settle(rig, engine.adjust({ speedDeltaMph: 0.1 }));
  v = snap();
  assert.match(v.overrideText, /1\.1 mph/);
  assert.equal(v.targetText, '1.1 mph · incline 1');
  await settle(rig, engine.pause());
  v = snap();
  assert.equal(v.stateLabel, 'Paused');
  assert.equal(v.buttons.resume.enabled, true);
  assert.equal(v.overrideText, '');
  await settle(rig, engine.resume(), 30000);
  rig.ctl.disconnected();
  v = snap();
  assert.equal(v.stateLabel, 'FAULT');
  assert.equal(v.beltMayBeRunning, true);
  assert.match(v.banner.text, /may still be running/);
  assert.equal(v.buttons.start.enabled, false);
});
