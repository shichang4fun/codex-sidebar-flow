# Codex Sidebar Flow

This local checkout includes an unpublished [periodic compensation patch](docs/local-compensation.md)
on top of v0.4.0-beta.1. The published beta tag has not been changed.

## v0.4.0-beta.1: local event-driven Desktop proxy

An opt-in macOS launcher observes structured App Server events and uses native
Desktop tools to move eligible local tasks between In Progress and For Review.
No sorting model turns, Hooks or heartbeat are required by this path.

**Start here: [installation, scope, privacy and rollback](docs/local-desktop-proxy.md).**
Use the dedicated launcher every time: the original Codex icon bypasses the proxy.
Remote tasks, Project tasks, Pinned and For Later are not managed by this beta.
Real Desktop start/completion movement has been observed on two local tasks;
this is not a stable release or a guarantee of instantaneous/lossless delivery.
See [protocol research and verification boundaries](docs/local-official-api-prototype.md).

The plugin manifest and `scripts/setup.mjs` still install the **legacy Hook path**,
not the new proxy. Do not run both mechanisms against the same tasks. Follow the
proxy guide's migration section before enabling it on an existing installation.

## Legacy v0.3.x Hook/controller integration

Codex Sidebar Flow v0.3.2 adds an experimental controller-host bridge for multi-host near-realtime organization on compatible Codex Desktop builds. A remote lifecycle Hook sends only a strict `{ protocol, event, threadId }` wake hint without a destination `hostId`; the organizer running on the controlling Mac resolves the unique controller-visible task, its real `remote-control:*` host, and the controlling Mac's section IDs before any move. A recurring heartbeat repairs missed or interrupted transitions. Classification never follows task content.

> [!WARNING]
> Lifecycle Hooks and the hostless routing behavior use private or current-build Codex Desktop capabilities and can break after a Desktop update. Keep the heartbeat enabled until a fresh end-to-end acceptance proves the controlling Mac moved the remote task.

## State rules

| Event or state | Destination |
|---|---|
| Controller-bridge `UserPromptSubmit` resolves one active eligible task | In Progress |
| Controller-bridge `Stop` resolves one terminal or attention-needing eligible task | For Review |
| Optional local root-agent transition starts/resumes an eligible task | In Progress |
| Optional local root-agent transition is about to return a successful final response | For Review |
| Active task observed in Tasks, For Review, or an eligible Project | In Progress |
| Authoritative `Stop` observes an idle, completed, failed, or needs-attention task in Tasks, In Progress, or an eligible Project | For Review |
| Heartbeat observes an idle, completed, failed, or needs-attention task already in In Progress | For Review |
| Host-bound `UserPromptSubmit` lifecycle event | Observe identity, persist state, optionally wake an explicitly hosted organizer |
| Host-bound background `Stop` lifecycle event | After a final terminal read, move an eligible task on that host; otherwise optionally wake its organizer |
| Task directly in Pinned or For Later | Never moved |
| Parent Project in For Later or another custom section | Child task is not moved |
| Parent Project in Pinned | Project remains pinned; eligible child task may move independently |

Membership is resolved from the controlling Mac's real sidebar item key by task or Project ID. In controller-bridge mode, the organizer requires exactly one controller-visible Codex task matching `threadId` across all hosts; zero or duplicate matches fail closed. The key's host component is never trusted for execution: `read_thread` and move calls use the task's actual structured `hostId`. Managed identities use `<hostId>:<threadId>`. Visible task text is untrusted and never drives state decisions.

## Install

Requirements: macOS, Codex Desktop, Node.js 20+, and custom sections named `In Progress`, `For Review`, and `For Later`.

Run setup and doctor separately on the local machine and on every connected execution host such as `scmeituan.local`. Remote Connections use that host's own Codex home, configuration, credentials, plugins, and global AGENTS files; one local installation is not shared with remote tasks.

Source mode base installation:

```bash
git clone https://github.com/shichang4fun/codex-sidebar-flow.git
cd codex-sidebar-flow
node scripts/setup.mjs
```

