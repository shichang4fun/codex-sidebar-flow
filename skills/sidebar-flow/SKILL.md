---
name: sidebar-flow
description: Set up, inspect, or repair automatic Codex Desktop task movement between In Progress, For Review, and For Later.
---

# Codex Sidebar Flow

1. Check whether `In Progress`, `For Review`, and `For Later` exist; create only missing sections.
2. Choose exactly one installation mode. For a plugin installation run `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --plugin`; for a source checkout run `node scripts/setup.mjs`. Never install both hook sets.
3. Explain that lifecycle events are verified real-time only on the local Desktop host. A remote host must pass a trusted app-tools pipe capability probe before installation; otherwise use heartbeat self-heal and do not claim remote real-time behavior.
4. Only create or change a recurring heartbeat when the user explicitly requests self-healing. Use `docs/heartbeat-prompt.md` verbatim, with the user's exact excluded task IDs. The heartbeat must not run the native-pipe script from a sandboxed shell.
5. State the cost explicitly: 5 minutes is 288 model runs/day, 1 hour is 24, and 4 hours is 6.
6. Explain the polling boundary: tasks observed active, or already in In Progress when they stop, converge within the heartbeat interval; a task that starts and finishes between polls is invisible without an event bridge. Items outside the 50-summary window require successful read hydration or an authoritative managed host identity.
7. Never move Pinned or For Later tasks, projects, or the organizer task itself.

The custom-sidebar mutation adapter is experimental and macOS-only. Do not describe it as a public stable API.
