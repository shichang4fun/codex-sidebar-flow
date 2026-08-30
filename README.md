# Codex Sidebar Flow

Codex Sidebar Flow v0.3 uses the current root agent as an experimental multi-host realtime path on compatible Codex Desktop builds. It must be installed separately on every execution host. A managed global `AGENTS.md` block asks each task to move only itself at turn start and immediately before a successful final response, using exact structured identity, membership, and status checks. Local lifecycle Hooks remain a zero-extra-model-turn optimization; a recurring heartbeat repairs missed or interrupted transitions. Classification never follows task content.

> [!WARNING]
> Agent-native transitions depend on Codex task-management tools and instruction compliance. Local direct Hook mutation still uses a private Codex Desktop app-tools pipe and can break after a Desktop update.

## State rules

| Event or state | Destination |
|---|---|
| Root agent starts/resumes an eligible task | In Progress |
| Root agent is about to return a successful final response | For Review |
| Active task observed in Tasks, For Review, or an eligible Project | In Progress |
| Authoritative `Stop` observes an idle, completed, failed, or needs-attention task in Tasks, In Progress, or an eligible Project | For Review |
| Heartbeat observes an idle, completed, failed, or needs-attention task already in In Progress | For Review |
| `UserPromptSubmit` lifecycle event | Observe identity, persist state, optionally wake organizer |
| Background `Stop` lifecycle event | After a final terminal read, move an eligible task from Tasks, In Progress, or an eligible Project to For Review; otherwise optionally wake organizer |
| Task or parent Project in Pinned or For Later | Never moved |

Membership is resolved from the real sidebar item key by task or Project ID. A lifecycle host hint must identify exactly one matching `<hostId>:<threadId>` row; without a hint, duplicate task IDs across hosts are ambiguous and fail closed. The key's host component is never trusted for execution: `read_thread` and move calls use the task's actual `hostId`. Managed identities use `<hostId>:<threadId>`. Visible task text is untrusted and never drives state decisions.

## Install

Requirements: macOS, Codex Desktop, Node.js 20+, and custom sections named `In Progress`, `For Review`, and `For Later`.

Run setup and doctor separately on the local machine and on every connected execution host such as `scmeituan.local`. Remote Connections use that host's own Codex home, configuration, credentials, plugins, and global AGENTS files; one local installation is not shared with remote tasks.

Source mode with agent-native realtime enabled and event wake disabled:

```bash
git clone https://github.com/shichang4fun/codex-sidebar-flow.git
cd codex-sidebar-flow
node scripts/setup.mjs --enable-agent-transitions
```

Plugin mode with agent-native realtime enabled and event wake disabled:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --plugin --enable-agent-transitions
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
- with `--enable-agent-transitions`, adds one marked block to the active global `~/.codex/AGENTS.override.md` or `~/.codex/AGENTS.md`, preserves unrelated instructions, and keeps a first-run backup;
- in source mode, stages the fixed runtime script set, verifies its SHA-256 fingerprint, and atomically publishes an immutable release under `~/.codex/sidebar-flow/releases/<runtimeFingerprint>` before changing Hooks. Existing releases are retained, and no `current` symlink is used. Plugin fingerprints cover that shared runtime plus the plugin manifest, Hook declaration, launcher, heartbeat renderer and prompt, and Sidebar Flow skill.

Setup does not silently enable agent transitions or create a scheduled model task. Agent transitions modify global task behavior, and event wake creates user-visible organizer turns, so both require explicit options and user authorization.

