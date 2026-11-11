// Routes raw Bluetooth notifications/indications into the Controller. Shared by the page and the tests,
// so what the tests exercise is exactly what the page runs.
import { CHARS, normalizeUuid, parseTreadmillData, parseTrainingStatus, parseMachineStatus } from '../ftms.js?v=b6';

export function routeNotification(ctl, rawUuid, dv) {
  const uuid = normalizeUuid(rawUuid);
  if (uuid === CHARS.controlPoint) {
    ctl.feedIndication(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
  } else if (uuid === CHARS.treadmillData) {
    const d = parseTreadmillData(dv);
    if (d.fields.speedKmh != null) ctl.feedTelemetry({ speedKmh: d.fields.speedKmh, inclinePct: d.fields.inclinePct });
  } else if (uuid === CHARS.trainingStatus) {
    const d = parseTrainingStatus(dv);
    if (d.code != null) ctl.feedTraining(d.code);
  } else if (uuid === CHARS.machineStatus) {
    const d = parseMachineStatus(dv);
    if (d.code != null) ctl.feedMachineStatus(d.code);
  }
}
