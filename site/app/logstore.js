// Keeps the activity log on this phone (localStorage) so that reloading or losing the page does not erase the record of
// a run that went wrong. Nothing leaves the phone. The storage object is injected so this is tested without a browser.
//
// At page load, the log saved by the previous load is moved to "previous" if anything worth keeping happened in it
// (a load with only the start-up lines is ignored, so reloading twice does not erase the earlier run). The two most
// recent worthwhile loads are kept, with their readings compacted to changes only.
import { compactTelemetry } from './report.js?v=a4';

export const KEY_CURRENT = 'treadmill.log.current';
export const KEY_PREVIOUS = 'treadmill.log.previous';
const MIN_EVENTS = 6;
const KEEP = 2;

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export class LogStore {
  constructor({ storage = defaultStorage(), now = () => new Date().toISOString() } = {}) {
    this.storage = storage;
    this.now = now;
    this.ok = !!storage;
    this.previous = [];
    this._rotate();
  }

  _read(key) {
    try { const raw = this.storage?.getItem(key); return raw ? JSON.parse(raw) : null; } catch { this.ok = false; return null; }
  }

  _write(key, value) {
    try { this.storage?.setItem(key, JSON.stringify(value)); return true; } catch { this.ok = false; return false; }
  }

  _rotate() {
    let previous = this._read(KEY_PREVIOUS);
    previous = Array.isArray(previous) ? previous.filter((p) => p && Array.isArray(p.events)) : [];
    const cur = this._read(KEY_CURRENT);
    if (cur && Array.isArray(cur.events) && cur.events.length >= MIN_EVENTS) {
      previous.unshift({ savedAt: cur.savedAt ?? null, events: cur.events, telemetry: compactTelemetry(Array.isArray(cur.telemetry) ? cur.telemetry : []) });
      previous = previous.slice(0, KEEP);
      this._write(KEY_PREVIOUS, previous);
    }
    this.previous = previous;
  }

  /** Writes this page load's log. Failures (full or blocked storage) are swallowed: the live log still works. */
  save(events, telemetryRows = []) {
    if (!this.storage) return false;
    return this._write(KEY_CURRENT, { savedAt: this.now(), events, telemetry: telemetryRows });
  }
}