Plugin mode base installation:

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
- with `--enable-agent-transitions`, adds one marked block to the active global `~/.codex/AGENTS.override.md` or `~/.codex/AGENTS.md`, preserves unrelated instructions, and keeps a first-run backup;
- in source mode, stages the fixed runtime script set, verifies its SHA-256 fingerprint, and atomically publishes an immutable release under `~/.codex/sidebar-flow/releases/<runtimeFingerprint>` before changing Hooks. Existing releases are retained, and no `current` symlink is used. Plugin fingerprints cover that shared runtime plus the plugin manifest, Hook declaration, launcher, heartbeat renderer and prompt, and Sidebar Flow skill.

Setup does not silently enable event wake or create a scheduled model task. Event wake creates user-visible organizer turns, so it requires an explicit option, a current-runtime Hook capability probe, and a confirmed organizer task ID. Controller-bridge mode disables agent transitions on that execution host to prevent writes to the wrong sidebar database.

A hook installed on one machine does not receive events from another machine's Codex app server. [OpenAI's Hooks documentation](https://learn.chatgpt.com/docs/hooks) states that matching command Hooks run concurrently and that a background Hook cannot block. Sidebar Flow keeps `UserPromptSubmit` synchronous and runs `Stop` in the background. In host-bound mode, `UserPromptSubmit` may provide `additionalContext`, while delayed `Stop` performs an exact final read before a direct move. In controller-bridge mode, neither event reads or moves the remote sidebar; `UserPromptSubmit` immediately sends a hostless wake and `Stop` sends one after the bounded publication delay. The recurring heartbeat remains an independent recovery path.

The repository is also a Codex plugin. Plugin installation and source installation are mutually exclusive:

- **Source mode**: run `node scripts/setup.mjs`; this writes global hooks.
- **Plugin mode**: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --plugin`; this creates configuration only because the plugin already supplies bundled hooks.

Cross-mode setup is rejected. To migrate plugin → source, first disable the plugin, run `node scripts/uninstall.mjs --plugin`, then run source setup. To migrate source → plugin, run `node scripts/uninstall.mjs`, enable the plugin, then run plugin setup. The plugin launcher uses only the fixed ChatGPT/Codex bundled Node paths instead of GUI `PATH`; a missing runtime produces a stable diagnostic and a failed Hook. It does not independently attest the bundled binary's code signature.

Plugin mode must use the same `CODEX_HOME` inherited by Codex Desktop. It rejects `--plugin --codex-home <path>` because a setup-only path cannot be carried into later lifecycle Hook processes. Set `CODEX_HOME` for the Desktop/plugin runtime before setup, or use source mode when an explicit installation path is required.

## Runtime model

- **Agent-native transitions**: the opt-in managed global instruction is retained for local or same-sidebar operation. It must be disabled on a remote execution host using controller-bridge mode because a remote agent's `local` sidebar is not the controlling Mac's aggregated sidebar.
- **Host-bound lifecycle Hooks**: synchronous `UserPromptSubmit` records authoritative identity and may provide the bounded self-move fallback. After a bounded delay, background `Stop` performs an exact `read_thread` and directly moves a confirmed terminal or attention-needing task from Tasks, In Progress, or an eligible Project to For Review. An active or internally conflicting final read fails closed.
- **Controller bridge**: `eventWake.routingMode="controller-bridge"` sends the strict three-field `codex-sidebar-flow/bridge-v1` envelope with no `hostId` tool argument. The remote Hook does not list, read, or move remote sidebar items. The controlling organizer treats the event as an untrusted wake hint, resolves exactly one task from its own `list_threads`, takes the structured host from that row, then performs an exact-host final `read_thread` before at most one move using controlling-Mac section IDs.
- **Host-bound event wake**: `eventWake.routingMode="host-bound"` preserves the older explicit organizer host and four-field `event-v1` envelope for same-data-plane operation. Route and envelope modes cannot be mixed.
- **Host-bound agent self-move fallback**: a Desktop turn can temporarily own the private app-tools pipe, especially during `UserPromptSubmit`. A recognized transient transport/contention failure can return a bounded `hookSpecificOutput.additionalContext` instruction even when organizer event wake is disabled; non-retryable failures and capability-probe events fail closed. The current agent then uses its already-connected task tools to move only itself after structured checks. Controller-bridge mode never emits this fallback.
- **Deterministic reconciler**: the host-bound background Stop Hook handles confirmed same-data-plane terminal transitions without a model; the controlling organizer handles bridge movement; the recurring heartbeat performs independent global recovery.
- **Project tasks**: a task without direct membership uses its Project as an identity and source signal. Reconciliation hydrates a uniquely identified Project-contained task with `read_thread` on its actual host before classification. A Project in Projects or Pinned may supply an eligible child task; a Pinned Project remains pinned, while moving the child creates explicit task membership in the destination section. A Project in For Later or another custom section protects its children. The Project object itself is never moved.
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
5. On a remote execution host, require probe status `present`, then enable the hostless controller bridge explicitly:
   `node scripts/setup.mjs --enable-event-wake --organizer-thread-id <controlling-organizer-task-id> --event-wake-routing-mode controller-bridge --disable-agent-transitions`
6. Verify: `node scripts/doctor.mjs`

Plugin mode:

1. Install/configure while disabled: `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --plugin`
2. Arm the one-shot probe: `node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --plugin --arm-event-wake-probe`
3. Submit one real disposable Codex prompt on the target host.
4. Read the result: `node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --plugin --event-wake-probe-result`
5. On a remote execution host, require probe status `present`, then enable the hostless controller bridge explicitly:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --plugin --enable-event-wake --organizer-thread-id <controlling-organizer-task-id> --event-wake-routing-mode controller-bridge --disable-agent-transitions`
6. Verify: `node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --plugin`

If the probe is missing, pending, expired, belongs to another install mode/runtime fingerprint, or is not `present`, keep event wake disabled and retain the 5-minute heartbeat. The Hook recomputes the mode-specific fingerprint from its own actual files before it may record `present`. The probe confirms whether that exact runtime saw the trusted app-tools context and whether organizer wake stayed suppressed for that probe event. It does not prove end-to-end organizer movement by itself. During normal execution, each new AppTools connection still performs a live `tools/list` and fails closed when its required tools are absent; a prior capability result is never used as a substitute for that live check.

Keep the heartbeat at 5 minutes until a real remote `UserPromptSubmit` and `Stop` have both moved the task in the controlling Mac's authoritative `list_threads` result. A successful send or movement visible only on the remote host is not acceptance. After repeated end-to-end acceptance, 30-60 minutes is a reasonable recovery cadence; the bridge does not depend on that interval.

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
- A local Hook cannot receive a remote app server's lifecycle event; controller-bridge mode therefore installs the Hook on the remote execution host and routes only a wake hint to the controlling organizer.
- Hostless routing has no application-level message authentication. The organizer treats every envelope as an untrusted hint and relies on current structured task state and protected membership checks for authorization; rate limiting bounds accidental wake storms but not every cost-denial scenario.
- Do not edit `AGENTS.md` or `AGENTS.override.md` concurrently with setup/uninstall. The installer detects observed file replacement and fails closed, but the platform provides no atomic compare-and-swap across both global instruction files.
- Codex launches matching command Hooks concurrently. Controller-bridge mode never injects a remote self-move fallback; if the hostless send fails, the heartbeat is the recovery path.
- The organizer's exact final read reduces the read/move race but the platform exposes no atomic conditional move, so status or membership can still change before the move commits.
- Hostless remote-to-controller routing is capability-gated, not assumed, and must be reaccepted after a runtime fingerprint or Desktop update.
- Heartbeat recovery has a bounded delay but cannot reconstruct an event that occurred entirely between snapshots.
- `list_threads` is limited to 50 summaries. In Progress items outside that window require successful `read_thread` discovery or an authoritative managed host identity; otherwise the tool fails closed.
- There is no external backend or detached daemon. Detached private-pipe callers currently fail tools RPC outside a valid task context, so LaunchAgent polling is not a supported runtime path.

## License

MIT
