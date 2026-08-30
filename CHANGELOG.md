# Changelog

All notable changes to this project are documented here.

## [0.3.0] - 2026-08-30

### Added

- Add opt-in root-agent `start` and `finish` transitions for local and remote-controlled tasks on separately installed hosts, without relying on remote Desktop Hook delivery.
- Add a fingerprint-bound context helper with root/subagent identity gating, exclusions, and fail-closed configuration validation.
- Add managed global AGENTS installation, idempotent updates, first-run backup, uninstall cleanup, and doctor verification.

### Changed

- Treat local Hooks as an optimization and heartbeat as recovery after agent-native lifecycle acceptance.
- Preserve Pinned, For Later, archived, ambiguous, non-Codex, excluded, and protected Project items across every path.
- Document that agent-native movement is realtime at the current agent's tool boundary, not an external authoritative observer.

## [0.2.1] - 2026-08-30

### Added

- Add a bounded `UserPromptSubmit` agent self-move fallback when the private Desktop app-tools pipe is occupied by the active turn.
- Record only a boolean `agentFallback` diagnostic; prompts, task content, paths, and private pipe errors remain excluded.
- Add one shared section-policy validator across setup, realtime reconciliation, event wake, heartbeat rendering, and self-move fallback.

### Changed

- Keep the direct content-free organizer event path as the zero-context fast path, while using the public Hook `additionalContext` contract only after a live app-tools failure.
- Decouple local lifecycle reconciliation from optional organizer wake capability: background Stop direct moves and the current-turn self-move fallback remain available when `send_message_to_thread` is absent and `eventWake.enabled=false`.
- Run `Stop` as a background Hook and require its delayed exact `read_thread` to confirm a terminal state before any direct move; an active or internally conflicting read fails closed instead of being classified prematurely.
- Give background `Stop` a 3-second finalization delay, 14-second runtime deadline, and 20-second command timeout after live Desktop acceptance showed the previous 500 ms / 9-second window was too short.
- Migrate the shipped 500 ms / 9-second timing defaults during upgrade while preserving explicit non-legacy overrides.
- Hydrate uniquely identified Project-contained tasks, including remote `notLoaded` tasks, through their authoritative host before classification.
- Fail closed as active when an exact read reports a terminal thread status but its latest turn is still running or in progress, unless the thread explicitly needs attention.
- Report successful direct Stop mutations as mutations rather than observation-only diagnostics.
- Report an expired post-enable capability probe as stale verification rather than a runtime failure; setup still requires a fresh exact-binding result before enabling event wake.
- Document the fallback's small model/tool-usage cost and fail-closed membership rules.
- Fail closed on duplicate memberships, duplicate cross-host thread IDs, mismatched hydration identities, invalid built-in destinations, and state changes detected by the final `read_thread`.
- Retry and fail closed when any candidate host read is unavailable, so a partial cross-host result cannot be mistaken for a unique identity.
- Normalize hyphenated and underscored attention states plus failed, interrupted, and cancelled terminal states across direct and `notLoaded` hydration paths.
- Bind plugin Hooks to an explicit runtime configuration path and reject setup-only custom `CODEX_HOME` values that the plugin runtime cannot inherit.
- Reject symlinked runtime roots during setup/uninstall and bind source Hooks to the exact installed configuration path.

## [0.2.0] - 2026-08-30

### Added

- Opt-in lifecycle event wake through a content-free organizer envelope, with a five-minute heartbeat retained as deterministic recovery.
- Exact local/remote `<hostId, threadId>` lifecycle selection, Project-contained task support, and final authoritative reads before targeted moves.
- Mode-specific runtime fingerprints, immutable source releases, one-shot capability probes, and live runtime verification in `doctor`.

### Changed

- Keep event wake disabled across upgrades until a fresh probe confirms the exact installed runtime and mode.
- Harden wake and managed-state locks against crashed owners, live-owner eviction, symlink attacks, and replacement-inode races.
- Restrict lifecycle logging to bounded statuses, timings, booleans, and stable error codes.
- Document that model tool restrictions are prompt-enforced and sidebar moves are not atomic compare-and-swap operations.

## [0.1.0] - 2026-08-29

### Added

- Observation-only local lifecycle identity and bounded-delay cross-host reconciliation without content classification.
- Cross-host membership resolution, remote hydration, Project-task support, managed identities, idempotent retries, and protected manual sections.
- Source installer, uninstaller, doctor, plugin manifest, security documentation, tests, and CI.

### Changed

- Isolated the unsupported Desktop sidebar protocol behind an explicit experimental macOS boundary.
- Hardened remote host discovery, parent Project protection, needs-attention handling, Hook deadlines, state locking, socket ownership checks, and log redaction after independent review.
- Split source and plugin installation modes so only one Hook set is active.
- Fail closed on unowned legacy sidebar Hooks and support exact-path source migration.
- Preserve plugin install mode during first-event configuration bootstrap.
- Reject source/plugin mode mismatches again at Hook runtime.
- Reject missing, flag-shaped, or relative `--codex-home` values before any filesystem access.
- Serialize managed-state writes so completed-task removals cannot be revived by stale disk state.
