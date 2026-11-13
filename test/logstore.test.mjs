// Run: node --test test/logstore.test.mjs
// The activity log saved on the phone, so that a page reload does not erase the record of a run that went wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LogStore, KEY_CURRENT, KEY_PREVIOUS } from '../site/app/logstore.js';
import { compactTelemetry, buildReport } from '../site/app/report.js';

const memory = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), m }; };
const lines = (n) => Array.from({ length: n }, (_, i) => `12:00:0${i % 10}  line ${i}`);

test('LOGSTORE: a page load that did something is kept as "previous" after a reload', () => {
  const storage = memory();
  new LogStore({ storage }).save(lines(30), [[1, 0, 0, 1], [2, 3.05, 0, 13]]);
  const b = new LogStore({ storage });
  assert.equal(b.previous.length, 1);
  assert.equal(b.previous[0].events.length, 30);
  assert.deepEqual(b.previous[0].telemetry, [[1, 0, 0, 1], [2, 3.05, 0, 13]]);
});

test('LOGSTORE: reloading twice does not erase the earlier run (a load with only start-up lines is ignored)', () => {
  const storage = memory();
  new LogStore({ storage }).save(lines(40), []);
  new LogStore({ storage }).save(lines(2), []); // loaded, nothing else happened
  const third = new LogStore({ storage });
  assert.equal(third.previous.length, 1);
  assert.equal(third.previous[0].events.length, 40);
});

test('LOGSTORE: only the two most recent worthwhile loads are kept, newest first', () => {
  const storage = memory();
  for (const tag of ['one', 'two', 'three']) new LogStore({ storage }).save(lines(8).map((l) => `${tag} ${l}`), []);
  const last = new LogStore({ storage });
  assert.equal(last.previous.length, 2);
  assert.match(last.previous[0].events[0], /^three/);
  assert.match(last.previous[1].events[0], /^two/);
});

test('LOGSTORE: blocked, full or corrupt storage never throws and the live log still works', () => {
  const none = new LogStore({ storage: null });
  assert.equal(none.save(lines(10), []), false);
  assert.deepEqual(none.previous, []);
  const full = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
  const s = new LogStore({ storage: full });
  assert.equal(s.save(lines(10), []), false);
  assert.equal(s.ok, false);
  const bad = memory();
  bad.setItem(KEY_CURRENT, '{not json');
  bad.setItem(KEY_PREVIOUS, '[1,2');
  assert.deepEqual(new LogStore({ storage: bad }).previous, []);
});

test('COMPACT: keeps changes in speed, incline and status, and both sides of any gap; drops identical repeats', () => {
  const rows = [];
  for (let t = 1; t <= 60; t++) rows.push([t, t < 30 ? 3.05 : 3.38, 0, 13]);
  const c = compactTelemetry(rows);
  assert.ok(c.length <= 4, `compacted to ${c.length}`);
  assert.deepEqual(c[0], [1, 3.05, 0, 13]);
  assert.ok(c.some((r) => r[1] === 3.38), 'the change is kept');
  assert.deepEqual(c[c.length - 1], [60, 3.38, 0, 13], 'the last reading is kept');
  const g = compactTelemetry([[1, 3, 0, 13], [2, 3, 0, 13], [3, 3, 0, 13], [9, 3, 0, 13], [10, 3, 0, 13]]);
  assert.ok(g.some((r) => r[0] === 3) && g.some((r) => r[0] === 9), 'both rows around a 6 s gap are kept so the gap shows');
  assert.deepEqual(compactTelemetry([]), []);
});

test('LOGSTORE + REPORT: earlier loads appear in the report, and no device identifiers are stored or reported', () => {
  const storage = memory();
  new LogStore({ storage }).save(['t  App loaded', ...lines(9)], [[1, 0, 0, 1]]);
  const store = new LogStore({ storage });
  const r = JSON.parse(buildReport({ build: 'a4', events: ['t  App loaded'], previous: store.previous }));
  assert.equal(r.previousSessions.length, 1);
  assert.equal(r.previousSessions[0].events.length, 10);
  assert.doesNotMatch(JSON.stringify(r) + [...storage.m.values()].join(''), /FS-|serial|uuid/i);
  assert.deepEqual(JSON.parse(buildReport({ build: 'a4' })).previousSessions, []);
});
