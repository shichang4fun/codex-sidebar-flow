# Codex Sidebar Flow

Codex Sidebar Flow reconciles observed active Codex tasks into **In Progress** and observed stopped tasks into **For Review**. Classification is deterministic and never reads task content.

> [!WARNING]
> Codex Hooks are supported, but custom-sidebar mutation currently depends on a private Codex Desktop app-tools pipe. Version 0.1 is an experimental macOS integration and can break after a Desktop update.

## State rules

| Event or state | Destination |
|---|---|
| Active task observed in Tasks, For Review, or an eligible Project | In Progress |
| Idle, completed, failed, or needs-attention task observed in In Progress | For Review |
| `UserPromptSubmit` lifecycle event | Record authoritative host/task activity only |
| `Stop` lifecycle event | Record diagnostics only; wait for confirmed observed state |
| Task or parent Project in Pinned or For Later | Never moved |

Membership is resolved from the real sidebar item key by task or Project ID. The key's host component is never trusted for execution: `read_thread` and move calls use the task's actual `hostId`. Managed identities use `<hostId>:<threadId>`.

## Install

Requirements: macOS, Codex Desktop, Node.js 20+, and custom sections named `In Progress`, `For Review`, and `For Later`.

```bash
git clone https://github.com/shichang4fun/codex-sidebar-flow.git
cd codex-sidebar-flow
node scripts/setup.mjs
node scripts/doctor.mjs
```

Restart Codex Desktop after setup. The installer:

- preserves unrelated hooks;
- backs up `~/.codex/hooks.json`;
- installs only `UserPromptSubmit` and `Stop` handlers;
- creates `~/.codex/sidebar-flow/config.json` only when absent.
- copies the runtime, doctor, and uninstaller into `~/.codex/sidebar-flow/scripts`, so the checkout can be moved or removed.

Setup does not silently create a scheduled model task. For automatic movement, explicitly create the recurring heartbeat described below; without it, the installed Hooks only collect lifecycle identity.

A hook installed on one machine does not receive events from another machine's Codex app server. Hooks improve local activity identity but deliberately do not move sidebar items: [OpenAI's Hooks documentation](https://learn.chatgpt.com/docs/hooks) states that matching command Hooks run concurrently, so one Hook cannot know whether another Hook will block a prompt or continue a stopped turn. Confirmed movement is performed by the observer/self-heal path.

The repository is also a Codex plugin. Plugin installation and source installation are mutually exclusive:

- **Source mode**: run `node scripts/setup.mjs`; this writes global hooks.
- **Plugin mode**: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --plugin`; this creates configuration only because the plugin already supplies bundled hooks.

Cross-mode setup is rejected. To migrate plugin → source, first disable the plugin, run `node scripts/uninstall.mjs --plugin`, then run source setup. To migrate source → plugin, run `node scripts/uninstall.mjs`, enable the plugin, then run plugin setup. The plugin launcher uses only the fixed ChatGPT/Codex bundled Node paths instead of GUI `PATH`; a missing runtime produces a stable diagnostic and a failed Hook. It does not independently attest the bundled binary's code signature.

## Runtime model

- **Lifecycle observer**: `UserPromptSubmit` records the current task's authoritative host identity; `Stop` emits bounded private diagnostics. Neither event mutates the sidebar before sibling Hook outcomes are known.
- **Deterministic reconciler**: the optional foreground observer or recurring heartbeat reads confirmed task status and performs all sidebar movement.
- **Project tasks**: a task without direct membership uses its Project only as a source and protection signal. Moving the task creates explicit task membership in the destination section; the Project itself is not moved.
- **Self-heal heartbeat**: the supported automatic-movement path unless a trusted foreground observer is already running. It performs global cross-host reconciliation and must call Codex task-management tools directly. A sandboxed heartbeat must not launch the native-pipe script because it lacks the trusted Desktop process context. Use the [audited prompt template](docs/heartbeat-prompt.md).

Render the heartbeat prompt with the exact organizer task ID before creating the automation:

```bash
node scripts/render-heartbeat.mjs --exclude <organizer-task-id>
```

Creation must fail if the placeholder remains or no exact organizer ID was supplied.

With a five-minute self-heal interval, an active task or an idle task already in In Progress normally converges within five minutes. A task that starts and finishes entirely between polls is not observable without a supported post-outcome event bridge. This is a platform boundary, not a real-time guarantee.

Hook observation uses zero model tokens. A heartbeat is a scheduled model turn: 5 minutes is 288 runs/day, 1 hour is 24, and 4 hours is 6. Actual token usage varies with the selected model and visible task count. Its task-tool result can expose visible titles and summaries to the selected model even though the audited prompt prohibits using them for decisions; do not enable the heartbeat if that metadata boundary is unacceptable.

## Verify

```bash
npm test
npm run check
node scripts/doctor.mjs
```

Plugin mode uses `node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --plugin`. Without an active `CLAUDE_PLUGIN_ROOT`, `--plugin-root <path>` can validate package completeness but reports app enablement as unverified.

`doctor` validates static installation. Outside a trusted Hook it deliberately reports runtime capability as unverified; an observed-state acceptance test is still required. `doctor --probe` performs read-only `tools/list` and section checks when run in a trusted app-tools context.

Hook diagnostics are written to `~/.codex/sidebar-flow/hook.log` with mode `0600` and one bounded rotation. Logs omit prompts, outputs, task titles, full task bodies, and private tool error bodies.

## Configuration

Edit `~/.codex/sidebar-flow/config.json`. Section names must be unique. Add organizer task IDs to `excludeThreadIds`; content and summary substrings never control exclusion.

Socket discovery is disabled by default. The supported path is the explicit `CODEX_APP_TOOLS_PIPE_PATH` inherited by a trusted Codex Hook. Enabling `allowSocketDiscovery` is for local debugging only.

## Uninstall

```bash
node ~/.codex/sidebar-flow/scripts/uninstall.mjs
```

Source mode removes only Sidebar Flow entries from global hooks. Plugin users should disable the plugin and run `node scripts/uninstall.mjs --plugin --purge` from the checkout; plugin mode never edits global hooks. Add `--purge` to remove configuration, state, installed runtime files, and logs.

## Known boundaries

- The private Desktop sidebar protocol may change without notice.
- A local Hook cannot receive a remote app server's lifecycle event.
- Codex launches matching command Hooks concurrently. Without a post-outcome event, a lifecycle Hook cannot safely commit the final sidebar state; v0.1 uses observed-state reconciliation.
- Current public remote Hook/MCP capabilities do not expose the multi-step custom-sidebar workflow required by a cross-host event bridge; remote Hook installation is therefore capability-gated, not assumed.
- Periodic self-heal has a bounded delay but cannot reconstruct an event that occurred entirely between snapshots.
- `list_threads` is limited to 50 summaries. In Progress items outside that window require successful `read_thread` discovery or an authoritative managed host identity; otherwise the tool fails closed.
- Detached daemons cannot reliably regain the trusted Desktop process ancestry after reconnecting; v0.1 uses observation Hooks plus task-tool heartbeat reconciliation.

## License

MIT
