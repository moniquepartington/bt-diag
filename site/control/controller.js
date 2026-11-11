// Safety state machine for the Phase 2 belt-empty test. No Bluetooth or DOM code here: the transport and clock
// are injected so the whole thing runs against a simulator.
//
// Rules enforced:
//  * ONE command outstanding at a time. Buttons stay disabled until it is resolved (acknowledged AND confirmed by
//    telemetry), including Stop, so the physical stop/safety key remains the real emergency stop.
//  * Any failure (write error, no acknowledgment, error result, unexpected response, telemetry that does not show
//    the expected result, unexpected motion, over-limit values, lost telemetry or connection) LOCKS OUT every command
//    except Stop. Nothing is ever retried automatically. Only resetLock() (a manual user action) clears the lock.
//  * Nothing is sent unless the user has ticked the safety boxes and fresh telemetry is flowing.
import { OP, RESULT_TEXT, LIMITS, capKmh, encodeRequestControl, encodeStart, encodeStop, encodeSetSpeedMph, encodeSetInclineLevel, parseIndication } from './protocol.js?v=c6';

export const TIMING = Object.freeze({
  ackMs: 3000, // no indication within this long = failure
  controlWatchMs: 6000, // after Take Control, watch for any motion this long (the belt countdown is about 3 s)
  startConfirmMs: 12000,
  speedConfirmMs: 8000,
  inclineConfirmMs: 10000,
  stopConfirmMs: 15000,
  staleMs: 3000, // while the belt is running or a command is pending, readings older than this are "lost"
  idleStaleMs: 6000, // while the belt is idle the treadmill pauses its readings for up to 3.3 s (seen on hardware)
  watchdogMs: 1000,
});

export const TRAINING = Object.freeze({ IDLE: 0x01, RUNNING: 0x0d, PRE: 0x0e, POST: 0x0f });
const SPEED_TOL_KMH = 0.08; // half of the treadmill's 0.16 km/h (0.1 mph) step
const INCLINE_TOL_PCT = 0.05;
const STOPPED_KMH = 0.05;
export const COMMANDS = ['takeControl', 'start', 'setSpeed', 'setIncline', 'stop'];

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');

export class Controller {
  constructor({ transport, clock, limits = LIMITS, timing = TIMING, onChange = () => {}, onLog = () => {} }) {
    Object.assign(this, { transport, clock, limits, timing, onChange, onLog });
    this.link = false;
    this.hasControl = false;
    this.armed = false;
    this.ranges = null;
    this.tele = { speedKmh: null, inclinePct: null, at: -Infinity };
    this.training = null;
    this.expect = 'stopped'; // what WE believe the belt is doing: 'stopped' | 'running'
    this.pending = null;
    this.lock = null;
    this.watchdog = null;
    this.abandoned = []; // opcodes whose response we no longer wait for
    this.listeners = new Set();
  }

  // ---------- connection / user state ----------
  connected(ranges) {
    this.link = true;
    this.ranges = ranges;
    this.hasControl = false;
    this.abandoned = [];
    this.expect = 'stopped';
    // Forget anything remembered from a previous connection: the belt state is unknown until new readings arrive.
    this.tele = { speedKmh: null, inclinePct: null, at: -Infinity };
    this.training = null;
    this._armWatchdog();
    this._log('Connected. Device ranges read; waiting for telemetry.');
    this._emit();
  }

  disconnected() {
    this.link = false;
    this.hasControl = false;
    if (this.watchdog != null) this.clock.clearTimeout(this.watchdog);
    this.watchdog = null;
    this._lockout('CONNECTION LOST', 'The belt may still be moving. Use the remote or safety key. No further commands will be sent.');
  }

  pageHidden() {
    if (this.link && (this.pending || this.expect === 'running' || this.hasControl)) {
      this._lockout('PAGE LEFT THE SCREEN', 'Timers and Bluetooth may have paused, so the belt state is unknown. Check the belt.');
    }
  }

