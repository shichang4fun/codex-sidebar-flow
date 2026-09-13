# Local boundary acceptance — 2026-09-13

Runtime: `6f9bb693d394c999c4da7c4d59445f149c876fe7ad5998ace0d0383df649b1dd`.
Build boundary: ChatGPT Desktop 26.908.40834 (8881), bundled CLI
0.154.0-alpha.6.2. Mode: explicit local status grouping with direct Pinned
protection; compensation interval 600 seconds.

## Latest new-task acceptance — 2026-09-14

After a normal user relaunch, process-path inspection and observer records
confirmed runtime `0ce55b498559bb339b894a86b291223cac1d6ae66412bfec7cc77a7279937336`.
The build and explicit status-grouping policy are unchanged. Two new tasks
were created by the user in the original GUI, not by a task-creation tool.
Acceptance inspection was read-only: no controller-issued moves or prompts.

| Fresh GUI-created local task | Start to In Progress | Completion to For Review |
| --- | ---: | ---: |
| Standalone | 363 ms | 154 ms |
| Project child | 333 ms | 645 ms |

Native status, automatic write/readback records and persisted membership agreed.
Both finished in For Review; the child retained its Project association. Active
transactions issued no task-list requests; completion retained list checks.
Times measure event receipt to move settlement, not pixel refresh. These two
samples pass the previously blocked new-task lifecycle gate. They do not rerun
the historical boundary matrix below or establish attention/cancel UI behavior,
an atomic pin/write guarantee, other Desktop builds or a latency SLA.

## Historical method and limits

Reused two existing user-visible local test tasks: a standalone task and a
Project child. Native API calls set initial test placement only (Pinned,
For Later, temporary custom group); test prompts did not move tasks or modify
files. Target status came from native task reads/waits. Movement evidence was
the running observer's native write/readback plus read-only persisted Desktop
membership. No controller-issued expected-destination move was counted as an
automatic transition. Times below are event-to-native-move settlement, not
rendered-pixel latency.

Computer Use was attempted through its authorized interface. The current client
was denied for safety reasons. No alternate UI automation or private write
interface was used to bypass that denial. In particular, tool-created tasks
were not substituted for GUI-new-task acceptance: earlier isolated protocol
tests established that tool-only creation and user-input creation have different
visibility behavior.

## Historical matrix (preceding runtime)

| Case | Evidence | Result |
| --- | --- | --- |
| Existing ordinary / Project-child start and completion | Previous running-client sample | Passed; both destinations and unchanged Project association |
| Direct Pinned during active and after completion | Running client, induced test | Passed; stayed Pinned, no observer move RPC |
| Project child initially in For Later | Running client, induced test | Passed; active to In Progress (310 ms), completed to For Review (149 ms) |
| Ordinary task initially in other custom group | Running client, induced test | Passed; active to In Progress (135 ms), completed to For Review (86 ms) |
| Short Project task, total turn about 2.2 seconds | Running client, induced test | Passed; active/complete moves 116/99 ms, final For Review |
| Repeated compensation after completion | Real scheduled reconciliation | Passed for both test tasks; unchanged, no repeat move |
| Archived, ephemeral, subagent, invalid identity, unknown/notLoaded | Automated regression | Passed; not an induced live GUI test |
| Approval/user-input attention and status races | Automated regression | Passed at tested code boundary; native UI not exercised |
| Pagination, invalid mapping, config switches, capacity | Automated regression | Passed |
| New task and lifecycle via bundled protocol | Three isolated App Server transports | Passed protocol checks only; native Desktop move boundary substituted for force adapter |
| New ordinary task / new Project child via original GUI | Computer Use denied | Blocked; not accepted |
| Native approval/input UI and manual cancellation | Computer Use denied | Blocked; not accepted |
| Pin exactly between final read and native write | No atomic compare-and-set API | Not proven; documented residual race |

For Later observation includes a loaded idle notification before the new active
turn: status mode may first move idle For Later to For Review, then active to
In Progress. This follows the selected policy; For Later is not an idle-state
protection in this mode.

## Checks and findings

### Historical denser-retry acceptance and active-path candidate

After normal activation, a real user-created ordinary task entered In Progress
in 5.37 seconds and completed into For Review in 214 ms. Its next start took
200 ms. The preceding runtime's denser retry schedule therefore did not pass
the initial-latency gate. The current active-event fast-path candidate instead
avoids preview-filtered list inclusion only for fresh active/no-attention local
starts. It has isolated protocol and regression evidence, not a fresh GUI
acceptance result. Retain the failed cold-start gate until user-controlled
activation and new standalone/Project-child samples are verified.

### Subsequent manually created task exposed a startup defect

The user supplied a real GUI-created ordinary task after the matrix run. Its
initial creation/start transactions exited after local list verification, with
no In Progress move. Completion moved successfully in 274 ms; a later resumed
turn moved at start/completion in 245/352 ms. Initial user-message persistence
was about 5.3 seconds after the recorded task start. This supports a cold-start
visibility gap, but the historical log does not contain the exact failed list
response or pixel-refresh timing. New-task acceptance is **failed**, not passed
by the existing-task samples above.

The reproducer confirms that a valid list missing an otherwise active exact
task ended processing without retry. The candidate fix labels only that absence
`TASK_NOT_VISIBLE`, reusing the manager's existing four finite retry delays.
Eight regressions cover ordinary/Project visibility, completion before retry,
completion consuming a pending retry, fresh Pinned protection, never-visible and
archived exhaustion, and malformed responses. The changed runtime still needs
normal relaunch and new user-created task acceptance; old runtime measurements
are not acceptance of this correction.

### Original matrix checks

- Fresh full suite: 282 tests, 279 passed, zero failures, three opt-in skips.
- Separately executed bundled App Server tests: three passed, zero failures.
- Pinned rejection currently logs `action: error` instead of a distinct policy
  skip. Archive exclusions can also appear as errors. These records are not
  evidence of a failed move: the test confirms no move was dispatched. This is
  an observability improvement to address separately, not silently fixed during
  acceptance.
- These samples do not establish every possible boundary, a stable latency SLA,
  remote support, or complete GUI acceptance. No release was published.

## Historical cleanup and remaining manual gate

The temporary custom group was verified empty and removed. Both reused test
tasks returned to For Review automatically, then were restored to archived
state. No business files were edited and no real Project container was moved.
Task history is retained and can be restored from the archive.

The new ordinary and Project-child GUI gates were subsequently closed by the
latest samples above. Remaining manual gates: on a test task, exercise a real
input/approval wait and cancel a running wait using the native
button. Record native status and observer timing alongside observed UI state.
Do not request broader OS access or bypass a safety denial merely to complete
this matrix. The read/write pin race remains a limitation even if manual samples
pass.
