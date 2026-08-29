# Codex Sidebar Flow

Codex Sidebar Flow v0.2 uses a hybrid control plane: lifecycle Hooks observe and persist task identity, then optionally send one content-free event envelope containing only `protocol`, `event`, `threadId`, and `hostId` to an organizer task; the organizer reads confirmed state immediately before at most one targeted move; a recurring heartbeat repairs missed events and stopped tasks that were already in `In Progress`. Classification is deterministic and never follows task content.

> [!WARNING]
> Codex Hooks are supported, but custom-sidebar mutation currently depends on a private Codex Desktop app-tools pipe. This experimental macOS integration can break after a Desktop update.

## State rules

| Event or state | Destination |
|---|---|
| Active task observed in Tasks, For Review, or an eligible Project | In Progress |
| Idle, completed, failed, or needs-attention task observed in In Progress | For Review |
| `UserPromptSubmit` lifecycle event | Observe identity, persist state, optionally wake organizer |
| `Stop` lifecycle event | Observe identity, persist diagnostics, optionally wake organizer |
| Task or parent Project in Pinned or For Later | Never moved |

Membership is resolved from the real sidebar item key by task or Project ID. A lifecycle host hint must identify exactly one matching `<hostId>:<threadId>` row; without a hint, duplicate task IDs across hosts are ambiguous and fail closed. The key's host component is never trusted for execution: `read_thread` and move calls use the task's actual `hostId`. Managed identities use `<hostId>:<threadId>`. Visible task text is untrusted and never drives state decisions.

## Install

Requirements: macOS, Codex Desktop, Node.js 20+, and custom sections named `In Progress`, `For Review`, and `For Later`.

Source mode install/configure keeps event wake disabled first:

```bash
git clone https://github.com/shichang4fun/codex-sidebar-flow.git
cd codex-sidebar-flow
node scripts/setup.mjs
```

Plugin mode install/configure keeps event wake disabled first:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --plugin
```

Existing v0.1 installations remain `eventWake.enabled=false` until you rerun setup with `--enable-event-wake` and a confirmed organizer task ID. Do not infer the organizer from the current task.

If setup reports `LEGACY_HOOK_CONFLICT`, inspect the reported absolute path. Migrate it only when it is an older Sidebar Flow installation you recognize:

```bash
node scripts/setup.mjs --migrate-legacy-hook /absolute/path/to/sidebar-hook.mjs
```

The installer automatically migrates the prior standard `~/.codex/sidebar-flow/scripts/sidebar-hook.mjs` command. Other unmarked commands fail closed and are never removed without the exact option above.

Restart Codex Desktop after setup. The installer:

- preserves unrelated hooks;
- backs up `~/.codex/hooks.json`;
- installs only `UserPromptSubmit` and `Stop` handlers;
- creates `~/.codex/sidebar-flow/config.json` only when absent.
- copies the runtime, doctor, and uninstaller into `~/.codex/sidebar-flow/scripts`, so the checkout can be moved or removed.

Setup does not silently create a scheduled model task. Event wake is model-triggering and user-visible, so enable it only with explicit user authorization. The event-wake fast path requires only the lifecycle Hook and a configured organizer task.

A hook installed on one machine does not receive events from another machine's Codex app server. Hooks improve local activity identity but deliberately do not move sidebar items directly: [OpenAI's Hooks documentation](https://learn.chatgpt.com/docs/hooks) states that matching command Hooks run concurrently, so one Hook cannot know whether another Hook will block a prompt or continue a stopped turn. Confirmed event-path movement is performed by the organizer task after it receives the Hook envelope and reads confirmed state. The recurring heartbeat is an independent global recovery path.

The repository is also a Codex plugin. Plugin installation and source installation are mutually exclusive:

- **Source mode**: run `node scripts/setup.mjs`; this writes global hooks.
- **Plugin mode**: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --plugin`; this creates configuration only because the plugin already supplies bundled hooks.

