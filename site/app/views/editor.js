// Workout editor: name, description and an ordered list of intervals, with live total duration and validation
// against the verified hardware limits. Nothing here can create a workout the engine would refuse.
import { h, clear, setText } from '../dom.js?v=a1';
import { twoStep } from '../components.js?v=a1';
import { formatDuration } from '../format.js?v=a1';
import * as ed from '../editor-model.js?v=a1';

export function editorView(ctx, id) {
  const original = id ? ctx.library.get(id) : null;
  if (id && !original) return { el: h('div', { class: 'card' }, 'That workout no longer exists. ', h('a', { href: '#/' }, 'Back to the list')), update() {} };

  const limits = ctx.limits;
  let draft = original ? structuredClone(original) : ed.newWorkout();
  let dirty = !original;

  const nameInput = h('input', { type: 'text', value: draft.name, 'aria-label': 'Workout name', oninput: (e) => { draft = ed.setName(draft, e.target.value); dirty = true; refreshStatus(); } });
  const descInput = h('textarea', { 'aria-label': 'Description', placeholder: 'Optional description', oninput: (e) => { draft = ed.setDescription(draft, e.target.value); dirty = true; } });
  descInput.value = draft.description ?? '';
  const total = h('div', { class: 'workout-meta' });
  const intervals = h('div');
  const problemsEl = h('div', { class: 'why err' });
  const saveMsg = h('div', { class: 'why err' });
  const save = h('button', { class: 'primary grow', onclick: onSave }, 'Save workout');

  const change = (next) => { draft = next; dirty = true; rebuild(); };

  function stepper(label, valueText, onMinus, onPlus, minusLabel = '−', plusLabel = '+') {
    return h('div', { class: 'stepper' }, h('small', {}, label), h('button', { class: 'small', onclick: onMinus, 'aria-label': `${label} down` }, minusLabel), h('span', { class: 'val' }, valueText), h('button', { class: 'small', onclick: onPlus, 'aria-label': `${label} up` }, plusLabel));
  }

  function intervalCard(iv, i) {
    const n = draft.intervals.length;
    const category = h('select', { 'aria-label': `Interval ${i + 1} category`, onchange: (e) => change(ed.setCategory(draft, i, e.target.value)) }, ed.CATEGORIES.map((c) => h('option', { value: c, ...(c === iv.category ? { selected: true } : {}) }, c)));
    return h('div', { class: 'card inner interval' },
      h('div', { class: 'head' }, h('b', {}, `${i + 1}`), category,
        h('button', { class: 'small', disabled: i === 0, 'aria-label': 'Move interval up', onclick: () => change(ed.moveInterval(draft, i, -1)) }, '↑'),
        h('button', { class: 'small', disabled: i === n - 1, 'aria-label': 'Move interval down', onclick: () => change(ed.moveInterval(draft, i, 1)) }, '↓'),
        h('button', { class: 'small', 'aria-label': 'Duplicate interval', onclick: () => change(ed.duplicateInterval(draft, i)) }, 'Copy'),
        h('button', { class: 'small danger', disabled: n <= 1, 'aria-label': 'Delete interval', onclick: () => change(ed.deleteInterval(draft, i)) }, '✕')),
      h('div', { class: 'stepper' }, h('small', {}, 'Time'),
        h('button', { class: 'small', onclick: () => change(ed.nudgeDuration(draft, i, -60)), 'aria-label': 'Minus one minute' }, '−1m'),
        h('button', { class: 'small', onclick: () => change(ed.nudgeDuration(draft, i, -5)), 'aria-label': 'Minus five seconds' }, '−5s'),
        h('span', { class: 'val' }, formatDuration(iv.durationSec)),
        h('button', { class: 'small', onclick: () => change(ed.nudgeDuration(draft, i, 5)), 'aria-label': 'Plus five seconds' }, '+5s'),
        h('button', { class: 'small', onclick: () => change(ed.nudgeDuration(draft, i, 60)), 'aria-label': 'Plus one minute' }, '+1m')),
      stepper('Speed', `${iv.speedMph.toFixed(1)} mph`, () => change(ed.nudgeSpeed(draft, i, -1, limits)), () => change(ed.nudgeSpeed(draft, i, 1, limits))),
      stepper('Incline', `${iv.inclineLevel}`, () => change(ed.nudgeIncline(draft, i, -1, limits)), () => change(ed.nudgeIncline(draft, i, 1, limits))));
  }

  function refreshStatus() {
    const p = ed.problems(draft, limits);
    const s = ed.summary(draft);
    setText(total, `Total ${formatDuration(s.totalSec)} · ${s.count} interval${s.count === 1 ? '' : 's'} · ${s.minSpeedMph.toFixed(1)}–${s.maxSpeedMph.toFixed(1)} mph · max incline ${s.maxIncline}`);
    setText(problemsEl, p.ok ? '' : [...p.errors, ...p.violations.map((v) => `interval ${v.interval}: ${v.field === 'speedMph' ? 'speed' : 'incline'} ${v.value} is above the verified limit ${v.limit}`)].join('\n'));
    problemsEl.style.whiteSpace = 'pre-line';
    save.disabled = !p.ok;
    save.title = p.ok ? '' : 'fix the problems above first';
    cancelPlain.hidden = dirty; // with unsaved changes, Cancel needs a second tap
    discard.el.hidden = !dirty;
  }

  function rebuild() {
    clear(intervals);
    draft.intervals.forEach((iv, i) => intervals.append(intervalCard(iv, i)));
    refreshStatus();
  }

  function onSave() {
    const r = ctx.library.save(draft);
    if (!r.ok) return void setText(saveMsg, `Not saved: ${r.reason}`);
    dirty = false;
    ctx.go('#/');
  }

  const discard = twoStep(ctx, {
    label: 'Cancel', armedLabel: 'TAP AGAIN to discard changes', warning: 'Your changes will be lost. Tap again to discard them, or wait to keep editing.',
    onConfirm: () => ctx.go('#/'),
  });
  const cancelPlain = h('button', { onclick: () => ctx.go('#/') }, 'Cancel');

  const el = h('div', {},
    h('section', { class: 'card' }, h('h2', {}, original ? 'Edit workout' : 'New workout'), nameInput, h('div', { style: 'height:8px' }), descInput, total),
    h('h2', {}, 'Intervals'), intervals,
    h('div', { class: 'row' }, h('button', { onclick: () => change(ed.addInterval(draft)) }, '+ Add interval')),
    problemsEl, saveMsg,
    h('div', { class: 'row' }, save, cancelPlain, discard.el));
  rebuild();
  return { el, update() {}, isDirty: () => dirty };
}
