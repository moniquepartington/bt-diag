// The workout library: unlimited workouts kept in this browser only (localStorage), with JSON export and import.
// No account, no cloud, no remote database. The storage object is injected so this runs (and is tested) without a browser.
//
// Rules:
//  * Every workout is validated when it is saved, loaded or imported, against the verified hardware limits.
//    Anything that fails is refused (save, import) or set aside, never silently dropped or clamped (load).
//  * The five presets are stored as ordinary, editable workouts on first run. Editing one never loses the original:
//    restorePresets() puts the five back to the spec values.
//  * Corrupted stored data is backed up under another key before anything is replaced.
//  * If storage is unavailable (private mode, blocked, full) the library keeps working in memory and says so.
import { validateWorkout, checkAgainstLimits, totalSeconds } from '../workout/workout.js';
import { PRESETS } from '../workout/presets.js';
import { VERIFIED_LIMITS } from '../workout/limits.js?v=l2';

export const STORAGE_KEY = 'treadmill.library';
export const FORMAT = 'treadmill-workouts';
export const VERSION = 1;
export const MAX_NAME_LENGTH = 200; // generous: the spec asks for no tiny name limit

const defaultId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** Keeps only the fields we own, in a plain, predictable shape. */
function normalize(w) {
  return {
    id: String(w.id),
    ...(w.presetId ? { presetId: String(w.presetId) } : {}),
    name: String(w.name ?? '').trim(),
    description: String(w.description ?? ''),
    intervals: (Array.isArray(w.intervals) ? w.intervals : []).map((i) => ({ category: i.category, durationSec: i.durationSec, speedMph: i.speedMph, inclineLevel: i.inclineLevel })),
  };
}

export class WorkoutLibrary {
  constructor({ storage = defaultStorage(), limits = VERIFIED_LIMITS, presets = PRESETS, makeId = defaultId, now = () => new Date().toISOString() } = {}) {
    Object.assign(this, { storage, limits, presets, makeId, now });
    this.workouts = [];
    this.quarantine = []; // stored items that failed validation: kept, shown in Settings, never run
    this.persistent = !!storage;
    this.notices = [];
  }

  // ---------- loading and saving ----------
  /** Reads the library, seeding the presets on first run. Returns notices for the UI. */
  load() {
    this.notices = [];
    let raw = null;
    try { raw = this.storage?.getItem(STORAGE_KEY) ?? null; } catch { this.persistent = false; this.notices.push('Saved workouts cannot be read in this browser; using temporary storage.'); }
    if (raw == null) {
      this._seed();
      return this.notices;
    }
    let data;
    try {
      data = JSON.parse(raw);
      if (!data || !Array.isArray(data.workouts)) throw new Error('unexpected shape');
    } catch {
      this._backupCorrupt(raw);
      this.notices.push('The saved library could not be read. A copy of it was kept, and the five presets were restored.');
      this._seed();
      return this.notices;
    }
    this.workouts = [];
    this.quarantine = Array.isArray(data.quarantine) ? data.quarantine : [];
    for (const item of data.workouts) {
      const w = normalize({ ...item, id: item?.id ?? this.makeId() });
      const problem = this._check(w);
      if (problem) this.quarantine.push({ ...w, problem });
      else this.workouts.push(w);
    }
    if (this.quarantine.length) this.notices.push(`${this.quarantine.length} saved workout(s) did not pass the checks and were set aside (see Settings).`);
    return this.notices;
  }

  _seed() {
    this.workouts = this.presets.map((p) => normalize({ ...p, id: this.makeId(), presetId: p.id }));
    this._write();
  }