Cross-mode setup is rejected. To migrate plugin → source, first disable the plugin, run `node scripts/uninstall.mjs --plugin`, then run source setup. To migrate source → plugin, run `node scripts/uninstall.mjs`, enable the plugin, then run plugin setup. The plugin launcher uses only the fixed ChatGPT/Codex bundled Node paths instead of GUI `PATH`; a missing runtime produces a stable diagnostic and a failed Hook. It does not independently attest the bundled binary's code signature.

## Runtime model

- **Lifecycle observer**: `UserPromptSubmit` and `Stop` record the current task's authoritative identity and bounded diagnostics. Neither event mutates the sidebar before sibling Hook outcomes are known.
- **Event wake**: when `eventWake.enabled=true` and a real Hook-context probe has confirmed `send_message_to_thread`, the Hook sends one content-free envelope containing only `protocol`, `event`, `threadId`, and `hostId` to the configured organizer task. The organizer handles an already-terminal `UserPromptSubmit` as a short-task completion, performs an exact final `read_thread`, rechecks structured host, status, attention, kind, and membership, and then performs at most one targeted move. This narrows but cannot eliminate the platform time-of-check/time-of-use window; it is not an atomic compare-and-swap.
- **Deterministic reconciler**: the organizer turn reads confirmed task status and performs event-path movement; the recurring heartbeat performs independent global recovery.
- **Project tasks**: a task without direct membership uses its Project only as a source and protection signal. Moving the task creates explicit task membership in the destination section; the Project itself is not moved.
- **Heartbeat recovery**: the recurring heartbeat performs global cross-host reconciliation and must call Codex task-management tools directly. It is the deterministic recovery path for missed events, unavailable remote event wake, and stopped tasks already in `In Progress`. A sandboxed heartbeat must not launch the native-pipe script because it lacks the trusted Desktop process context. Use the [audited prompt template](docs/heartbeat-prompt.md).

Render the heartbeat prompt with the exact organizer task ID before creating the automation:

```bash
node scripts/render-heartbeat.mjs --exclude <organizer-task-id>
```

Creation must fail if the placeholder remains or no exact organizer ID was supplied.

Enable event wake in two phases because `doctor` treats enabled-without-successful-probe as unhealthy.

Source mode:

1. Install/configure while disabled: `node scripts/setup.mjs`
2. Arm the one-shot probe: `node scripts/doctor.mjs --arm-event-wake-probe`
3. Submit one real disposable Codex prompt on the target host.
4. Read the result: `node scripts/doctor.mjs --event-wake-probe-result`
5. Require probe status `present`, then enable explicitly:
   `node scripts/setup.mjs --enable-event-wake --organizer-thread-id <organizer-task-id> --organizer-host-id local`
6. Verify: `node scripts/doctor.mjs`

Plugin mode:

