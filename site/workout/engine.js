// Workout engine: runs an interval workout on top of the safety Controller. Headless (no DOM, no Bluetooth).
//
// Safety rules enforced here, in addition to the Controller's own:
//  * Every command goes through ONE serial queue. The engine only ever asks the Controller for its five verified
//    commands, and only ever for the CURRENT interval's targets (latest wins), so a missed boundary is never replayed.
//  * Targets are checked against the verified hardware limits BEFORE a workout can start. Nothing is clamped.
//  * Pause stops the belt and freezes the clock. Resume needs a tap, a countdown, a verified restart and a verified
//    treadmill state before any speed or incline is changed. Stop ends the workout for good (no resume).
//  * Any failure, disconnect, lockout, suspension or timer gap puts the engine in FAULTED. It never retries, never
//    resumes by itself and never restarts the belt. The remote or safety key stays the real emergency stop.
import { validateWorkout, checkAgainstLimits, totalSeconds } from './workout.js';
import { VERIFIED_LIMITS } from './limits.js?v=l2';

export const STATE = Object.freeze({
  IDLE: 'idle', // nothing loaded
  READY: 'ready', // loaded and checked against the limits
  STARTING: 'starting', // take control, start, verify (belt not yet running)
  RUNNING: 'running',
  PAUSING: 'pausing', // pause tapped: clock frozen, waiting for the belt to be confirmed stopped
  PAUSED: 'paused', // belt stopped, clock frozen, resumable
  RESUMING: 'resuming', // countdown, verified restart, verified state, restore targets
  STOPPING: 'stopping', // stop tapped: waiting for the belt to be confirmed stopped
  STOPPED: 'stopped', // TERMINAL: the user ended the workout; cannot be resumed
  COMPLETING: 'completing', // the last interval ended: stopping the belt
  COMPLETED: 'completed', // TERMINAL: finished
  FAULTED: 'faulted', // something went wrong; the belt may be moving; needs the user
});

export const DEFAULT_CONFIG = Object.freeze({ tickMs: 250, maxTickGapMs: 5000, resumeCountdownMs: 3000 });
const MPH_PER_KMH = 1 / 1.61; // how the treadmill reports its own speed (see KMH_PER_MPH_DISPLAY in control/protocol.js)
const STOPPED_KMH = 0.05;
const MIN_START_SPEED_SLACK_KMH = 0.2; // a fresh start must be at the treadmill's minimum speed, within this
const TRAINING = { IDLE: 0x01, RUNNING: 0x0d, POST: 0x0f };
const CANCELLED = Object.freeze({ ok: false, cancelled: true, sent: false });

export class WorkoutEngine {
  constructor({ controller, clock, limits = VERIFIED_LIMITS, config = {}, onChange = () => {}, onEvent = () => {} }) {
    if (limits.maxMph > controller.limits.maxMph + 1e-9 || limits.maxInclineLevel > controller.limits.maxInclineLevel) {
      throw new RangeError('workout limits are looser than the control layer limits; refusing to run');
    }
    Object.assign(this, { ctl: controller, clock, limits, onChange, onEvent });
    this.cfg = { ...DEFAULT_CONFIG, ...config };
    this.state = STATE.IDLE;
    this.workout = null;
    this.cum = [];
    this.epoch = 0;
    this.sleepers = new Set();
    this.tail = Promise.resolve();
    this.tickHandle = null;
    this.acc = 0; // workout milliseconds accumulated while the clock was running
    this.segStart = null; // clock.now() when the clock last started running
    this.lastTickAt = 0;
    this.idx = -1;
    this.desired = null;
    this.pumping = false;
    this.beltKnown = 'stopped'; // 'stopped' | 'running' | 'unknown', from confirmed commands only
    this.fault = null;
    this.notice = null;
    this.countdownEndsAt = null;
    this.events = [];
    this.stopPromise = null;
    this.override = null; // manual speed/incline change, valid until the next interval starts
    this.adjusting = false;
    controller.subscribe((snap) => this._onController(snap));
  }

