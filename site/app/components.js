// Reusable pieces shared by the screens. Each returns { el, update } where update() re-reads the live state.
import { h, setText, setDisabled } from './dom.js?v=a1';
import { wireTwoStep } from '../control/confirm.js?v=c8';
import { SAFETY_REMINDER } from './workout-vm.js?v=a4';

export const safetyStrip = () => h('div', { class: 'strip' }, SAFETY_REMINDER);

/** A button that needs a second tap. The warning is shown under it while it is armed; it never blocks the page. */
export function twoStep(ctx, { label, armedLabel, warning, onConfirm, cls = '' }) {
  const warn = h('div', { class: 'why warn' });
  const btn = h('button', { class: cls }, label);
  const step = wireTwoStep(btn, warn, { clock: ctx.clock, label, armedLabel, warning, onConfirm });
  return { el: h('div', {}, btn, warn), btn, step };
}

export function banner() {
  const title = h('b');
  const text = h('div');
  const el = h('div', { class: 'banner info', hidden: true }, title, text);
  return {
    el,
    set(b) {
      el.hidden = !b;
      if (!b) return;
      el.className = `banner ${b.level}`;
      setText(title, b.title);
      setText(text, b.text);
    },
  };
}

/** Connection status plus Scan & connect / Disconnect. */
export function connectionCard(ctx) {
  const pill = h('span', { class: 'pill' }, 'Not connected');
  const name = h('span', { class: 'workout-meta' });
  const msg = h('div', { class: 'why' });
  const connect = h('button', { class: 'primary', onclick: () => ctx.connect() }, 'Scan & connect');
  const disconnect = h('button', { onclick: () => ctx.session.disconnect() }, 'Disconnect');
  const el = h('section', { class: 'card' }, h('h2', {}, 'Treadmill connection'), h('div', {}, pill, ' ', name), h('div', { class: 'row' }, connect, disconnect), msg);
  return {
    el,
    update() {
      const s = ctx.ctl.snapshot();
      pill.className = `pill ${s.link ? 'ok' : ''}`;
      setText(pill, s.link ? (s.hasControl ? 'Connected, control held' : 'Connected') : 'Not connected');
      setText(name, s.link && ctx.session.deviceName ? ctx.session.deviceName : '');
      const avail = ctx.session.availability();
      connect.disabled = s.link || !avail.ok || ctx.state.connecting;
      disconnect.disabled = !s.link;
      setText(msg, !avail.ok ? avail.reason : ctx.state.connecting ? 'Choose your treadmill (FS-…) in the list that appears…' : ctx.state.connectMessage);
    },
  };
}

/** The three safety boxes. Nothing can start until all are ticked. They are never remembered between visits. */
export function checklistCard(ctx) {
  const labels = ['The belt is empty and I am ready to step on safely.', 'I am within reach of the remote or safety key.', 'FitShow and Kinni are fully closed.'];
  const boxes = labels.map((text, i) => h('input', { type: 'checkbox', onchange: (e) => ctx.setChecklist(i, e.target.checked) }));
  const el = h('section', { class: 'card' }, h('h2', {}, 'Safety checklist'), ...labels.map((text, i) => h('label', { class: 'chk' }, boxes[i], text)));
  return { el, update() { boxes.forEach((b, i) => { if (b.checked !== ctx.state.checklist[i]) b.checked = ctx.state.checklist[i]; }); } };
}

/** "Copy activity report": the diagnostic report (including earlier page loads saved on this phone). */
export function reportCard(ctx) {
  const box = h('textarea', { readonly: true, hidden: true, 'aria-label': 'Activity report' });
  const msg = h('div', { class: 'why' });
  const copy = async () => {
    box.value = ctx.buildReport();
    try { await navigator.clipboard.writeText(box.value); setText(msg, 'Report copied. Paste it into the chat.'); box.hidden = true; } catch { box.hidden = false; box.select(); setText(msg, 'Copying is blocked: long-press the box below, choose Select All, then Copy.'); }
  };
  const el = h('div', {}, h('div', { class: 'row' }, h('button', { class: 'primary', onclick: copy }, 'Copy activity report')), box, msg);
  return { el };
}

export { setText, setDisabled };
