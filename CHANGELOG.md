# Changelog

All notable changes to this project are documented here.

## [Unreleased]

- Support eligible local Project child tasks while preserving their Project association and protected parent/task membership.
- Preserve short-turn start evidence through bounded startup retries and periodic compensation; defer repairs while lifecycle work is pending.
- Project lifecycle evidence immediately, merge equivalent in-flight events and cancel obsolete prewrite work without stale retries. Rebuild task context after superseded recovery.
- Bound native listing deadlines, share identical in-flight reads within one context and retain fresh prewrite/readback safeguards.
- Add private bounded timing diagnostics, lifecycle/race regression coverage and anonymized Desktop acceptance evidence. Real movement remains subject to multi-second native queries and queueing; no latency SLA or cross-host support is implied.

## [0.4.0-beta.1+local.reconcile] - Unpublished local patch

- Add deterministic compensation inside the existing proxy: first check after five seconds, then sixty seconds after each completed check. No model heartbeat or separate daemon.
- Discover loaded App Server contexts without starting/resuming tasks; keep executor context separate from the repair target so unloaded targets can be read through native Desktop tools.
- Rotate bounded batches through eligible tasks in the native recent-50 snapshot, using the shared write queue and current identity/status/protection checks. Ordinary idle Tasks are not treated as completed work.
- Support hot interval configuration and disable, sanitized diagnostics, EOF cleanup, context isolation and missed-event regression tests.
- Existing installations require a normal relaunch through the dedicated entry to load the new immutable runtime. This patch does not republish the beta tag.

## [0.4.0-beta.1] - 2026-09-07

### Added

- Opt-in macOS Desktop stdio proxy that observes structured lifecycle events and uses native Desktop list/read/move tools without sorting model turns, Hooks or heartbeat.
- Local-only automatic discovery, explicit allowlist/exclusions, hot disable, serialized/coalesced events, final state validation and fail-closed protection for manual sections, Projects and remote tasks.
- Private content-hashed installation, dedicated app/command launcher, attachment diagnostics, stale-lock recovery and standalone recoverable uninstall.
- Protocol, Unicode framing, lifecycle, burst, installer and launcher regression tests; optional isolated real App Server tests; Node 20/22/24 CI.

### Fixed during independent review

- Reject fresh Project membership even when an earlier list snapshot classified the task as non-Project.
- Stop observer injection on client EOF while preserving pending Desktop request mappings and draining final server output.

### Release scope

- Prerelease only. Use the dedicated launcher on every start; the original app icon bypasses the proxy. Plugin enablement and the legacy setup command do not install the proxy.
- Start/completion movement was observed on two real local Desktop tasks. A third ordinary task, repeat normal launch, and real approval/cancellation UI acceptance remain unverified.
- Remote and Project tasks are not supported by this new path. No periodic reconciliation, atomic move guarantee or latency SLA is provided. Existing legacy mechanisms must be disabled separately before migration.

## [0.3.2] - 2026-08-31

### Fixed

- Route remote lifecycle events to the controlling Mac without a host override, then resolve the unique task ID to the controller-visible `remote-control:*` host before any read or move.
- Disable remote self-moves in controller-bridge mode so remote Hooks cannot update only the remote machine's local sidebar database and falsely appear centrally reconciled.
- Keep host-bound event wake available as an explicit compatibility mode and fail closed on route/envelope mismatches or duplicate cross-host task IDs.

## [0.3.1] - 2026-08-31

### Fixed

- Allow an unpinned child task of a Pinned Project to move independently while the Project object remains pinned.
- Keep direct Pinned and For Later task membership, parent Projects in For Later or custom sections, ambiguity, exclusions, and Project objects fail-closed.
- Align agent-native transitions, Hook fallback, event wake, heartbeat recovery, documentation, and regression coverage with the same Project-container policy.

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
