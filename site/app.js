// Read-only BLE diagnostic. This file must never write to a characteristic.
// Allowed GATT operations: connect, discover, readValue(), startNotifications()/stopNotifications().
// (Enabling notifications writes the standard CCCD descriptor internally; that is not a control command.)
import { SERVICES, CHARS, READABLE, NOTIFY_DEFAULT, uuid16, normalizeUuid, hex, text, decode } from './ftms.js?v=b6';

const $ = (id) => document.getElementById(id);
const CONNECT_TIMEOUT_MS = 20000;
const BUILD = 'b6'; // bump on each change (also in index.html and the ftms.js import) to defeat browser caching

const report = { build: BUILD, generatedAt: null, environment: {}, device: null, services: [], reads: {}, notifySamples: {}, events: [], errors: [] };
const live = { device: null, subscribed: [] };

// ---------- logging ----------
function log(msg, kind = 'info') {
  const line = `${new Date().toLocaleTimeString()}  ${msg}`;
  const el = document.createElement('div');
  el.className = kind;
  el.textContent = line;
  $('log').prepend(el);
  report.events.push(line);
  if (kind === 'err') report.errors.push(line);
}
const fail = (what, e) => log(`${what}: ${e.name ?? 'Error'}: ${e.message}`, 'err');

// ---------- environment ----------
function checkEnvironment() {
  const env = {
    userAgent: navigator.userAgent,
    secureContext: window.isSecureContext,
    webBluetooth: 'bluetooth' in navigator,
  };
  report.environment = env;
  $('env').textContent = env.webBluetooth && env.secureContext
    ? 'Web Bluetooth is available.'
    : `Web Bluetooth is NOT available (secureContext=${env.secureContext}, navigator.bluetooth=${env.webBluetooth}). Open this page in Bluefy over https://.`;
  $('env').className = env.webBluetooth && env.secureContext ? 'ok' : 'err';
  $('connect').disabled = !(env.webBluetooth && env.secureContext);
  return env;
}

