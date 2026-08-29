---
name: sidebar-flow
description: Set up, inspect, or repair automatic Codex Desktop task movement between In Progress, For Review, and For Later.
---

# Codex Sidebar Flow

1. Check whether `In Progress`, `For Review`, and `For Later` exist; create only missing sections.
2. Choose exactly one installation mode. For a plugin installation run `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --plugin`; for a source checkout run `node scripts/setup.mjs`. Never install both hook sets.
3. Require explicit user authorization before enabling event wake or changing heartbeat cadence because both create model-triggering, user-visible organizer turns.
4. Never infer the organizer. Use only the exact organizer task ID and organizer host ID the user supplied. Existing v0.1 installs remain event-wake disabled until explicitly upgraded.
5. Explain that lifecycle Hooks are observation-first because matching command Hooks run concurrently. The Hook persists state, then may send one content-free envelope containing only `threadId` and `hostId` to the organizer. The organizer reads confirmed state and performs at most one targeted move.
6. Capability-gate setup and repair. Before claiming local or remote event wake works, require a live trusted Hook-context probe with `node scripts/doctor.mjs --arm-event-wake-probe`, one real disposable prompt on the target host, and `node scripts/doctor.mjs --event-wake-probe-result`. If that probe or later live acceptance fails, fall back truthfully to heartbeat recovery.
7. Only create or change a recurring heartbeat when the user explicitly requests self-healing. Render `docs/heartbeat-prompt.md` with `scripts/render-heartbeat.mjs --exclude <organizer-task-id>` and verify that the resulting prompt contains every exact excluded task ID and no placeholder. The heartbeat must not run the native-pipe script from a sandboxed shell.
8. State the cost explicitly: event wake incurs one organizer model turn per lifecycle event; heartbeat costs 288 runs/day at 5 minutes, 24 at 1 hour, and 6 at 4 hours.
9. Explain the recovery boundary: heartbeat is the deterministic recovery path, not the primary fast path. Tasks observed active, or already in In Progress when they stop, converge within the heartbeat interval even when event wake is unavailable. A task that starts and finishes between polls is invisible without an event bridge. Items outside the 50-summary window require successful read hydration or an authoritative managed host identity.
10. Never move Pinned, For Later, archived, non-Codex, Project objects, or the organizer task itself. Always use the task's actual `hostId` for `read_thread` and moves.

The custom-sidebar mutation adapter is experimental and macOS-only. Do not describe it as a public stable API.
