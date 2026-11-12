// Bluetooth connection for the app: choose the treadmill, read its limits, subscribe to everything (including the
// control-point responses) and hand the notifications to the Controller. It is the only place in the app that holds a
// Bluetooth characteristic, and its single write path is `transport.write`, which the Controller calls after its own
// safety checks. Nothing here decides whether a command may be sent.
import { SERVICES, CHARS, parseSpeedRange, parseInclineRange, parseTrainingStatus } from '../ftms.js?v=b6';
import { routeNotification } from '../control/bridge.js?v=c8';

const CONNECT_TIMEOUT_MS = 20000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000} s`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class BleSession {
  constructor({ bluetooth = globalThis.navigator?.bluetooth, secure = globalThis.isSecureContext, onLog = () => {}, connectTimeoutMs = CONNECT_TIMEOUT_MS } = {}) {
    Object.assign(this, { bluetooth, secure, onLog, connectTimeoutMs });
    this.controller = null;
    this.device = null;
    this.cp = null; // control point characteristic
    this.generation = 0; // events from an older connection are ignored, so one acknowledgment is never counted twice
    this.onGattDisconnect = null;
    this.deviceName = null;
    this.ranges = null;
    // The Controller calls this after its own checks; this is the only write call in the app.
    this.transport = { write: (bytes) => { if (!this.cp) throw new Error('not connected'); return this.cp.writeValue(bytes); } };
  }

  attach(controller) { this.controller = controller; }

  /** Can Bluetooth be used at all here? */
  availability() {
    if (!this.bluetooth) return { ok: false, reason: 'Web Bluetooth is not available in this browser. Open this page in Bluefy.' };
    if (!this.secure) return { ok: false, reason: 'Bluetooth needs a secure (https) page.' };
    return { ok: true };
  }

  async connect() {
    const a = this.availability();
    if (!a.ok) return a;
    const ctl = this.controller;
    try {
      if (this.device && this.onGattDisconnect) this.device.removeEventListener('gattserverdisconnected', this.onGattDisconnect);
      this.onLog('Opening the device chooser…');
      this.device = await this.bluetooth.requestDevice({ filters: [{ namePrefix: 'FS-' }], optionalServices: [SERVICES.fitnessMachine] });
      const gen = ++this.generation;
      this.onGattDisconnect = () => {
        if (gen !== this.generation) return;
        if (ctl.link) ctl.disconnected();
        else this.onLog('Disconnected before the connection was ready.');
      };
      this.device.addEventListener('gattserverdisconnected', this.onGattDisconnect);
      const server = await withTimeout(this.device.gatt.connect(), this.connectTimeoutMs, 'Bluetooth connect');
      const svc = await server.getPrimaryService(SERVICES.fitnessMachine);
      const ch = (uuid) => svc.getCharacteristic(uuid);
      this.cp = await ch(CHARS.controlPoint);
      const [data, training, machine] = await Promise.all([ch(CHARS.treadmillData), ch(CHARS.trainingStatus), ch(CHARS.machineStatus)]);
      const speed = parseSpeedRange(await (await ch(CHARS.speedRange)).readValue());
      const incline = parseInclineRange(await (await ch(CHARS.inclineRange)).readValue());
      if (!(speed.minKmh > 0 && speed.maxKmh > speed.minKmh) || !(incline.maxPct >= incline.minPct)) throw new Error("the treadmill's limits could not be read sensibly");
      // Listen first (including control-point responses) so no acknowledgment can be missed. If any subscription fails
      // we refuse to continue: we never send a command we cannot see the answer to.
      for (const c of [data, training, machine, this.cp]) {
        c.addEventListener('characteristicvaluechanged', (ev) => { if (gen === this.generation) routeNotification(ctl, ev.target.uuid, ev.target.value); });
        await c.startNotifications();
      }
      this.ranges = { speed: { minKmh: speed.minKmh, maxKmh: speed.maxKmh }, incline: { minPct: incline.minPct, maxPct: incline.maxPct } };
      ctl.connected(this.ranges);
      const t = parseTrainingStatus(await training.readValue());
      if (t.code != null) ctl.feedTraining(t.code);
      this.deviceName = this.device.name ?? 'treadmill';
      this.onLog(`Connected to ${this.deviceName}.`);
      return { ok: true, name: this.deviceName };
    } catch (e) {
      const reason = e?.message || 'The device chooser was cancelled, or the browser gave no details.';
      this.onLog(`Connect failed: ${reason}. No commands will be sent.`);
      try { this.device?.gatt?.disconnect(); } catch { /* ignore */ }
      this.cp = null;
      return { ok: false, reason };
    }
  }

  disconnect() {
    try { this.device?.gatt?.disconnect(); } catch { /* ignore */ }
  }
}
