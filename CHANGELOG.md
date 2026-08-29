# Changelog

All notable changes to this project are documented here.

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
