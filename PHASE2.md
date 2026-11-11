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

## Hardware results (belt empty, iPhone, Bluefy, control page build c1)

Three runs on the real treadmill, all with no lockouts and no retries. Replies came back in about 0.1 s every time.

| Command | Bytes sent | Result on the real treadmill |
|---|---|---|
| Take control | `00` | Acknowledged. No belt motion in the 6 s watch (two runs). |
| Start | `07` | Acknowledged. Machine status "started", then 3.0 s later a second "started" and the belt at **0.96 km/h**. Same sequence as starting from the remote. |
| Speed 0.8 mph | `02 80 00` | Acknowledged. Reading confirmed **1.28 km/h** (exact). |
| Speed 1.0 mph | `02 a0 00` | Acknowledged. Reading confirmed **1.61 km/h** (1 hundredth above the 1.60 requested; the treadmill snaps to its own grid). |
| Incline 1, 2, 0 | `03 0a 00`, `03 14 00`, `03 00 00` | Acknowledged. Readings confirmed **1 %, 2 %, 0 %**, each within 0.1 s of the acknowledgment. |
| Stop | `08 01` | Acknowledged. Machine status "stopped" and speed 0 about 2.4 to 3.2 s later. |

Confirmed by the user after the run:
- The console readings matched the page (speed and incline level). Exact console values were reported as "correct", not written down per step.
- The incline ramp physically moved up and down as commanded.

Caveats on what this proves:
- Incline readings changed almost instantly after each command, so they follow the treadmill's target. The user separately saw the ramp move, so the commanded level is being applied.
- Incline level N equalling N % rests on the user's "read correctly" and the matching 0-12 ranges; per-step values were not logged.
- Once, with the belt idle and control held, speed readings paused for more than 3 s (the page correctly refused to send). Not seen while the belt was running. Builds c2 and c3 add gap logging.
- Not tested on hardware: disconnecting while the belt runs, locked screen or backgrounded page, anything above 1.0 mph or incline 2, a failure lockout, two reconnects in a row.

## Disconnect test (belt empty, 0.6 mph): THE BELT KEEPS RUNNING

Take control, Start (belt at 0.96 km/h), then the page's **Disconnect** button (a clean disconnect). Result reported by the user: the belt **continued at the same steady speed**, and **nothing changed on the console**. The belt was stopped with the remote. The page behaved as designed: locked out with CONNECTION LOST and sent nothing further.

Consequences (these now override any optimistic assumption):
- The treadmill has **no dead-man behaviour on Bluetooth loss**. After a disconnect, the belt stays at its last speed and incline until someone stops it with the remote, safety key or power.
- In a real workout, a dropped connection leaves the belt at the current interval's speed and incline. The workout cannot continue or cool down automatically.
- The page cannot stop the belt after a disconnect. A new connection would have to regain control first, and the control page currently refuses Take Control while the belt is moving. A recovery path (reconnect, take control, stop only) is designed but not built or tested.
- Not tested: a forced app quit or an abrupt link loss (range). The clean disconnect already showed the module does not stop the belt, so a more abrupt drop is not expected to be safer.

## Recovery mode (control page build c4): simulator-tested only

Built after the disconnect finding. When the page is locked out and the belt is moving (after a disconnect, or a reload while it runs), the page shows a recovery panel and offers exactly two actions: **Take control** (normally refused while the belt moves) and **Stop belt**. Start, Speed and Incline stay disabled, even with control held, until the belt has stopped and the user presses Reset test.

- Nothing is sent automatically; both steps are user taps, one command at a time, confirmed against the readings, no retries.
- Readings from a previous connection are discarded on reconnect; Take control is offered only once fresh speed readings show the belt state.
- If the belt speeds up after Take control in recovery, the page locks deeper and keeps Stop available.
- Stop is also available before Take control (the treadmill may reject it without control; the page then locks and the user takes control and tries again manually).
- Reconnects ignore events from older connections so one acknowledgment is never counted twice.
- Tests: 61 pass, including 8 recovery cases. Real page driven against the simulator through start, disconnect, reconnect, take control, stop (writes exactly `00` then `08 01`).
### Recovery mode on the real treadmill (build c4): WORKS

Two real recoveries in one session, belt empty at 0.6 mph:
1. The belt was already moving when the page opened (left running from the earlier test). The page locked with BELT ACTIVE UNEXPECTEDLY. **Take control** was acknowledged (`80 00 01`) and the 6 s watch saw no speed change.
2. Start, then **Disconnect**, then reconnect: **Take control** acknowledged (`80 00 01`) with the belt running, no speed change; **Stop** (`08 01`) acknowledged (`80 08 01`) and the belt stopped 2.6 s later (machine status `02 01`), confirmed from the readings.

So: a fresh connection can take control of a belt that is already running and stop it, from the page. Taking control does not change a running belt (seen twice). Recovery is verified for a clean disconnect; an abrupt link loss (range) is not tested.

New observation: while the belt was idle, speed readings paused for 2.6 s (and for more than 3 s earlier). The 3 s freshness limit is too tight at idle. Readings were steady while the belt ran.

## Can Take Control move the belt on this device? Two observations say no, not proven in general

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