  setArmed(on) {
    this.armed = !!on;
    this._emit();
  }

  resetLock() {
    if (this.pending) return { ok: false, reason: 'a command is still in progress' };
    this.lock = null;
    const moving = (this.tele.speedKmh ?? 0) > STOPPED_KMH || this.training === TRAINING.RUNNING || this.training === TRAINING.PRE;
    this.expect = moving ? 'running' : 'stopped';
    this._log(`Test reset by user. Treating the belt as ${this.expect}.`);
    this._emit();
    return { ok: true };
  }

  // ---------- gating ----------
  canSend(cmd) {
    const no = (why) => ({ ok: false, why });
    if (!this.link) return no('not connected');
    if (this.pending) return no('previous command still in progress');
    // Stop is the one command that moves toward safety, so it is allowed even in a lockout and even if the
    // acknowledgment of Take Control never arrived (the treadmill will simply reject it if control is not held).
    if (cmd === 'stop') return this.hasControl || this.lock || this.abandoned.length ? { ok: true } : no('nothing to stop yet: control has not been taken');
    if (this.lock) {
      // RECOVERY: locked out with the belt moving (for example after a disconnect, or a reload while it runs).
      // The only extra thing allowed is asking for control, so that Stop can be accepted. Never Start, Speed or Incline.
      if (cmd === 'takeControl' && this.recovery) {
        if (this.hasControl) return no('already have control: press Stop belt');
        return this._fresh() ? { ok: true } : no('waiting for fresh readings before asking for control');
      }
      return no(`locked out (${this.lock.reason}): press Reset test`);
    }
    if (!this.armed) return no('tick all three safety boxes');
    if (!this.ranges) return no("the treadmill's limits have not been read");
    if (!this._fresh()) {
      const age = this.clock.now() - this.tele.at;
      return no(Number.isFinite(age) ? `no fresh telemetry (last reading ${(age / 1000).toFixed(1)} s ago)` : 'no telemetry received yet');
    }
    const stopped = this._isStopped();
    const running = this.training === TRAINING.RUNNING && (this.tele.speedKmh ?? 0) > STOPPED_KMH;
    switch (cmd) {
      case 'takeControl':
        if (this.hasControl) return no('already have control');
        return stopped ? { ok: true } : no('the belt must be stopped and idle');
      case 'start':
        if (!this.hasControl) return no('take control first');
        return stopped ? { ok: true } : no('the belt must be stopped and idle');
      case 'setSpeed':
      case 'setIncline':
        if (!this.hasControl) return no('take control first');
        return running ? { ok: true } : no('the belt must be running');
      default:
        return no('unknown command');
    }
  }

  // ---------- commands ----------
  takeControl() {
    return this._issue('takeControl', () => ({
      bytes: encodeRequestControl(),
      // In recovery the belt is already moving: remember its speed so any INCREASE afterwards is caught.
      meta: { baselineKmh: this.recovery ? this.tele.speedKmh : null },
    }));
  }
  start() { return this._issue('start', () => ({ bytes: encodeStart() })); }
  stop() { return this._issue('stop', () => ({ bytes: encodeStop() })); }
  setSpeedMph(mph) {
    return this._issue('setSpeed', () => {
      const r = encodeSetSpeedMph(mph, this.ranges, this.limits);
      return { bytes: r.bytes, meta: { targetKmh: r.kmh } };
    });
  }
  setInclineLevel(level) {
    return this._issue('setIncline', () => {
      const r = encodeSetInclineLevel(level, this.ranges, this.limits);
      return { bytes: r.bytes, meta: { targetPct: r.pct } };
    });
  }

