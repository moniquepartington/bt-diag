// Phase 2 control-test page: Web Bluetooth plumbing and UI only. Every decision about whether a command may be
// sent lives in controller.js, and every byte is built by protocol.js.
import { Controller } from './controller.js?v=c2';
import { routeNotification } from './bridge.js?v=c2';
import { LIMITS, MPH_TO_KMH, encodeSetSpeedMph, encodeSetInclineLevel } from './protocol.js?v=c2';
import { SERVICES, CHARS, parseSpeedRange, parseInclineRange, parseTrainingStatus } from '../ftms.js?v=b6';

const BUILD = 'c2';
const $ = (id) => document.getElementById(id);
const CONNECT_TIMEOUT_MS = 20000;
const SPEEDS_MPH = [0.6, 0.7, 0.8, 0.9, 1.0];
const INCLINES = [0, 1, 2];
const TRAINING_NAMES = { 0x01: 'Idle', 0x0d: 'Running', 0x0e: 'Countdown', 0x0f: 'Finished' };

const events = [];
let device = null;
let cp = null; // control point characteristic
let lastSnap = null;

const clock = { now: () => performance.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id) };
const transport = { write: (bytes) => { if (!cp) throw new Error('not connected'); return cp.writeValue(bytes); } };
const ctl = new Controller({ transport, clock, onChange: render, onLog: log });

function log(line) {
  events.push(line);
  const el = document.createElement('div');
  if (/LOCKOUT|REFUSED|failed|FAILED/i.test(line)) el.className = 'err';
  el.textContent = line;
  $('log').prepend(el);
}

