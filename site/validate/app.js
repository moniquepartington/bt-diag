// Staged limits-validation page: Web Bluetooth plumbing and UI only. Every decision about whether a command may be
// sent lives in the Controller (control/controller.js) and the workout engine (workout/engine.js); every byte is
// built by control/protocol.js. A stage's raised limits exist only inside the Controller created for that stage.
import { Controller } from '../control/controller.js?v=c8';
import { routeNotification } from '../control/bridge.js?v=c8';
import { wireTwoStep } from '../control/confirm.js?v=c8';
import { MPH_TO_KMH, kmhToMph, encodeSetSpeedMph, encodeSetInclineLevel } from '../control/protocol.js?v=c8';
import { SERVICES, CHARS, parseSpeedRange, parseInclineRange, parseTrainingStatus } from '../ftms.js?v=b6';
import { WorkoutEngine, STATE } from '../workout/engine.js?v=v4';
import { STAGES, ENABLED_STAGES, unlockStage, unlockPhrase } from './stages.js?v=v2';
import { restartVerdict, TelemetryLog } from './observe.js?v=v2';

const BUILD = 'v4';
const $ = (id) => document.getElementById(id);
const CONNECT_TIMEOUT_MS = 20000;
const TRAINING_NAMES = { 0x01: 'Idle', 0x0d: 'Running', 0x0e: 'Countdown', 0x0f: 'Finished' };
const MANUAL_OK_STATES = [STATE.IDLE, STATE.READY, STATE.STOPPED, STATE.COMPLETED, STATE.FAULTED];

const events = [];
const telemetry = new TelemetryLog();
let stage = null;
let ctl = null;
let engine = null;
let device = null;
let cp = null; // control point characteristic
let lastSnap = null;
let lastEngineSnap = null;
let lastManual = true;
let startConfirm = null; // two-step confirmations: they do not freeze the page the way the browser dialog does
let beginConfirm = null;
let lastTargetKmh = null;
let startCount = 0;
let generation = 0;
let onGattDisconnect = null;

const clock = { now: () => performance.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id) };
const transport = { write: (bytes) => { if (!cp) throw new Error('not connected'); return cp.writeValue(bytes); } };