  _issue(cmd, build) {
    const gate = this.canSend(cmd);
    if (!gate.ok) {
      this._log(`REFUSED ${cmd}: ${gate.why}`);
      return Promise.resolve({ ok: false, reason: gate.why, sent: false });
    }
    let built;
    try {
      built = build();
    } catch (e) {
      this._log(`REFUSED ${cmd}: ${e.message}`);
      return Promise.resolve({ ok: false, reason: e.message, sent: false });
    }
    return new Promise((resolve) => {
      const p = { cmd, op: built.bytes[0], meta: built.meta ?? {}, sentAt: this.clock.now(), acked: false, resolve, ackTimer: null, confirmTimer: null };
      this.pending = p;
      p.ackTimer = this.clock.setTimeout(() => {
        if (this.pending === p) this._lockout('NO ACKNOWLEDGMENT', `${cmd}: no response within ${this.timing.ackMs / 1000} s. Outcome unknown. Not retrying.`);
      }, this.timing.ackMs);
      this._log(`SEND ${cmd} [${hex(built.bytes)}]`);
      this._emit();
      let w;
      try {
        w = this.transport.write(built.bytes);
      } catch (e) {
        w = Promise.reject(e);
      }
      Promise.resolve(w).catch((e) => {
        if (this.pending === p) this._lockout('WRITE FAILED', `${cmd}: ${e?.message ?? e}. Outcome unknown. Not retrying.`);
        else this._log(`Late write error for ${cmd}: ${e?.message ?? e}`);
      });
    });
  }

  // ---------- inputs from the treadmill ----------
  feedIndication(bytes) {
    const ind = parseIndication(bytes);
    const p = this.pending;
    if (!ind) return this._lockout('UNRECOGNISED RESPONSE', hex(bytes));
    // A response that arrives after we already gave up on (locked out) that command is expected exactly once.
    const late = this.abandoned.indexOf(ind.op);
    if (late !== -1 && !(p && p.op === ind.op && !p.acked)) {
      this.abandoned.splice(late, 1);
      this._log(`Late response for an abandoned command (opcode ${ind.op}, result ${ind.result}); ignored.`);
      if (ind.op === OP.REQUEST_CONTROL && ind.ok) this.hasControl = true;
      return this._emit();
    }
    if (!p) return this._lockout('UNEXPECTED RESPONSE', `treadmill answered for opcode ${ind.op} with nothing pending [${hex(bytes)}]`);
    if (p.acked) return this._lockout('DUPLICATE RESPONSE', `[${hex(bytes)}]`);
    if (ind.op !== p.op) return this._lockout('RESPONSE FOR A DIFFERENT COMMAND', `sent opcode ${p.op}, answered ${ind.op}`);
    if (!ind.ok) return this._lockout('TREADMILL REJECTED COMMAND', `${p.cmd}: ${RESULT_TEXT[ind.result] ?? `result ${ind.result}`}. Not retrying.`);
    p.acked = true;
    this.clock.clearTimeout(p.ackTimer);
    this._log(`ACK ${p.cmd} [${hex(bytes)}]`);
    const t = this.timing;
    if (p.cmd === 'takeControl') {
      this.hasControl = true;
      p.confirmTimer = this.clock.setTimeout(() => {
        if (this.pending === p) {
          this._log('Take Control: no belt motion seen during the watch window.');
          this._settle(p, { ok: true });
        }
      }, t.controlWatchMs);
    } else {
      const ms = { start: t.startConfirmMs, setSpeed: t.speedConfirmMs, setIncline: t.inclineConfirmMs, stop: t.stopConfirmMs }[p.cmd];
      p.confirmTimer = this.clock.setTimeout(() => {
        if (this.pending === p) this._lockout('NOT CONFIRMED BY TELEMETRY', `${p.cmd}: acknowledged, but the readings never showed the expected result within ${ms / 1000} s. Not retrying.`);
      }, ms);
    }
    this._checkConfirm();
    this._emit();
  }

