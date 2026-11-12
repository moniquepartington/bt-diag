// Turns the engine and controller snapshots into exactly what the workout screen shows: clocks, progress, the banner,
// and which buttons are enabled (with the reason when one is not). Pure functions, so the safety-relevant UI decisions
// are tested without a browser.
import { STATE } from '../workout/engine.js?v=v4';
import { formatCountdown, formatElapsed, describeInterval, mphText } from './format.js?v=a1';

export const SAFETY_REMINDER = 'Keep the treadmill\'s remote or safety key within reach. The on-screen Stop is not an emergency stop.';

const ACTIVE = [STATE.STARTING, STATE.RUNNING, STATE.PAUSING, STATE.PAUSED, STATE.RESUMING, STATE.STOPPING, STATE.COMPLETING];
export const isActive = (state) => ACTIVE.includes(state);

const STATE_LABEL = {
  [STATE.IDLE]: 'No workout loaded', [STATE.READY]: 'Ready', [STATE.STARTING]: 'Starting', [STATE.RUNNING]: 'Running',
  [STATE.PAUSING]: 'Pausing', [STATE.PAUSED]: 'Paused', [STATE.RESUMING]: 'Resuming', [STATE.STOPPING]: 'Stopping',
  [STATE.STOPPED]: 'Stopped', [STATE.COMPLETING]: 'Finishing', [STATE.COMPLETED]: 'Complete', [STATE.FAULTED]: 'FAULT',
};

const yes = () => ({ enabled: true, why: '' });
const no = (why) => ({ enabled: false, why });

/**
 * @param eng   engine.snapshot()
 * @param ctl   controller.snapshot()
 * @param ctx   { checklistOk, nowMs } from the page
 */
export function runView(eng, ctl, { checklistOk = false, nowMs = 0 } = {}) {
  const st = eng.state;
  const gateStart = ctl.hasControl ? ctl.buttons.start : ctl.buttons.takeControl;

  const start = st !== STATE.READY ? no(st === STATE.STOPPED || st === STATE.COMPLETED ? 'this run is over: open the workout again to start a new one' : 'no workout is ready')
    : !ctl.link ? no('connect to the treadmill first')
    : !checklistOk ? no('tick the three safety boxes first')
    : ctl.lock ? no(`locked out (${ctl.lock.reason}): reset first`)
    : !gateStart.ok ? no(gateStart.why)
    : yes();

  const resume = st !== STATE.PAUSED ? no('not paused')
    : !ctl.link ? no('reconnect to the treadmill first')
    : ctl.lock ? no(`locked out (${ctl.lock.reason}): reset first`)
    : !ctl.buttons.start.ok ? no(ctl.buttons.start.why)
    : yes();

  const running = st === STATE.RUNNING;
  const adjustWhy = !running ? 'only while the workout is running' : eng.busy ? 'wait for the current change to finish' : null;
  const adjust = adjustWhy ? no(adjustWhy) : yes();

  // The lockout may be reset only when the belt is CONFIRMED stopped (from the readings, so the connection must be
  // back): resetting it while the belt may still be moving would hide the recovery controls.
  const beltActive = (ctl.tele?.speedKmh ?? 0) > 0.05 || ctl.training === 0x0d || ctl.training === 0x0e;
  const resetLock = !ctl.lock ? no('no lockout')
    : ctl.pending ? no('a command is in progress')
    : !ctl.link ? no('reconnect first, so the belt can be checked')
    : beltActive ? no('the belt is still moving: stop it first')
    : yes();

  const banner = bannerFor(eng, ctl, nowMs);
  return {
    state: st,
    stateLabel: STATE_LABEL[st] ?? st,
    name: eng.name,
    remainingText: formatCountdown(eng.remainingMs),
    elapsedText: formatElapsed(eng.elapsedMs),
    totalText: formatElapsed(eng.totalMs),
    progressPct: eng.totalMs > 0 ? Math.min(100, Math.round((eng.elapsedMs / eng.totalMs) * 1000) / 10) : 0,
    intervalText: eng.interval ? `${eng.intervalIndex + 1}. ${describeInterval(eng.interval)}` : '—',
    targetText: eng.interval ? `${mphText((eng.override ?? eng.interval).speedMph)} · incline ${(eng.override ?? eng.interval).inclineLevel}` : '—',
    nextText: eng.next ? describeInterval(eng.next) : eng.interval ? 'Last interval' : '—',
    overrideText: eng.override ? `Manual override until the next interval: ${mphText(eng.override.speedMph)}, incline ${eng.override.inclineLevel}` : '',
    banner,
    beltMayBeRunning: st === STATE.FAULTED && eng.fault?.beltKnown !== 'stopped',
    buttons: {
      start, resume, adjust,
      pause: running ? yes() : no('not running'),
      stop: [STATE.STARTING, STATE.RUNNING, STATE.PAUSING, STATE.PAUSED, STATE.RESUMING, STATE.FAULTED].includes(st) ? yes() : no('nothing to stop'),
      acknowledgeFault: st === STATE.FAULTED ? yes() : no('no fault'),
      resetLock,
      speedUp: adjust, speedDown: adjust, inclineUp: adjust, inclineDown: adjust,
      takeControl: ctl.recovery ? (ctl.buttons.takeControl.ok ? yes() : no(ctl.buttons.takeControl.why)) : no('only needed after a problem with the belt moving'),
      recoveryStop: ctl.recovery ? (ctl.buttons.stop.ok ? yes() : no(ctl.buttons.stop.why)) : no('only needed after a problem with the belt moving'),
    },
    recovery: !!ctl.recovery,
  };
}

function bannerFor(eng, ctl, nowMs) {
  const st = eng.state;
  if (st === STATE.FAULTED && eng.fault) {
    return { level: 'danger', title: `FAULT: ${eng.fault.reason}`, text: `${eng.fault.detail} ${eng.fault.belt}` };
  }
  if (ctl.lock) {
    return { level: 'danger', title: `LOCKED OUT: ${ctl.lock.reason}`, text: ctl.lock.detail };
  }
  if (st === STATE.RESUMING && eng.countdownEndsAt != null) {
    const left = Math.max(0, Math.ceil((eng.countdownEndsAt - nowMs) / 1000));
    return { level: 'info', title: `Resuming in ${left}…`, text: 'Nothing happens during the countdown. The belt then starts slowly and returns to this interval\'s settings.' };
  }
  if (st === STATE.PAUSED) return { level: 'warn', title: 'Paused', text: eng.notice?.text ?? 'The belt is stopped and the clock is frozen. Resume needs a tap.' };
  if (st === STATE.COMPLETED) return { level: 'ok', title: 'Workout complete', text: 'The belt has stopped.' };
  if (st === STATE.STOPPED) return { level: 'info', title: 'Workout stopped', text: 'This run is over and cannot be resumed.' };
  if (st === STATE.RUNNING && eng.override) return { level: 'info', title: 'Manual override active', text: 'The plan takes over again at the next interval.' };
  return null;
}
