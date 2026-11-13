// Settings: device details, what has actually been verified on the treadmill, diagnostics, and your data.
import { h, setText, clear } from '../dom.js?v=a1';
import { connectionCard, twoStep, reportCard } from '../components.js?v=a4';
import { kmhToMph } from '../../control/protocol.js?v=c8';

// Only things that were observed on the real treadmill, plus a plain list of what has NOT been tested.
const VERIFIED = [
  'Speed from 0.6 mph (the minimum) up to 2.8 mph in 0.1 mph steps. Incline from 0 up to level 8.',
  'Starting: about a 3-second countdown, then the belt runs at its minimum speed. A restart after a stop also begins at the minimum.',
  'Speed and incline changes are acknowledged in about 0.1 second and show in the readings within about a second.',
  'Stopping: the belt slows over about 2 to 9 seconds (longer from higher speeds) and the incline returns to 0.',
  'Full 20-minute workouts: every interval change lands within about a second of the plan, and the belt stops at the end.',
  'If Bluetooth drops (turned off, or out of range), or the phone is locked or the page left during a run, the app stops sending, freezes the clock and shows a fault within about a second. The belt keeps running at its last speed: stop it with the remote, then close the fault on the screen.',
  'A phone lock of a minute or more does not drop the Bluetooth link; readings pause while locked and resume on unlock.',
  'The remote\'s Stop key during a run pauses the workout; Resume restarts it. Speed or incline changed from the remote is put back to the plan at the next interval change (it is not noticed before then).',
];
const NOT_TESTED = [
  'Any run with a person on the belt: every test so far had an empty belt.',
  'Pulling the treadmill\'s safety key during a run.',
  'Runs longer than 20 minutes.',
];

export function settingsView(ctx, build) {
  const conn = connectionCard(ctx);
  const details = h('div', { class: 'workout-meta' });
  const quarantineEl = h('div');
  const exportBox = h('textarea', { readonly: true, placeholder: 'Your workouts as JSON appear here.', 'aria-label': 'Export' });
  const importBox = h('textarea', { placeholder: 'Paste exported workouts here, or choose a file.', 'aria-label': 'Import' });
  const dataMsg = h('div', { class: 'why' });
  const logEl = h('div', { class: 'log' });
  const report = reportCard(ctx);

  const status = () => {
    const s = ctx.ctl.snapshot();
    const r = ctx.session.ranges;
    return [
      s.link ? `Connected to ${ctx.session.deviceName ?? 'the treadmill'}.` : 'Not connected.',
      r ? `Treadmill reports speed ${r.speed.minKmh}–${r.speed.maxKmh} km/h (${kmhToMph(r.speed.minKmh).toFixed(1)}–${kmhToMph(r.speed.maxKmh).toFixed(1)} mph) and incline ${r.incline.minPct}–${r.incline.maxPct} %.` : '',
      Number.isFinite(s.tele.at) ? `Last speed reading ${((ctx.clock.now() - s.tele.at) / 1000).toFixed(1)} s ago.` : 'No readings yet.',
      `Verified limits used by the app: ${ctx.limits.maxMph} mph, incline ${ctx.limits.maxInclineLevel}.`,
      `Workouts are stored ${ctx.library.persistent ? 'in this browser' : 'only until you close this page (storage is unavailable): export a backup'}.`,
      ctx.wake.describe(),
      `Build ${build}.`,
    ].filter(Boolean).join('\n');
  };

  function rebuildQuarantine() {
    clear(quarantineEl);
    if (!ctx.library.quarantine.length) return;
    quarantineEl.append(h('h2', {}, 'Set aside (failed the checks, never run)'));
    ctx.library.quarantine.forEach((q, i) => quarantineEl.append(h('div', { class: 'card inner' }, h('b', {}, q.name || '(no name)'), h('div', { class: 'why err' }, q.problem ?? ''), h('button', { class: 'small', onclick: () => { ctx.library.removeQuarantined(i); rebuildQuarantine(); } }, 'Remove'))));
  }

  const copy = async () => {
    try { await navigator.clipboard.writeText(exportBox.value); setText(dataMsg, 'Copied.'); } catch { exportBox.select(); setText(dataMsg, 'Copying is blocked: long-press the box, choose Select All, then Copy.'); }
  };
  const download = () => {
    const blob = new Blob([exportBox.value], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'treadmill-workouts.json' });
    document.body.append(a);
    a.click();
    a.remove();
  };
  const doImport = () => {
    const r = ctx.library.importJson(importBox.value);
    if (!r.ok) return void setText(dataMsg, `Not imported: ${r.reason}.`);
    const lines = [`Imported ${r.added} workout${r.added === 1 ? '' : 's'}.`, ...r.rejected.map((x) => `Refused #${x.index} "${x.name}": ${x.reason}`)];
    setText(dataMsg, lines.join('\n'));
    dataMsg.style.whiteSpace = 'pre-line';
  };
  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', onchange: (e) => { const f = e.target.files?.[0]; if (f) f.text().then((t) => { importBox.value = t; }); } });

  const restore = twoStep(ctx, { label: 'Restore the five presets', armedLabel: 'TAP AGAIN to restore', warning: 'Edited presets go back to their original values and deleted ones come back. Your other workouts are not touched. Tap again to restore, or wait to cancel.', onConfirm: () => setText(dataMsg, `Restored ${ctx.library.restorePresets().restored} presets.`) });
  const reset = twoStep(ctx, { label: 'Delete everything and start over', armedLabel: 'TAP AGAIN to delete everything', cls: 'danger', warning: 'ALL your workouts will be deleted and only the five presets kept. Export a backup first. Tap again to delete, or wait to cancel.', onConfirm: () => { ctx.library.resetAll(); rebuildQuarantine(); setText(dataMsg, 'Everything was deleted; the five presets are back.'); } });

  const el = h('div', {},
    conn.el,
    h('section', { class: 'card' }, h('h2', {}, 'Device and diagnostics'), details),
    h('section', { class: 'card' }, h('h2', {}, 'Verified on this treadmill'), h('ul', {}, VERIFIED.map((t) => h('li', {}, t))), h('h2', { style: 'margin-top:12px' }, 'Not tested yet'), h('ul', {}, NOT_TESTED.map((t) => h('li', {}, t)))),
    h('section', { class: 'card' }, h('h2', {}, 'Your data'),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => { exportBox.value = ctx.library.exportJson(); setText(dataMsg, ''); } }, 'Export all workouts'), h('button', { onclick: copy }, 'Copy'), h('button', { onclick: download }, 'Download file')),
      exportBox, h('div', { style: 'height:12px' }), importBox,
      h('div', { class: 'row' }, fileInput, h('button', { class: 'primary', onclick: doImport }, 'Import')),
      dataMsg, h('div', { class: 'row' }, restore.el), h('div', { class: 'row' }, reset.el)),
    quarantineEl,
    h('section', { class: 'card' }, h('h2', {}, 'Recent activity'),
      report.el, logEl),
    h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/' }, '← Back to workouts')));
  rebuildQuarantine();

  return {
    el,
    update() {
      conn.update();
      details.style.whiteSpace = 'pre-line';
      setText(details, status());
      const text = ctx.events.slice(-80).reverse().join('\n');
      if (logEl.textContent !== text) logEl.textContent = text;
    },
  };
}
