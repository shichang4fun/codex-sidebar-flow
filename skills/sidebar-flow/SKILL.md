---
name: sidebar-flow
description: Set up, inspect, or repair automatic Codex Desktop task movement between In Progress, For Review, and For Later.
---

# Codex Sidebar Flow

1. Check whether `In Progress`, `For Review`, and `For Later` exist; create only missing sections.
2. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs"` for a source installation, then run `doctor.mjs`.
3. Explain that lifecycle events are verified real-time only on the local Desktop host. A remote host must pass a trusted app-tools pipe capability probe before installation; otherwise use heartbeat self-heal and do not claim remote real-time behavior.
4. Only create or change a recurring heartbeat when the user explicitly requests self-healing. The heartbeat must use Codex task-management tools directly; it must not run the native-pipe script from a sandboxed shell.
5. Explain the polling boundary: tasks observed active, or already in In Progress when they stop, converge within the heartbeat interval; a remote task that starts and finishes between polls is invisible without a remote Hook.
6. Never move Pinned or For Later tasks, projects, or the organizer task itself.

The custom-sidebar mutation adapter is experimental and macOS-only. Do not describe it as a public stable API.
