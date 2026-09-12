# Local periodic compensation patch

Version: `0.4.0-beta.1+local.reconcile` (unpublished). This extends the released
beta; it does not alter the GitHub tag or re-enable legacy Hooks/agent heartbeat.

## Operation

The existing proxy runs a check five seconds after startup, then waits sixty
seconds after each check finishes. Real lifecycle events remain the primary
path. There is no model invocation, new task, task resume, extra daemon or
listening socket. Native tool calls run against an already-loaded local task
context, while explicit read/move arguments identify the independently validated
target. An unloaded target need not be started merely to inspect it.

Each round uses the native recent-task snapshot, currently limited by Desktop to
50 non-pinned tasks. Protected, remote, Project, archived, excluded and ambiguous
tasks are skipped. At most 20 eligible tasks are checked per round in rotating
order. Scheduling new candidates stops after a ten-second soft budget; an
in-flight transaction is allowed to finish. Writes share the real-event queue.

- Confirmed active tasks without attention flags belong in In Progress.
- Confirmed attention belongs in For Review.
- Idle/systemError tasks stuck in In Progress return to For Review.
- An ordinary idle task in Tasks is not evidence of a missed completion.
- Unknown/unavailable identities or states never authorize a move.

This is bounded recovery, not a sixty-second SLA or full-history repair. More
than twenty eligible tasks need multiple rounds. Tasks absent from the recent-50
snapshot, missing native-tool contexts, app shutdown, suspension and persistent
tool errors can delay/prevent compensation. A turn whose entire start and finish
were missed while it remained in Tasks cannot be reconstructed from idle status.
The platform still has no atomic compare-and-move operation.

## Configuration

In the installation's `config.json`, existing policy and exclusions are preserved.
The new optional field defaults to sixty seconds:

```json
{
  "version": 1,
  "mode": "all-local",
  "threadIds": [],
  "excludedThreadIds": ["YOUR_ORGANIZER_TASK_ID"],
  "reconcileIntervalSeconds": 60
}
```

Use `reconcileIntervalSeconds: 0` to stop compensation while keeping live events.
Valid nonzero values are integers from 15 to 3600. `mode: "disabled"` stops both
paths. Changes are checked again before native operations; the next scheduled
wake reloads the interval. Disabled/invalid settings are rechecked in about sixty
seconds. Uninstall removes the config path and disables future observer calls.

One content-free diagnostic per check records outcome, checked/moved/error counts
on stderr. There are no prompts, titles, task IDs, raw native errors or external
telemetry in compensation diagnostics. `unavailable/no-native-context` is not
reported as a successful repair. Native tools may return preview text, but the
code neither classifies from nor stores it.

## Install and activate

Run the [dedicated installer](local-desktop-proxy.md#setup) **from this local
checkout**, omitting that guide's clone command for the old beta tag. Existing
config and old immutable runtime snapshots are retained. The installer does not
replace code inside a running process: quit Codex normally after work finishes,
then reopen through **Codex Sidebar Flow.app** or its launch command, or through
the original icon after [explicitly enabling original-icon startup](original-icon.md). The old
launcher/runtime can be retained for rollback; do not delete its snapshot.

Automated tests cover missed-event repairs, exclusions, idempotency, rotating
batches, hot disable, loaded executor/unloaded target separation, timer startup
without lifecycle events and EOF shutdown. Isolated real App Server tests cover
loaded-task discovery and recovery from a stale section. Actual Desktop timer
operation still requires acceptance after the new runtime is launched.
