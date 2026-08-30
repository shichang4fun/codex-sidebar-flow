# Codex Sidebar Flow

Codex Sidebar Flow v0.2 uses a hybrid control plane: `UserPromptSubmit` observes and persists task identity, then optionally sends one content-free event envelope to an organizer task; when the private app-tools pipe is busy, it uses the public `additionalContext` contract to ask the current agent to reconcile only itself. `Stop` runs in the background, waits briefly, then directly moves only a task whose exact final read is authoritatively terminal. A recurring heartbeat repairs missed events and stopped tasks that were already in `In Progress`. Classification never follows task content.

> [!WARNING]
> Codex Hooks are supported, but custom-sidebar mutation currently depends on a private Codex Desktop app-tools pipe. This experimental macOS integration can break after a Desktop update.

## State rules

| Event or state | Destination |
|---|---|
| Active task observed in Tasks, For Review, or an eligible Project | In Progress |
| Authoritative `Stop` observes an idle, completed, failed, or needs-attention task in Tasks, In Progress, or an eligible Project | For Review |
| Heartbeat observes an idle, completed, failed, or needs-attention task already in In Progress | For Review |
| `UserPromptSubmit` lifecycle event | Observe identity, persist state, optionally wake organizer |
| Background `Stop` lifecycle event | After a final terminal read, move an eligible task from Tasks, In Progress, or an eligible Project to For Review; otherwise optionally wake organizer |
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

Existing v0.1 installations remain `eventWake.enabled=false` until setup publishes the current runtime, a trusted Hook records a probe for that exact runtime, and setup is rerun with `--enable-event-wake` and a confirmed organizer task ID. Do not infer the organizer from the current task.

If setup reports `LEGACY_HOOK_CONFLICT`, inspect the reported absolute path. Migrate it only when it is an older Sidebar Flow installation you recognize:

```bash
node scripts/setup.mjs --migrate-legacy-hook /absolute/path/to/sidebar-hook.mjs
```

The installer automatically migrates the prior standard `~/.codex/sidebar-flow/scripts/sidebar-hook.mjs` command. Other unmarked commands fail closed and are never removed without the exact option above.

Restart Codex Desktop after setup. The installer:

- preserves unrelated hooks;
- backs up `~/.codex/hooks.json`;
- installs only `UserPromptSubmit` and `Stop` handlers;
- creates or upgrades `~/.codex/sidebar-flow/config.json` with the exact install mode and runtime fingerprint;
- in source mode, stages the fixed runtime script set, verifies its SHA-256 fingerprint, and atomically publishes an immutable release under `~/.codex/sidebar-flow/releases/<runtimeFingerprint>` before changing Hooks. Existing releases are retained, and no `current` symlink is used. Plugin fingerprints cover that shared runtime plus the plugin manifest, Hook declaration, launcher, heartbeat renderer and prompt, and Sidebar Flow skill.

Setup does not silently create a scheduled model task. Event wake is model-triggering and user-visible, so enable it only with explicit user authorization. The event-wake fast path requires only the lifecycle Hook and a configured organizer task.

