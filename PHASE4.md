# Phase 4: the app (simulator-tested only, NOT deployed, NOT run on hardware)

Status: built and tested against the simulator and in a desktop browser. Nothing here has been sent to the real treadmill. It lives in `site/app/` (local only until deployment is approved).

## What it is

A static, framework-free web app (plain HTML, CSS and JavaScript modules) for Bluefy on the iPhone, in `site/app/`. Four screens, hash-routed:

| Screen | What it does |
|---|---|
| **Dashboard** | Treadmill connection, the three safety boxes, and every saved workout as a card (total time, intervals, speed and incline range). Start, Edit, Copy, move up and down, Delete (two-step). "Create workout". Your five presets are stored as ordinary, editable workouts on first run. |
| **Editor** | Name, description, ordered intervals. Per interval: category, time (+/- 1 min, +/- 5 s), speed (0.1 mph), incline (levels), move, copy, delete. Live total time. Limits and validation shown before Save. |
| **Workout** | Big countdown, progress bar, current interval and target, next interval, connection status, Start (two-step), Pause, Resume (3 s countdown), Stop, manual speed and incline changes, fault and recovery panels. Leaving is blocked while a workout is active or faulted. |
| **Settings** | Connection and diagnostics, what has been verified on this treadmill and what has not, export, import, restore presets, delete everything, items set aside by validation, recent activity. |

## Rules carried into the app

- Verified limits (2.8 mph, incline 8) are enforced in the editor, on save, on import, on load and by the engine; the control layer enforces them again at command time.
- **Manual override** (approved): +/- 0.1 mph and +/- 1 incline during a run, one queued command at a time, valid until the next interval; refused (no command, no fault) at any limit or while another change is in progress; dropped on pause, stop, fault or the next interval. Resume restores the plan, not the override.
- **Storage** (browser only, no account): unlimited workouts, validated on save/load/import, corrupt data backed up before replacement, failed or unavailable storage reported (work continues in memory), export/import JSON (import adds new workouts, never overwrites, lists what it refuses and why), "restore the five presets" (two-step).
- **No blocking dialogs anywhere**: every confirmation (Start, Delete, Restore, Delete all, discard edits) is a two-step button that keeps the page running.
- Safety checklist is never remembered between visits. The lockout can be reset only when the belt is confirmed stopped and the connection is back.
- Screen wake lock where the browser supports it, with plain instructions where it does not.
- The 3 s freshness limit is restored for readings (the 6 s idle relaxation was removed), because the gaps it was meant for were caused by the old blocking dialog.

## Tests

- **217 tests pass** across eleven files (`node --test test/<file>.test.mjs`): decoders 18, controller 46, engine 57, override 17, staged validation 18, confirmation 6, app logic 30 (formatting, editor operations incl. a 600-edit random test, library, view model, a real-engine run), Bluetooth session and wake lock 17, activity report 4, import-version hygiene 4.
- Mutation check: 10 deliberate breakages of the new layers (ignore limits, new workout claiming to be a preset, no upper speed clamp, no 5 s snapping, Start ignoring the checklist, lockout reset while the belt moves, ignoring a failed control-point subscription, stale listeners not ignored, override over the limit, override while not running) each made at least one test fail.
- Real pages driven in a desktop browser against the simulator: create and save a workout through the editor, run it with the two-step Start, manual override, pause, resume (silent countdown, plan restored), completion; a disconnect mid-run (fault banner, navigation blocked, belt reported as possibly running, nothing sent); recovery (take control, stop); export, import with a refused item, two-step restore. Phone-width layout checked (no sideways scrolling).
- Bugs found and fixed by the tests and browser runs: an override recorded when nothing was applied; the lockout reset being allowed while the belt moved; the `hidden` attribute being overridden by button styles (a duplicate Cancel and Resume showing); interval controls too wide for a phone.

## Activity report (build a2)

Settings has a "Copy activity report" button: the app log, once-a-second readings, engine and controller state. No device name, address or serial number (a test checks this, and caught one slip where the Bluetooth session logged the device name).

## Hardware check 1 (build a2, belt empty, one-minute "Check run", imported through Settings): PASSED

No lockouts, no refusals, no faults, no telemetry gap over about 1.1 s. Observations from the activity report:

| Step | Result |
|---|---|
| Import, open workout, connect, two-step Start | Worked. Start to running (take control, start, speed 1.0 mph) took 10.2 s from the second tap. |
| Manual override | Speed + three times: 1.1, 1.2, 1.3 mph read as 1.77, 1.93, 2.09 km/h; each acknowledged in 0.1 s, confirmed in 0.7 to 1.0 s. The override ended exactly at the interval boundary and the plan (2.0 mph, incline 3) took over. |
| Boundaries | Intervals changed within 0.1 to 0.25 s of schedule (20.2, 20.0 s). Each change is speed first, then incline, about 1 s apart. |
| Pause | Clock frozen at the tap (37.8 s into the workout). Belt stopped, confirmed 7.2 s later from 2.0 mph; incline returned to 0. |
| Resume | Silent 3 s countdown, then start; running at the minimum after another 3.4 s; speed 2.0 mph and incline 3 restored; resumed 8.5 s after the tap. The remaining 2.2 s of the interval ran, then interval 3. |
| Clock accuracy | 60.0 s of workout time across a 30.3 s pause: workout ended at the expected moment (observed 193.6 s, expected 193.4 s). |
| End | Final stop confirmed 3.5 s later from 1.0 mph. Workout COMPLETED. |
| Wake lock | The report shows the wake-lock status as "idle" at the end, which is what happens after it was granted and released at the end of the workout (a refusal would read "denied", an unsupported browser "unsupported"). Not proven by the log; the next build logs wake events. |

**Correction.** I earlier described a "one missed reading (2.0 s gap) after each command write". In this report, and on reflection in the earlier ones, there is no such gap in the real data: the page's own once-a-second recording keeps one reading per whole second, and a reading taken at the moment a command is sent used up that second, so the next regular reading was dropped from the LOG. The controller's own gap logging (which watches the real packet times) never reported a gap over 2 s. The 3 s limit has never been in real danger since the dialog was removed.

Not reported by the user: console readings, whether the ramp moved, and whether the screen stayed awake.

## Not verified on hardware (Phase 5)

- The app as a whole on the real phone and treadmill, including Bluefy's wake lock support and what a locked or backgrounded screen does.
- A full 20-minute preset run; losing the connection by walking out of range.
- Speed or incline changed from the remote during a workout is not detected.
- Timer-only mode is not built (not part of this phase).

## Deploying

Everything under `site/` is published by the existing workflow. The app would live at `/app/`. The shared control and workout modules changed (3 s limit restored, override, accessor), so the control page becomes build c8 and the validation page v4 in the same deploy.
