// Fake navigator.bluetooth for driving the Phase 2 control page in a browser, backed by the SIMULATED treadmill.
// Mimics Bluefy: characteristic IDs are reported in short form. Every control-point write is recorded.
// Usage: window.__faults = {...}; await import('/test/mock-ble-control.js');
import { createSim } from './sim-treadmill.js';
import { CHARS } from '../site/ftms.js';

window.__writes = [];
const short = (u) => u.slice(4, 8).toUpperCase();
const dv = (...b) => new DataView(Uint8Array.from(b).buffer);

function makeChar(fullUuid, props, readValue) {
  const el = new EventTarget();
  return Object.assign(el, {
    uuid: short(fullUuid), full: fullUuid, properties: { read: false, write: false, notify: false, indicate: false, ...props },
    async readValue() { return readValue(); },
    async startNotifications() { return this; },
    async stopNotifications() { return this; },
    async writeValue(bytes) { window.__writes.push(Array.from(bytes)); return sim.write(bytes); },
  });
}

const chars = {};
const emit = (uuid, bytes) => {
  const c = chars[uuid];
  c.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  c.dispatchEvent(new Event('characteristicvaluechanged'));
};
const clock = { setTimeout: (f, ms) => setTimeout(f, ms) };
const sim = createSim({ clock, emit, faults: window.__faults ?? {} });
window.__sim = sim;

chars[CHARS.controlPoint] = makeChar(CHARS.controlPoint, { write: true, indicate: true }, () => dv());
chars[CHARS.treadmillData] = makeChar(CHARS.treadmillData, { notify: true }, () => dv());
chars[CHARS.trainingStatus] = makeChar(CHARS.trainingStatus, { read: true, notify: true }, () => dv(0x01, sim.state.training));
chars[CHARS.machineStatus] = makeChar(CHARS.machineStatus, { notify: true }, () => dv());
chars[CHARS.speedRange] = makeChar(CHARS.speedRange, { read: true }, () => dv(0x60, 0x00, 0x25, 0x03, 0x0a, 0x00));
chars[CHARS.inclineRange] = makeChar(CHARS.inclineRange, { read: true }, () => dv(0x00, 0x00, 0x78, 0x00, 0x0a, 0x00));

const service = {
  async getCharacteristic(uuid) {
    const c = chars[uuid.toLowerCase()];
    if (!c) throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
    return c;
  },
};
const device = Object.assign(new EventTarget(), {
  name: 'FS-MOCK',
  gatt: {
    connected: false,
    async connect() { this.connected = true; return this; },
    disconnect() { this.connected = false; device.dispatchEvent(new Event('gattserverdisconnected')); },
    async getPrimaryService() { return service; },
  },
});
sim.start();

Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: { async requestDevice() { return device; } } });
Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
