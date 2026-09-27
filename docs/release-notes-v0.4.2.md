# Codex Sidebar Flow v0.4.2

## Fix

Opening an idle historical task is not a new execution. Local status grouping
now preserves its placement instead of automatically moving it to For Review.
Terminal snapshots need execution evidence or existing In Progress placement;
explicit terminal turn events can recover a missed start. Tasks already in
For Review stay there. Active and attention handling is unchanged.

Direct Pinned and For Later protections still take precedence. Project-child
tasks use the same lifecycle rules; Project containers are not moved. This
change introduces no remote enumeration, legacy Hooks, or model heartbeat.

## Verification and limits

- Automated suite: 358 tests, 355 passed, zero failed, three opt-in tests skipped.
- Those three bundled App Server isolated transport tests passed separately.
- Syntax checks: `npm run check` and `npm run check:desktop` passed.
- On ChatGPT Desktop 26.924.20706 (11431), the user confirmed after relaunch
  that opening an idle historical task without execution did not move it.
- The current task's real start moved in approximately 484 ms, measured by the
  observer rather than rendered pixels.

The historical-task result is a user-reported GUI sample, not an exhaustive
GUI boundary test. Isolated transport tests do not verify Desktop rendering.
Other Desktop builds require independent verification. A missed start and
completion with no In Progress placement deliberately leaves the task alone;
an idle snapshot cannot distinguish untouched history from missed execution.
Native move operations still have a non-atomic final-read/write race.

## Installation and rollback

Use the existing [Desktop proxy installation instructions](local-desktop-proxy.md)
with this version's source and the installed app's actual bundled CLI path.
Fully quit and reopen the app to load an updated runtime; existing running
processes keep their old code. Preserve your existing configuration.

To roll back, reinstall the previously working source/runtime using those same
local app and CLI paths, then fully quit and reopen. Version v0.4.1 restores the
old behavior, including the historical-idle misclassification fixed here.
Rollback does not undo earlier sidebar movements; restore those manually.
