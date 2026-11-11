# Phase 1: Bluetooth discovery report

Status: diagnostic built and tested against a **simulated** device only. Nothing here has been tested on the Rockare W400A.

## Architecture recommendation

**Direct Web Bluetooth in Bluefy, standard FTMS, static HTTPS page. No server.**

Why:
- The only public FS-BT-C1 implementation ([aradix85/fitshow-treadmill-accessible](https://github.com/aradix85/fitshow-treadmill-accessible), MIT) talks to the module with **standard Bluetooth FTMS** (Fitness Machine Service, 0x1826). It adds no custom framing, checksum or handshake. Control commands are 1 to 3 bytes.
- Web Bluetooth handles FTMS fine, so there is nothing a Python bridge would add except a laptop that must stay on.
- Fallback if Bluefy proves unreliable: Python/Bleak on a laptop. The same repo already does this and is MIT-licensed. Python is not installed on this PC.

Needs a decision later (not now): the page must be served over HTTPS. Options: GitHub Pages (free, needs a GitHub account; page is public but holds no secrets) or Netlify Drop (drag the `diag` folder; an unclaimed site is deleted after about an hour unless you sign up).

## Verified (from reading code and docs, not from your treadmill)

- FS-BT-C1 module reports manufacturer `FITSHOW`, device name `FS-` plus hex. Matches the expected module.
- Exposes FTMS characteristics: Control Point `2AD9`, Treadmill Data `2ACD`, Training Status `2AD3`, Machine Status `2ADA`, plus a vendor service `FFF0` / char `FFF1` (notify).
- Reference control opcodes (standard FTMS): `00` request control, `01` reset, `02` set speed (km/h x 100, uint16 LE), `03` set incline (% x 10, int16 LE), `07` start, `08 01` stop. **None are used by the diagnostic.**
- FitShow and Kinni are reported to work against FTMS-style bridges (ESPHome-Treadmill-FTMS project), which supports the FTMS reading.
- Only one treadmill was tested by the reference author (VirtuFit TR600i). Behaviour on the W400A is unconfirmed.

## Unknowns and risks

| Item | Why it matters |
|---|---|
| Does Bluefy list the device and allow GATT access? | Whole architecture hinges on this. Test 1. |
| Does the W400A expose FTMS at all, or only the vendor service? | Your firmware shows 1.4.3; the reference was 1.4.2. |
| Real speed and incline limits | Read from `2AD4` / `2AD5` by the diagnostic. Do not hardcode. W400A is MPH and incline levels 0-12; FTMS uses km/h and %. The mapping from level to % is unknown. |
| Pairing/bonding requirement | Unknown on iOS. |
| One connection at a time | FitShow or Kinni connected to the treadmill will likely block Bluefy. Force-quit them first. |
| Reference docs have a field-table error (their table disagrees with the FTMS spec for Treadmill Data) | The diagnostic follows the spec and shows raw bytes so we can check. |
| Training Status codes | Reference labels `0x0E` "warming up"; the spec calls it "Pre-workout". Raw codes are logged. |
| Incline above the machine limit | Reference notes the treadmill silently ignores it and still says OK. Never trust an OK as proof of the actual state. |
| Belt behaviour on disconnect | Unknown. Do not assume Bluetooth loss stops the belt. |
| Background / locked-phone behaviour | Unknown; Phase 5. |

## Safety

- Diagnostic never writes to a characteristic. Enforced three ways: no write calls in source (checked by a unit test), the Control Point is never opened, and the simulated-device test counted zero write attempts.
- Enabling live notifications writes only the standard notification switch (CCCD). It is not a control command.
- Keep the physical stop/safety key within reach for all tests. An on-screen button is not an emergency stop.

## Tests run (no hardware)

- 11 unit tests for the FTMS decoders, using synthetic data built from the spec: all pass (`node --test test/ftms.test.mjs`).
- Page driven in a desktop browser against a fake device (`test/mock-ble.js`): connect, discovery, reads, live data, disconnect, report copy all worked; 0 write attempts.
- Not tested: real Bluefy, real iPhone, real treadmill.

## Files

- `diag/index.html`, `diag/app.js`, `diag/ftms.js` is the diagnostic (host these three together).
- `test/ftms.test.mjs`, `test/mock-ble.js` are tests only; do not upload.
