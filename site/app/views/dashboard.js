// Dashboard: connection, safety checklist, and the saved workouts.
import { h, clear } from '../dom.js?v=a1';
import { connectionCard, checklistCard, twoStep, banner } from '../components.js?v=a1';
import { formatDuration } from '../format.js?v=a1';
import { summary } from '../editor-model.js?v=a1';
import { isActive } from '../workout-vm.js?v=a1';
import { STATE } from '../../workout/engine.js?v=v4';

export function dashboardView(ctx) {
  const conn = connectionCard(ctx);
  const check = checklistCard(ctx);
  const list = h('div', { class: 'cards' });
  const notices = h('div');
  const activeCard = h('section', { class: 'card', hidden: true });
  const msg = h('div', { class: 'why' });

  function rebuild() {
    clear(list);
    clear(notices);
    for (const n of [...ctx.library.notices, ...ctx.state.notices]) notices.append(h('div', { class: 'strip' }, n));
    const all = ctx.library.list();
    if (!all.length) list.append(h('div', { class: 'card' }, 'No workouts yet. Tap "Create workout" or restore the presets in Settings.'));
    all.forEach((w, i) => {
      const s = summary(w);
      const del = twoStep(ctx, {
        label: 'Delete', armedLabel: 'TAP AGAIN to delete', cls: 'small danger',
        warning: `Delete "${w.name}" for good? Tap again to delete, or wait to cancel.`,
        onConfirm: () => { ctx.library.remove(w.id); rebuild(); },
      });
      list.append(h('div', { class: 'card' },
        h('h3', {}, w.name, w.presetId ? h('span', { class: 'badge' }, 'preset') : null),
        h('div', { class: 'workout-meta' }, `${formatDuration(s.totalSec)} · ${s.count} interval${s.count === 1 ? '' : 's'} · ${s.minSpeedMph.toFixed(1)}–${s.maxSpeedMph.toFixed(1)} mph · max incline ${s.maxIncline}`),
        w.description ? h('div', { class: 'workout-meta' }, w.description) : null,
        h('div', { class: 'row' },
          h('button', { class: 'primary grow', onclick: () => ctx.go(`#/run/${w.id}`) }, 'Start…'),
          h('button', { onclick: () => ctx.go(`#/edit/${w.id}`) }, 'Edit'),
          h('button', { onclick: () => { ctx.library.duplicate(w.id); rebuild(); } }, 'Copy')),
        h('div', { class: 'row tight' },
          h('button', { class: 'small', disabled: i === 0, 'aria-label': 'Move up', onclick: () => { ctx.library.move(w.id, -1); rebuild(); } }, '↑'),
          h('button', { class: 'small', disabled: i === all.length - 1, 'aria-label': 'Move down', onclick: () => { ctx.library.move(w.id, 1); rebuild(); } }, '↓'),
          h('span', { class: 'grow' }), del.el)));
    });
  }

  const el = h('div', {},
    activeCard, conn.el, check.el,
    h('div', { class: 'row' }, h('h2', { class: 'grow', style: 'margin:0' }, 'Workouts'), h('button', { class: 'primary', onclick: () => ctx.go('#/new') }, 'Create workout')),
    notices, msg, list);
  rebuild();

  return {
    el,
    update() {
      conn.update();
      check.update();
      const st = ctx.engine.state;
      activeCard.hidden = !(isActive(st) || st === STATE.FAULTED);
      if (!activeCard.hidden) {
        clear(activeCard);
        activeCard.append(h('b', {}, 'A workout is in progress.'), h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => ctx.go(`#/run/${ctx.state.runId}`) }, 'Open it')));
      }
    },
  };
}
