# v0.4.0-beta.2 release notes — draft, not published

Status: candidate metadata only on `feat/local-periodic-reconciliation`.
`VERSION`, `package.json` and `.codex-plugin/plugin.json` agree. This document does
not create a tag, GitHub Release or stable-support commitment. Publish only after
the maintainer explicitly approves the final reviewed commit and remote readback.

## Changes since beta.1

- Support eligible local root tasks, including children of an ordinary Projects
  entry without individual sidebar membership. Move only the child between
  In Progress and For Review; preserve its `projectId` and parent placement.
- Keep Pinned, For Later, other custom groups and ambiguous task/parent membership
  fail-closed. A Pinned Project protects its children. Never move Project
  containers, remote tasks, subagents, archived tasks or excluded organizers.
- Retain short-turn start evidence, coalesce equivalent events and supersede
  obsolete prewrite work while preserving fresh identity/status/readback checks.
- Add deterministic in-proxy periodic compensation and optional original-icon
  startup. No sorting model, legacy Hook or heartbeat is needed.
- Add bounded private timing diagnostics. These include task IDs but no task
  content; do not upload them as public acceptance evidence.
- Correct the doctor CLI test fixture to use the installer's quoted Hook command,
  rather than a hand-built unquoted path. Always test real copied source/plugin
  runtimes under a path containing spaces, rejecting wrong fingerprints before
  accepting exact fingerprints. Production fingerprint verification is unchanged.
- Extend Node 20/22/24 CI to ordinary and space-containing checkout paths; align
  current scope, security, installation and rollback documentation.

## Compatibility and acceptance boundary

| Component | Verified boundary |
| --- | --- |
| Desktop on the closeout Mac | ChatGPT Desktop 26.908.40834, build 8881 |
| Its real bundled App Server | Codex CLI 0.154.0-alpha.6.2 |
| Accepted implementation | `a3dc1514fd6c36e072f2dae69c03c95bd017f165` |
| Unchanged Desktop runtime SHA-256 | `6f25af2678ab8e740445d06a6f5c0490f1a3221224d8b00f95a2d876066fc96d` |

The maintainer supplied real GUI acceptance for ordinary and ordinary-Project
child tasks: active → In Progress → completed → For Review; Project association
and placement preserved; Pinned Project/Pinned/For Later protected; original-icon
observer startup verified. The recorded timed sample resumed existing tasks, not
new-task creation. See [baseline evidence](local-new-task-validation.md).

Release closeout changes only tests, CI, metadata and documentation. No Desktop
runtime file, classifier, guard, installed configuration or business repository is
changed. The plugin manifest version changes its **legacy plugin** fingerprint;
that does not enable the legacy plugin or alter the Desktop runtime hash.
An installation already running the accepted hash needs no runtime reinstall for
these closeout-only changes.

Other ChatGPT/Codex Desktop builds, another Mac's local installation and controller
cross-host organization are not established by this acceptance. Retest after an
app update. The direct Desktop MCP tools and `CODEX_CLI_PATH` are version-specific
implementation capabilities, not a supported third-party extension contract.

## Release gates

Local verification on Node 22.23.1:

| Gate | Total | Pass | Fail | Skip |
| --- | ---: | ---: | ---: | ---: |
| Full suite, ordinary checkout | 227 | 224 | 0 | 3 |
| Full suite, checkout path containing spaces | 227 | 224 | 0 | 3 |
| Explicit real bundled App Server tests, ordinary checkout | 3 | 3 | 0 | 0 |
| Explicit real bundled App Server tests, spaced checkout | 3 | 3 | 0 | 0 |

The three default skips are the explicit opt-in App Server tests above, not
skipped path/fingerprint regressions. Both `npm run check` and
`npm run check:desktop` pass in both checkouts. The App Server tests use temporary
storage, a loopback fixture model and fixture MCP calls, not real Desktop sidebar
storage or paid model calls. GUI acceptance is separate and inherited from the
unchanged accepted runtime, not rerun or inferred from these isolated tests.

Before publishing, confirm independent review, a diff limited to release closeout,
remote branch SHA equality and CI for that exact commit. No private paths,
usernames, live task IDs, logs, tokens or acceptance databases belong in the
commit or release assets. This draft contains only aggregate evidence.

## Recommendation and remaining risks

Publish as **beta / pre-release**, not stable. Ordinary and Project-child
lifecycles are accepted, but evidence is bounded to one build and a small sample.
Real approval/cancellation UI lifecycles, broader build/host compatibility,
long-running reliability and native-icon-speed movement remain unverified.
Native listing/queueing can still take seconds; read-and-move is not atomic.
Compensation is bounded recent-list recovery, not lossless event replay or an SLA.
The original-icon override affects the GUI session, and launchers are unsigned.

## Upgrade and rollback

Use the [current Desktop installer](local-desktop-proxy.md#setup), not legacy
`setup.mjs` or plugin enablement. Preserve configuration/exclusions and verify the
selected commit/hash. Newly installed runtime code requires a normal quit/relaunch
and real movement verification; never force-quit ongoing work.

For this closeout, the prior accepted code is `a3dc1514fd6c36e072f2dae69c03c95bd017f165`
and the Desktop hash is unchanged. To roll back a later runtime upgrade, privately
back up config, atomically disable its mode, quit normally, then reinstall from a
separate checkout of that accepted commit using the same root and verified paths.
Verify the selected hash, restore the intended mode/exclusions, relaunch and
recheck placement. Do not reset/overwrite an existing working tree or delete
retained snapshots. Follow [full recovery steps](local-desktop-proxy.md#uninstall-and-recovery).

For original-icon problems, [disable that integration](original-icon.md#disable--uninstall)
before using the original icon as a bypass or uninstalling the proxy. Proxy
reinstall does not roll back its separately installed helper. The proxy uninstaller
moves only its owned directory to a recoverable backup; no rollback requires
restoring Hooks, heartbeat or remote bridges.
