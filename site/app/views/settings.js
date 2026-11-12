// Settings: device details, what has actually been verified on the treadmill, diagnostics, and your data.
import { h, setText, clear } from '../dom.js?v=a1';
import { connectionCard, twoStep } from '../components.js?v=a1';
import { kmhToMph } from '../../control/protocol.js?v=c8';

// Only things that were observed on the real treadmill, plus a plain list of what has NOT been tested.
const VERIFIED = [
  'Speed from 0.6 mph (the minimum) up to 2.8 mph in 0.1 mph steps. Incline from 0 up to level 8.',
  'Starting: about a 3-second countdown, then the belt runs at its minimum speed. A restart after a stop also begins at the minimum.',
  'Speed and incline changes are acknowledged in about 0.1 second and show in the readings within about a second.',
  'Stopping: the belt slows over about 2 to 9 seconds (longer from higher speeds) and the incline returns to 0.',
  'If Bluetooth drops, the belt keeps running at its last speed and incline until someone stops it. After reconnecting, the app must take control again before it can stop the belt.',
];
const NOT_TESTED = [
  'What a locked or backgrounded phone does to a workout.',
  'A full 20-minute run on the treadmill, and losing the connection by walking out of range.',
  'Speed or incline changed from the treadmill\'s own remote during a workout (the app does not detect it).',
];

export function settingsView(ctx, build) {
  const conn = connectionCard(ctx);
  const details = h('div', { class: 'workout-meta' });
  const quarantineEl = h('div');
  const exportBox = h('textarea', { readonly: true, placeholder: 'Your workouts as JSON appear here.', 'aria-label': 'Export' });
  const importBox = h('textarea', { placeholder: 'Paste exported workouts here, or choose a file.', 'aria-label': 'Import' });
  const dataMsg = h('div', { class: 'why' });
  const logEl = h('div', { class: 'log' });

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
    h('section', { class: 'card' }, h('h2', {}, 'Recent activity'), logEl),
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
