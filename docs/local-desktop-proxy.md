# Local Desktop proxy (v0.4.0-beta.2 candidate, unreleased)

This page describes the current development branch, not the unchanged published
v0.4.0-beta.1 tag. See [periodic compensation](local-compensation.md),
[local lifecycle validation](local-new-task-validation.md) and the
[release notes draft](release-notes-beta.2.md). Optional
[original-icon integration](original-icon.md) enables the original icon to load
the same proxy. The dedicated-launch behavior below applies without that opt-in.
Disable original-icon integration before using the original icon as a bypass or
uninstalling the proxy.

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

Requirements: macOS, the [tested Desktop build](#verification-status), Node 20+ (Node 22+ for the
separate WebSocket research tests), and exactly one custom section each named
`In Progress`, `For Review`, `For Later`. Supply your actual absolute paths:

```sh
git clone --branch feat/local-periodic-reconciliation https://github.com/shichang4fun/codex-sidebar-flow.git
cd codex-sidebar-flow
node scripts/install-desktop-proxy.mjs \
  --root /absolute/private/sidebar-flow-desktop \
  --node /absolute/path/to/node \
  --app /Applications/ChatGPT.app \
  --codex /Applications/ChatGPT.app/Contents/Resources/codex \
  --exclude YOUR_ORGANIZER_TASK_ID
```

The branch is moving: inspect `git rev-parse HEAD` and compare it with the exact
reviewed commit before installation. A candidate version string is not proof of
publication or acceptance. Other app names/paths require matching build checks.

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
excluded IDs. Only root local Codex tasks are eligible (not subagents, ephemeral
or archived tasks). Standalone tasks require one unambiguous direct membership in
Tasks/In Progress/For Review. Local Project children are also eligible when their
parent has one unambiguous ordinary Projects membership; a child with no direct
membership is treated as a Tasks candidate.

Only the child task moves: its `projectId` and parent Project placement remain
unchanged. Project containers are never moved. Pinned, For Later, other custom
sections and ambiguous membership fail closed for both the child and its parent.
In particular, children of Pinned Projects remain untouched even without their
own pinned membership. The same safeguards are refreshed before every write.
Remote tasks and excluded identities remain untouched. A local task is not
blocked merely because a remote host is offline.

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

To roll back an upgrade:

1. Preserve a private copy of the installation's config, then atomically set its
   `mode` to `disabled`. Finish work and quit the app normally; an already-issued
   move may finish before shutdown. Do not force-quit.
2. Use a separate trusted checkout of the previous accepted commit. Run that
   checkout's `install-desktop-proxy.mjs` with the same root and verified app,
   Node and CLI paths. This selects the previous content-hashed runtime without
   resetting the working repository, deleting snapshots or overwriting config.
3. Verify `installation.json` references the expected previous runtime hash.
   Restore the intended mode atomically, retaining current exclusions. Relaunch
   with the dedicated entry, or the original icon if its unchanged owned
   integration is still enabled. Recheck real start/completion placement.

Original-icon support is installed separately: proxy reinstall does not replace
that helper. If it is the cause, disable it first and use the dedicated entry;
follow its guide before replacing an owned helper or changing target paths.

To undo uninstall, move the reported backup back only if the original destination
is absent, then use the installed entry. Never overwrite newer user files blindly.
Backups are not deleted automatically. No rollback step requires legacy Hooks or
a heartbeat.

## Verification status

The accepted development baseline is commit
`a3dc1514fd6c36e072f2dae69c03c95bd017f165`, Desktop runtime
`6f25af2678ab8e740445d06a6f5c0490f1a3221224d8b00f95a2d876066fc96d`.
The release-closeout environment reports ChatGPT Desktop **26.908.40834 (8881)**
and bundled Codex CLI **0.154.0-alpha.6.2**. This is the compatibility boundary;
the Codex product name does not imply support for every standalone Codex app build.

The maintainer's real acceptance covers ordinary GUI tasks and local children of
ordinary Projects: active → In Progress → completed → For Review, unchanged
`projectId`/Project placement, Pinned Project/Pinned/For Later protections, and
observer startup through the original icon. The recorded timed sample resumed
existing tasks; it is not a new-task-creation or latency benchmark. See
[detailed evidence and boundaries](local-new-task-validation.md).

Real approval/cancellation UI lifecycles, broader build/host compatibility and
long-running reliability remain unverified. A new installation's
`proxy-attached` status proves only transport attachment; retest actual movements
after installation or Desktop updates. Isolated App Server tests do not substitute
for these GUI checks.
