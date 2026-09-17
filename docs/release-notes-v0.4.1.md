# Codex Sidebar Flow v0.4.1

This stable patch release makes direct For Later placement a real deferral in
explicit local status-grouping mode. It contains the reviewed implementation at
`6725249ca2b6afb615627c81662821d3ad07ea81` plus release metadata and docs.

## What changed

- A task manually placed in For Later stays there while idle, completed, waiting
  for attention, recovering, or still running the turn that preceded deferral.
- Only an explicit later `turn/started` event can release it. Native start and
  section-entry timestamps must prove the ordering, and the fresh task must still
  be active with no attention flags.
- Missing, invalid or same-second timestamps fail closed. Delayed, retried,
  superseded and already-completed starts cannot undo manual deferral.
- After the subsequent start moves the task to In Progress, normal completion
  moves it to For Review.
- Direct Pinned protection, Project association, Project-container immobility,
  local-only scope, serialized writes and the ten-minute compensation interval
  remain unchanged. No legacy Hook or model heartbeat is restored.

## Compatibility and evidence

| Item | Verified boundary |
| --- | --- |
| Desktop | ChatGPT Desktop 26.908.70816, build 9275, on macOS |
| Bundled App Server | Codex CLI 0.154.0-alpha.6.2 |
| Desktop runtime SHA-256 | `b86111ebc364120494d4c08b1548fbecfc208e159d3a8c07324099d1608b81af` |
| Automated suite | 355 total: 352 pass, zero fail, three opt-in skips |
| Real bundled server | Three isolated transports pass; native Desktop move boundary is substituted |
| Live For Later flow | Deferral held; later start to In Progress in 233 ms; completion to For Review in 285 ms |

The live values measure observer event receipt to native move settlement, not
screen rendering or a latency guarantee. Earlier standalone and Project-child
acceptance used Desktop 26.908.40834 (8881). Other builds require fresh testing.

## Install or upgrade

Use the `v0.4.1` tag and follow the
[Desktop installer](local-desktop-proxy.md#setup). Reinstalling stages a new
immutable runtime while preserving private configuration. Finish running work,
quit normally and reopen Codex to activate it; installation does not force-restart
the app. Verify `installation.json` and the running process path before counting
the upgrade as active.

The plugin manifest and legacy `scripts/setup.mjs` do not install this Desktop
proxy. Do not enable legacy Hooks or a model heartbeat alongside it.

## Known limits

- Scope is local tasks on the named Desktop build. Remote-host classification is
  not part of this release.
- Native approval/input-wait and manual cancellation UI are covered by regression
  tests but have not been separately accepted end to end.
- The platform exposes no conditional section move. Pinning, archiving or manual
  movement after the final read can race the write.
- Second-resolution timestamps intentionally keep same-second ordering deferred.
- Periodic compensation is bounded and can require multiple intervals for a full
  sweep. It is recovery, not the normal real-time path.
- The integration relies on version-specific Desktop capabilities, not a public
  stable extension API.

## Rollback

Set the private config's `mode` to `disabled`, finish work and quit normally.
Reinstall the retained `v0.4.0` source into the same private root, verify that
`installation.json` selects runtime
`0ce55b498559bb339b894a86b291223cac1d6ae66412bfec7cc77a7279937336`,
then restore a v0.4.0-compatible configuration and relaunch. v0.4.0 does not
preserve direct For Later placement in explicit status-grouping mode. No rollback
step requires deleting tasks, restoring legacy Hooks or enabling a heartbeat.