  // ---------- loading ----------
  load(workout) {
    if (![STATE.IDLE, STATE.READY, STATE.STOPPED, STATE.COMPLETED].includes(this.state)) {
      return this._refuse(this.state === STATE.FAULTED ? 'resolve the fault first (confirm the belt is stopped)' : 'a workout is in progress');
    }
    const errors = validateWorkout(workout);
    if (errors.length) { this.state = STATE.IDLE; this.workout = null; this._emit(); return { ok: false, reason: 'invalid workout', errors }; }
    const violations = checkAgainstLimits(workout, this.limits);
    if (violations.length) {
      this.state = STATE.IDLE;
      this.workout = null;
      this._log(`Refused "${workout.name}": ${violations.length} target(s) exceed the verified hardware limits (${this.limits.maxMph} mph, incline ${this.limits.maxInclineLevel}).`);
      this._emit();
      return { ok: false, reason: 'exceeds verified hardware limits', violations };
    }
    this.workout = structuredClone(workout);
    let t = 0;
    this.cum = this.workout.intervals.map((i) => (t += i.durationSec * 1000));
    Object.assign(this, { acc: 0, segStart: null, idx: -1, desired: null, fault: null, notice: null, countdownEndsAt: null, stopPromise: null, override: null });
    this.state = STATE.READY;
    this._log(`Loaded "${workout.name}" (${totalSeconds(workout)} s).`);
    this._emit();
    return { ok: true };
  }

  // ---------- user actions ----------
  /** Start: take control if needed, start the belt, verify it, then run interval 1. */
  async begin() {
    if (this.state !== STATE.READY) return this._refuse(this.state === STATE.STOPPED || this.state === STATE.COMPLETED ? 'load the workout again to start a new run' : `cannot start from "${this.state}"`);
    const gate = this.ctl.canSend(this.ctl.hasControl ? 'start' : 'takeControl');
    if (!gate.ok) return this._refuse(gate.why);
    const e = this._newEpoch();
    this.state = STATE.STARTING;
    this._emit();
    if (!this.ctl.hasControl) {
      const r = await this._call(e, () => this.ctl.takeControl());
      if (e !== this.epoch) return CANCELLED;
      if (!r.ok) return this._failed('take control', r, STATE.READY);
    }
    const s = await this._startBelt(e);
    if (e !== this.epoch) return CANCELLED;
    if (!s.ok) return this._failed('start', s, STATE.READY, s.sent !== false);
    this.beltKnown = 'running';
    const v = this._verifyFreshStart();
    if (!v.ok) return this._fault('UNEXPECTED STATE AFTER START', v.why, 'running');
    this.idx = 0;
    this.acc = 0;
    this.desired = { ...this._target(0) };
    const a = await this._apply(e, this.desired);
    if (e !== this.epoch) return CANCELLED;
    if (!a.ok) return this._failed('apply first interval', a, null);
    this.desired = null;
    this._startClock();
    this.state = STATE.RUNNING;
    this._log('Workout running.');
    this._emit();
    return { ok: true };
  }

  /** Pause: freeze the clock at once and stop the belt. */
  async pause() {
    if (this.state !== STATE.RUNNING) return this._refuse(`cannot pause from "${this.state}"`);
    this._freezeClock();
    this.desired = null;
    this.state = STATE.PAUSING;
    const e = this._newEpoch(); // cancels any queued interval commands; an in-flight one finishes first
    this._log('Pause tapped: clock frozen, stopping the belt.');
    this._emit();
    const r = await this._call(e, () => this.ctl.stop());
    if (e !== this.epoch || this.state !== STATE.PAUSING) return CANCELLED;
    if (!r.ok) return this._fault('PAUSE FAILED', `the belt was not confirmed stopped (${r.reason ?? 'no detail'}). It may still be running.`, r.sent === false ? 'running' : 'unknown');
    this.beltKnown = 'stopped';
    this.state = STATE.PAUSED;
    this._log('Paused: belt stopped.');
    this._emit();
    return { ok: true };
  }