function log(line) {
  events.push(line);
  const el = document.createElement('div');
  if (/LOCKOUT|REFUSED|failed|FAILED|FAULT/i.test(line)) el.className = 'err';
  el.textContent = line;
  $('log').prepend(el);
}
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000} s`)), ms))]);

// ---------- unlocking a stage ----------
for (const s of Object.values(STAGES)) {
  const enabled = ENABLED_STAGES.includes(s.id);
  const row = document.createElement('label');
  row.className = 'chk';
  row.innerHTML = '<input type="radio" name="stage"><span></span>';
  row.querySelector('input').value = s.id;
  row.querySelector('input').checked = s.id === ENABLED_STAGES[0];
  row.querySelector('span').textContent = `${s.label}${enabled ? '' : ' (locked in this build)'}: ${s.summary}. Limits ${s.limits.maxMph} mph, incline ${s.limits.maxInclineLevel}.`;
  $('stageList').append(row);
}

$('unlockBtn').addEventListener('click', () => {
  if (ctl) return void ($('unlockMsg').textContent = `Already unlocked (${stage.label}). Reload the page to change stage.`);
  const id = document.querySelector('input[name="stage"]:checked')?.value;
  const r = unlockStage(id, $('unlockInput').value);
  if (!r.ok) { $('unlockMsg').textContent = r.reason; return log(`Unlock refused: ${r.reason}`); }
  stage = r.stage;
  ctl = new Controller({ transport, clock, limits: stage.limits, onChange: render, onLog: log });
  ctl.subscribe((snap) => telemetry.add(clock.now(), snap.tele.speedKmh, snap.tele.inclinePct, snap.training));
  if (stage.workout) engine = new WorkoutEngine({ controller: ctl, clock, limits: stage.limits, onChange: renderEngine, onEvent: log });
  $('unlockMsg').textContent = `${stage.label} unlocked: limits ${stage.limits.maxMph} mph, incline ${stage.limits.maxInclineLevel}.`;
  $('unlockInput').disabled = true;
  $('unlockBtn').disabled = true;
  buildStageButtons();
  $('connect').disabled = false;
  $('enginePanel').hidden = !engine;
  log(`${stage.label} unlocked (${stage.limits.maxMph} mph, incline ${stage.limits.maxInclineLevel}).`);
  render(ctl.snapshot());
  if (engine) renderEngine(engine.snapshot());
});
$('unlockInput').placeholder = unlockPhrase(ENABLED_STAGES[0]);

function buildStageButtons() {
  $('limitsNote').textContent = `${stage.label}: speeds up to ${stage.limits.maxMph} mph, incline up to ${stage.limits.maxInclineLevel}. Anything higher is refused before it is sent.`;
  for (const mph of stage.speedsMph) {
    const btn = Object.assign(document.createElement('button'), { textContent: mph.toFixed(1) });
    btn.dataset.speed = mph;
    btn.disabled = true;
    btn.addEventListener('click', () => runSpeed(mph));
    $('speedRow').append(btn);
  }
  for (const lvl of stage.inclines) {
    const btn = Object.assign(document.createElement('button'), { textContent: `${lvl}` });
    btn.dataset.incline = lvl;
    btn.disabled = true;
    btn.addEventListener('click', () => runIncline(lvl));
    $('inclineRow').append(btn);
  }
}

// ---------- connect ----------
async function connect() {
  if (!ctl) return log('Unlock a stage first.');
  if (!(navigator.bluetooth && window.isSecureContext)) return log('Web Bluetooth is not available here. Open this page in Bluefy over https://.');
  try {
    log('Opening device chooser…');
    if (device && onGattDisconnect) device.removeEventListener('gattserverdisconnected', onGattDisconnect);
    device = await navigator.bluetooth.requestDevice({ filters: [{ namePrefix: 'FS-' }], optionalServices: [SERVICES.fitnessMachine] });
    const gen = ++generation;
    onGattDisconnect = () => {
      if (gen !== generation) return;
      if (ctl.link) ctl.disconnected();
      else log('Disconnected before the test was ready.');
    };
    device.addEventListener('gattserverdisconnected', onGattDisconnect);
    const server = await withTimeout(device.gatt.connect(), CONNECT_TIMEOUT_MS, 'GATT connect');
    const svc = await server.getPrimaryService(SERVICES.fitnessMachine);
    const ch = (uuid) => svc.getCharacteristic(uuid);
    cp = await ch(CHARS.controlPoint);
    const [data, training, machine] = await Promise.all([ch(CHARS.treadmillData), ch(CHARS.trainingStatus), ch(CHARS.machineStatus)]);
    const speed = parseSpeedRange(await (await ch(CHARS.speedRange)).readValue());
    const incline = parseInclineRange(await (await ch(CHARS.inclineRange)).readValue());
    if (!(speed.minKmh > 0 && speed.maxKmh > speed.minKmh) || !(incline.maxPct >= incline.minPct)) throw new Error('the treadmill limits could not be read sensibly; no commands will be sent');
    // Listen first (including control-point responses) so that no acknowledgment can be missed. If any subscription
    // fails we refuse to continue: we never send a command we cannot see the answer to.
    for (const c of [data, training, machine, cp]) {
      c.addEventListener('characteristicvaluechanged', (ev) => { if (gen === generation) routeNotification(ctl, ev.target.uuid, ev.target.value); });
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
const disconnect = () => { try { device?.gatt?.disconnect(); } catch { /* ignore */ } };

// ---------- manual commands, with the facts each stage is meant to establish ----------
async function timed(label, promise) {
  const t0 = clock.now();
  const r = await promise;
  const secs = ((clock.now() - t0) / 1000).toFixed(1);
  log(r.ok ? `${label}: OK (${secs} s from tap to confirmed)` : `${label}: ${r.sent === false ? 'REFUSED' : 'FAILED'} (${r.reason})`);
  return r;
}

async function runSpeed(mph) {
  const from = lastSnap?.tele.speedKmh == null ? '?' : kmhToMph(lastSnap.tele.speedKmh).toFixed(2);
  const r = await timed(`Speed ${from} → ${mph.toFixed(1)} mph`, ctl.setSpeedMph(mph));
  if (r.ok) lastTargetKmh = mph * MPH_TO_KMH;
}
async function runIncline(level) {
  const from = lastSnap?.tele.inclinePct == null ? '?' : lastSnap.tele.inclinePct.toFixed(1);
  await timed(`Incline ${from} → ${level}`, ctl.setInclineLevel(level));
}
async function runStart() {
  const r = await timed('Start', ctl.start());
  if (!r.ok) return;
  startCount += 1;
  const kmh = ctl.tele.speedKmh;
  const v = restartVerdict(kmh, ctl.ranges.speed.minKmh, lastTargetKmh);
  const text = startCount === 1 ? `first start: ${v.text}` : `start #${startCount}: ${v.text}`;
  $('vRestart').textContent = text;
  log(`RESTART OBSERVATION: ${text}`);
}