A hook installed on one machine does not receive events from another machine's Codex app server. [OpenAI's Hooks documentation](https://learn.chatgpt.com/docs/hooks) states that matching command Hooks run concurrently and that a background Hook cannot block. Sidebar Flow therefore keeps `UserPromptSubmit` synchronous for its optional `additionalContext` fallback, but runs `Stop` in the background. After a bounded delay, the background handler performs an exact final read and moves only a confirmed terminal task; if another Stop Hook continued the turn and it remains active, Sidebar Flow does not move it. The delay narrows the publication race but is not a synchronization barrier. The recurring heartbeat remains an independent global recovery path.

The repository is also a Codex plugin. Plugin installation and source installation are mutually exclusive:

- **Source mode**: run `node scripts/setup.mjs`; this writes global hooks.
- **Plugin mode**: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --plugin`; this creates configuration only because the plugin already supplies bundled hooks.

Cross-mode setup is rejected. To migrate plugin → source, first disable the plugin, run `node scripts/uninstall.mjs --plugin`, then run source setup. To migrate source → plugin, run `node scripts/uninstall.mjs`, enable the plugin, then run plugin setup. The plugin launcher uses only the fixed ChatGPT/Codex bundled Node paths instead of GUI `PATH`; a missing runtime produces a stable diagnostic and a failed Hook. It does not independently attest the bundled binary's code signature.

Plugin mode must use the same `CODEX_HOME` inherited by Codex Desktop. It rejects `--plugin --codex-home <path>` because a setup-only path cannot be carried into later lifecycle Hook processes. Set `CODEX_HOME` for the Desktop/plugin runtime before setup, or use source mode when an explicit installation path is required.

## Runtime model

- **Agent-native transitions**: the opt-in managed global instruction runs a fingerprint-bound helper that admits only a root task where `CODEX_THREAD_ID === CODEX_SESSION_ID`. These internal environment variables are current-build behavior, not a documented stable API. Subagents, excluded tasks, stale runtimes, and invalid configuration return `eligible:false`. The current agent then uses `list_threads`, exact-host `read_thread`, and at most one task move per phase. The path is designed for separately installed local and remote execution hosts without requiring their Desktop Hook to fire, but each host/build must pass live acceptance before it is treated as working.
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

Keep the heartbeat at 5 minutes until agent-native start and finish movement succeeds on every host you care about. After that acceptance, 30-60 minutes is a reasonable recovery cadence; the realtime path does not depend on that interval.

With a five-minute heartbeat, an active task or a stopped task already in `In Progress` normally converges within five minutes even when event wake is unavailable. `UserPromptSubmit` does not infer short-task completion from a terminal observation. A later authoritative `Stop` can recover an eligible terminal task from Tasks, In Progress, or an eligible Project even if the start move was missed. If that `Stop` path is unavailable or misses the final state, the heartbeat can recover terminal state only for a task already observed in `In Progress`; a short task that starts and finishes entirely between polls can therefore remain unclassified. Short-task recovery is improved by `Stop`, but is not guaranteed.

Agent-native transitions do not create a separate model turn, but each phase adds one small helper result plus bounded task-tool calls to the current turn. Successful Hook observation and a successful background Stop direct move use zero model tokens. Event wake and heartbeat are separate model turns. A heartbeat is scheduled 288 times/day at 5 minutes, 24 at 1 hour, and 6 at 4 hours. Actual token usage varies with the selected model and visible task count. Agent-native, organizer, and heartbeat paths can expose visible task metadata to the selected model even though the policy prohibits using text for decisions.

## Verify

```bash
npm test
npm run check
node scripts/doctor.mjs
```

Plugin mode uses `node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --plugin`. Without an active `CLAUDE_PLUGIN_ROOT`, `--plugin-root <path>` can validate package completeness but reports app enablement as unverified.

`doctor` validates the runtime fingerprint and verifies that `agentTransitions.enabled` matches the active global AGENTS block. A merely well-formed stored hash is not accepted. Outside a trusted Hook it deliberately reports Hook runtime capability as unverified; observed-state acceptance is still required.

Hook diagnostics are written to `~/.codex/sidebar-flow/hook.log` with mode `0600` and one bounded rotation. Logs contain only bounded event, status/error-code, attempt, capability, fallback, and duration fields; they omit prompts, outputs, task titles, full task bodies, complete task IDs, executable paths, socket paths/basenames, and private tool error bodies.

## Configuration

Edit `~/.codex/sidebar-flow/config.json`. Section names must be unique. Add organizer task IDs to `excludeThreadIds`; content and summary substrings never control exclusion. Use setup's `--enable-agent-transitions` or `--disable-agent-transitions` options instead of editing the managed AGENTS block. Event wake remains disabled until explicitly enabled through setup.

Socket discovery is disabled by default. The supported path is the explicit `CODEX_APP_TOOLS_PIPE_PATH` inherited by a trusted Codex Hook. Enabling `allowSocketDiscovery` is for local debugging only.

## Uninstall

Run `node scripts/uninstall.mjs` from the source checkout. If the checkout was removed, use the `releaseRoot` printed by setup and run `node <releaseRoot>/scripts/uninstall.mjs`.

Source mode removes only Sidebar Flow entries from global hooks. Every uninstall removes only the marked Sidebar Flow block from global agent instructions and disables agent transitions/event wake while preserving unrelated content and state. Plugin users should disable the plugin and run `node scripts/uninstall.mjs --plugin --purge` from the checkout. Add `--purge` to remove configuration, state, installed runtime files, releases, and logs.

## Known boundaries

- The private Desktop sidebar protocol may change without notice.
- A local Hook cannot receive a remote app server's lifecycle event.
- Agent-native movement is realtime at agent tool-call granularity, not an external authoritative task-state observer; a model that ignores the managed instruction or a task that crashes before finalization still needs heartbeat recovery.
- Do not edit `AGENTS.md` or `AGENTS.override.md` concurrently with setup/uninstall. The installer detects observed file replacement and fails closed, but the platform provides no atomic compare-and-swap across both global instruction files.
- Codex launches matching command Hooks concurrently. The Hook therefore observes and persists first, then may send one envelope to the organizer. If the app-tools pipe is unavailable during `UserPromptSubmit`, it can only inject a bounded self-move instruction into the current agent; that fallback depends on model/tool execution and fails closed on ambiguity.
- The organizer's exact final read reduces the read/move race but the platform exposes no atomic conditional move, so status or membership can still change before the move commits.
- Current public remote Hook/MCP capabilities do not expose the multi-step custom-sidebar workflow required by a cross-host event bridge; remote Hook installation is therefore capability-gated, not assumed, and remote realtime must not be claimed without live acceptance.
- Heartbeat recovery has a bounded delay but cannot reconstruct an event that occurred entirely between snapshots.
- `list_threads` is limited to 50 summaries. In Progress items outside that window require successful `read_thread` discovery or an authoritative managed host identity; otherwise the tool fails closed.
- There is no external backend or detached daemon. v0.3 uses root-agent transitions plus local Hook optimizations and heartbeat recovery.

## License

MIT