  /** Resume: explicit tap, countdown, verified restart, verified state, THEN restore the interval's speed and incline. */
  async resume() {
    if (this.state !== STATE.PAUSED) return this._refuse(this.state === STATE.STOPPED || this.state === STATE.COMPLETED ? 'this workout was stopped; load it and start a new run' : `cannot resume from "${this.state}"`);
    const pre = this.ctl.canSend('start'); // refuse up front if it could not work (e.g. disconnected), before any countdown
    if (!pre.ok) return this._refuse(pre.why);
    const e = this._newEpoch();
    this.state = STATE.RESUMING;
    this.countdownEndsAt = this.clock.now() + this.cfg.resumeCountdownMs;
    this._log(`Resume tapped: ${this.cfg.resumeCountdownMs / 1000} s countdown. Nothing is sent during the countdown.`);
    this._emit();
    await this._sleep(this.cfg.resumeCountdownMs);
    if (e !== this.epoch) return CANCELLED;
    this.countdownEndsAt = null;
    const gate = this.ctl.canSend('start');
    if (!gate.ok) {
      this.state = STATE.PAUSED;
      this._log(`Resume not sent: ${gate.why}`);
      this._emit();
      return { ok: false, reason: gate.why, sent: false };
    }
    const s = await this._startBelt(e);
    if (e !== this.epoch) return CANCELLED;
    if (!s.ok) return this._failed('restart', s, STATE.PAUSED, s.sent !== false);
    this.beltKnown = 'running';
    const v = this._verifyFreshStart(); // verify the treadmill BEFORE touching speed or incline
    if (!v.ok) return this._fault('UNEXPECTED STATE AFTER RESTART', v.why, 'running');
    const a = await this._apply(e, this._target(this.idx));
    if (e !== this.epoch) return CANCELLED;
    if (!a.ok) return this._failed('restore interval', a, null);
    this._startClock();
    this.state = STATE.RUNNING;
    this._log('Resumed.');
    this._emit();
    return { ok: true };
  }

  /**
   * Manual override: nudge speed (0.1 mph steps) and/or incline (levels) for the rest of the CURRENT interval.
   * The next interval, a pause or a fault drops it, and the plan takes over again. Same serial queue and limits as
   * everything else. A request that would break a limit, or that arrives while another change is in progress, is
   * REFUSED (nothing sent, no fault); only a real command failure faults the workout.
   */
  async adjust({ speedDeltaMph = 0, inclineDelta = 0 } = {}) {
    if (this.state !== STATE.RUNNING) return this._refuse(`cannot adjust from "${this.state}"`);
    if (this.pumping || this.adjusting || this.desired || this.ctl.hasPending()) return this._refuse('a change is already in progress');
    if (!Number.isInteger(inclineDelta) || Math.abs(Math.round(speedDeltaMph * 10) - speedDeltaMph * 10) > 1e-6) return this._refuse('speed changes are in 0.1 mph steps and incline in whole levels');
    const base = this.override ?? this._target(this.idx);
    const speedMph = (Math.round(base.speedMph * 10) + Math.round(speedDeltaMph * 10)) / 10;
    const inclineLevel = base.inclineLevel + inclineDelta;
    const minMph = Math.round((this.ctl.ranges?.speed?.minKmh ?? 0) * MPH_PER_KMH * 10) / 10;
    if (speedMph < minMph - 1e-9) return this._refuse('already at the minimum speed');
    if (speedMph > this.limits.maxMph + 1e-9) return this._refuse('already at the speed limit');
    if (inclineLevel < 0) return this._refuse('incline is already 0');
    if (inclineLevel > this.limits.maxInclineLevel) return this._refuse('already at the incline limit');
    if (speedMph === base.speedMph && inclineLevel === base.inclineLevel) return this._refuse('nothing to change');
    const e = this.epoch;
    const idx0 = this.idx;
    this.adjusting = true;
    this._emit();
    let applied = { ...base };
    let changed = false; // did at least one command actually go through?
    try {
      const steps = [];
      if (speedMph !== base.speedMph) steps.push([() => this.ctl.setSpeedMph(speedMph), { speedMph }]);
      if (inclineLevel !== base.inclineLevel) steps.push([() => this.ctl.setInclineLevel(inclineLevel), { inclineLevel }]);
      for (const [step, change] of steps) {
        const r = await this._call(e, step);
        if (r.cancelled || e !== this.epoch) return CANCELLED;
        if (!r.ok) {
          if (r.sent === false) { // nothing was sent: keep whatever was already applied, no fault
            if (changed && idx0 === this.idx) this.override = { ...applied };
            return { ok: false, reason: r.reason, sent: false };
          }
          return this._fault('MANUAL ADJUSTMENT FAILED', `${r.reason ?? 'command failed'}. Not retrying.`, 'running');
        }
        applied = { ...applied, ...change };
        changed = true;
      }
    } finally {
      this.adjusting = false;
    }
    if (idx0 !== this.idx) { // the next interval started while we were adjusting: the plan wins
      this._log('Manual override superseded: the next interval started.');
      this._emit();
      return { ok: true, superseded: true };
    }
    this.override = { speedMph: applied.speedMph, inclineLevel: applied.inclineLevel };
    this._log(`Manual override: ${this.override.speedMph} mph, incline ${this.override.inclineLevel} (until the next interval).`);
    this._emit();
    return { ok: true, override: { ...this.override } };
  }

