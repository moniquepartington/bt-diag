// App shell: creates the services once (library, Bluetooth session, controller, workout engine, wake lock), routes
// between the four screens, and refreshes the visible screen when anything changes. Every decision about whether
// a command may be sent lives in the Controller and the workout engine, not here.
import { Controller } from '../control/controller.js?v=c8';
import { WorkoutEngine, STATE } from '../workout/engine.js?v=v5';
import { VERIFIED_LIMITS } from '../workout/limits.js?v=l2';
import { WorkoutLibrary } from './storage.js?v=a1';
import { BleSession } from './session.js?v=a2';
import { ScreenWake } from './wakelock.js?v=a1';
import { isActive } from './workout-vm.js?v=a4';
import { buildReport, PacketLog } from './report.js?v=a4';
import { LogStore } from './logstore.js?v=a4';
import { h, clear } from './dom.js?v=a1';
import { safetyStrip } from './components.js?v=a4';
import { dashboardView } from './views/dashboard.js?v=a1';
import { editorView } from './views/editor.js?v=a1';
import { workoutView } from './views/workout.js?v=a4';
import { settingsView } from './views/settings.js?v=a4';

const BUILD = 'a4';
const view = document.getElementById('view');
const clock = { now: () => performance.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id) };

// The log is also saved on the phone, so reloading the page does not erase the record of a run that went wrong.
const logStore = new LogStore();
let telemetry = null; // assigned below; the log is saved with the readings as they stand
const events = [];
function log(line) {
  events.push(`${new Date().toLocaleTimeString()}  ${line}`);
  if (events.length > 400) events.shift();
  logStore.save(events, telemetry?.rows ?? []);
}

const limits = VERIFIED_LIMITS;
const session = new BleSession({ onLog: log });
const ctl = new Controller({ transport: session.transport, clock, limits, onChange: () => requestRender(), onLog: log });
session.attach(ctl);
const engine = new WorkoutEngine({ controller: ctl, clock, limits, onChange: () => requestRender(), onEvent: log });
const library = new WorkoutLibrary();
library.load();
const wake = new ScreenWake({ onChange: (status) => { log(`Screen wake: ${status}`); requestRender(); } });
telemetry = new PacketLog(4000); // every real speed reading, for the copyable report
ctl.subscribe((snap) => telemetry.add(snap.tele.at, snap.tele.speedKmh, snap.tele.inclinePct, snap.training));
let savedRows = 0;
setInterval(() => { if (telemetry.rows.length !== savedRows) { savedRows = telemetry.rows.length; logStore.save(events, telemetry.rows); } }, 10000);

let current = null;
let pending = false;
function requestRender() {
  if (pending) return;
  pending = true;
  setTimeout(() => {
    pending = false;
    housekeeping();
    current?.update?.();
  }, 40);
}

const ctx = {
  clock, limits, library, session, ctl, engine, wake, events, log,
  buildReport: () => buildReport({ build: BUILD, events, telemetry: telemetry.rows, engine: engine.snapshot(), controller: ctl.snapshot(), limits, storagePersistent: library.persistent, wake: wake.status, previous: logStore.previous }),
  state: { checklist: [false, false, false], connecting: false, connectMessage: '', notices: [], runId: null, adjustMsg: '', faultMsg: '' },
  checklistOk: () => ctx.state.checklist.every(Boolean),
  go: (path) => { if (location.hash === path) route(); else location.hash = path; },
  requestRender,
  setChecklist(i, on) {
    ctx.state.checklist[i] = on;
    ctl.setArmed(ctx.checklistOk());
    requestRender();
  },
  async connect() {
    ctx.state.connecting = true;
    ctx.state.connectMessage = '';
    requestRender();
    const r = await session.connect();
    ctx.state.connecting = false;
    ctx.state.connectMessage = r.ok ? '' : r.reason;
    requestRender();
  },
  /** Called from the second tap of the Start button (a user gesture, which the wake lock needs). */
  async startWorkout() {
    await wake.acquire();
    const r = await engine.begin();
    log(r.ok ? 'Workout started.' : `Workout not started: ${r.reason ?? 'see the fault'}`);
    requestRender();
  },
  async act(label, promise) {
    const r = await promise;
    log(r.ok ? `${label}: OK` : `${label}: ${r.sent === false ? 'REFUSED' : 'FAILED'} (${r.reason ?? 'see the fault'})`);
    requestRender();
  },
  async adjust(change) {
    const r = await engine.adjust(change);
    ctx.state.adjustMsg = r.ok ? '' : `Not changed: ${r.reason}`;
    log(r.ok ? `Manual change ${JSON.stringify(change)}: OK` : `Manual change refused: ${r.reason}`);
    requestRender();
  },
};

/** Things that follow the state: let the screen sleep again when a workout ends. */
function housekeeping() {
  if (!isActive(engine.state) && wake.status === 'active') wake.release();
}

// ---------- routing ----------
const parts = (hash) => hash.replace(/^#\/?/, '').split('/').filter(Boolean);

function route() {
  const hash = location.hash || '#/';
  const [page, id] = parts(hash);
  // While a workout is active (or faulted and unresolved) the user stays on its screen: Stop it first.
  const locked = isActive(engine.state) || engine.state === STATE.FAULTED;
  if (locked && ctx.state.runId && !(page === 'run' && id === ctx.state.runId)) return void location.replace(`#/run/${ctx.state.runId}`);
  clear(view);
  let next;
  if (page === 'new') next = editorView(ctx, null);
  else if (page === 'edit') next = editorView(ctx, id);
  else if (page === 'run') next = workoutView(ctx, id);
  else if (page === 'settings') next = settingsView(ctx, BUILD);
  else next = dashboardView(ctx);
  current = next;
  view.append(next.el);
  next.update?.();
  window.scrollTo(0, 0);
}

// ---------- shell ----------
document.getElementById('shell').append(
  h('header', { class: 'top' }, h('h1', {}, 'Treadmill'), h('nav', {}, h('a', { class: 'btn small', href: '#/' }, 'Workouts'), h('a', { class: 'btn small', href: '#/settings' }, 'Settings'))),
  safetyStrip());

window.addEventListener('hashchange', route);
// A page that leaves the screen may be suspended: timers and Bluetooth can pause. The controller locks out and the
// engine faults rather than guessing what the belt did.
document.addEventListener('visibilitychange', () => { log(document.hidden ? 'Page hidden (screen locked or app switched).' : 'Page visible again.'); if (document.hidden) ctl.pageHidden(); });
window.addEventListener('pagehide', () => { log('Page closing or hidden.'); ctl.pageHidden(); });
setInterval(requestRender, 500);

log(`App loaded (build ${BUILD}). Nothing has been sent to the treadmill.`);
route();

// Exposed for the browser tests only; nothing in the app reads these.
globalThis.__app = { ctx, engine, ctl, library };
