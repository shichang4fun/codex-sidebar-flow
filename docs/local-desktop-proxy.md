# Local Desktop proxy (v0.4.0-beta.1)

This page describes the published beta. For the unpublished local compensation
addition in this checkout, see [periodic compensation](local-compensation.md).
For the unpublished Project/new-task lifecycle fix, see
[local new-task validation](local-new-task-validation.md). The published beta's
Project exclusion below does not describe that working-checkout change.
For optional original-icon startup in this checkout (not the published beta),
see [original-icon integration](original-icon.md). The dedicated-launch behavior
below describes installations without that additional opt-in. Disable the
original-icon integration before relying on the original icon as a bypass or
following this page's uninstall/recovery instructions.

This opt-in path observes the original Desktop App Server stdio stream and calls
the native `codex_app` read/move tools. It does not start model turns for sorting,
scan conversation files, change the signed app, install Hooks, or require a
heartbeat. Local rule evaluation does not consume model tokens.

## What persistent installation means

Use the installed **Codex Sidebar Flow.app** or `.command` entry every time you
start Codex. It supplies `CODEX_CLI_PATH` to that exact launch. The installation
and entry survive logout/reboot; the original Codex icon does **not** inherit this
configuration. To bypass the proxy, quit Codex normally and then launch the
original icon. Opening that icon while Codex is running only activates the
existing process; it does not detach the proxy.
There is no global launchctl override and no automatic restart of running work.

If Codex is already running without this installed proxy, the command reports
`restart-required`. Run the entry with `--wait-for-quit`, finish running work and
quit Codex normally; the launcher waits up to 30 minutes and starts the configured
app only after it exits. It never kills the app. `launch-status.json` records
attachment separately from actual task-movement acceptance.

## Setup

Requirements: macOS, a compatible Codex Desktop build, Node 20+ (Node 22+ for the
separate WebSocket research tests), and exactly one custom section each named
`In Progress`, `For Review`, `For Later`. Supply your actual absolute paths:

```sh
git clone --branch v0.4.0-beta.1 https://github.com/shichang4fun/codex-sidebar-flow.git
cd codex-sidebar-flow
node scripts/install-desktop-proxy.mjs \
  --root /absolute/private/sidebar-flow-desktop \
  --node /absolute/path/to/node \
  --app /Applications/Codex.app \
  --codex /Applications/Codex.app/Contents/Resources/codex \
  --exclude YOUR_ORGANIZER_TASK_ID
```

The parent installation directory must exist. The dedicated root must be new or
owned by this installer. Runtime files are content-hashed snapshots, not links
into the checkout. Reinstall preserves `config.json`; it does not silently enable
a disabled policy. Update the app/Node paths on reinstall if their locations
change. No account login or GitHub credential is required.

## Migrating from the legacy Hook installation

First pause your Sidebar Flow organizer heartbeat in Codex. For source mode, run
`node scripts/uninstall.mjs` from the old checkout; for plugin mode, disable the
plugin and run `node scripts/uninstall.mjs --plugin`. This removes the owned Hook
and managed agent-instruction paths; review its output and preserve unrelated
Hooks/instructions. Keep any backup it reports. Quit Codex normally after work
finishes, then start it using the new dedicated entry. Do not enable the legacy
plugin again alongside this proxy for the same tasks.

This installer deliberately does not inspect or disable existing automations,
third-party Hooks or other installations. Excluding an organizer ID from proxy
classification does not stop that organizer from making its own moves.

## Scope and hot configuration

The default installation config explicitly selects `all-local` and the supplied
excluded IDs. Only ordinary, non-Project, root local Codex tasks with an unambiguous
direct membership in Tasks/In Progress/For Review are eligible. Remote tasks,
Projects and their child tasks, Pinned, For Later, other custom sections, archived
tasks and ambiguous identities remain untouched. A local task is not blocked
merely because a remote host is offline.

Each event and each native operation re-reads `config.json`. To stop future writes
without restarting, set `mode` to `disabled`. For a limited rollout use:

```json
{"version":1,"mode":"allowlist","threadIds":["YOUR_TEST_TASK_ID"],"excludedThreadIds":["YOUR_ORGANIZER_TASK_ID"]}
```

Malformed/missing config disables observer operations, not the underlying Codex
transport. Write config atomically to avoid transient parse failures. Config text
is never interpreted as executable code.

## State rules and limits

- Confirmed active without attention flags → In Progress.
- Approval/user-input attention → For Review; resumed activity → In Progress.
- Confirmed idle/systemError after observed activity, or already in In Progress
  → For Review. Cancellation is handled when the server reports idle.
- Unknown status/flags, missing identities or native-tool errors → no move.
- Pending events are coalesced per task with original start evidence retained.
  Work is serialized. At most 256 task observers are retained; completions of
  already observed tasks are admitted even under pending-event pressure.
