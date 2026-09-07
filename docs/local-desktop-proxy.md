# Local Desktop proxy (v0.4.0-beta.1)

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
- This is event-driven, not an instantaneous/atomic UI guarantee. Native MCP
  startup, queued work and Desktop rendering add latency. A final authoritative
  read narrows but cannot eliminate the platform's read/write race.
- There is no periodic reconciliation. Recovered idle tasks already in In
  Progress can be repaired when a subsequent event occurs, but untouched tasks
  with no post-restart event are not scanned. More than 256 distinct concurrent
  task identities, missing events or persistent native-tool failures can require
  a later event/retry. Do not call this guaranteed lossless delivery.

## Privacy and permissions

The proxy has access to the local App Server stream just as the selected CLI
wrapper does. It forwards prompts/results without logging them; classification
uses only structured identity, membership and status. Native list/read responses
may contain previews, but the code neither interprets nor persists that text.
Diagnostic messages omit task content and raw server errors. No new TCP listener,
remote bridge, telemetry endpoint, credentials copy or analytics is installed.

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