  _write() {
    if (!this.storage) { this.persistent = false; return false; }
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify({ format: FORMAT, version: VERSION, savedAt: this.now(), workouts: this.workouts, quarantine: this.quarantine }));
      this.persistent = true;
      return true;
    } catch {
      this.persistent = false;
      this.notices.push('Could not save to this browser (storage full or blocked). Changes are kept only until you close the page: export a backup.');
      return false;
    }
  }

  _backupCorrupt(raw) {
    try { this.storage?.setItem(`${STORAGE_KEY}.corrupt.${Date.now()}`, raw); } catch { /* nothing more we can do */ }
  }

  _check(w) {
    const errors = validateWorkout(w);
    if (errors.length) return errors[0];
    if (w.name.length > MAX_NAME_LENGTH) return `name is longer than ${MAX_NAME_LENGTH} characters`;
    const v = checkAgainstLimits(w, this.limits);
    if (v.length) return `interval ${v[0].interval}: ${v[0].field === 'speedMph' ? 'speed' : 'incline'} ${v[0].value} is above the verified limit ${v[0].limit}`;
    return null;
  }

  // ---------- reading ----------
  list() { return this.workouts.map((w) => structuredClone(w)); }
  get(id) { const w = this.workouts.find((x) => x.id === id); return w ? structuredClone(w) : null; }
  summaryOf(w) { return { id: w.id, name: w.name, totalSec: totalSeconds(w), count: w.intervals.length, isPreset: !!w.presetId }; }

  // ---------- changing ----------
  /** Adds a new workout (no id) or replaces an existing one (same id). Returns {ok, workout} or {ok:false, reason}. */
  save(workout) {
    const w = normalize({ ...workout, id: workout.id ?? this.makeId() });
    const problem = this._check(w);
    if (problem) return { ok: false, reason: problem };
    const at = this.workouts.findIndex((x) => x.id === w.id);
    if (at >= 0) {
      const keep = this.workouts[at].presetId;
      this.workouts[at] = keep ? { ...w, presetId: keep } : w;
    } else {
      delete w.presetId; // a brand-new workout is never a preset
      this.workouts.push(w);
    }
    this._write();
    return { ok: true, workout: structuredClone(this.workouts[at >= 0 ? at : this.workouts.length - 1]) };
  }

  duplicate(id) {
    const src = this.workouts.find((w) => w.id === id);
    if (!src) return { ok: false, reason: 'no such workout' };
    const copy = { ...structuredClone(src), id: this.makeId(), name: `${src.name} (copy)` };
    delete copy.presetId;
    const at = this.workouts.indexOf(src);
    this.workouts.splice(at + 1, 0, copy);
    this._write();
    return { ok: true, workout: structuredClone(copy) };
  }

  remove(id) {
    const at = this.workouts.findIndex((w) => w.id === id);
    if (at < 0) return { ok: false, reason: 'no such workout' };
    this.workouts.splice(at, 1);
    this._write();
    return { ok: true };
  }

  /** dir -1 moves it up the list, +1 down. */
  move(id, dir) {
    const at = this.workouts.findIndex((w) => w.id === id);
    const to = at + dir;
    if (at < 0 || to < 0 || to >= this.workouts.length || Math.abs(dir) !== 1) return { ok: false, reason: 'cannot move there' };
    [this.workouts[at], this.workouts[to]] = [this.workouts[to], this.workouts[at]];
    this._write();
    return { ok: true };
  }

  /** Puts all five presets back to their spec values (re-adding any that were deleted). Other workouts are untouched. */
  restorePresets() {
    let restored = 0;
    for (const p of this.presets) {
      const fresh = normalize({ ...p, id: this.makeId(), presetId: p.id });
      const at = this.workouts.findIndex((w) => w.presetId === p.id);
      if (at >= 0) this.workouts[at] = { ...fresh, id: this.workouts[at].id };
      else this.workouts.push(fresh);
      restored += 1;
    }
    this._write();
    return { ok: true, restored };
  }

  removeQuarantined(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.quarantine.length) return { ok: false, reason: 'no such item' };
    this.quarantine.splice(index, 1);
    this._write();
    return { ok: true };
  }

  /** Deletes everything and re-seeds the presets. The UI asks for a confirmation first. */
  resetAll() {
    this.quarantine = [];
    this._seed();
    return { ok: true };
  }

  // ---------- export and import ----------
  exportJson() {
    return JSON.stringify({ format: FORMAT, version: VERSION, exportedAt: this.now(), workouts: this.workouts.map((w) => { const { presetId, ...rest } = w; return rest; }) }, null, 2);
  }

  /** Adds every valid workout in the text as a NEW workout (fresh ids); invalid ones are listed and refused. Never overwrites. */
  importJson(text) {
    let data;
    try { data = JSON.parse(text); } catch { return { ok: false, reason: 'that is not valid JSON', added: 0, rejected: [] }; }
    const items = Array.isArray(data) ? data : data?.workouts;
    if (!Array.isArray(items)) return { ok: false, reason: 'no workouts found in that file', added: 0, rejected: [] };
    if (data?.format && data.format !== FORMAT) return { ok: false, reason: `unrecognised file format "${data.format}"`, added: 0, rejected: [] };
    if (Number(data?.version) > VERSION) return { ok: false, reason: 'this file was made by a newer version of the app', added: 0, rejected: [] };
    let added = 0;
    const rejected = [];
    items.forEach((item, index) => {
      if (!item || typeof item !== 'object') return void rejected.push({ index: index + 1, name: '(not a workout)', reason: 'not a workout' });
      const w = normalize({ ...item, id: this.makeId() });
      delete w.presetId;
      const problem = this._check(w);
      if (problem) return void rejected.push({ index: index + 1, name: w.name || '(no name)', reason: problem });
      this.workouts.push(w);
      added += 1;
    });
    if (added) this._write();
    return { ok: true, added, rejected };
  }
}