- In this unpublished checkout, lifecycle evidence is projected immediately on
  receipt, independently of the native RPC queue. Equal known state/turn events
  share an in-flight transaction; new turn identities, attention changes and
  unknown events supersede obsolete work. There is no persistent status cache.
  Superseded reads finish at the transport level but cannot dispatch the old
  move or schedule a stale retry. An already-dispatched write still gets its
  fresh readback, followed by the newer event's transaction. A recovery-context
  observer is discarded before switching back to a task's own event context.
  These changes save duplicate/obsolete work, not the three fresh sidebar
  snapshots required for a successful move or the platform's own RPC latency.
- This is event-driven, not an instantaneous/atomic UI guarantee. Native MCP
  startup, queued work and Desktop rendering add latency. A final authoritative
  read narrows but cannot eliminate the platform's read/write race.
- Periodic reconciliation repairs missed events using loaded local contexts and
  bounded, rotating batches from the native list. `reconcileIntervalSeconds`
  defaults to 60; set it to 600 for ten-minute compensation or 0 to disable.
  Startup checks begin after five seconds. Pending lifecycle work defers a scan
  by five seconds; completed scans use the configured interval. Already-issued
  reads are not cancelled. Native visibility limits and persistent failures can
  still require a later event/retry; this is not guaranteed lossless delivery.
- Only native Desktop list reads have a 35-second deadline to cover cold startup.
  Identical in-flight reads share work within one context, without caching settled
  responses. Writes retain their original deadline and fresh protection checks.

## Privacy and permissions

The proxy has access to the local App Server stream just as the selected CLI
wrapper does. It forwards prompts/results without logging them; classification
uses only structured identity, membership and status. Native list/read responses
may contain previews, but the code neither interprets nor persists that text.
Diagnostic messages omit task content and raw server errors. No new TCP listener,
remote bridge, telemetry endpoint, credentials copy or analytics is installed.

Installed proxies write content-free timing summaries to `timings.jsonl` in the
private installation root. Records contain PID, task ID, event kind, timestamps,
queue/execution durations, native call counts/durations and result category; they
never include prompts, titles, tool arguments or raw errors. One record is written
per processed queue entry, not per token or event in a burst. The file is mode
0600 and capped at 256 KiB (old records are discarded when full). Unsafe links,
non-private files and write errors are rejected without stopping classification.
The recoverable uninstaller moves this log with the installation directory.

`queueMs` begins when the manager enqueues an entry; it does not measure the time
before the notification reaches the proxy. `moveAfterMs` measures enqueue to the
move RPC settling, not screen rendering or successful verification; consult
`action` too. `readbackMs` covers the remaining execution after that RPC. Retries
produce separate attempt records. These fields reveal plugin queuing and native
query costs without claiming an atomic UI transition.
An `action` of `superseded` records a safely abandoned prewrite transaction,
not an RPC failure or successful sidebar move. Its successor has its own record.

The `CODEX_CLI_PATH` selection and direct Desktop MCP behavior are version-specific
implementation capabilities, not a promised third-party plugin contract. Retest
after Codex updates. The launcher is unsigned; macOS policy may prevent opening
the `.app` entry, in which case use the `.command` entry. Do not disable Gatekeeper.

## Uninstall and recovery

Use the installed `Uninstall Codex Sidebar Flow.command`; keeping the source
checkout is not required. Alternatively, from this checkout:

```sh
node scripts/install-desktop-proxy.mjs --root /absolute/private/sidebar-flow-desktop --uninstall
```

The entire owned directory is moved to a uniquely named adjacent backup, preserving
the original config. The running proxy's config path then disappears and future
observer operations fail closed. Codex itself is not stopped. Launch the original
Codex icon after exiting normally. A live installer/launcher lock blocks uninstall
to avoid racing a pending app launch; stale PID locks are checked and recovered.

To roll back an upgrade, restore the previous runtime via its retained release and
review the launcher/manifest paths. To undo uninstall, move the reported backup
back only if the original destination is absent, then use the installed entry.
Never overwrite newer user files blindly. Backups are not deleted automatically.

## Verification status

On 2026-09-07, the installed all-local path had real Desktop start/completion
evidence for two local tasks on bundled Codex CLI 0.153.4. Measured start
acknowledgement to native move response was approximately 0.4–1.9 seconds; this
is not UI-render latency or an SLA. All-local discovery, hot disable, protection
rules, event bursts and recoverable installation have automated tests.

A third ordinary task, a second normal launch through the installed entry, and
real approval/cancellation UI lifecycles remain deployment acceptance gaps.
A new installation's `proxy-attached` status proves only transport attachment;
verify actual task movement and normal relaunch on that installation. The beta
does not claim general compatibility with other Desktop builds.
