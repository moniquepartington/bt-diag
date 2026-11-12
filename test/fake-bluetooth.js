// A fake Web Bluetooth stack backed by the SIMULATED treadmill, usable from Node and from a browser page.
// Not a real device. Options: shortUuids (Bluefy style IDs), faults (passed to the simulator), plus per-test switches.
import { createSim } from './sim-treadmill.js';
import { CHARS } from '../site/ftms.js';

const short = (u) => u.slice(4, 8).toUpperCase();
const dv = (...b) => new DataView(Uint8Array.from(b).buffer);

export function createFakeBluetooth({ clock, faults = {}, shortUuids = true, name = 'FS-FAKE', failCpNotify = false, badSpeedRange = false, chooserError = null, connectHangs = false } = {}) {
  const writes = [];
  const chars = {};
  const calls = { connect: 0, requestDevice: 0, startNotifications: [] };
  let sim;

  const makeChar = (full, props, readValue) => {
    const el = new EventTarget();
    return Object.assign(el, {
      uuid: shortUuids ? short(full) : full, full, properties: { read: false, write: false, notify: false, indicate: false, ...props },
      async readValue() { return readValue(); },
      async startNotifications() {
        calls.startNotifications.push(short(full));
        if (failCpNotify && full === CHARS.controlPoint) throw new Error('indications could not be enabled');
        return this;
      },
      async stopNotifications() { return this; },
      async writeValue(bytes) { writes.push(Array.from(bytes)); return sim.write(bytes); },
    });
  };

  const emit = (uuid, bytes) => {
    const c = chars[uuid];
    c.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    c.dispatchEvent(new Event('characteristicvaluechanged'));
  };
  sim = createSim({ clock, emit, faults });
  chars[CHARS.controlPoint] = makeChar(CHARS.controlPoint, { write: true, indicate: true }, () => dv());
  chars[CHARS.treadmillData] = makeChar(CHARS.treadmillData, { notify: true }, () => dv());
  chars[CHARS.trainingStatus] = makeChar(CHARS.trainingStatus, { read: true, notify: true }, () => dv(0x01, sim.state.training));
  chars[CHARS.machineStatus] = makeChar(CHARS.machineStatus, { notify: true }, () => dv());
  chars[CHARS.speedRange] = makeChar(CHARS.speedRange, { read: true }, () => (badSpeedRange ? dv(0, 0, 0, 0, 0, 0) : dv(0x60, 0x00, 0x25, 0x03, 0x0a, 0x00)));
  chars[CHARS.inclineRange] = makeChar(CHARS.inclineRange, { read: true }, () => dv(0x00, 0x00, 0x78, 0x00, 0x0a, 0x00));

  const service = {
    async getCharacteristic(uuid) {
      const c = chars[uuid.toLowerCase()];
      if (!c) throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
      return c;
    },
  };
  const device = Object.assign(new EventTarget(), {
    name,
    gatt: {
      connected: false,
      async connect() {
        calls.connect += 1;
        if (connectHangs) return new Promise(() => {});
        this.connected = true;
        return this;
      },
      disconnect() { this.connected = false; device.dispatchEvent(new Event('gattserverdisconnected')); },
      async getPrimaryService() { return service; },
    },
  });
  const bluetooth = {
    async requestDevice() {
      calls.requestDevice += 1;
      if (chooserError) throw chooserError;
      return device;
    },
  };
  sim.start();
  return { bluetooth, sim, device, writes, calls, chars };
}
