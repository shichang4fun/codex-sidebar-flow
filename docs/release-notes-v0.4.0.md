# Codex Sidebar Flow v0.4.0

Local event-driven sidebar organization for the tested macOS Desktop build.
This stable release promotes the reviewed implementation at
`796969bb8cae2639d5f62a969b386fd9c83653ab`; release preparation changes only
metadata and documentation, not the Desktop runtime.

## Features and policy

- Explicit `forceStatusSections` groups local root tasks by current runtime
  state: running without attention flags goes to In Progress; idle, error or
  waiting for approval/input goes to For Review. Unknown state fails closed.
- Only directly Pinned tasks are protected in this mode. For Later and other
  task groups can be overwritten. Project membership is preserved; Project
  containers are never moved. Remote, subagent, ephemeral, archived and excluded
  tasks are not managed.
- Fresh active events can move new tasks before their preview appears in local
  task lists. Completion and periodic recovery retain nonarchived list checks.
- Optional original-icon startup and in-proxy periodic compensation require no
  sorting model, legacy Hook or model heartbeat. Existing installations retain
  their conservative default policy until explicitly configured otherwise.

## Compatibility and evidence

| Item | Boundary |
| --- | --- |
| Desktop | ChatGPT Desktop 26.908.40834, build 8881, on macOS |
| Bundled App Server | Codex CLI 0.154.0-alpha.6.2 |
| Desktop runtime SHA-256 | `0ce55b498559bb339b894a86b291223cac1d6ae66412bfec7cc77a7279937336` |
| Automated suite | 327 total: 324 pass, zero fail, three opt-in skips; ordinary and spaced checkout paths |
| Real bundled server | Three isolated transports pass separately; native Desktop move boundary is substituted |
| CI | Node 20/22/24, ordinary and spaced checkout paths |
| First Mac | Fresh GUI-created ordinary and Project-child start/completion accepted with native write/readback evidence |
| Second Mac | Exact installation and tests recorded; activation and verification subsequently confirmed by the maintainer |

First-Mac start/completion timings were 363/154 ms for an ordinary task and
333/645 ms for a Project child. They measure event receipt to native move
settlement, not screen refresh or a latency SLA. Second-Mac confirmation is not
an independently retrieved latency trace. See the
[acceptance record](local-boundary-acceptance.md).

## Install and upgrade

Use the `v0.4.0` tag and the [Desktop installer](local-desktop-proxy.md#setup).
Then explicitly configure [local status grouping](local-status-grouping.md)
using the destination Mac's actual Desktop/local section mappings. Never copy
another user's private IDs. Existing configuration is preserved on reinstall;
installing this release does not silently enable the new policy.

If desired, enable [original-icon startup](original-icon.md). Finish running
work, quit normally and reopen to activate a newly staged runtime. Installation
does not force-restart the app. Installations already running the hash above do
not need reinstalling merely for this metadata-only release.

The plugin manifest and legacy `scripts/setup.mjs` do **not** install the Desktop
proxy. Do not enable legacy Hooks/heartbeat alongside this path.

## Known limits

- Other Desktop builds and controller-side cross-host sorting are outside the
  verified scope. Revalidate after a Desktop update; this relies on
  version-specific capabilities, not a supported third-party extension API.
- Native approval/input-wait and manual cancellation UI have regression
  coverage but have not been separately accepted end to end.
- Pin/archive between the final read and native move is a non-atomic race.
  There is no zero-race, lossless replay or instantaneous-movement guarantee.
- Recovery is bounded and may lag; completion can still require paged local
  reads. Long-running reliability is not established by the short samples.
- Original-icon integration affects the GUI session and uses unsigned local
  launchers. Timing diagnostics are private and can include task IDs; do not
  upload private config, logs or native databases as release evidence.

## Rollback

Preserve private configuration backups and prior immutable runtimes. To restore
a prior runtime, disable the current mode, finish work and quit normally, then
run the retained runtime's installer with the same verified root/app/Node/CLI
paths. Restore a configuration supported by that runtime, relaunch normally and
check task placement. Do not reset an existing source checkout or write native
databases. The previously accepted baseline implementation is
`a3dc1514fd6c36e072f2dae69c03c95bd017f165`; its default policy differs from
explicit status grouping, so do not carry incompatible configuration backward.

For startup problems, [disable original-icon integration](original-icon.md#disable--uninstall)
before bypassing/uninstalling the proxy. The helper is separately installed;
proxy reinstall alone does not roll it back. See
[full uninstall and recovery](local-desktop-proxy.md#uninstall-and-recovery).
