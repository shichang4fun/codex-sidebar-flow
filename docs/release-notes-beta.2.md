# v0.4.0-beta.2 — archived development draft

Superseded by [v0.4.0 release notes](release-notes-v0.4.0.md). Pending gates and
recommendations below are historical snapshots, not current release status.

Status: candidate metadata only on `feat/local-periodic-reconciliation`.
`VERSION`, `package.json` and `.codex-plugin/plugin.json` agree. This document does
not create a tag, GitHub Release or stable-support commitment. Publish only after
the maintainer explicitly approves the final reviewed commit and remote readback.

## Changes since beta.1

- Opt-in `forceStatusSections` groups local root tasks by runtime status and
  protects only direct Pinned membership. For Later, other task groups and
  parent Project placement do not protect children in this mode; Project
  association is preserved and Project containers are never moved. The
  conservative default policy described in the following bullets is unchanged.
- Support eligible local root tasks, including children of an ordinary Projects
  entry without individual sidebar membership. Move only the child between
  In Progress and For Review; preserve its `projectId` and parent placement.
- Let directly deferred For Later tasks enter In Progress only on fresh active
  state without attention flags. Idle/attention/unknown/stale-start cases stay
  deferred; no direct For Later-to-review move is allowed. Completion after a
  successful start move follows the normal For Review rule, including recovery.
- Keep Pinned tasks, other custom groups and ambiguous membership fail-closed.
  Parent Projects in Pinned, For Later or other custom groups protect children.
  Never move Project
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
| Previously accepted Desktop runtime SHA-256 | `6f25af2678ab8e740445d06a6f5c0490f1a3221224d8b00f95a2d876066fc96d` |
| For Later candidate runtime SHA-256 (GUI acceptance pending) | `859b777e6f32c5b6fb6a8ca5bbc06b9a7520a0ea9443d9d8498c7a0f233d4409` |

The maintainer supplied real GUI acceptance for ordinary and ordinary-Project
child tasks: active → In Progress → completed → For Review; Project association
and placement preserved; Pinned Project/Pinned/For Later protected; original-icon
observer startup verified. The recorded timed sample resumed existing tasks, not
new-task creation. See [baseline evidence](local-new-task-validation.md).

The initial closeout at `0043069c21eb42dcdd60047d3bcbf86eb2950067` changed only
tests, CI, metadata and documentation. The subsequent authorized For Later start
rule changes the Desktop observer, manager and write guard. It needs a new runtime
installation, normal relaunch and GUI acceptance; the old hash is no longer the
candidate hash. Pinned and Project ancestor protections remain unchanged. No
legacy Hook/heartbeat or business repository is changed.

Other ChatGPT/Codex Desktop builds, another Mac's local installation and controller
cross-host organization are not established by this acceptance. Retest after an
app update. The direct Desktop MCP tools and `CODEX_CLI_PATH` are version-specific
implementation capabilities, not a supported third-party extension contract.

## Release gates

### Local active-event fast path (fresh GUI-created samples passed)

The denser-retry runtime was activated, but a real manually created ordinary
task still took 5.37 seconds at first start, versus 214 ms at completion and
200 ms on a subsequent start. This did not pass the cold-start latency gate.
Bundled-server probes reproduced active exact reads while both DB-only and
scan-and-repair lists still filtered the empty preview.

The lifecycle manager now enables the force adapter's active-only fast path
only when its latest event projects a valid running state. Fresh exact metadata
must independently confirm active with empty flags, local root identity and
non-Pinned placement. Completion/attention/unknown events, periodic recovery
and the default policy retain their existing checks. Each retry rebuilds current
policy; obsolete work is cancelled before write and config changes still revoke
permission. A reviewer-discovered attention-event scope leak was fixed with
four red/green regressions.

Real bundled-server tests use the actual lifecycle manager and substitute only
the native Desktop write with an isolated raw section move. They require a move
before preview materialization, no task-list call on active movement, list
checks on completion, native Pinned/archived rejection, and rejection of another
local App Server's archive request while the task has an active writer.
These are not renderer or real GUI latency tests. Pin/archive after the final
read remains a non-atomic boundary. Existing installation config and prior
immutable runtime must be retained for rollback; no tag or Release is authorized.

Verification after lifecycle wiring and the attention-scope fix: ordinary and
space-containing checkouts each pass 327 total tests (324 pass, zero fail,
three opt-in skips). Both syntax checks pass on both paths. All three bundled
App Server transport tests pass separately. These replace neither a normal
activation check nor fresh manually created standalone/Project-child GUI samples.

