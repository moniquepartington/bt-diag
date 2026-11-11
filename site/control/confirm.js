// A two-step confirmation that does NOT block the page. The browser's confirm() dialog freezes the page's JavaScript
// while it is open, so Bluetooth readings queue up unprocessed and the next safety check wrongly sees old data
// (that is what produced the "no fresh telemetry" refusals and 3 to 4 second gaps seen on Start taps). Here the
// page keeps running: the first tap arms the button and shows the warning, a second tap within the window confirms,
// and doing nothing cancels.

/** Pure state machine; the clock is injected so it can be tested. */
export class TwoStepConfirm {
  constructor({ clock, windowMs = 8000, onArm = () => {}, onDisarm = () => {}, onConfirm }) {
    Object.assign(this, { clock, windowMs, onArm, onDisarm, onConfirm });
    this.armed = false;
    this.timer = null;
  }

  /** @returns {'armed'|'confirmed'} */
  tap() {
    if (!this.armed) {
      this.armed = true;
      this.timer = this.clock.setTimeout(() => this.cancel(), this.windowMs);
      this.onArm();
      return 'armed';
    }
    this._disarm();
    this.onConfirm();
    return 'confirmed';
  }

  /** Called on timeout, or whenever the action stops being allowed. */
  cancel() {
    if (this.armed) this._disarm();
  }

  _disarm() {
    this.armed = false;
    if (this.timer != null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.onDisarm();
  }
}

/** Wires a TwoStepConfirm to a button and a warning element. */
export function wireTwoStep(button, warnEl, { clock, label, armedLabel, warning, onConfirm, windowMs }) {
  const step = new TwoStepConfirm({
    clock,
    windowMs,
    onConfirm,
    onArm: () => { button.textContent = armedLabel; button.classList.add('attn'); warnEl.textContent = warning; },
    onDisarm: () => { button.textContent = label; button.classList.remove('attn'); warnEl.textContent = ''; },
  });
  button.addEventListener('click', () => step.tap());
  return step;
}
