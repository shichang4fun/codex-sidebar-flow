# Local status grouping — For Later policy update (unreleased)

This checkout adds a direct For Later exception to the released v0.4.0 force
policy. Existing v0.4.0 installations still overwrite For Later until upgraded.
The released behavior and evidence remain in [v0.4.0 notes](release-notes-v0.4.0.md).

This is a new, explicitly selected policy, not a silent upgrade of existing
manual-group protections. The released baseline targeted ChatGPT Desktop
26.908.40834 (8881), bundled Codex CLI 0.154.0-alpha.6.2. Other builds need new
verification. Protocol tests do not establish real Desktop GUI acceptance.

After normal relaunch, fresh user-created standalone and Project-child GUI
tasks passed automatic start/completion movement. Active moves took 363/333 ms;
completion moves took 154/645 ms. Active transactions made no task-list request.
These are event-to-move measurements, not pixel latency or complete boundary
acceptance. See [current and historical evidence](local-boundary-acceptance.md).

## Rules

| Local root task | Result |
| --- | --- |
| Directly Pinned | No move |
| Directly in For Later | Keep placement unless a provably subsequent turn starts; see below |
| Active, no attention flags | In Progress |
| Active, waiting for approval/user input | For Review |
| Idle or systemError | For Review, without requiring remembered start evidence |
| Unknown/notLoaded, malformed status or identity | No move |
| Archived, ephemeral, subagent, excluded or remote | No move |

Other custom task groups are overwritten according to status.
Project association and the Project's group are not classification inputs.
Only the task moves: Project containers are never moved, including pinned
containers. Parent placement does not protect a child.

### For Later means deferred

Only a current explicit `turn/started` event can release a directly deferred
task. The attached server's `turn.startedAt` must be strictly greater than the
fresh task's `sectionEnteredAt`, and fresh status must still be active with no
attention flags. These checks repeat immediately before the native write.
After a successful move to In Progress, completion follows the normal review rule.

Idle, completion, attention, ordinary active notifications and periodic recovery
cannot release For Later. Moving a running task there invalidates earlier start
evidence, including delayed/retried starts. No persistent history or additional
global/remote query is introduced; the timestamps come from the same server.
For Later is identified by its current native section name or the local section
list's ID. Renaming it removes the named rule, like other named destinations.

Both timestamps have second precision. Missing/invalid fields or same-second
operations stay deferred; unknown ordering is not guessed. A short turn already
completed, or a start superseded by a later status notification before processing,
also stays deferred. Resume a later turn or manually remove the task from For
Later to release it. The final read/write race remains non-atomic.

This patch is verified with synthetic regressions and isolated actual bundled
App Server transports, not a live Desktop GUI acceptance. The inspected current
app is 26.908.70816 (9275), bundled CLI 0.154.0-alpha.6.2. Do not reuse the older
GUI sample above as acceptance of this policy change or the updated app build.

## Query path

The existing stdio observer receives local lifecycle events and reads the exact
task's native status and section. In force-status mode, a current running event
(a valid turn start or active notification with no attention flags) enables a
small fast path: if the fresh task read also says active with an empty flags
array, it does not wait for `thread/list` preview materialization. Other events,
states and periodic compensation still verify nonarchived inclusion using a
local `thread/list` filtered by cwd/source. The native Desktop move uses
`hostId: local`. It rechecks Pinned and status immediately before the write and
verifies local section/Project readback afterward. It never calls
`codex_app.list_threads`, enumerates remote hosts, scans session files, or reads
private Desktop databases at runtime. No model, Hook or heartbeat is added.

The reserved Pinned section ID is a current-build protocol constant, not a
user ID. Local section discovery must expose it; otherwise no move is allowed.
Missing placement metadata is not treated as unpinned. Legacy-only pin stores
on unsupported builds are not a supported migration path.

The fast path relies on verified behavior of the bundled build above: archive
unloads a running task, another local App Server cannot archive its active
writer, and direct resume of archived tasks is rejected. It never resumes a
task to establish eligibility. Unknown/attention/terminal states do not use
this active-only proof; their exact raw read lacks an archive flag, so their
nonarchived query remains necessary. It follows pages rather than interpreting
absence from one page as archival. This is not a global Desktop/remote query,
but large local directories can still require multiple reads. Native writes
remain serialized and have no atomic compare-and-set guard: pinning or archiving
after the final read can race a move. There is no instantaneous-movement or
zero-race guarantee. The fresh GUI samples above do not establish native
attention/cancel UI behavior or compatibility with other Desktop builds.

When the fast path cannot apply (for example, runtime metadata is still notLoaded),
force-status lifecycle starts missing from a valid local list use bounded
retry delays of 250, 250, 250, 250, 500, 500, 1000, 2000 and 3000 ms, each after
the preceding failure. Transport failures, idle-only events and the default
policy retain the original 250, 750, 2000 and 5000 ms backoff.
New tasks may start before their first user message makes them list-visible.
Every retry rereads status and protected placement; an already-completed task
goes directly to For Review unless directly deferred in For Later.
Missing/archived tasks never become eligible merely by
retrying. Invalid responses remain errors, and periodic recovery does not start
a separate retry timer. Consecutive start-visibility failures allow at most nine
retries (previously four), with the same eight seconds of timer waits, excluding
RPC and queue time. This trades a few extra local reads for shorter early gaps;
it does not accelerate underlying persistence. A longer visibility delay may
still require a later event or compensation pass. A real new-task sample on the
preceding denser-retry runtime still took 5.37 seconds to enter In Progress;
denser retries alone did not solve initial latency. Simulated timing is not a
UI latency guarantee.

Periodic compensation reuses the existing timer (including a configured
600-second interval). Each pass processes up to one local page of 20 candidates,
retaining progress when lifecycle work takes priority. A full sweep can take
multiple intervals; unknown/notLoaded tasks are not resumed just to classify
them. Force transactions do not retain per-task history after completion.

## Explicit configuration

Back up the private installation's `config.json`, preserving its mode, exclusions
and interval. Add `forceStatusSections` with these two named entries:

```json
{
  "inProgress": { "desktopId": "DESKTOP_LOGICAL_UUID", "localId": "LOCAL_APP_SERVER_UUID" },
  "forReview": { "desktopId": "DESKTOP_LOGICAL_UUID", "localId": "LOCAL_APP_SERVER_UUID" }
}
```

The placeholders must be replaced with verified current-account IDs. Desktop
logical section IDs and host-local App Server section IDs are different namespaces;
do not infer one from the other, task titles, or a remote host. Verify the Desktop
section's local mapping during setup and both local names (`In Progress`,
`For Review`). IDs must be distinct UUIDs; the runtime revalidates local names/IDs
on each transaction. Configuration is trusted deployment input: local validation
alone cannot prove a logical mapping belongs to the current Desktop account.
Remove the opt-in before switching accounts or reusing configuration on another
machine. An invalid mapping must not be treated as a recoverable automatic guess.

Use the existing installer to stage the reviewed runtime. Reinstall preserves
config; it does not add this field automatically. A normal Desktop quit/relaunch
is required to load changed runtime files. Never count a staged hash or isolated
server result as evidence that the live client has switched.

## Rollback

Set `mode` to `disabled` to block future operations (an already-dispatched move
may finish). Restore the config backup/remove `forceStatusSections` to return to
the default manual-group protection policy. Reinstall a retained reviewed source
revision and relaunch normally if runtime rollback is also needed. No task is
deleted. Previously overwritten manual groups are not automatically reconstructed;
restore those task placements manually if needed. Do not re-enable legacy Hooks
or heartbeat as part of rollback.