  /** Stop: ends the workout. After this the workout cannot be resumed. Idempotent. */
  stop() {
    if (this.state === STATE.STOPPED || this.state === STATE.COMPLETED) return Promise.resolve({ ok: true, already: true });
    if (this.state === STATE.STOPPING || this.state === STATE.COMPLETING) return this.stopPromise ?? Promise.resolve({ ok: true });
    if (this.state === STATE.IDLE || this.state === STATE.READY) return Promise.resolve({ ok: true, nothingToStop: true });
    this.stopPromise = this._stop();
    return this.stopPromise;
  }

  /** After a fault: check, from the treadmill's own readings, that the belt is stopped, then close the workout. */
  acknowledgeFault() {
    if (this.state !== STATE.FAULTED) return this._refuse('there is no fault to acknowledge');
    const snap = this.ctl.snapshot();
    const stopped = snap.link && snap.tele.speedKmh != null && snap.tele.speedKmh <= STOPPED_KMH && (snap.training === TRAINING.IDLE || snap.training === TRAINING.POST) && this.ctl.isFresh();
    if (!stopped) return this._refuse('the belt is not confirmed stopped: use the remote, or reconnect and use Stop');
    this.beltKnown = 'stopped';
    this.state = STATE.STOPPED;
    this._log('Fault acknowledged: belt confirmed stopped. Workout closed.');
    this._emit();
    return { ok: true };
  }

  /**
   * After a fault with NO connection the belt cannot be checked. This closes the workout on the user's word that they
   * stopped the belt themselves (remote or safety key). Nothing is sent. When the app next connects, the controller
   * checks the belt from its own readings and locks out again if it is moving, so a wrong tap cannot start anything.
   */
  acknowledgeFaultByUser() {
    if (this.state !== STATE.FAULTED) return this._refuse('there is no fault to close');
    if (this.ctl.snapshot().link) return this._refuse('the treadmill is connected: use the normal check, which reads the belt');
    this.beltKnown = 'stopped';
    this.state = STATE.STOPPED;
    this._log('Fault closed on the user\'s word that the belt was stopped by hand (no connection to check). Nothing was sent.');
    this._emit();
    return { ok: true };
  }

  /**
   * Sends Start. From the moment it is sent the belt state is UNKNOWN until verified, so any failure or lockout that
   * interrupts it (even one raised before the command's own result arrives) reports the belt honestly. If the command
   * was never sent (a refusal), the previous belief is restored.
   */
  async _startBelt(e) {
    const prior = this.beltKnown;
    this.beltKnown = 'unknown';
    const r = await this._call(e, () => this.ctl.start());
    if (r.sent === false) this.beltKnown = prior;
    return r;
  }

