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

### Stage A hardware results (validate page v1, belt empty) — COMPLETE (speed run, then incline run)

What was run: take control, start, speed 1.0 / 1.4 / 2.0 mph, stop from 2.0 mph, start again, speed 2.0 from the minimum, stop. User notes: console matched each step; each change felt instant. No lockouts.

Incline follow-up run (separate session, belt at its minimum speed): incline **2, then 5, then 0** each acknowledged in 0.1 to 0.2 s and confirmed by the readings within 0.5 to 1.1 s (readings 2 %, 5 %, 0 %). User note: "each incline function works instantly". Stop at the minimum speed confirmed in 2.6 s. No lockouts, no refusals, no telemetry gaps over 1.8 s in that run. Caveat: the readings follow the target within a second, so how long the ramp physically takes is known only from the user's "instantly"; incline above 5 and a drop from 5 to 2 (as opposed to 5 to 0) were not run.

| Question | Result |
|---|---|
| Speeds above 1.0 mph accepted | Yes, 1.0, 1.4 and 2.0 mph acknowledged in 0.1 s and confirmed by the readings; console matched. |
| Big step from the minimum | Yes. 0.6 to 2.0 mph in one command (0.96 to 3.22 km/h) confirmed in 0.3 s. |
| Restart speed after a Stop in the same connection | **The minimum (0.96 km/h), both times.** The workout engine's assumption holds. |
| Speed changes | Readings jump to the new value at the next packet; no slow ramp visible. |
| Stop is not instant | From 2.0 mph the belt decelerated over about 5 s (3.22, 2.41, 1.77, 1.28, 0.64, 0.16 km/h) and was confirmed stopped 6.6 to 6.7 s after the tap (0.6 mph stops took 2.4 to 3.2 s). Within the 15 s stop confirmation limit, but a stop from 5 mph would take longer. |
| Speed conversion | The treadmill reports 1.0, 1.4, 2.0 mph as 1.61, 2.25, 3.22 km/h (factor about 1.61, floored), while low speeds read 0.96, 1.12, 1.28, 1.44 (the same factor). Our 1.6 command factor lands on the right 0.1 mph step; readings stay within the 0.08 km/h tolerance up to the preset maximum. The page's mph display (divides by 1.6) shows 1.01 and 1.41 where the console says 1.0 and 1.4; cosmetic. |
| Idle telemetry gaps | Seen again (3.3 s and 2.2 s while idle); one Start was refused for "no fresh telemetry (3.3 s ago)". Safe refusal; evidence for loosening the idle limit to 6 s (awaiting approval). |
| A "stopped" status (`02 01`) appears right after connecting while idle | Harmless, seen before. |

### Build v2 / c6 (approved after Stage A was recorded)

- **Stage B enabled** (alongside A), each stage unlocked only by its own typed phrase. Stage B is run on hardware next.
- **Idle reading limit loosened from 3 s to 6 s** while the belt is idle and nothing is pending. It stays at 3 s whenever the belt is moving, a command is pending, or an unexpected moving belt is seen. Mutation-checked (always strict, always relaxed, relaxed while pending, a 60 s limit: each fails a test).
- **mph display and readback** now use the treadmill's own factor (about 1.61 km/h per mph), so the page matches the console (1.00, 1.40, 2.00 instead of 1.01, 1.41, 2.01). Commands are unchanged.
- **Simulator** now snaps commanded speeds to the 0.1 mph grid and reports them the way the real treadmill does (1.61, 2.25, 3.22 km/h). All tests, including full preset runs, pass against it.
- 135 tests pass (18 decoders, 47 controller, 52 engine, 18 staged validation). `VERIFIED_LIMITS` is still 1.0 mph and incline 2.

### Stage B hardware results (validate page v2, belt empty): PASSED

Run: take control, start, speed 2.0 / 2.4 / 2.8 mph, incline 2 / 5 / 8 / 0, stop; then the engine's 100 s validation workout with a pause and a resume. Every command acknowledged in 0.1 s and confirmed by the readings; no lockouts, no refusals. User note: "During pause mode, belt stopped but incline decreases to 0. All else ran as written."