Independent review closed the attention-scope finding and found no remaining
installation blocker. Runtime
`0ce55b498559bb339b894a86b291223cac1d6ae66412bfec7cc77a7279937336`
was activated by a normal user relaunch, confirmed by the running process path
and observer records; all twelve runtime files match the checkout and private
config is byte-for-byte preserved. Two fresh user-created GUI tasks passed:

| New local task | Start to In Progress | Completion to For Review |
| --- | ---: | ---: |
| Standalone | 363 ms | 154 ms |
| Project child | 333 ms | 645 ms |

Both finished in For Review; the child retained its Project association.
Active transactions issued no task-list request. Times measure event receipt
to native move settlement, not rendered pixels. These samples close the two
new-task lifecycle gates, not native attention/cancel UI or every race case.
See [acceptance evidence](local-boundary-acceptance.md).

The prior immutable runtime
`f89a2c64374cf0c6e414d67eeb91a369de0284d1541b8d1b5d5ca90bb70022f9`
is retained for rollback. Roll back by running the retained prior runtime's
installer with the same verified root/app/Node/Codex arguments, preserve config,
then relaunch normally; no app bundle or private database edit is needed.

### Historical new-task visibility retry correction (superseded above)

Follow-up: force-status starts now use a denser bounded schedule (250, 250,
250, 250, 500, 500, 1000, 2000, 3000 ms). It replaces the four-delay schedule
described in the original correction below, retaining eight seconds of timer
waits for consecutive visibility failures. Other failure paths keep the original
backoff. A deterministic fixture visible at 1.2 seconds is handled at 1.5 seconds
instead of 3 seconds, excluding RPC/queue time; this is not fresh GUI acceptance.
Follow-up verification: ordinary and space-containing checkout suites each
report 295 total, 292 pass, zero fail and three opt-in skips; both syntax checks
pass on both paths. The three bundled App Server isolated tests pass separately.
No tag or Release is created. This schedule still requires runtime activation
and a fresh real GUI-created task latency sample.

A later user-created ordinary GUI task exposed an initial-start failure in the
local status grouping runtime below. Valid local listing had not yet provided
the task, and the adapter's ordinary error discarded the start without retry.
The correction adds `TASK_NOT_VISIBLE` to that specific exhausted-list absence
and reuses the existing four lifecycle retry delays. No queue, global query,
heartbeat, dependency or protection bypass is added. Each retry rereads current
state and placement; completed tasks go directly to review and Pinned/archived
tasks cannot be moved by retained start evidence.

Eight new regressions were added, with seven failing before the correction and
all passing afterward (malformed-response rejection already passed). Ordinary
and space-containing full suites each report 290 tests: 287 pass, zero fail,
three opt-in skips. Both syntax checks pass on both paths. Three real bundled
App Server isolation tests pass separately. Independent narrow review ran 74
related tests and found no blocker.

Runtime `5bacf865fd34c2eef4916097b0bac64c29d8bbc25f2e6697722b8626ec5b04f1`
is staged with existing configuration preserved; process inspection still showed
the preceding runtime. A normal user relaunch and fresh manually created
standalone/Project-child tests remain required. Four retry waits total eight
seconds plus RPC/queue time, so this repairs a dropped-event path, not all cold
startup latency. No tag, release or GUI-new-task success is claimed.

### Local status grouping candidate (running-client lifecycle sample passed)

An explicit `forceStatusSections` configuration now selects local-only queries
and status-driven placement with direct Pinned protection. For Later, other
manual sections and parent Project placement no longer block task-only moves.
Existing configuration files retain the default policy described above. See
[configuration, limits and rollback](local-status-grouping.md).

The tested bundled App Server exposes direct pin membership in `thread/read`.
All three isolated transports verify rejection of pinned tasks, a For Later to
For Review transition, and idempotency using the real local protocol. The native
Desktop move boundary is substituted in these tests: neither GUI invalidation
nor end-to-end latency is established. Do not reuse older GUI acceptance or
query-handoff timings as acceptance of this new policy.

Independent review identified missing pagination in nonarchive verification and
unnecessary retained force observers. Both have dedicated regressions and fixes.
Final independent re-review found no remaining blocker after also fixing the
default-to-force hot-switch capacity guard. Ordinary and space-containing paths
each pass 282 tests (279 pass, zero fail, three opt-in skips); both syntax checks
pass on both paths. The three real bundled App Server tests pass separately.
Runtime `6f9bb693d394c999c4da7c4d59445f149c876fe7ad5998ace0d0383df649b1dd`
was staged locally with a backed-up configuration, then confirmed loaded by
process-path inspection after a normal user relaunch. Two existing local GUI
tasks (standalone and Project child) were resumed and completed without any
controller-issued section move. Native task status, observer write/readback
records and read-only persisted Desktop membership agreed on both transitions.
Project association remained unchanged; test tasks were re-archived afterward.