  // ---------- internals: stop ----------
  async _stop() {
    const wasFaulted = this.state === STATE.FAULTED;
    this._freezeClock();
    this.desired = null;
    this.countdownEndsAt = null;
    const e = this._newEpoch(); // cancels the countdown and any queued interval commands
    if (this.beltKnown === 'stopped' && !wasFaulted) { // paused, or not yet started: nothing to stop, just end it
      this.state = STATE.STOPPED;
      this._log('Workout stopped (belt was already stopped).');
      this._emit();
      return { ok: true };
    }
    this.state = STATE.STOPPING;
    this._log('Stop tapped: ending the workout and stopping the belt.');
    this._emit();
    const r = await this._call(e, () => this.ctl.stop());
    if (e !== this.epoch || this.state !== STATE.STOPPING) return r.cancelled ? CANCELLED : r;
    if (!r.ok) return this._fault('STOP FAILED', `the belt was not confirmed stopped (${r.reason ?? 'no detail'}). Use the remote or safety key. Not retrying.`, 'unknown');
    this.beltKnown = 'stopped';
    this.state = STATE.STOPPED;
    this._log('Workout stopped.');
    this._emit();
    return { ok: true };
  }

  // ---------- internals: clock and intervals ----------
  _elapsedMs() { return this.acc + (this.segStart == null ? 0 : this.clock.now() - this.segStart); }
  _startClock() { this.segStart = this.clock.now(); this.lastTickAt = this.segStart; this._schedule(); }
  _freezeClock() { this.acc = this._elapsedMs(); this.segStart = null; this._stopTicking(); this.override = null; }
  _schedule() { this._stopTicking(); this.tickHandle = this.clock.setTimeout(() => this._tick(), this.cfg.tickMs); }
  _stopTicking() { if (this.tickHandle != null) this.clock.clearTimeout(this.tickHandle); this.tickHandle = null; }
  _target(i) { const iv = this.workout.intervals[i]; return { speedMph: iv.speedMph, inclineLevel: iv.inclineLevel }; }
  _indexAt(ms) { const i = this.cum.findIndex((end) => ms < end); return i === -1 ? this.cum.length - 1 : i; }

  _tick() {
    this.tickHandle = null;
    if (this.state !== STATE.RUNNING) return;
    const now = this.clock.now();
    const gap = now - this.lastTickAt;
    this.lastTickAt = now;
    if (gap > this.cfg.maxTickGapMs) {
      // The browser was probably suspended. Time passed but we cannot know what happened to the belt. Do NOT catch up.
      return this._fault('TIMER GAP', `The workout timer did not run for ${(gap / 1000).toFixed(1)} s (browser suspended?). Nothing was replayed.`, 'running');
    }
    const el = this._elapsedMs();
    if (el >= this.cum[this.cum.length - 1]) return void this._complete();
    const idx = this._indexAt(el);
    if (idx !== this.idx) {
      if (idx - this.idx > 1) this._log(`Boundaries missed (late timer): skipped intervals ${this.idx + 2} to ${idx}; only interval ${idx + 1} will be applied.`);
      this.idx = idx;
      if (this.override) { this._log('Manual override ended: the next interval started.'); this.override = null; }
      this.desired = { ...this._target(idx) }; // latest wins: earlier targets are dropped, never replayed
      this._log(`Interval ${idx + 1}: ${this.desired.speedMph} mph, incline ${this.desired.inclineLevel}.`);
      void this._pump();
    }
    this._emit();
    this._schedule();
  }