// ---------- UI ----------
function manualAllowed() { return !engine || MANUAL_OK_STATES.includes(engine.state); }
const validSpeed = (mph) => { try { encodeSetSpeedMph(mph, ctl.ranges, ctl.limits); return true; } catch { return false; } };
const validIncline = (lvl) => { try { encodeSetInclineLevel(lvl, ctl.ranges, ctl.limits); return true; } catch { return false; } };

function render(snap) {
  lastSnap = snap;
  $('state').textContent = snap.link ? 'Connected' : 'Not connected';
  $('state').className = snap.link ? 'pill ok' : 'pill';
  $('connect').disabled = !ctl || snap.link;
  $('disconnect').disabled = !snap.link;
  $('lock').hidden = !snap.lock;
  if (snap.lock) { $('lockReason').textContent = `LOCKED OUT: ${snap.lock.reason}`; $('lockDetail').textContent = snap.lock.detail; }
  $('recoveryHelp').hidden = !snap.recovery;
  $('bControl').classList.toggle('attn', snap.recovery && snap.buttons.takeControl.ok);
  $('bStop').classList.toggle('attn', snap.recovery && snap.buttons.stop.ok);
  $('reset').disabled = !!snap.pending;

  const kmh = snap.tele.speedKmh;
  $('vSpeed').textContent = kmh == null ? '—' : `${kmh.toFixed(2)} km/h · ${kmhToMph(kmh).toFixed(2)} mph`; // mph as the treadmill's console shows it
  $('vIncline').textContent = snap.tele.inclinePct == null ? '—' : `${snap.tele.inclinePct.toFixed(1)} %`;
  $('vStatus').textContent = snap.training == null ? '—' : TRAINING_NAMES[snap.training] ?? `0x${snap.training.toString(16)}`;
  $('vControl').textContent = snap.hasControl ? 'held' : 'not held';
  $('vPending').textContent = snap.pending ? `${snap.pending.cmd}: ${snap.pending.acked ? 'waiting for the readings to confirm' : 'waiting for the treadmill to answer'}` : 'none';

  const b = snap.buttons;
  const allow = manualAllowed();
  const setBtn = (el, why, state) => { el.disabled = !state.ok || !allow; why.textContent = !allow ? 'a workout is active: manual steps are off' : state.ok ? '' : state.why; };
  setBtn($('bControl'), $('wControl'), b.takeControl);
  setBtn($('bStart'), $('wStart'), b.start);
  setBtn($('bStop'), $('wStop'), b.stop);
  if ($('bStart').disabled) startConfirm?.cancel(); // never leave a Start armed once it is no longer allowed
  for (const el of document.querySelectorAll('[data-speed]')) el.disabled = !allow || !b.setSpeed.ok || !validSpeed(+el.dataset.speed);
  for (const el of document.querySelectorAll('[data-incline]')) el.disabled = !allow || !b.setIncline.ok || !validIncline(+el.dataset.incline);
  $('wSpeed').textContent = b.setSpeed.ok ? '' : b.setSpeed.why;
  $('wIncline').textContent = b.setIncline.ok ? '' : b.setIncline.why;
  if (engine && lastEngineSnap) renderEngine(lastEngineSnap);
}

function renderEngine(s) {
  lastEngineSnap = s;
  if (!engine) return;
  const fmt = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  $('eState').textContent = s.state.toUpperCase();
  $('eTime').textContent = s.name ? `${fmt(s.elapsedMs)} / ${fmt(s.totalMs)}` : '—';
  $('eInterval').textContent = s.interval ? `${s.intervalIndex + 1}: ${s.interval.category} ${s.interval.speedMph} mph, incline ${s.interval.inclineLevel}${s.next ? ` (next: ${s.next.speedMph} mph, incline ${s.next.inclineLevel})` : ' (last)'}` : '—';
  const left = s.countdownEndsAt == null ? null : Math.max(0, Math.ceil((s.countdownEndsAt - clock.now()) / 1000));
  $('eNote').textContent = s.fault ? `FAULT: ${s.fault.reason}. ${s.fault.detail} ${s.fault.belt}` : left != null ? `Resuming in ${left}…` : s.notice ? s.notice.text : '';
  const st = s.state;
  const connected = !!lastSnap?.link;
  $('eLoad').disabled = ![STATE.IDLE, STATE.READY, STATE.STOPPED, STATE.COMPLETED].includes(st);
  $('eBegin').disabled = st !== STATE.READY || !connected;
  $('ePause').disabled = st !== STATE.RUNNING;
  $('eResume').disabled = st !== STATE.PAUSED || !connected;
  $('eStop').disabled = ![STATE.STARTING, STATE.RUNNING, STATE.PAUSING, STATE.PAUSED, STATE.RESUMING, STATE.FAULTED].includes(st);
  $('eAck').disabled = st !== STATE.FAULTED;
  if ($('eBegin').disabled) beginConfirm?.cancel();
  // Manual buttons switch off while a workout is active and back on afterwards.
  const manual = MANUAL_OK_STATES.includes(st);
  if (manual !== lastManual) { lastManual = manual; if (lastSnap) render(lastSnap); }
}