  /** Only Treadmill Data packets that carry speed should be fed here. */
  feedTelemetry({ speedKmh, inclinePct }) {
    if (speedKmh != null) {
      const now = this.clock.now();
      const gap = now - this.tele.at;
      if (Number.isFinite(gap) && gap > 2000) this._log(`Telemetry gap: no speed reading for ${(gap / 1000).toFixed(1)} s`);
      this.tele.speedKmh = speedKmh;
      this.tele.at = now;
    }
    if (inclinePct != null) this.tele.inclinePct = inclinePct;
    this._monitor();
    const p = this.pending;
    if (p?.cmd === 'takeControl' && p.meta.baselineKmh != null && speedKmh != null && speedKmh > p.meta.baselineKmh + STOPPED_KMH) {
      this._lockout('SPEED INCREASED AFTER TAKE CONTROL', `${speedKmh} km/h, up from ${p.meta.baselineKmh}. Stop the belt with the remote or safety key now.`);
    }
    this._checkConfirm();
    this._emit();
  }

  feedTraining(code) {
    this.training = code;
    this._monitor();
    this._checkConfirm();
    this._emit();
  }

  feedMachineStatus(code, raw = '') {
    this._log(`Machine status 0x${code.toString(16)}${raw ? ` [${raw}]` : ''}`);
    if (code === 0xff) {
      this.hasControl = false;
      return this._lockout('CONTROL PERMISSION LOST', 'Another app or the console took control.');
    }
    if (code === 0x04 && this.expect === 'stopped' && this.pending?.cmd !== 'start' && !this.lock) {
      return this._lockout(this.pending?.cmd === 'takeControl' ? 'MOTION AFTER TAKE CONTROL' : 'BELT STARTED BY SOMETHING ELSE', 'The treadmill reported "started". Stop the belt with the remote or safety key now.');
    }
    this._emit();
  }

  /** True if a speed reading arrived recently enough to trust the belt state. */
  isFresh() { return this._fresh(); }

  // ---------- internals ----------
  _fresh() {
    if (this.tele.speedKmh == null) return false;
    // Strict (3 s) whenever the belt is, or may be, moving; relaxed (6 s) only when it is idle and nothing is pending.
    const idle = !this.pending && this.expect === 'stopped' && !this._beltActive();
    return this.clock.now() - this.tele.at <= (idle ? this.timing.idleStaleMs : this.timing.staleMs);
  }

  _isStopped() {
    return (this.tele.speedKmh ?? Infinity) <= STOPPED_KMH && (this.training === TRAINING.IDLE || this.training === TRAINING.POST);
  }

  /** True while locked out with the belt moving and the link up: the only state where Take control is allowed in a lockout. */
  get recovery() { return this.link && !!this.lock && this._beltActive(); }

  _beltActive() {
    return (this.tele.speedKmh ?? 0) > STOPPED_KMH || this.training === TRAINING.RUNNING || this.training === TRAINING.PRE;
  }

  _monitor() {
    // Already locked out: these checks would only add duplicate lockouts, and a duplicate would wrongly fail a
    // recovery Take control or Stop that is in progress. The existing lock already blocks everything else.
    if (this.lock) return;
    const { speedKmh: s, inclinePct: i } = this.tele;
    const cap = capKmh(this.limits);
    if (s != null && s > cap + 0.1) return this._lockout('OVERSPEED', `${s} km/h is above the test limit of ${cap} km/h. Stop the belt with the remote or safety key.`);
    if (i != null && i > this.limits.maxInclineLevel + 0.5) return this._lockout('INCLINE ABOVE LIMIT', `${i} % is above the test limit of ${this.limits.maxInclineLevel}.`);
    const moving = s != null && s > STOPPED_KMH;
    const startPending = this.pending?.cmd === 'start';
    const active = this.training === TRAINING.RUNNING || this.training === TRAINING.PRE;
    if (this.expect === 'stopped' && !startPending && (moving || active)) {
      return this._lockout(
        this.pending?.cmd === 'takeControl' ? 'MOTION AFTER TAKE CONTROL' : 'BELT ACTIVE UNEXPECTEDLY',
        'The belt is moving and this page did not start it. Use the remote or safety key, or press Take control and then Stop belt.',
      );
    }
    if (this.expect === 'running' && !startPending && !moving && (this.training === TRAINING.IDLE || this.training === TRAINING.POST)) {
      if (!this.pending) {
        this.expect = 'stopped';
        this._log('Belt stopped (remote, key or end of run).');
      } else if (this.pending.cmd !== 'stop') {
        return this._lockout('BELT STOPPED DURING A COMMAND', `${this.pending.cmd} was in progress.`);
      }
    }
  }

