# Phase 1: Bluetooth discovery report

Status: read-only discovery **completed on the real FS-BT-C1** (iPhone, iOS 18.7, Bluefy 3.9.3, diagnostic builds b4 and b5, belt idle and moving). No control command has ever been sent.

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

### Moving-belt capture (build b5, read-only; belt empty, started and adjusted from the treadmill's own remote)

| Observation | Detail |
|---|---|
| Start sequence | Machine Status `04` (started) and Training Status `0x0E` (pre-workout), then **3 s later** Training Status `0x0D` (running) and a second `04`; belt reported its first speed at the same moment. The belt starts at the minimum, 0.96 km/h (about 0.6 mph) |
| Stop sequence | Machine Status `02 01` (stopped by user) and Training Status `0x0F` (post-workout). Training Status goes back to idle `0x01` once settled (not yet seen in a capture) |
| Speed steps seen | `0x60`, `0x70`, `0x80`, `0x90` = 0.96, 1.12, 1.28, 1.44 km/h = about 0.6, 0.7, 0.8, 0.9 mph. Steps of 0.16 km/h are **0.1 mph**, so the console's native step is 0.1 mph (strongly suggests, not yet confirmed against what the console displayed) |
| Incline readings | 2.0 %, then 4.0 and 5.0 % one second apart. The reading changed immediately, so it follows the console's level setting rather than the physical ramp position |
| Distance / energy / elapsed | Distance climbed 0 to 27 m over 76 s, energy 1 kcal, elapsed time counted real seconds from the moment the belt started |
| Heart rate, energy per hour/min | 0 and "not available" |
| Second packet type | Extra bytes `00 00 00` at idle, `01 00 00` once the belt was running. Looks like a running-state flag. Unconfirmed; return to `00` after stopping was not captured (sample cap, fixed in b6) |

Not yet confirmed because no console readings were noted: that the console showed 0.6 to 0.9 mph and levels 2 and 5 for these values.

Fit with the presets: all preset speeds (1.8 to 2.8 mph) and incline levels (0 to 8) are inside the reported ranges. Because speed steps are 0.1 km/h, a preset speed would land within about 0.03 mph of the target.

## Not verified (no hardware evidence yet)

| Item | Why it matters |
|---|---|
| Any control command (request control, start, speed, incline, stop) | Never sent. Needs your approval and a safety review |
| Incline "level" equals reported percent | Ranges match 0-12 and readings of 2 and 5 appeared after the remote's incline presses; console display was not recorded, so unconfirmed |
| Whether the treadmill rounds a requested speed to its 0.1 mph grid | Matters for exact preset speeds; only testable with a control command |
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

- 18 unit tests for the decoders, including packets captured from the real module at idle: `node --test test/ftms.test.mjs`.
- Page driven against a simulated device with Bluefy-style short IDs: connect, reads, both packet types, report redaction, 0 write attempts.
- Real device: read-only discovery and idle notifications only.

## Files

- `site/` is the published root (the diagnostic page plus `site/control/`) (index.html, app.js, ftms.js). Bump the version in all three places on each change to defeat caching.
- `test/` is tests only and is not published.
- `.github/workflows/pages.yml` deploys `diag/` to GitHub Pages on every push to `main`.