| Question | Result |
|---|---|
| Speeds up to 2.8 mph, incline up to 8 | Accepted. 2.4 and 2.8 mph read 3.86 and 4.50 km/h. Incline 8 reached and held. |
| Engine boundaries | Intervals changed within 0.1 to 0.25 s of schedule (intervals at 20.1, 20.0, 20.0, 20.2 s). Each change is speed first, then incline, about 1 s apart. |
| Pause | Clock frozen at the tap. Belt stopped, confirmed 8.2 s after the tap from 2.8 mph. **The incline dropped to 0 at the stop.** |
| Pause freeze accuracy | Workout ran 100.0 s of workout time across a 62.2 s pause (end of workout at 252.7 + 100 + 62.2 = 414.9 s; observed 415.0 s). |
| Resume | Silent 3 s countdown, then start (the treadmill's own 3 s countdown), restart verified at the minimum, speed back to 2.8 mph, incline back to 8; running again 8.3 s after the tap. The engine restored the incline because it compares with the treadmill's own readings. |
| End of workout | Last interval ended, stop sent, confirmed 5.7 s later from 1.8 mph. Workout COMPLETED. |
| Stop time grows with speed | 2.0 mph: 6.6 s. 2.8 mph: 8.2 to 9.0 s. 1.8 mph: 5.7 s. About 0.6 km/h per second of deceleration, so 5 mph would take about 13 s, close to the 15 s stop-confirmation limit (only relevant if limits are ever raised beyond the presets). |
| Idle reading gap | One 4.4 s gap before Start was sent; it was allowed by the new 6 s idle limit (the old 3 s limit would have refused it). |

**Telemetry gaps, corrected diagnosis.** Reading the two Stage A reports and the Stage B report together: (1) every command write is followed by one missed reading, giving a 2.0 s gap that the 3 s limit tolerates; (2) the longer gaps (3.3 s, 2.6 s, 4.4 s) all coincide with Start taps. Those taps call `window.confirm()`, which freezes the page's JavaScript while the dialog is open, so incoming Bluetooth readings are not processed and the next check sees old data. The diagnostic page, which has no dialog, never showed such gaps. So the "idle pauses" were most likely the page's own blocking dialog, not the treadmill, and the 6 s idle limit was approved on that wrong diagnosis. Proposed fix: non-blocking in-page confirmations, then re-measure before deciding whether to restore the 3 s limit.

Simulator and tests updated to model the incline reset on Stop (and the keep-incline alternative). 138 tests pass.

### Build v3 / c7 (approved after Stage B was recorded)

- **Verified limits raised to 2.8 mph and incline 8** (`workout/limits.js`), the validated Stage B ceiling and exactly the top of the five presets. All five presets now load and run on the real limits in the simulator (57 engine tests). Anything above is still refused, never clamped, and the control layer enforces the same numbers again when the Controller is created with them. The Phase 2 control page keeps its own lower caps (1.0 mph, incline 2), as agreed.
- **Blocking dialogs removed.** The browser's confirm dialog froze the page while open, so readings were not processed and the next freshness check saw old data. Start (both pages) and Start workout (validation page) now use a non-blocking two-step confirmation: the first tap arms and shows the same warning, a second tap within 8 s confirms, doing nothing cancels, and an armed Start is dropped if it stops being allowed. A test guards that no page uses `confirm`, `alert` or `prompt`.
- **Idle reading limit kept at 6 s for now.** The next hardware run with no dialog will show whether the gaps are gone; if so the stricter 3 s limit can be restored.
- 146 tests pass (18 decoders, 47 controller, 57 engine, 18 validation, 6 confirmation). Mutation checks: raising or lowering the limits and breaking the confirm each fail tests.
- **Hardware check done (build v3, belt empty, Stage A page): PASSED.** Three Starts through the two-step confirm, a 2.0 mph jump and three Stops, no lockouts, **no refusals and no "Telemetry gap" lines**. At every Start tap the readings kept flowing (no gap at all around the taps), which confirms the diagnosis: the 3.3 to 4.4 s gaps were the page's own blocking dialog. The only gap left is the known 2.0 s (one missed reading) around some command writes. Restarts were at the minimum speed all three times. Stop confirmations took 6.3 s (from 2.0 mph), 3.0 s and 2.0 s (from the minimum). Since the reason for the 6 s idle limit is gone, the plan is to restore the 3 s limit in the next build.

## Next hardware-validation milestone (needs separate approval)

Staged, belt-empty validation of the preset range: raise the validated limits in two stages on a dedicated test page, each stage its own approval and its own remote-in-hand run:
- **Stage A:** up to 2.0 mph and incline 5. Includes the large step from the 0.6 mph minimum, and stop then restart in one connection (what speed does it restart at?).
- **Stage B:** up to 2.8 mph and incline 8, plus an explicit Pause/Resume cycle and a short real-time run of a preset-style interval change.

Only after Stage B is recorded would `VERIFIED_LIMITS` be raised, which is what makes the five presets runnable.