const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000} s`)), ms))]);

// ---------- connect ----------
async function connect() {
  if (!(navigator.bluetooth && window.isSecureContext)) return log('Web Bluetooth is not available here. Open this page in Bluefy over https://.');
  try {
    log('Opening device chooser…');
    device = await navigator.bluetooth.requestDevice({ filters: [{ namePrefix: 'FS-' }], optionalServices: [SERVICES.fitnessMachine] });
    device.addEventListener('gattserverdisconnected', () => {
      if (ctl.link) ctl.disconnected();
      else log('Disconnected before the test was ready.');
    });
    const server = await withTimeout(device.gatt.connect(), CONNECT_TIMEOUT_MS, 'GATT connect');
    const svc = await server.getPrimaryService(SERVICES.fitnessMachine);
    const ch = (uuid) => svc.getCharacteristic(uuid);
    cp = await ch(CHARS.controlPoint);
    const [data, training, machine] = await Promise.all([ch(CHARS.treadmillData), ch(CHARS.trainingStatus), ch(CHARS.machineStatus)]);
    const speed = parseSpeedRange(await (await ch(CHARS.speedRange)).readValue());
    const incline = parseInclineRange(await (await ch(CHARS.inclineRange)).readValue());
    if (!(speed.minKmh > 0 && speed.maxKmh > speed.minKmh) || !(incline.maxPct >= incline.minPct)) throw new Error('the treadmill limits could not be read sensibly; no commands will be sent');

    // Listen first (including control-point responses) so that no acknowledgment can be missed.
    // If any subscription fails we refuse to continue: we never send a command we cannot see the answer to.
    for (const c of [data, training, machine, cp]) {
      c.addEventListener('characteristicvaluechanged', (ev) => routeNotification(ctl, ev.target.uuid, ev.target.value));
      await c.startNotifications();
    }
    ctl.connected({ speed: { minKmh: speed.minKmh, maxKmh: speed.maxKmh }, incline: { minPct: incline.minPct, maxPct: incline.maxPct } });
    const t = parseTrainingStatus(await training.readValue());
    if (t.code != null) ctl.feedTraining(t.code);
  } catch (e) {
    log(`Connect failed: ${e?.message || 'cancelled or no details from the browser'}. No commands will be sent.`);
    try { device?.gatt?.disconnect(); } catch { /* ignore */ }
    cp = null;
  }
}

function disconnect() {
  try { device?.gatt?.disconnect(); } catch { /* ignore */ }
}

// ---------- UI ----------
function render(snap) {
  lastSnap = snap;
  $('state').textContent = snap.link ? 'Connected' : 'Not connected';
  $('state').className = snap.link ? 'pill ok' : 'pill';
  $('connect').disabled = snap.link;
  $('disconnect').disabled = !snap.link;
  $('lock').hidden = !snap.lock;
  if (snap.lock) { $('lockReason').textContent = `LOCKED OUT: ${snap.lock.reason}`; $('lockDetail').textContent = snap.lock.detail; }
  $('reset').disabled = !!snap.pending;

  const kmh = snap.tele.speedKmh;
  $('vSpeed').textContent = kmh == null ? '—' : `${kmh.toFixed(2)} km/h · ${(kmh / MPH_TO_KMH).toFixed(2)} mph`; // mph on the treadmill's own 1.6 km/h-per-mph grid
  $('vIncline').textContent = snap.tele.inclinePct == null ? '—' : `${snap.tele.inclinePct.toFixed(1)} %`;
  $('vStatus').textContent = snap.training == null ? '—' : TRAINING_NAMES[snap.training] ?? `0x${snap.training.toString(16)}`;
  $('vControl').textContent = snap.hasControl ? 'held' : 'not held';
  $('vPending').textContent = snap.pending ? `${snap.pending.cmd}: ${snap.pending.acked ? 'waiting for the readings to confirm' : 'waiting for the treadmill to answer'}` : 'none';

  const b = snap.buttons;
  const setBtn = (el, why, state) => { el.disabled = !state.ok; why.textContent = state.ok ? '' : state.why; };
  setBtn($('bControl'), $('wControl'), b.takeControl);
  setBtn($('bStart'), $('wStart'), b.start);
  setBtn($('bStop'), $('wStop'), b.stop);
  for (const el of document.querySelectorAll('[data-speed]')) el.disabled = !b.setSpeed.ok || !validSpeed(+el.dataset.speed);
  for (const el of document.querySelectorAll('[data-incline]')) el.disabled = !b.setIncline.ok || !validIncline(+el.dataset.incline);
  $('wSpeed').textContent = b.setSpeed.ok ? '' : b.setSpeed.why;
  $('wIncline').textContent = b.setIncline.ok ? '' : b.setIncline.why;
}

const validSpeed = (mph) => { try { encodeSetSpeedMph(mph, ctl.ranges, LIMITS); return true; } catch { return false; } };
const validIncline = (lvl) => { try { encodeSetInclineLevel(lvl, ctl.ranges, LIMITS); return true; } catch { return false; } };

async function run(label, promise) {
  const r = await promise;
  log(r.ok ? `${label}: OK` : `${label}: ${r.sent === false ? 'REFUSED' : 'FAILED'} (${r.reason})`);
}

for (const mph of SPEEDS_MPH) {
  const btn = Object.assign(document.createElement('button'), { textContent: `${mph.toFixed(1)}` });
  btn.dataset.speed = mph;
  btn.disabled = true;
  btn.addEventListener('click', () => run(`Speed ${mph} mph`, ctl.setSpeedMph(mph)));
  $('speedRow').append(btn);
}
for (const lvl of INCLINES) {
  const btn = Object.assign(document.createElement('button'), { textContent: `${lvl}` });
  btn.dataset.incline = lvl;
  btn.disabled = true;
  btn.addEventListener('click', () => run(`Incline ${lvl}`, ctl.setInclineLevel(lvl)));
  $('inclineRow').append(btn);
}

$('connect').addEventListener('click', connect);
$('disconnect').addEventListener('click', disconnect);
$('bControl').addEventListener('click', () => run('Take control', ctl.takeControl()));
$('bStart').addEventListener('click', () => {
  if (!window.confirm('The belt will start in about 3 seconds. Is the belt empty, and are you standing beside it with the remote or safety key in reach?')) return;
  run('Start', ctl.start());
});
$('bStop').addEventListener('click', () => run('Stop', ctl.stop()));
$('reset').addEventListener('click', () => { const r = ctl.resetLock(); log(r.ok ? 'Reset test: OK' : `Reset test: refused (${r.reason})`); });
for (const box of document.querySelectorAll('.arm')) box.addEventListener('change', () => ctl.setArmed([...document.querySelectorAll('.arm')].every((x) => x.checked)));
document.addEventListener('visibilitychange', () => { if (document.hidden) ctl.pageHidden(); });
window.addEventListener('pagehide', () => ctl.pageHidden());

$('copy').addEventListener('click', async () => {
  const body = JSON.stringify({ build: BUILD, generatedAt: new Date().toISOString(), limits: LIMITS, lock: lastSnap?.lock ?? null, events }, null, 2);
  $('reportBox').value = body;
  try { await navigator.clipboard.writeText(body); log('Report copied. Paste it into the chat.'); } catch { $('reportBox').select(); log('Clipboard blocked: long-press the box, Select All, Copy.'); }
});

$('build').textContent = `Build ${BUILD}`;
log(`Page loaded (${BUILD}). Nothing has been sent to the treadmill.`);
render(ctl.snapshot());