1. Install/configure while disabled: `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --plugin`
2. Arm the one-shot probe: `node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --plugin --arm-event-wake-probe`
3. Submit one real disposable Codex prompt on the target host.
4. Read the result: `node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --plugin --event-wake-probe-result`
5. Require probe status `present`, then enable explicitly:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --plugin --enable-event-wake --organizer-thread-id <organizer-task-id> --organizer-host-id local`
6. Verify: `node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --plugin`

If the probe is missing, pending, expired, or not `present`, keep event wake disabled and retain the 5-minute heartbeat. The probe confirms whether a real lifecycle Hook saw the trusted app-tools context and whether organizer wake stayed suppressed for that probe event. It does not prove end-to-end organizer movement by itself.

Keep the heartbeat at 5 minutes until live acceptance succeeds on the hosts you care about. Only after verified event-path acceptance should you consider 30-60 minutes. If remote acceptance is absent or fails, do not claim remote realtime behavior and keep the heartbeat interval short enough to cover the remote repair delay you still need.

With a five-minute heartbeat, an active task or a stopped task already in `In Progress` normally converges within five minutes even when event wake is unavailable. A supported `UserPromptSubmit` or `Stop` event wake can move an already-terminal short task from Tasks, In Progress, or an eligible Project task to For Review; heartbeat terminal recovery deliberately does not sweep those historical sources. If every applicable post-outcome event is dropped, a task that starts and finishes entirely between polls remains unobservable. This is a platform boundary, not a real-time guarantee.

Hook observation uses zero model tokens. Event wake and heartbeat are model turns. Event wake produces at most one organizer turn per eligible successfully delivered lifecycle event; exclusions, duplicate suppression, probe suppression, rate limits, capability failures, identity failures, and send failures can reduce that to zero. A heartbeat is a scheduled model turn: 5 minutes is 288 runs/day, 1 hour is 24, and 4 hours is 6. Actual token usage varies with the selected model and visible task count. Only the Hook-originated organizer envelope is content-free; the organizer's subsequent `list_threads` and `read_thread` results can expose visible titles, summaries, and status metadata to the selected model even though the audited prompts prohibit using visible text for decisions. Do not enable event wake or heartbeat if that metadata boundary is unacceptable.

## Verify

```bash
npm test
npm run check
node scripts/doctor.mjs
```

Plugin mode uses `node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --plugin`. Without an active `CLAUDE_PLUGIN_ROOT`, `--plugin-root <path>` can validate package completeness but reports app enablement as unverified.

`doctor` validates static installation. Outside a trusted Hook it deliberately reports runtime capability as unverified; an observed-state acceptance test is still required. `doctor --probe` performs read-only `tools/list` and section checks when run in a trusted app-tools context. `doctor --arm-event-wake-probe` and `doctor --event-wake-probe-result` are the supported capability-gating path before claiming event wake works.

Hook diagnostics are written to `~/.codex/sidebar-flow/hook.log` with mode `0600` and one bounded rotation. Logs omit prompts, outputs, task titles, full task bodies, lifecycle fingerprints, and private tool error bodies.

## Configuration

Edit `~/.codex/sidebar-flow/config.json`. Section names must be unique. Add organizer task IDs to `excludeThreadIds`; content and summary substrings never control exclusion. Event wake remains disabled until `eventWake.enabled` is explicitly set through setup.

Socket discovery is disabled by default. The supported path is the explicit `CODEX_APP_TOOLS_PIPE_PATH` inherited by a trusted Codex Hook. Enabling `allowSocketDiscovery` is for local debugging only.

## Uninstall

```bash
node ~/.codex/sidebar-flow/scripts/uninstall.mjs
```

Source mode removes only Sidebar Flow entries from global hooks. Plugin users should disable the plugin and run `node scripts/uninstall.mjs --plugin --purge` from the checkout; plugin mode never edits global hooks. Add `--purge` to remove configuration, state, installed runtime files, and logs.

## Known boundaries

- The private Desktop sidebar protocol may change without notice.
- A local Hook cannot receive a remote app server's lifecycle event.
- Codex launches matching command Hooks concurrently. The Hook therefore observes and persists first, then may send one envelope to the organizer; it does not mutate the sidebar directly.
- The organizer's exact final read reduces the read/move race but the platform exposes no atomic conditional move, so status or membership can still change before the move commits.
- Current public remote Hook/MCP capabilities do not expose the multi-step custom-sidebar workflow required by a cross-host event bridge; remote Hook installation is therefore capability-gated, not assumed, and remote realtime must not be claimed without live acceptance.
- Heartbeat recovery has a bounded delay but cannot reconstruct an event that occurred entirely between snapshots.
- `list_threads` is limited to 50 summaries. In Progress items outside that window require successful `read_thread` discovery or an authoritative managed host identity; otherwise the tool fails closed.
- There is no external backend or detached daemon. v0.2 remains a local Hook-plus-organizer-plus-heartbeat system.

## License

MIT
