// Keeps the screen awake during a workout, where the browser supports it, and says plainly when it does not.
// A screen that locks suspends the page, and a suspended page cannot manage the belt.
export class ScreenWake {
  constructor({ nav = globalThis.navigator, onChange = () => {} } = {}) {
    Object.assign(this, { nav, onChange });
    this.sentinel = null;
    this.status = this.supported ? 'idle' : 'unsupported'; // 'unsupported' | 'idle' | 'active' | 'lost' | 'denied'
  }

  get supported() { return !!this.nav?.wakeLock?.request; }

  async acquire() {
    if (!this.supported) return { ok: false, reason: 'unsupported' };
    try {
      this.sentinel = await this.nav.wakeLock.request('screen');
      this.sentinel.addEventListener?.('release', () => { if (this.status === 'active') this._set('lost'); });
      this._set('active');
      return { ok: true };
    } catch (e) {
      this._set('denied');
      return { ok: false, reason: e?.message || 'the browser refused' };
    }
  }

  async release() {
    try { await this.sentinel?.release?.(); } catch { /* ignore */ }
    this.sentinel = null;
    if (this.status !== 'unsupported') this._set('idle');
  }

  _set(s) { this.status = s; this.onChange(s); }

  /** What to tell the user. */
  describe() {
    return {
      unsupported: 'This browser cannot keep the screen awake. Set Auto-Lock to Never (iPhone Settings, Display & Brightness) before a workout, and keep the screen on.',
      idle: 'The screen will be kept awake during a workout.',
      active: 'Screen awake.',
      lost: 'The screen may lock: keep it awake yourself. A locked screen can pause the workout.',
      denied: 'The browser would not keep the screen awake. Set Auto-Lock to Never and keep the screen on.',
    }[this.status];
  }
}
