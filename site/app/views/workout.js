// The workout screen. Everything shown here comes from runView() (workout-vm.js), which is tested without a browser.
import { h, setText, setDisabled } from '../dom.js?v=a1';
import { connectionCard, checklistCard, twoStep, banner, reportCard } from '../components.js?v=a4';
import { runView, isActive, closeFaultByHand } from '../workout-vm.js?v=a4';
import { STATE } from '../../workout/engine.js?v=v5';

const LOADABLE = [STATE.IDLE, STATE.READY, STATE.STOPPED, STATE.COMPLETED];

export function workoutView(ctx, id) {
  const w = ctx.library.get(id);
  if (!w) return { el: h('div', { class: 'card' }, 'That workout no longer exists. ', h('a', { href: '#/' }, 'Back to the list')), update() {} };
  const eng = ctx.engine;
  let loadProblem = null;
  if (LOADABLE.includes(eng.state)) {
    const r = eng.load(w);
    ctx.state.runId = id;
    ctx.state.adjustMsg = '';
    if (!r.ok) loadProblem = `This workout cannot run: ${r.reason}${r.violations ? ` (${r.violations.length} target(s) above the verified limits)` : ''}.`;
  }

  const conn = connectionCard(ctx);
  const check = checklistCard(ctx);
  const preflight = h('div');
  preflight.append(conn.el, check.el);
  const pre = banner();

  // ---- live display ----
  const stateEl = h('span', { class: 'pill' });
  const clockEl = h('div', { class: 'big-clock' }, '0:00');
  const subEl = h('div', { class: 'sub' });
  const barFill = h('div', { style: 'width:0%' });
  const intervalEl = h('div');
  const targetEl = h('div');
  const nextEl = h('div');
  const overrideEl = h('div', { class: 'why' });
  const connEl = h('span', { class: 'pill' });
  const wakeEl = h('div', { class: 'why' });
  const live = h('section', { class: 'card' },
    h('div', { class: 'row tight' }, h('h3', { class: 'grow', style: 'margin:0' }, w.name), stateEl),
    clockEl, subEl, h('div', { class: 'bar' }, barFill),
    h('div', { class: 'kv' },
      h('div', { class: 'cell', style: 'grid-column:span 2' }, h('small', {}, 'Now'), intervalEl),
      h('div', { class: 'cell' }, h('small', {}, 'Target'), targetEl),
      h('div', { class: 'cell' }, h('small', {}, 'Next'), nextEl)),
    overrideEl, h('div', { class: 'row tight' }, connEl), wakeEl);

  const bannerComp = banner();

  // ---- start ----
  const startWhy = h('div', { class: 'why' });
  const start = twoStep(ctx, {
    label: 'Start workout', armedLabel: 'TAP AGAIN to start the workout', cls: 'primary',
    warning: 'The belt will start (about a 3-second countdown) and then change speed and incline on its own. Belt empty, and you are beside it with the remote or safety key in reach? Tap again to start, or wait to cancel.',
    onConfirm: () => ctx.startWorkout(),
  });
  const startPanel = h('section', { class: 'card' }, h('h2', {}, 'Start'), start.el, startWhy);

  // ---- controls ----
  const pauseBtn = h('button', { class: 'grow', onclick: () => ctx.act('Pause', eng.pause()) }, 'Pause');
  const resumeBtn = h('button', { class: 'primary grow', onclick: () => ctx.act('Resume', eng.resume()) }, 'Resume');
  const stopBtn = h('button', { class: 'danger', onclick: () => ctx.act('Stop', eng.stop()) }, 'Stop workout');
  const stopWhy = h('div', { class: 'why' }, 'Stop ends this run for good; it cannot be resumed. Pause stops the belt and lets you resume.');
  const controls = h('section', { class: 'card' }, h('h2', {}, 'Controls'), h('div', { class: 'row' }, pauseBtn, resumeBtn), h('div', { class: 'row' }, stopBtn), stopWhy);

  // ---- manual override ----
  const adjustMsg = h('div', { class: 'why' });
  const mk = (label, change) => h('button', { class: 'small', onclick: () => ctx.adjust(change), 'aria-label': label }, label.includes('+') ? '+' : '−');
  const speedDown = mk('Speed −', { speedDeltaMph: -0.1 });
  const speedUp = mk('Speed +', { speedDeltaMph: 0.1 });
  const inclineDown = mk('Incline −', { inclineDelta: -1 });
  const inclineUp = mk('Incline +', { inclineDelta: 1 });
  const adjustPanel = h('section', { class: 'card' }, h('h2', {}, 'Manual change (until the next interval)'),
    h('div', { class: 'adjust' }, h('span', {}, 'Speed, 0.1 mph steps'), speedDown, speedUp),
    h('div', { class: 'adjust' }, h('span', {}, 'Incline, 1 level steps'), inclineDown, inclineUp), adjustMsg);

  // ---- problems ----
  const takeControlBtn = h('button', { class: 'primary', onclick: () => ctx.act('Take control', ctx.ctl.takeControl()) }, '1. Take control');
  const recStopBtn = h('button', { class: 'danger', onclick: () => ctx.act('Stop belt', ctx.ctl.stop()) }, '2. Stop belt');
  const recovery = h('section', { class: 'card' }, h('h2', {}, 'The belt may still be moving'),
    h('div', { class: 'why' }, 'The remote or safety key is the fastest way to stop it. From here: take control, then stop the belt. Nothing runs by itself.'),
    h('div', { class: 'row' }, takeControlBtn, recStopBtn));
  const ackBtn = h('button', { onclick: () => { const r = eng.acknowledgeFault(); ctx.state.faultMsg = r.ok ? '' : `Not closed: ${r.reason}`; ctx.requestRender(); } }, 'The belt is stopped: close this fault');
  const resetBtn = h('button', { onclick: () => { const r = ctx.ctl.resetLock(); ctx.state.faultMsg = r.ok ? '' : `Not reset: ${r.reason}`; ctx.requestRender(); } }, 'Reset the lockout');
  const faultMsg = h('div', { class: 'why err' });
  const resetWhy = h('div', { class: 'why' });
  // No connection means the app cannot see the belt. The user can say they stopped it by hand (remote or safety key).
  const byHand = twoStep(ctx, {
    label: 'I stopped the belt by hand: close this', armedLabel: 'TAP AGAIN: the belt is stopped', cls: 'danger',
    warning: 'Only tap this if the belt has actually stopped. The app cannot see the belt without a connection, and this sends nothing. When you reconnect, the app checks the belt and locks out again if it is still moving. Tap again to close, or wait to cancel.',
    onConfirm: () => { const r = closeFaultByHand(ctx.engine, ctx.ctl); ctx.log(r.ok ? 'Fault and lockout closed by the user (belt stopped by hand).' : `Not closed: ${r.reason}`); ctx.state.faultMsg = r.ok ? '' : `Not closed: ${r.reason}`; ctx.requestRender(); },
  });
  const byHandWhy = h('div', { class: 'why' }, 'Not connected: the belt cannot be checked from here. Stop it with the remote or safety key, then use this button. Or reconnect (Scan & connect) to stop it from here.');
  const handBlock = h('div', {}, byHandWhy, byHand.el);
  const faultPanel = h('section', { class: 'card' }, h('h2', {}, 'After a problem'),
    h('div', { class: 'why' }, 'When the belt has stopped, close the fault, then reset the lockout. A new run needs a fresh start.'),
    h('div', { class: 'row' }, ackBtn, resetBtn), resetWhy, handBlock, faultMsg);
  const diagnostics = h('section', { class: 'card' }, h('h2', {}, 'Activity report'), reportCard(ctx).el,
    h('div', { class: 'why' }, 'The activity log is also saved on this phone, so a page reload does not lose it.'));
  const backRow = h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/' }, '← Back to workouts'));

  const el = h('div', {}, bannerComp.el, pre.el, preflight, live, startPanel, controls, adjustPanel, recovery, faultPanel, diagnostics, backRow);
  if (loadProblem) { pre.set({ level: 'danger', title: 'Cannot start', text: loadProblem }); }

  return {
    el,
    update() {
      const snap = eng.snapshot();
      const ctlSnap = ctx.ctl.snapshot();
      const v = runView(snap, ctlSnap, { checklistOk: ctx.checklistOk(), nowMs: ctx.clock.now() });
      const st = v.state;
      const active = isActive(st);
      const faulted = st === STATE.FAULTED;

      conn.update();
      check.update();
      preflight.hidden = active;
      setText(stateEl, v.stateLabel);
      stateEl.className = `pill ${faulted ? 'err' : st === STATE.RUNNING ? 'ok' : st === STATE.PAUSED || st === STATE.RESUMING ? 'warn' : ''}`;
      setText(clockEl, v.remainingText);
      setText(subEl, `${v.elapsedText} of ${v.totalText}`);
      barFill.style.width = `${v.progressPct}%`;
      setText(intervalEl, v.intervalText);
      setText(targetEl, v.targetText);
      setText(nextEl, v.nextText);
      setText(overrideEl, v.overrideText);
      setText(connEl, ctlSnap.link ? (ctlSnap.hasControl ? 'Connected, control held' : 'Connected') : 'Not connected');
      connEl.className = `pill ${ctlSnap.link ? 'ok' : 'err'}`;
      setText(wakeEl, ctx.wake.describe());
      bannerComp.set(v.banner);

      startPanel.hidden = st !== STATE.READY;
      setDisabled(start.btn, v.buttons.start.why, v.buttons.start.enabled);
      if (!v.buttons.start.enabled) start.step.cancel();
      setText(startWhy, v.buttons.start.enabled ? '' : v.buttons.start.why);

      controls.hidden = !(active || faulted);
      setDisabled(pauseBtn, v.buttons.pause.why, v.buttons.pause.enabled);
      setDisabled(resumeBtn, v.buttons.resume.why, v.buttons.resume.enabled);
      pauseBtn.hidden = st === STATE.PAUSED || st === STATE.RESUMING;
      resumeBtn.hidden = !(st === STATE.PAUSED || st === STATE.RESUMING);
      setDisabled(stopBtn, v.buttons.stop.why, v.buttons.stop.enabled);

      adjustPanel.hidden = !(st === STATE.RUNNING || st === STATE.PAUSED || st === STATE.RESUMING);
      for (const b of [speedDown, speedUp, inclineDown, inclineUp]) setDisabled(b, v.buttons.speedUp.why, v.buttons.speedUp.enabled);
      setText(adjustMsg, ctx.state.adjustMsg ?? '');

      recovery.hidden = !v.recovery;
      setDisabled(takeControlBtn, v.buttons.takeControl.why, v.buttons.takeControl.enabled);
      setDisabled(recStopBtn, v.buttons.recoveryStop.why, v.buttons.recoveryStop.enabled);

      faultPanel.hidden = !(faulted || (ctlSnap.lock && !active));
      ackBtn.hidden = !faulted;
      setDisabled(resetBtn, v.buttons.resetLock.why, v.buttons.resetLock.enabled);
      setText(resetWhy, v.buttons.resetLock.enabled ? '' : v.buttons.resetLock.why);
      handBlock.hidden = !v.buttons.closeByHand.enabled;
      if (handBlock.hidden) byHand.step.cancel();
      setText(faultMsg, ctx.state.faultMsg ?? '');

      backRow.hidden = active || faulted;
    },
  };
}