| Existing local task | Start to In Progress | Completion to For Review |
| --- | ---: | ---: |
| Standalone | 288 ms | 164 ms |
| Project child | 146 ms | 172 ms |

Times are event receipt to native move-RPC settlement, not rendered-pixel latency.
The observer recorded zero global `list_threads` calls in this process through
the sample. One independently observed Pinned task was rejected before writing
and remained pinned; this was not an induced active/completed Pinned test.
New-task creation, live For Later/custom-group transitions, attention UI and a
pin-during-write race were not exercised by this initial sample. Subsequent
[boundary acceptance](local-boundary-acceptance.md) passed induced Pinned,
For Later, custom-group, short-task and scheduled-idempotency checks in the
running client. GUI-new-task and native attention/cancel checks remain blocked
by Computer Use safety restrictions. No stable latency SLA, complete GUI
acceptance or publication is claimed.

### Query-handoff candidate (functional sample passed; latency gate failed)

Superseded prewrite waits now yield immediately instead of blocking the serial
queue until an obsolete RPC returns. Successors retain their own event identity
and guarded transaction. The existing relay shares only identical unresolved
lists within the same task context; it never caches completed snapshots. Fresh
prewrite protection/status checks and postwrite readback remain mandatory, and
already-dispatched writes are not cancelled.

The relay/manager regression reduces the overlapping anonymous-active and
explicit-start scenario from four wire list requests to three. A blocked obsolete
target read no longer delays a successor's completion. These are deterministic
scheduling results, not a measured Desktop speedup or a fix for a list request
that remains stalled. Extremely short tasks may still finish before classification.
Timing records measure logical wait until supersession, not eventual wire time.

Validation: ordinary-path and space-containing-path suites each report 252 tests,
249 pass, zero fail and three opt-in skips; the three bundled App Server tests
pass separately. Both syntax checks and whitespace checks pass. Independent
review found no blockers and ran 73 relevant tests with strict unhandled-rejection
checking.

A normal relaunch activated runtime
`6739e33f748b212990d975ac8a4f25ddf606e249b1fc8709d76f0ed9c9adbee5`.
Two existing local tasks again transitioned automatically through In Progress
and For Review. Native task status, observer move/readback records and read-only
persisted Desktop membership were checked, without a controller-issued move.

| Task / transition | Previous runtime sample | Query-handoff sample |
| --- | ---: | ---: |
| Ordinary start | 7.246 s | 3.903 s |
| Project-child start | 8.707 s | 5.356 s |
| Ordinary completion | 5.177 s | 13.656 s |
| Project-child completion | 9.218 s | 24.369 s |

These are event-entry to move-RPC-settlement timings, not pixel-render latency.
The independent runs are not a controlled benchmark: starts were faster, but
completions were slower. Completion transactions spent 17.693 s and 14.741 s in
list waits through readback, with the second also queued for 14.611 s. Logs confirm
immediate supersession, but not an overall latency improvement or resolution of
global-list variability. A 3.174 s short turn remained in For Review throughout;
its completion correctly returned unchanged after 0.705 s. Immediate short-task
running display therefore still fails.

Project association/parent custom placement and Pinned task/Project IDs plus
For Later memberships remained unchanged across this sample. This is not a new
protected-task lifecycle test. Both reused fixtures were restored to their prior
archived state. No new-task-creation or stable performance claim is made. The
query-stall/latency release gate remains open; do not publish this as a proven
speed improvement.

### Additional query-stall gate (not yet accepted)

After the For Later runtime was activated, one real start moved successfully,
but a controlled ordinary/Project lifecycle trial did not pass: native
`list_threads(limit=50)` calls repeatedly hit the observer's 35-second deadline
before classification. Direct native calls also stalled. Read-only comparisons
with limits 1, 10, 25 and 49 returned complete pinned/section data. Installed
client code aggregates local/remote lists, ChatGPT queries and pinned hydration;
the precise internally hung promise has not been identified. Local App Server
`thread/list` responses in the same client log were fast.

An uninstalled smaller-list experiment was withdrawn after review found reduced
duplicate-ID visibility. The original list/read/move architecture and safeguards
remain unchanged; scope stays local and limited to the For Later start rule.
The query fault is tracked separately and is not fixed. Do not publish on the
basis of the earlier test counts or the single successful start below.

