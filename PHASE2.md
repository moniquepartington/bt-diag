# Phase 2: belt-empty control test page

Status: **built and tested against a simulator only. No command has been sent to the real treadmill.** It lives on the local `phase2` branch and is not pushed or deployed. Hardware use needs explicit approval.

## What exists

- `site/control/` is a separate page (`protocol.js` encoders, `controller.js` safety state machine, `bridge.js`, `app.js`, `index.html`). The read-only diagnostic (`site/index.html`) is unchanged and still has no write calls.
- Ladder, one tap per step: Take control, Start, Speed (0.6 to 1.0 mph), Incline (0 to 2), Stop.
- Only five opcodes can be encoded: `00` request control, `07` start, `02` set speed, `03` set incline, `08 01` stop. No reset, no pause, nothing else.

## Safety rules implemented (and tested on the simulator)

| Rule | Behaviour |
|---|---|
| One outstanding command | A command stays outstanding until the treadmill acknowledges it AND the readings confirm it. Every button, including Stop, is disabled until then. |
| Timeouts | No acknowledgment within 3 s, or no confirming readings within 8 to 15 s depending on the command, is a failure. |
| Lockout, no retry | Any failure locks out every command except Stop. Nothing is ever resent automatically. Only the "Reset test" button (manual) clears it. |
| Unexpected telemetry | Over-limit speed or incline, belt moving when we did not start it, readings that do not match the request, stopped mid-command, lost readings (3 s), lost connection, page leaving the screen, control permission lost, error or duplicate or unsolicited responses: all lock out. |
| Hard caps | Speed 0.6 to 1.0 mph in 0.1 steps, incline 0 to 2. Inputs outside these (or outside the treadmill's own reported range) are refused before anything is written. |
| Pre-conditions | Safety boxes ticked, fresh readings flowing, belt stopped for Take control/Start, belt running for Speed/Incline. Take control or Start while the belt is already active is refused. |
| Never trust an OK | Every command is confirmed against the treadmill's own readings, not only its reply. |
| Stop | Offered only once control is held or something has failed. It is exempt from nothing else: while any command is pending it is disabled like every other button. The remote or safety key is the real emergency stop. |

## Tests

- 53 tests pass: `node --test test/ftms.test.mjs test/controller.test.mjs` (18 decoder tests, 35 controller tests on the simulator covering the happy path, limits, and the failure, lockout and tripwire cases).
- The real page was driven against a simulated treadmill in a desktop browser with Bluefy-style short IDs: gating, one-at-a-time buttons, the full ladder (exact bytes `00, 07, 02 80 00, 02 a0 00, 03 0a 00, 03 14 00, 08 01`), and the lockout banner.
- Not tested: real Bluefy writes, the real W400A, any real acknowledgment from the module.

## Can Take Control move the belt on this device? NOT ESTABLISHED

Evidence that it should not:
- The standard defines Request Control (`00`) as a permission request only; Start (`07`) is separate.
- The reference project (same module firmware V2.6.3, different treadmill) sends `00` once on every connect and has a separate start path.
- Your own capture shows Start produces its own sequence: status "started", a 3 s countdown, then motion.

Why this is not proof for your W400A:
- Nothing documents or tests it on this treadmill. The reference project never read the control responses, so we also do not know your module replies at all.
- It cannot be tested without sending it.

What the page does about it: a tripwire watches for any "started" status, countdown, or belt speed for 6 s after Take Control and locks out immediately. It detects motion within about a second; it cannot prevent it.

Options for the first physical step (your call):
1. If the W400A has a safety key, pull it for the Take Control step. With the key out the belt should not be able to run even if the module tried to start it. Reinsert it before Start. Unverified whether this model has one.
2. Accept the residual risk: belt empty, remote in hand, standing beside it. The worst plausible outcome is the belt starting at its minimum, 0.6 mph, which you stop with the remote.

## Deployment (when approved)

Merge `phase2` into `main` and push. The workflow publishes `site/`, so the diagnostic stays at the root and this page appears at `/control/`. Bump the `?v=` tags in the control files on every change.
