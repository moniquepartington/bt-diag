# Phase 1: Bluetooth discovery report

Status: read-only discovery **completed on the real FS-BT-C1** (iPhone, iOS 18.7, Bluefy 3.9.3, diagnostic build b4, belt idle). No control command has ever been sent.

## Architecture recommendation

**Direct Web Bluetooth in Bluefy, standard FTMS, static HTTPS page on GitHub Pages. No server.**

- The module exposes standard Bluetooth FTMS (service 0x1826), so no custom framing or checksum is needed.
- Bluefy connected, discovered services, read values and received notifications on the first successful build.
- Fallback if Bluefy proves unreliable later: Python/Bleak on a laptop (the reference project does this, MIT license). Not needed so far.

## Verified on the user's hardware (read-only)

| Item | Result |
|---|---|
| Bluefy connects and reads | Yes |
| Module | FITSHOW FS-BT-C1, firmware V2.6.3, hardware 1.0, software 1.4.3 |
| Services | FTMS 0x1826, Device Info 0x180A, vendor 0xFFF0. No battery or running-speed service |
| FTMS characteristics | Feature 2ACC (read), Treadmill Data 2ACD (notify), Training Status 2AD3 (read, notify), Machine Status 2ADA (notify), Control Point 2AD9 (write, indicate), speed range 2AD4, incline range 2AD5, plus 2AD7/2AD8 (read) |
| Vendor service | FFF1 notify, FFF2 write-without-response (purpose unknown; not needed, not touched) |
| Target settings supported | Speed, inclination, resistance, power |
| Speed range | 0.96 to 8.05 km/h = **0.60 to 5.00 mph**, step 0.1 km/h (about 0.062 mph) |
| Incline range | **0 to 12 %, step 1** |
| Training status at idle | `01 01` (Idle) |
| Treadmill Data | Two packet types alternate about once per second: flags `0x058c` (speed, distance, incline, energy, HR, elapsed time) and flags `0x2001` with 3 extra bytes (bit 13 is reserved in the spec; bytes were `00 00 00` at idle) |

Fit with the presets: all preset speeds (1.8 to 2.8 mph) and incline levels (0 to 8) are inside the reported ranges. Because speed steps are 0.1 km/h, a preset speed would land within about 0.03 mph of the target.

## Not verified (no hardware evidence yet)

| Item | Why it matters |
|---|---|
| Any control command (request control, start, speed, incline, stop) | Never sent. Needs your approval and a safety review |
| Incline "level" equals reported percent | Ranges match 0-12, but this is an inference until incline is read while the treadmill is at a known level |
| Live values while the belt moves | Idle data only so far. Speed units and the meaning of the 0x2001 packet's extra bytes are unconfirmed |
| Whether Control Point needs pairing/bonding on iOS | Unknown |
| What the belt does if Bluetooth drops | Unknown. Never assume it stops |
| Behaviour with the screen locked or Bluefy backgrounded | Unknown (Phase 5) |
| Single-connection conflict with FitShow/Kinni | Assumed; keep them force-quit |
| Reference project's Training Status labels | Spec says 0x0E is Pre-workout, reference says "warming up". Raw codes are logged |
| Treadmill silently ignores out-of-range values while replying OK (reference project's observation) | Do not trust an OK; always read back actual state |

## Safety

- The diagnostic never writes to a characteristic. Enforced by: no write calls in source (unit test), the Control Point is never opened, and the simulated-device test counts zero write attempts.
- Enabling live notifications writes only the standard notification switch. It is not a control command.
- Reports hide the serial number and the browser's device id.
- The physical stop/safety key is the real emergency stop. An on-screen button is not.

## Tests run

- 15 unit tests for the decoders, including packets captured from the real module at idle: `node --test test/ftms.test.mjs`.
- Page driven against a simulated device with Bluefy-style short IDs: connect, reads, both packet types, report redaction, 0 write attempts.
- Real device: read-only discovery and idle notifications only.

## Files

- `diag/` is the published diagnostic (index.html, app.js, ftms.js). Bump the version in all three places on each change to defeat caching.
- `test/` is tests only and is not published.
- `.github/workflows/pages.yml` deploys `diag/` to GitHub Pages on every push to `main`.
