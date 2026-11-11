# Phase 3: workout engine (simulator only)

Status: built and tested against the SIMULATOR only. No command was sent to the real treadmill. Committed locally, not deployed; the hardware-validated control page (build c4) is still the one live.

## What exists

`site/workout/`: `workout.js` (model, validation, limit check), `presets.js` (the five presets), `limits.js` (verified hardware limits, kept apart from presets), `engine.js` (headless engine on top of the safety Controller). No UI yet (Phase 4).

## Rules implemented

| Rule | How |
|---|---|
| Limits separate from presets | Presets carry no limits and do not import them. The engine checks every interval against `VERIFIED_LIMITS` (1.0 mph, incline 2) before a workout can start, and refuses (never clamps) if any target exceeds them. The control layer enforces the same numbers again when a command is encoded. The engine refuses to be built looser than the control layer. |
| Serialized commands | One serial queue; the engine only uses the controller's five verified commands, only for the CURRENT interval (latest target wins), only what differs from the treadmill's own readings. |
| Pause | Clock frozen at the tap, belt stopped and confirmed, state PAUSED. |
| Resume | Explicit tap, 3 s countdown (nothing sent), Start, verified restart (belt running, at its minimum speed, control held, fresh readings), THEN speed and incline restored; clock restarts after that. |
| Stop | Ends the workout. STOPPED is terminal: no resume or restart until the workout is loaded again. From PAUSED it sends nothing (belt already stopped). A Stop during an in-flight command cancels queued steps and follows it. |
| Failures | Any failed or unacknowledged command, lockout, disconnect, page leaving the screen or timer gap: FAULTED. Never retries, never resumes, never restarts the belt. The fault says whether the belt may still be running. |
| Missed boundaries | Time is read from the monotonic clock. Late timer: only the current interval is applied, skipped targets are never sent. Gap over 5 s (suspension suspected): fault, nothing replayed. |
| Remote stop | Belt stopped from the remote while running becomes a PAUSE; resumable by an explicit tap. |

## Test results

- **113 tests pass** (`node --test test/ftms.test.mjs test/controller.test.mjs test/engine.test.mjs`): 18 decoders, 43 controller, 52 engine.
- All five presets total exactly 1200 s, every interval is a multiple of 5 s; all five run to completion on the simulator in 20:00 with only changed targets sent, one command at a time.
- With the real limits all five presets are refused and nothing is sent; a workout inside the limits runs to completion.
- Covered: pause/resume/stop and their states, disconnects at every stage, page suspension, timer gaps, late timers, several missed boundaries, slow and missing acknowledgments, error results, restart not verified, wrong state after restart.
- Mutation check: 10 deliberate breakages of the safety rules (skip limit check, skip restart verification, catch-up after a gap, resume after Stop, no countdown, no cancellation on Stop, auto-retry, no serial queue, stray Start, wrong belt belief) each made at least one test fail.
- Found and fixed by the tests: after an unacknowledged Start the engine believed the belt was stopped; it now reports "unknown".

## Unresolved safety issues

1. **No preset can run on hardware yet.** All five exceed the validated 1.0 mph and incline 2 (they use up to 2.8 mph and incline 8). Higher speeds, larger speed steps and incline changes have never been commanded on the real treadmill.
2. **The belt keeps running after any fault** (confirmed on hardware). A disconnect, suspension or crash leaves the belt at the last interval's settings until someone stops it. Recovery (reconnect, take control, stop) works, but nothing in software can stop a belt on a suspended phone. The remote must always be in reach.
3. **Pause/resume untested on hardware.** The simulator assumes Start after Stop in the same connection restarts at the minimum speed. If the real treadmill restarts at the old target, the engine faults safely, but that is unconfirmed.
4. **Idle readings pause for 2.6 s or more** and the freshness limit is 3 s, so Start/Resume can be refused spuriously (safe). Loosening it to 6 s awaits approval.
5. **Suspension and screen lock on iOS Bluefy** are untested; whether timers and Bluetooth survive, and whether a screen wake lock is available, are unknown.
6. **Simulator assumptions** (instant telemetry, exact speeds, incline readback follows the target, remembered state) may differ from the real treadmill.
7. A speed or incline changed from the remote during a workout is not detected or flagged (the engine does not fight it).

## Staged limits-validation page (built, simulator-tested, NOT deployed, NOT run on hardware)

`site/validate/` is a separate page so the hardware-validated control page stays as it is. Its raised limits exist only inside the Controller it creates for the unlocked stage; `VERIFIED_LIMITS` is untouched.

- **Gate:** a stage is unlocked by typing its name (STAGE A) plus the three safety boxes. A stage that is not listed in `ENABLED_STAGES` cannot be unlocked at all. This build lists **only Stage A**; Stage B is built and tested but stays locked until its own approval, which means a separate deploy.
- **Stage A** (up to 2.0 mph, incline 5): manual ladder with speed buttons 0.6, 1.0, 1.4, 2.0 and incline 0, 2, 5. The page times every command and records each reading once a second. It reports what speed the belt **restarts at after a Stop** (minimum, previous speed, or other), which settles the unconfirmed Pause/Resume assumption.
- **Stage B** (up to 2.8 mph, incline 8): adds 2.4 and 2.8 mph and incline 8, plus a 100 s engine-driven validation workout with Pause and Resume (manual buttons switch off while it runs).
- **Tests:** 17 new tests (130 in all). Includes the staged ladders on the simulator, the exact bytes, over-limit refusals, the unlock gate, the engine failing safe if the belt restarts at its previous speed, and a Stage B run with pause and resume. The real page was also driven against the simulator for Stage A, and for Stage B through a test-only server that enables it.
- Raising the validated limits (which is what makes the five presets runnable) remains a separate step after Stage B is recorded and approved.

## Next hardware-validation milestone (needs separate approval)

Staged, belt-empty validation of the preset range: raise the validated limits in two stages on a dedicated test page, each stage its own approval and its own remote-in-hand run:
- **Stage A:** up to 2.0 mph and incline 5. Includes the large step from the 0.6 mph minimum, and stop then restart in one connection (what speed does it restart at?).
- **Stage B:** up to 2.8 mph and incline 8, plus an explicit Pause/Resume cycle and a short real-time run of a preset-style interval change.

Only after Stage B is recorded would `VERIFIED_LIMITS` be raised, which is what makes the five presets runnable.