  /** Applies the latest desired target, one command at a time. Coalesces if the target changes meanwhile. */
  async _pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.state === STATE.RUNNING && this.desired) {
        const want = this.desired;
        const e = this.epoch;
        const r = await this._apply(e, want);
        if (r.cancelled || e !== this.epoch) return;
        if (!r.ok) return void this._fault('COULD NOT APPLY INTERVAL', `${r.reason ?? 'command failed'}. The belt is still at the previous interval's settings. Not retrying.`, 'running');
        if (this.desired === want) this.desired = null;
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Sends only what differs from the treadmill's own readings: speed first, then incline. */
  async _apply(e, want) {
    const snap = this.ctl.snapshot();
    const curMph = snap.tele.speedKmh == null ? NaN : Math.round(snap.tele.speedKmh * MPH_PER_KMH * 10) / 10;
    const curIncline = snap.tele.inclinePct == null ? NaN : Math.round(snap.tele.inclinePct);
    const steps = [];
    if (!(Math.abs(want.speedMph - curMph) < 0.05)) steps.push(() => this.ctl.setSpeedMph(want.speedMph));
    if (want.inclineLevel !== curIncline) steps.push(() => this.ctl.setInclineLevel(want.inclineLevel));
    for (const step of steps) {
      const r = await this._call(e, step);
      if (!r.ok) return r;
    }
    return { ok: true };
  }

  async _complete() {
    this._freezeClock();
    this.desired = null;
    this.state = STATE.COMPLETING;
    const e = this._newEpoch();
    this._log('Last interval finished: stopping the belt.');
    this._emit();
    const r = await this._call(e, () => this.ctl.stop());
    if (e !== this.epoch || this.state !== STATE.COMPLETING) return;
    if (!r.ok) return void this._fault('END-OF-WORKOUT STOP FAILED', `the belt was not confirmed stopped (${r.reason ?? 'no detail'}). Use the remote or safety key.`, r.sent === false ? 'running' : 'unknown');
    this.beltKnown = 'stopped';
    this.state = STATE.COMPLETED;
    this._log('Workout completed.');
    this._emit();
  }

  // ---------- internals: serial queue ----------
  _newEpoch() {
    this.epoch += 1;
    for (const s of this.sleepers) { this.clock.clearTimeout(s.h); s.res(); }
    this.sleepers.clear();
    return this.epoch;
  }

  _sleep(ms) {
    return new Promise((res) => { const s = { res, h: this.clock.setTimeout(() => { this.sleepers.delete(s); res(); }, ms) }; this.sleepers.add(s); });
  }

  /** Every controller command goes through here: strictly one at a time, and skipped if its flow was cancelled. */
  _call(e, fn) {
    const run = async () => {
      if (e !== this.epoch) return CANCELLED;
      try { return await fn(); } catch (err) { return { ok: false, sent: true, reason: err?.message ?? String(err) }; }
    };
    const p = this.tail.then(run);
    this.tail = p.then(() => {}, () => {});
    return p;
  }

  // ---------- internals: verification, faults, controller events ----------
  _verifyFreshStart() {
    const snap = this.ctl.snapshot();
    const min = this.ctl.ranges?.speed?.minKmh ?? 0;
    if (!snap.link) return { ok: false, why: 'connection lost' };
    if (snap.lock) return { ok: false, why: `controller locked out (${snap.lock.reason})` };
    if (!snap.hasControl) return { ok: false, why: 'control is not held' };
    if (snap.training !== TRAINING.RUNNING) return { ok: false, why: `treadmill status is not "running" (0x${(snap.training ?? 0).toString(16)})` };
    if (!this.ctl.isFresh()) return { ok: false, why: 'no fresh readings' };
    if (snap.tele.speedKmh > min + MIN_START_SPEED_SLACK_KMH) return { ok: false, why: `the belt restarted at ${snap.tele.speedKmh} km/h, not at its minimum (${min} km/h)` };
    return { ok: true };
  }

  _onController(snap) {
    const live = [STATE.STARTING, STATE.RUNNING, STATE.RESUMING].includes(this.state);
    if (live && (snap.lock || !snap.link)) {
      const why = !snap.link ? 'CONNECTION LOST' : `CONTROLLER LOCKOUT: ${snap.lock.reason}`;
      const known = this.state === STATE.RESUMING && this.countdownEndsAt != null ? 'stopped' : this.beltKnown;
      return void this._fault(why, snap.lock?.detail ?? 'Bluetooth was lost.', known);
    }
    if (this.state === STATE.PAUSED && (snap.lock || !snap.link)) {
      if (this.notice?.kind !== 'paused-link') { this.notice = { kind: 'paused-link', text: 'Paused, but the connection or controller needs attention. Reconnect and reset before resuming.' }; this._emit(); }
      return;
    }
    // The belt was stopped from the remote or key while running: treat as a pause, never as a reason to keep sending.
    if (this.state === STATE.RUNNING && !snap.pending && snap.tele.speedKmh != null && snap.tele.speedKmh <= STOPPED_KMH && (snap.training === TRAINING.IDLE || snap.training === TRAINING.POST) && this.ctl.isFresh()) {
      this._freezeClock();
      this.desired = null;
      this._newEpoch();
      this.beltKnown = 'stopped';
      this.state = STATE.PAUSED;
      this.notice = { kind: 'external-stop', text: 'The belt was stopped from the remote or key. Workout paused; tap Resume when ready.' };
      this._log(this.notice.text);
      this._emit();
    }
  }

  _fault(reason, detail, beltKnown) {
    if ([STATE.FAULTED, STATE.STOPPED, STATE.COMPLETED, STATE.IDLE].includes(this.state)) return { ok: false, reason };
    this._freezeClock();
    this.desired = null;
    this.countdownEndsAt = null;
    this._newEpoch();
    if (beltKnown) this.beltKnown = beltKnown;
    const t = this.workout && this.idx >= 0 ? this._target(this.idx) : null;
    const belt = this.beltKnown === 'running'
      ? `The belt may still be running${t ? ` at about ${t.speedMph} mph, incline ${t.inclineLevel}` : ''}. Use the remote or safety key, or reconnect and use Stop.`
      : this.beltKnown === 'stopped' ? 'The belt is stopped.' : 'The belt state is unknown. Use the remote or safety key.';
    this.fault = { reason, detail, belt, beltKnown: this.beltKnown, atMs: this.acc };
    this.state = STATE.FAULTED;
    this._log(`FAULT: ${reason}. ${detail} ${belt}`);
    this._emit();
    return { ok: false, reason, fault: true };
  }

  /** A controller command did not succeed. Refusals (nothing sent) revert; real failures are faults. */
  _failed(what, r, revertTo, beltMaybeMoved = false) {
    if (r.cancelled) return CANCELLED;
    if (r.sent === false && revertTo) {
      this.state = revertTo;
      this._log(`${what} not sent: ${r.reason}`);
      this._emit();
      return { ok: false, reason: r.reason, sent: false };
    }
    return this._fault(`${what.toUpperCase()} FAILED`, `${r.reason ?? 'no detail'}. Not retrying.`, beltMaybeMoved || what === 'start' || what === 'restart' ? 'unknown' : undefined);
  }

  _refuse(reason) { this._log(`Refused: ${reason}`); return { ok: false, reason, sent: false }; }
  _log(msg) { const line = `${(this.clock.now() / 1000).toFixed(1)}s  ${msg}`; this.events.push(line); this.onEvent(line); }
  _emit() { this.onChange(this.snapshot()); }

  snapshot() {
    const total = this.workout ? this.cum[this.cum.length - 1] : 0;
    const el = this.workout ? Math.min(this._elapsedMs(), total) : 0;
    const i = this.workout && this.idx >= 0 ? this.idx : null;
    return {
      state: this.state, name: this.workout?.name ?? null, elapsedMs: el, totalMs: total, remainingMs: total - el,
      intervalIndex: i, interval: i == null ? null : this.workout.intervals[i], next: i == null ? null : this.workout.intervals[i + 1] ?? null,
      beltKnown: this.beltKnown, countdownEndsAt: this.countdownEndsAt, fault: this.fault, notice: this.notice,
      override: this.override ? { ...this.override } : null,
      busy: this.pumping || this.adjusting || !!this.desired || !!this.ctl.hasPending(),
    };
  }
}