async function runEngine(label, promise) {
  const r = await promise;
  log(r.ok ? `${label}: OK` : `${label}: ${r.sent === false ? 'REFUSED' : 'FAILED'} (${r.reason ?? 'see fault above'})`);
}

$('connect').addEventListener('click', connect);
$('disconnect').addEventListener('click', disconnect);
$('bControl').addEventListener('click', () => timed('Take control', ctl.takeControl()));
startConfirm = wireTwoStep($('bStart'), $('startWarn'), {
  clock, label: 'Start belt', armedLabel: 'TAP AGAIN to start the belt',
  warning: 'The belt will start in about 3 seconds. Is the belt empty, and are you standing beside it with the remote or safety key in reach? Tap again to start, or wait to cancel.',
  onConfirm: runStart,
});
$('bStop').addEventListener('click', () => timed('Stop', ctl.stop()));
$('reset').addEventListener('click', () => { const r = ctl.resetLock(); log(r.ok ? 'Reset test: OK' : `Reset test: refused (${r.reason})`); });
for (const box of document.querySelectorAll('.arm')) box.addEventListener('change', () => ctl?.setArmed([...document.querySelectorAll('.arm')].every((x) => x.checked)));
$('eLoad').addEventListener('click', () => { const r = engine.load(stage.workout); log(r.ok ? 'Workout loaded.' : `Workout refused: ${r.reason}`); renderEngine(engine.snapshot()); });
beginConfirm = wireTwoStep($('eBegin'), $('beginWarn'), {
  clock, label: 'Start workout', armedLabel: 'TAP AGAIN to start the workout',
  warning: 'The workout will start the belt (3-second countdown) and then change speed and incline on its own. Belt empty, and you are beside it with the remote or safety key in reach? Tap again to start, or wait to cancel.',
  onConfirm: () => runEngine('Workout start', engine.begin()),
});
$('ePause').addEventListener('click', () => runEngine('Pause', engine.pause()));
$('eResume').addEventListener('click', () => runEngine('Resume', engine.resume()));
$('eStop').addEventListener('click', () => runEngine('Stop workout', engine.stop()));
$('eAck').addEventListener('click', () => { const r = engine.acknowledgeFault(); log(r.ok ? 'Fault closed: belt confirmed stopped.' : `Not closed: ${r.reason}`); });
document.addEventListener('visibilitychange', () => { if (document.hidden) ctl?.pageHidden(); });
window.addEventListener('pagehide', () => ctl?.pageHidden());

setInterval(() => {
  const at = lastSnap?.tele?.at;
  $('vAge').textContent = Number.isFinite(at) ? `Last speed reading: ${((clock.now() - at) / 1000).toFixed(1)} s ago (commands need under 3 s)` : 'Last speed reading: none yet';
  if (engine && lastEngineSnap?.countdownEndsAt != null) renderEngine(engine.snapshot());
}, 500);

$('copy').addEventListener('click', async () => {
  const body = JSON.stringify({
    build: BUILD, generatedAt: new Date().toISOString(),
    stage: stage ? { id: stage.id, limits: stage.limits } : null,
    notes: $('notes').value, lock: lastSnap?.lock ?? null, events, telemetry: telemetry.rows,
  }, null, 2);
  $('reportBox').value = body;
  try { await navigator.clipboard.writeText(body); log('Report copied. Paste it into the chat.'); } catch { $('reportBox').select(); log('Clipboard blocked: long-press the box, Select All, Copy.'); }
});

$('build').textContent = `Build ${BUILD}`;
log(`Page loaded (${BUILD}). Nothing has been sent to the treadmill. Enabled stages in this build: ${ENABLED_STAGES.join(', ')}.`);