A hook installed on one machine does not receive events from another machine's Codex app server. [OpenAI's Hooks documentation](https://learn.chatgpt.com/docs/hooks) states that matching command Hooks run concurrently and that a background Hook cannot block. Sidebar Flow therefore keeps `UserPromptSubmit` synchronous for its optional `additionalContext` fallback, but runs `Stop` in the background. After a bounded delay, the background handler performs an exact final read and moves only a confirmed terminal task; if another Stop Hook continued the turn and it remains active, Sidebar Flow does not move it. The delay narrows the publication race but is not a synchronization barrier. The recurring heartbeat remains an independent global recovery path.

The repository is also a Codex plugin. Plugin installation and source installation are mutually exclusive:

- **Source mode**: run `node scripts/setup.mjs`; this writes global hooks.
- **Plugin mode**: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --plugin`; this creates configuration only because the plugin already supplies bundled hooks.

Cross-mode setup is rejected. To migrate plugin → source, first disable the plugin, run `node scripts/uninstall.mjs --plugin`, then run source setup. To migrate source → plugin, run `node scripts/uninstall.mjs`, enable the plugin, then run plugin setup. The plugin launcher uses only the fixed ChatGPT/Codex bundled Node paths instead of GUI `PATH`; a missing runtime produces a stable diagnostic and a failed Hook. It does not independently attest the bundled binary's code signature.

Plugin mode must use the same `CODEX_HOME` inherited by Codex Desktop. It rejects `--plugin --codex-home <path>` because a setup-only path cannot be carried into later lifecycle Hook processes. Set `CODEX_HOME` for the Desktop/plugin runtime before setup, or use source mode when an explicit installation path is required.

## Runtime model

- **Lifecycle Hooks**: synchronous `UserPromptSubmit` records authoritative identity and may provide the bounded self-move fallback. After a bounded delay, background `Stop` performs an exact `read_thread` and directly moves a confirmed terminal or attention-needing task from Tasks, In Progress, or an eligible Project to For Review. An active or internally conflicting final read fails closed.
- **Event wake**: when `eventWake.enabled=true` and a real Hook-context probe has confirmed `send_message_to_thread`, a Hook that did not directly reconcile may send one content-free envelope containing only `protocol`, `event`, `threadId`, and `hostId` to the configured organizer task. `UserPromptSubmit` may move only an authoritatively active task to In Progress; a delayed `Stop` envelope may move a confirmed terminal or attention-needing task from Tasks, In Progress, or an eligible Project to For Review. Immediately before a move, the organizer performs an exact `read_thread` and rechecks structured host, status, attention, kind, and membership. This narrows but cannot eliminate the platform time-of-check/time-of-use window; it is not an atomic compare-and-swap.
- **Agent self-move fallback**: a Desktop turn can temporarily own the private app-tools pipe, especially during `UserPromptSubmit`. A recognized transient transport/contention failure can return a bounded `hookSpecificOutput.additionalContext` instruction even when organizer event wake is disabled; non-retryable failures and capability-probe events fail closed. The current agent then uses its already-connected `list_threads`, exact `read_thread`, and at most one `move_thread_to_sidebar_section` call to move only itself to the configured In Progress section after checking structured status, attention flags, host identity, direct/Project membership, and parent protection. Excluded and organizer tasks never receive this context. This fallback is model-assisted, not a deterministic external daemon.
- **Deterministic reconciler**: the background Stop Hook handles confirmed local terminal transitions without a model; the organizer turn handles event-path movement; the recurring heartbeat performs independent global recovery.
- **Project tasks**: a task without direct membership uses its Project only as a source and protection signal. Reconciliation hydrates a uniquely identified Project-contained task with `read_thread` on its actual host before classification. Moving the task creates explicit task membership in the destination section; the Project itself is not moved.
- **Heartbeat recovery**: the recurring heartbeat performs global cross-host reconciliation and must call Codex task-management tools directly. It is the deterministic recovery path for missed events, unavailable remote event wake, and stopped tasks already in `In Progress`. A sandboxed heartbeat must not launch the native-pipe script because it lacks the trusted Desktop process context. Use the [audited prompt template](docs/heartbeat-prompt.md).

Render the heartbeat prompt with the exact organizer task ID before creating the automation:

```bash
node scripts/render-heartbeat.mjs --exclude <organizer-task-id>
```

When section names are customized, render the same policy explicitly with `--in-progress`, `--for-review`, and `--for-later`; setup, event wake, heartbeat, and the self-move fallback all reject invalid or built-in destination names.

Creation must fail if the placeholder remains or no exact organizer ID was supplied.

Enable event wake in two phases because capability is bound to both `installMode` and the SHA-256 fingerprint of the exact mode-specific runtime files. A setup that changes either binding succeeds with event wake forced disabled. `--enable-event-wake` fails with `CAPABILITY_PROBE_REQUIRED` before writing unless the latest strict probe result is `present` for the current binding and its request TTL has not expired.

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

If the probe is missing, pending, expired, belongs to another install mode/runtime fingerprint, or is not `present`, keep event wake disabled and retain the 5-minute heartbeat. The Hook recomputes the mode-specific fingerprint from its own actual files before it may record `present`. The probe confirms whether that exact runtime saw the trusted app-tools context and whether organizer wake stayed suppressed for that probe event. It does not prove end-to-end organizer movement by itself. During normal execution, each new AppTools connection still performs a live `tools/list` and fails closed when its required tools are absent; a prior capability result is never used as a substitute for that live check.

Keep the heartbeat at 5 minutes until live acceptance succeeds on the hosts you care about. Only after verified event-path acceptance should you consider 30-60 minutes. If remote acceptance is absent or fails, do not claim remote realtime behavior and keep the heartbeat interval short enough to cover the remote repair delay you still need.

With a five-minute heartbeat, an active task or a stopped task already in `In Progress` normally converges within five minutes even when event wake is unavailable. `UserPromptSubmit` does not infer short-task completion from a terminal observation. A later authoritative `Stop` can recover an eligible terminal task from Tasks, In Progress, or an eligible Project even if the start move was missed. If that `Stop` path is unavailable or misses the final state, the heartbeat can recover terminal state only for a task already observed in `In Progress`; a short task that starts and finishes entirely between polls can therefore remain unclassified. Short-task recovery is improved by `Stop`, but is not guaranteed.

Successful Hook observation and a successful background Stop direct move use zero model tokens. Event wake and heartbeat are model turns. A transient `UserPromptSubmit` pipe failure adds one short developer-context instruction to the current turn and normally causes one `list_threads`, one exact `read_thread`, and at most one move call; it does not start a separate fallback model turn, but it does add input/tool-result usage even when event wake is disabled. Event wake produces at most one organizer turn per eligible successfully delivered lifecycle event; exclusions, a successful direct Stop move, probe suppression, rate limits, capability failures, identity failures, and send failures can reduce that to zero. A heartbeat is a scheduled model turn: 5 minutes is 288 runs/day, 1 hour is 24, and 4 hours is 6. Actual token usage varies with the selected model and visible task count. Only the Hook-originated organizer envelope is content-free; the organizer or self-move fallback can expose visible titles, summaries, and status metadata to the selected model even though the audited instructions prohibit using visible text for decisions. Do not install the local fallback or enable event wake/heartbeat if that metadata boundary is unacceptable.

## Verify

```bash
npm test
npm run check
node scripts/doctor.mjs
```

Plugin mode uses `node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --plugin`. Without an active `CLAUDE_PLUGIN_ROOT`, `--plugin-root <path>` can validate package completeness but reports app enablement as unverified.

`doctor` validates static installation and reproduces the configured fingerprint from the source Hook's owned target root or the supplied plugin root; a merely well-formed stored hash is not accepted. Outside a trusted Hook it deliberately reports runtime capability as unverified; an observed-state acceptance test is still required. `doctor --probe` performs read-only `tools/list` and section checks when run in a trusted app-tools context. `doctor --arm-event-wake-probe` and `doctor --event-wake-probe-result` are the supported capability-gating path before claiming event wake works. The self-move fallback uses the documented [`UserPromptSubmit` additional-context output](https://learn.chatgpt.com/docs/hooks#userpromptsubmit); a capability probe does not prove that the current model will obey the injected instruction, so live movement acceptance remains required.

Hook diagnostics are written to `~/.codex/sidebar-flow/hook.log` with mode `0600` and one bounded rotation. Logs contain only bounded event, status/error-code, attempt, capability, fallback, and duration fields; they omit prompts, outputs, task titles, full task bodies, complete task IDs, executable paths, socket paths/basenames, and private tool error bodies.

## Configuration

Edit `~/.codex/sidebar-flow/config.json`. Section names must be unique. Add organizer task IDs to `excludeThreadIds`; content and summary substrings never control exclusion. Event wake remains disabled until `eventWake.enabled` is explicitly set through setup. A background `Stop` waits 3 seconds for Desktop turn finalization, then has a 14-second total Hook deadline; its command handler allows 20 seconds so fingerprint checks and bounded logging do not consume the mutation window.

Socket discovery is disabled by default. The supported path is the explicit `CODEX_APP_TOOLS_PIPE_PATH` inherited by a trusted Codex Hook. Enabling `allowSocketDiscovery` is for local debugging only.

## Uninstall

Run `node scripts/uninstall.mjs` from the source checkout. If the checkout was removed, use the `releaseRoot` printed by setup and run `node <releaseRoot>/scripts/uninstall.mjs`.

Source mode removes only Sidebar Flow entries from global hooks. A normal uninstall also disables event wake and removes the install-mode/runtime-fingerprint binding while preserving configuration and state. Plugin users should disable the plugin and run `node scripts/uninstall.mjs --plugin --purge` from the checkout; plugin mode never edits global hooks. Add `--purge` to remove configuration, state, installed runtime files, releases, and logs.

## Known boundaries

- The private Desktop sidebar protocol may change without notice.
- A local Hook cannot receive a remote app server's lifecycle event.
- Codex launches matching command Hooks concurrently. The Hook therefore observes and persists first, then may send one envelope to the organizer. If the app-tools pipe is unavailable during `UserPromptSubmit`, it can only inject a bounded self-move instruction into the current agent; that fallback depends on model/tool execution and fails closed on ambiguity.
- The organizer's exact final read reduces the read/move race but the platform exposes no atomic conditional move, so status or membership can still change before the move commits.
- Current public remote Hook/MCP capabilities do not expose the multi-step custom-sidebar workflow required by a cross-host event bridge; remote Hook installation is therefore capability-gated, not assumed, and remote realtime must not be claimed without live acceptance.
- Heartbeat recovery has a bounded delay but cannot reconstruct an event that occurred entirely between snapshots.
- `list_threads` is limited to 50 summaries. In Progress items outside that window require successful `read_thread` discovery or an authoritative managed host identity; otherwise the tool fails closed.
- There is no external backend or detached daemon. v0.2 remains a local Hook-plus-organizer-plus-heartbeat system.

## License

MIT