// ---------- helpers ----------
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s`)), ms))]);

function extraServiceUuids() {
  return $('extra').value.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)
    .map(normalizeUuid);
}

const propList = (p) => Object.entries({ read: p.read, write: p.write, writeNoResp: p.writeWithoutResponse, notify: p.notify, indicate: p.indicate }).filter(([, v]) => v).map(([k]) => k);

// ---------- connect + discover ----------
async function connect() {
  checkEnvironment();
  try {
    const optionalServices = [...Object.values(SERVICES), ...extraServiceUuids()];
    const request = $('all').checked ? { acceptAllDevices: true, optionalServices } : { filters: [{ namePrefix: 'FS-' }], optionalServices };
    log('Opening device chooser…');
    const device = await navigator.bluetooth.requestDevice(request);
    live.device = device;
    report.device = { name: device.name ?? '(no name)' }; // the browser's device id is deliberately not recorded
    log(`Selected: ${report.device.name}`);
    device.addEventListener('gattserverdisconnected', () => { log('Device disconnected.', 'warn'); setConnected(false); });

    log('Connecting…');
    live.server = await withTimeout(device.gatt.connect(), CONNECT_TIMEOUT_MS, 'GATT connect');
    log('Connected.', 'ok');
    setConnected(true);
    await discover();
  } catch (e) {
    if (!e.name && !e.message) log('Device chooser was cancelled or failed (Bluefy gave no details). Tap Scan & connect to try again.', 'warn');
    else fail('Connect', e);
    if (e.name === 'NotFoundError') log('No device chosen. If the treadmill was not listed: close FitShow/Kinni completely, power-cycle the console, then try "Show all devices".', 'warn');
  }
}

async function discover() {
  report.services = [];
  const candidates = [...new Set([...Object.values(SERVICES), ...extraServiceUuids()])];
  const rows = [];
  for (const uuid of candidates) {
    let service;
    try {
      service = await live.server.getPrimaryService(uuid);
    } catch (e) {
      const reason = e.name || e.message || 'not found';
      rows.push({ uuid, found: false, reason });
      report.services.push({ uuid, found: false, reason });
      continue;
    }
    const entry = { uuid, found: true, characteristics: [] };
    try {
      const chars = await service.getCharacteristics();
      for (const c of chars) {
        const item = { uuid: normalizeUuid(c.uuid), properties: propList(c.properties), char: c };
        entry.characteristics.push(item);
      }
    } catch (e) {
      fail(`Characteristics of ${uuid}`, e);
    }
    rows.push(entry);
    report.services.push({ ...entry, characteristics: entry.characteristics.map(({ char, ...rest }) => rest) });
  }
  renderGatt(rows);
  const found = rows.filter((r) => r.found).length;
  log(`Discovery finished: ${found} of ${candidates.length} candidate services found.`, found ? 'ok' : 'warn');
  await readSafeCharacteristics(rows);
}

function renderGatt(rows) {
  const root = $('gatt');
  root.textContent = '';
  for (const r of rows) {
    const h = document.createElement('div');
    h.className = r.found ? 'svc' : 'svc missing';
    h.textContent = r.found ? `✔ ${r.uuid}` : `✘ ${r.uuid}  (not present: ${r.reason})`;
    root.append(h);
    for (const c of r.characteristics ?? []) {
      const d = document.createElement('div');
      d.className = 'chr' + (c.uuid === CHARS.controlPoint ? ' danger' : '');
      d.textContent = `${c.uuid}  [${c.properties.join(', ') || 'none'}]${c.uuid === CHARS.controlPoint ? '  ← control point (not touched by this page)' : ''}`;
      root.append(d);
    }
  }
}

// Reads ONLY characteristics on the READABLE allow-list.
async function readSafeCharacteristics(rows) {
  const out = $('reads');
  out.textContent = '';
  for (const r of rows) {
    for (const c of r.characteristics ?? []) {
      if (!READABLE.has(c.uuid) || !c.properties.includes('read')) continue;
      const label = READABLE.get(c.uuid);
      try {
        const dv = await c.char.readValue();
        if (c.uuid === uuid16(0x2a25)) { // serial number: shown nowhere and never put in the report
          report.reads[label] = { value: '(hidden)' };
          addRead(label, '(read OK, hidden from report)', '');
          continue;
        }
        const decoded = decode(c.uuid, dv);
        const value = decoded ?? (c.uuid === uuid16(0x2a19) ? `${dv.getUint8(0)} %` : text(dv));
        report.reads[label] = decoded ? { ...decoded } : { value, raw: hex(dv) };
        addRead(label, decoded ? JSON.stringify(stripRaw(decoded)) : value, hex(dv));
      } catch (e) {
        report.reads[label] = { error: `${e.name}: ${e.message}` };
        addRead(label, `read failed (${e.name})`, '');
      }
    }
  }
  if (!out.children.length) addRead('—', 'no readable allow-listed characteristics found', '');
}

const stripRaw = ({ raw, ...rest }) => rest;
function addRead(label, value, raw) {
  const d = document.createElement('div');
  d.className = 'read';
  d.innerHTML = '<b></b><span></span><code></code>';
  d.children[0].textContent = label;
  d.children[1].textContent = value;
  d.children[2].textContent = raw ? `raw: ${raw}` : '';
  $('reads').append(d);
}

// ---------- live data (notifications only) ----------
async function startListening() {
  if (!live.server?.connected) return log('Not connected.', 'warn');
  live.t0 = performance.now();
  live.lastKey = {};
  report.notifySamples = {};
  const wanted = [...NOTIFY_DEFAULT];
  if ($('fff1').checked) wanted.push(CHARS.vendorFff1);
  for (const uuid of wanted) {
    try {
      let char = null;
      for (const sUuid of report.services.filter((s) => s.found).map((s) => s.uuid)) {
        const service = await live.server.getPrimaryService(sUuid);
        char = await service.getCharacteristic(uuid).catch(() => null);
        if (char) break;
      }
      if (!char) { log(`Characteristic ${uuid} not present on this device.`, 'warn'); continue; }
      if (!char.properties.notify) { log(`${uuid} has no notify property; skipped.`, 'warn'); continue; }
      char.addEventListener('characteristicvaluechanged', onNotify);
      await char.startNotifications();
      live.subscribed.push(char);
      log(`Listening to ${uuid}`, 'ok');
    } catch (e) { fail(`Subscribe ${uuid}`, e); }
  }
}

async function stopListening() {
  for (const c of live.subscribed) {
    try { c.removeEventListener('characteristicvaluechanged', onNotify); await c.stopNotifications(); } catch (e) { fail('Unsubscribe', e); }
  }
  live.subscribed = [];
  log('Stopped listening.');
}

const seenLogs = new Set();
function logOnce(msg, kind) { if (!seenLogs.has(msg)) { seenLogs.add(msg); log(msg, kind); } }

function onNotify(ev) {
  const uuid = normalizeUuid(ev.target.uuid);
  const dv = ev.target.value;
  const h = hex(dv);
  const d = decode(uuid, dv);
  // Record only CHANGES (with seconds since listening began). For Treadmill Data, distance/energy/elapsed
  // tick constantly, so a change means speed, incline, packet type or the vendor bytes changed.
  const samples = (report.notifySamples[uuid] ??= []);
  const kind = uuid === CHARS.treadmillData && d ? d.flags : '';
  const key = kind ? `${d.fields.speedKmh}|${d.fields.inclinePct}|${d.vendorExtension?.bytes ?? ''}` : h;
  const lastKey = (live.lastKey ??= {});
  if (lastKey[uuid + kind] !== key && samples.length < 400) {
    lastKey[uuid + kind] = key;
    samples.push({ t: +((performance.now() - live.t0) / 1000).toFixed(1), hex: h });
  }
  $('liveRaw').textContent = `${uuid.slice(4, 8)}: ${h}`;
  if (!d) return;
  if (uuid === CHARS.treadmillData) {
    const f = d.fields; // each packet carries only some fields; only update the ones present
    if (f.speedKmh != null) $('vSpeed').textContent = `${f.speedKmh.toFixed(2)} km/h · ${f.speedMph.toFixed(2)} mph`;
    if (f.inclinePct != null) $('vIncline').textContent = `${f.inclinePct.toFixed(1)} %`;
    if (f.distanceM != null) $('vDist').textContent = `${f.distanceM} m`;
    if (f.elapsedS != null) $('vTime').textContent = `${f.elapsedS} s`;
    for (const w of d.warnings) logOnce(`Treadmill data warning: ${w} (flags ${d.flags}, ${d.raw})`, 'warn');
    if (d.vendorExtension) logOnce(`Second packet type seen (flags ${d.flags}); extra bytes kept raw: ${d.vendorExtension.bytes}`);
  } else if (uuid === CHARS.trainingStatus) {
    $('vStatus').textContent = d.name;
  } else if (uuid === CHARS.machineStatus) {
    log(`Machine status: ${d.name}${d.detail ? ` (${d.detail})` : ''}  [${d.raw}]`);
  }
}

// ---------- disconnect / report ----------
function setConnected(on) {
  $('disconnect').disabled = !on;
  $('connect').disabled = on || !(report.environment.webBluetooth && report.environment.secureContext);
  $('listen').disabled = !on;
  $('unlisten').disabled = !on;
  $('state').textContent = on ? 'Connected' : 'Not connected';
  $('state').className = on ? 'pill ok' : 'pill';
  if (!on) live.subscribed = [];
}

async function disconnect() {
  await stopListening();
  if (live.device?.gatt?.connected) live.device.gatt.disconnect();
  setConnected(false);
}

async function copyReport() {
  report.generatedAt = new Date().toISOString();
  const body = JSON.stringify(report, null, 2);
  $('reportBox').value = body;
  try {
    await navigator.clipboard.writeText(body);
    log('Report copied to clipboard. Paste it into the chat.', 'ok');
  } catch {
    $('reportBox').select();
    log('Clipboard blocked: the report is in the box below. Long-press → Select All → Copy.', 'warn');
  }
}

$('connect').addEventListener('click', connect);
$('disconnect').addEventListener('click', disconnect);
$('listen').addEventListener('click', startListening);
$('unlisten').addEventListener('click', stopListening);
$('copy').addEventListener('click', copyReport);
checkEnvironment();
setConnected(false);
$('build').textContent = `Build ${BUILD}`;
log(`Page loaded (${BUILD}). Nothing has been sent to the treadmill.`);
