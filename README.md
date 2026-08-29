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

A hook installed on one machine does not receive events from another machine's Codex app server. Version 0.1 verifies real-time hooks on the local Desktop host. On a remote host, install only after a capability probe confirms that the trusted Hook process receives the required app-tools pipe; otherwise use heartbeat self-heal.

The repository is also a Codex plugin. Its skill guides section creation, installation, diagnosis, and self-heal setup.

## Runtime model

- **Verified local Hook**: `UserPromptSubmit` and `Stop` are real-time, subject to normal hook execution latency.
- **Cross-host reconciliation**: every trusted hook rereads the global sidebar and reconciles visible active and managed tasks using each task's real `hostId`.
- **Project tasks**: a task without direct membership uses its Project only as a source and protection signal. Moving the task creates explicit task membership in the destination section; the Project itself is not moved.
- **Self-heal heartbeat**: optional. It must call Codex task-management tools directly. A sandboxed heartbeat must not launch the native-pipe script because it lacks the trusted Desktop process context.

With a five-minute self-heal interval, an active task or an idle task already in In Progress normally converges within five minutes. A remote task that starts and finishes entirely between polls is not observable unless the Hook is also installed on that remote host. This is a platform boundary, not a stronger real-time guarantee.

Hook classification and mutation use zero model tokens. A heartbeat is a scheduled model turn and has recurring token cost.

## Verify

```bash
npm test
npm run check
node scripts/doctor.mjs
```

Hook diagnostics are written to `~/.codex/sidebar-flow/hook.log` with mode `0600`. Logs omit prompts, outputs, task titles, and full task bodies.

## Configuration

Edit `~/.codex/sidebar-flow/config.json`. Section names must be unique. Add organizer task IDs to `excludeThreadIds`.

Socket discovery is disabled by default. The supported path is the explicit `CODEX_APP_TOOLS_PIPE_PATH` inherited by a trusted Codex Hook. Enabling `allowSocketDiscovery` is for local debugging only.

## Uninstall

```bash
node scripts/uninstall.mjs
```

This removes only Sidebar Flow hook entries. Add `--purge` to remove its configuration, state, and logs as well.

## Known boundaries

- The private Desktop sidebar protocol may change without notice.
- A local Hook cannot receive a remote app server's lifecycle event.
- Current public remote Hook/MCP capabilities do not expose the multi-step custom-sidebar workflow required by this tool; remote Hook installation is therefore capability-gated, not assumed.
- Periodic self-heal has a bounded delay but cannot reconstruct an event that occurred entirely between snapshots.
- Detached daemons cannot reliably regain the trusted Desktop process ancestry after reconnecting; v0.1 uses Hooks plus optional task-tool heartbeat reconciliation.

## License

MIT