### Snapshot-recovery correction and limited local acceptance

Incomplete Desktop protection snapshots now use the existing transient-error
path instead of a permanent error. This preserves genuine start evidence during
the existing bounded retries, allowing a short completed task to be classified
when protection data recovers. Missing protection still blocks movement; retry
exhaustion can still discard activity evidence. No new state store, remote
support, Hook or heartbeat was added.

Six regressions cover ordinary/Project completion recovery, direct Pinned and
For Later protection, Pinned Project ancestry, and finite retries. Independent
review found no blocking issue for this bounded correction. Global
`list_threads` remains; this is not the proposed local-only replacement and does
not fix the query-stall gate above.

| Candidate check | Total | Pass | Fail | Skip |
| --- | ---: | ---: | ---: | ---: |
| Full suite, ordinary source path | 243 | 240 | 0 | 3 opt-in |
| Full suite, source path containing spaces | 243 | 240 | 0 | 3 opt-in |
| Bundled App Server opt-in tests | 3 | 3 | 0 | 0 |

`npm run check`, `npm run check:desktop` and `git diff --check` also passed.

On the reference Desktop build, all three isolated bundled App Server transports
passed. Raw section writes read back successfully, with no notification observed
between write and readback. Native Desktop movement additionally invalidates
window/query state. Server readback is therefore not evidence of immediate
Desktop sidebar refresh. The separate real Desktop observations below are not
derived from these isolated tests.

After a normal relaunch, process inspection confirmed runtime
`ba5afa9a5dca4991b8384425360993f759e7889b915afd24c39136908e0b54bb`.
Two existing local acceptance tasks (ordinary and ordinary-Project child) were
resumed with wait-only prompts. Native task status, observer move/readback
records and read-only persisted Desktop sidebar membership agreed on active
in In Progress, then completed in For Review. No controller-issued section move
was used; the Project association stayed unchanged.

| Existing task | Start event to move RPC settlement | Completion event to move RPC settlement |
| --- | ---: | ---: |
| Ordinary | 7.246 s | 5.177 s |
| Project child | 8.707 s | 9.218 s |

These are not pixel-render timings or a latency guarantee. An additional 3.537 s
ordinary turn completed before the start transaction could write; it remained
in For Review and its completion was correctly unchanged. This fails an
immediate-running-display expectation, despite a correct final destination.
Pinned task/Project IDs and For Later memberships were unchanged across this
short-turn trial; this is not a fresh protected-task lifecycle test. Both reused
fixtures were restored to their prior archived state after measurement.

This sample did not reproduce missing protection metadata, so the narrow
snapshot-recovery case remains established by regressions rather than live fault
injection. No new-task creation, all-local discovery, pixel-level UI refresh or
query-stall resolution is claimed. The release gate remains open.

### Previously verified For Later candidate

For Later candidate verification on Node 22.23.1:

| Gate | Total | Pass | Fail | Skip |
| --- | ---: | ---: | ---: | ---: |
| Full suite, ordinary checkout | 237 | 234 | 0 | 3 |
| Full suite, checkout path containing spaces | 237 | 234 | 0 | 3 |
| Explicit real bundled App Server tests, ordinary checkout | 3 | 3 | 0 | 0 |
| Explicit real bundled App Server tests, spaced checkout | 3 | 3 | 0 | 0 |

The three default skips are the explicit opt-in App Server tests above, not
skipped path/fingerprint regressions. Both `npm run check` and
`npm run check:desktop` pass in both checkouts. The App Server tests use temporary
storage, a loopback fixture model and fixture MCP calls, not real Desktop sidebar
storage or paid model calls. GUI acceptance is separate: the earlier accepted
runtime does not prove the new For Later rule, and isolated tests cannot replace
that GUI check. Ten new regressions cover the For Later exception and preserved
Pinned/parent protection; targeted tests were observed failing before the fix.

Before publishing, confirm independent review, a diff limited to the reviewed
candidate scope including the For Later start rule,
remote branch SHA equality and CI for that exact commit. No private paths,
usernames, live task IDs, logs, tokens or acceptance databases belong in the
commit or release assets. This draft contains only aggregate evidence.

## Recommendation and remaining risks

Publish as **beta / pre-release**, not stable, and only after the new For Later
runtime receives GUI acceptance. Earlier ordinary and Project-child lifecycle
evidence is bounded to one build and a small sample.
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

The prior accepted code is `a3dc1514fd6c36e072f2dae69c03c95bd017f165`
with the previous hash above; it keeps For Later protected. To roll back, privately
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
