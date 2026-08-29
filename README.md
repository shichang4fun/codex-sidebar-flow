# Codex Sidebar Flow

Codex Sidebar Flow moves active Codex tasks to **In Progress** and stopped tasks to **For Review**. Lifecycle decisions are deterministic; no model classifies task content.

> [!WARNING]
> Codex Hooks are supported, but custom-sidebar mutation currently depends on a private Codex Desktop app-tools pipe. Version 0.1 is an experimental macOS integration and can break after a Desktop update.

## State rules

| Event or state | Destination |
|---|---|
| `UserPromptSubmit` from Tasks, For Review, or an eligible Project | In Progress |
| `Stop` while in In Progress | For Review |
| Active task observed by self-heal | In Progress |
| Idle, completed, or needs-attention task already in In Progress | For Review |
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
- copies the two runtime scripts into `~/.codex/sidebar-flow/scripts`, so the checkout can be moved or removed.

A hook installed on one machine does not receive events from another machine's Codex app server. Version 0.1 verifies real-time hooks on the local Desktop host. On a remote host, install only after a capability probe confirms that the trusted Hook process receives the required app-tools pipe; otherwise use heartbeat self-heal.

The repository is also a Codex plugin. Plugin installation and source installation are mutually exclusive:

- **Source mode**: run `node scripts/setup.mjs`; this writes global hooks.
- **Plugin mode**: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --plugin`; this creates configuration only because the plugin already supplies bundled hooks.

Do not run source setup on top of the plugin. The plugin launcher selects the signed Node bundled with ChatGPT/Codex Desktop instead of relying on GUI `PATH`.

## Runtime model

- **Verified local Hook**: `UserPromptSubmit` and `Stop` are real-time, subject to normal hook execution latency.
- **Hook scope**: a lifecycle Hook handles only its current task and has a 9-second internal deadline. It rereads final status after `Stop`, so a blocking Stop hook does not prematurely move a continuing task.
- **Project tasks**: a task without direct membership uses its Project only as a source and protection signal. Moving the task creates explicit task membership in the destination section; the Project itself is not moved.
- **Self-heal heartbeat**: optional. It performs the global cross-host reconciliation and must call Codex task-management tools directly. A sandboxed heartbeat must not launch the native-pipe script because it lacks the trusted Desktop process context. Use the [audited prompt template](docs/heartbeat-prompt.md).

With a five-minute self-heal interval, an active task or an idle task already in In Progress normally converges within five minutes. A remote task that starts and finishes entirely between polls is not observable unless the Hook is also installed on that remote host. This is a platform boundary, not a stronger real-time guarantee.

Hook classification and mutation use zero model tokens. A heartbeat is a scheduled model turn: 5 minutes is 288 runs/day, 1 hour is 24, and 4 hours is 6. Actual token usage varies with the selected model and visible task count.

## Verify

```bash
npm test
npm run check
node scripts/doctor.mjs
```

`doctor` validates static installation. Outside a trusted Hook it deliberately reports runtime capability as unverified; a real lifecycle-event acceptance test is still required. `doctor --probe` performs read-only `tools/list` and section checks when run in a trusted app-tools context.

Hook diagnostics are written to `~/.codex/sidebar-flow/hook.log` with mode `0600` and one bounded rotation. Logs omit prompts, outputs, task titles, full task bodies, and private tool error bodies.

## Configuration

Edit `~/.codex/sidebar-flow/config.json`. Section names must be unique. Add organizer task IDs to `excludeThreadIds`; content and summary substrings never control exclusion.

Socket discovery is disabled by default. The supported path is the explicit `CODEX_APP_TOOLS_PIPE_PATH` inherited by a trusted Codex Hook. Enabling `allowSocketDiscovery` is for local debugging only.

## Uninstall

```bash
node scripts/uninstall.mjs
```

Source mode removes only Sidebar Flow entries from global hooks. Plugin users should disable the plugin and run `node scripts/uninstall.mjs --plugin --purge`; plugin mode never edits global hooks. Add `--purge` to remove configuration, state, installed runtime files, and logs.

## Known boundaries

- The private Desktop sidebar protocol may change without notice.
- A local Hook cannot receive a remote app server's lifecycle event.
- Current public remote Hook/MCP capabilities do not expose the multi-step custom-sidebar workflow required by this tool; remote Hook installation is therefore capability-gated, not assumed.
- Periodic self-heal has a bounded delay but cannot reconstruct an event that occurred entirely between snapshots.
- `list_threads` is limited to 50 summaries. In Progress items outside that window require successful `read_thread` discovery or an authoritative managed host identity; otherwise the tool fails closed.
- Detached daemons cannot reliably regain the trusted Desktop process ancestry after reconnecting; v0.1 uses Hooks plus optional task-tool heartbeat reconciliation.

## License

MIT
