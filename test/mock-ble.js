// Fake navigator.bluetooth for browser smoke tests. SYNTHETIC data, not a real treadmill.
// Any write attempt throws and is counted in window.__bleWrites, so the test can prove the page never writes.
const u = (n) => `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
const dv = (...b) => new DataView(new Uint8Array(b).buffer);
const str = (s) => new DataView(new TextEncoder().encode(s).buffer);

window.__bleWrites = 0;
window.__bleCalls = [];

function makeChar(uuid, props, value) {
  const el = new EventTarget();
  const c = Object.assign(el, {
    uuid, properties: { read: false, write: false, writeWithoutResponse: false, notify: false, indicate: false, ...props }, value,
    async readValue() { window.__bleCalls.push('read ' + uuid.slice(4, 8)); return this.value; },
    async startNotifications() { window.__bleCalls.push('notify ' + uuid.slice(4, 8)); c.timer = setInterval(() => { c.value = c.next(); c.dispatchEvent(new Event('characteristicvaluechanged')); }, 200); return c; },
    async stopNotifications() { clearInterval(c.timer); },
    async writeValue() { window.__bleWrites++; throw new Error('MOCK: write attempted'); },
    async writeValueWithResponse() { window.__bleWrites++; throw new Error('MOCK: write attempted'); },
    async writeValueWithoutResponse() { window.__bleWrites++; throw new Error('MOCK: write attempted'); },
  });
  return c;
}

let tick = 0;
const treadmillData = makeChar(u(0x2acd), { notify: true }, dv());
treadmillData.next = () => { tick++; return dv(0x8c, 0x05, 0xc8, 0x00, 0x10, 0x27, 0x00, 0x32, 0x00, 0x00, 0x00, 0x0a, 0x00, 0xff, 0xff, 0xff, 0x00, tick & 0xff, 0x00); };
const training = makeChar(u(0x2ad3), { notify: true, read: true }, dv());
training.next = () => dv(0x00, 0x0d);
const machine = makeChar(u(0x2ada), { notify: true }, dv());
machine.next = () => dv(0x04);

const chars = {
  [u(0x1826)]: [
    makeChar(u(0x2acc), { read: true }, dv(0x0c, 0, 0, 0, 0x03, 0, 0, 0)),
    treadmillData, training,
    makeChar(u(0x2ad4), { read: true }, dv(0x64, 0, 0xb0, 0x04, 0x0a, 0)),
    makeChar(u(0x2ad5), { read: true }, dv(0, 0, 0x78, 0, 0x0a, 0)),
    makeChar(u(0x2ad9), { write: true, indicate: true }, dv()),
    machine,
  ],
  [u(0x180a)]: [makeChar(u(0x2a29), { read: true }, str('MOCK-MFR')), makeChar(u(0x2a24), { read: true }, str('MOCK-MODEL'))],
  [u(0xfff0)]: [makeChar(u(0xfff1), { notify: true }, dv())],
};
chars[u(0xfff0)][0].next = () => dv(0xaa, 0xbb);

const server = {
  connected: false,
  async connect() { this.connected = true; return this; },
  disconnect() { this.connected = false; device.dispatchEvent(new Event('gattserverdisconnected')); },
  async getPrimaryService(uuid) {
    if (!chars[uuid]) throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
    return { uuid, async getCharacteristics() { return chars[uuid]; }, async getCharacteristic(cu) { const c = chars[uuid].find((x) => x.uuid === cu); if (!c) throw Object.assign(new Error('nf'), { name: 'NotFoundError' }); return c; } };
  },
};
const device = Object.assign(new EventTarget(), { name: 'FS-MOCK01', id: 'mock-id', gatt: server });

Object.defineProperty(navigator, 'bluetooth', {
  configurable: true,
  value: { async requestDevice(opts) { window.__lastRequest = opts; return device; }, async getAvailability() { return true; } },
});
Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