  _checkConfirm() {
    const p = this.pending;
    if (!p || !p.acked || this.tele.at <= p.sentAt) return;
    const { speedKmh: s, inclinePct: i } = this.tele;
    const minKmh = this.ranges?.speed?.minKmh ?? 0;
    if (p.cmd === 'start' && this.training === TRAINING.RUNNING && s >= minKmh - 0.05) {
      this.expect = 'running';
      this._log(`Start confirmed: belt running at ${s} km/h.`);
      this._settle(p, { ok: true });
    } else if (p.cmd === 'setSpeed' && Math.abs(s - p.meta.targetKmh) <= SPEED_TOL_KMH) {
      this._log(`Speed confirmed: ${s} km/h.`);
      this._settle(p, { ok: true });
    } else if (p.cmd === 'setIncline' && i != null && Math.abs(i - p.meta.targetPct) <= INCLINE_TOL_PCT) {
      this._log(`Incline confirmed: ${i} %.`);
      this._settle(p, { ok: true });
    } else if (p.cmd === 'stop' && s <= STOPPED_KMH && this.training !== TRAINING.RUNNING && this.training !== TRAINING.PRE) {
      this.expect = 'stopped';
      this._log('Stop confirmed: belt stopped.');
      this._settle(p, { ok: true });
    }
  }

  _armWatchdog() {
    if (this.watchdog != null) this.clock.clearTimeout(this.watchdog);
    const tick = () => {
      if ((this.pending || this.expect === 'running') && this.link && this.clock.now() - this.tele.at > this.timing.staleMs) {
        this._lockout('TELEMETRY LOST', 'No speed readings for 3 s while a command or the belt was active. Check the belt.');
      }
      if (this.link) this.watchdog = this.clock.setTimeout(tick, this.timing.watchdogMs);
    };
    this.watchdog = this.clock.setTimeout(tick, this.timing.watchdogMs);
  }

  _settle(p, result) {
    this.clock.clearTimeout(p.ackTimer);
    this.clock.clearTimeout(p.confirmTimer);
    if (this.pending === p) this.pending = null;
    p.resolve({ sent: true, ...result });
    this._emit();
  }

  _lockout(reason, detail = '') {
    if (!this.lock) this.lock = { reason, detail, at: this.clock.now() };
    else this._log(`(already locked) additional problem: ${reason}`);
    this._log(`LOCKOUT: ${reason}. ${detail}`);
    if (this.pending) {
      if (!this.pending.acked) this.abandoned.push(this.pending.op);
      this._settle(this.pending, { ok: false, reason, detail });
    }
    this._emit();
  }

  snapshot() {
    const buttons = {};
    for (const c of COMMANDS) buttons[c] = this.canSend(c);
    return { link: this.link, hasControl: this.hasControl, armed: this.armed, lock: this.lock, recovery: this.recovery, pending: this.pending && { cmd: this.pending.cmd, acked: this.pending.acked }, tele: { ...this.tele }, training: this.training, expect: this.expect, buttons };
  }

  /** Lets another module (the workout engine) watch state changes. Returns an unsubscribe function. */
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    const snap = this.snapshot();
    this.onChange(snap);
    for (const fn of [...this.listeners]) fn(snap);
  }
  _log(msg) { this.onLog(`${(this.clock.now() / 1000).toFixed(1)}s  ${msg}`); }
}

export { OP };
