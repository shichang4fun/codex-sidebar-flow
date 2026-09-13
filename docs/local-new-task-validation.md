# Local new-task lifecycle validation

This page describes the current development branch, not the published beta tag.
The Desktop adapter supports local root tasks, including children of an ordinary
Projects entry. It moves the task only and preserves its Project association.
Pinned tasks, For Later, custom sections, protected or ambiguous parent Projects,
remote tasks, archived tasks and excluded organizer tasks remain fail-closed.

## Implementation

- Treat a Project child with no individual membership as a candidate only when
  its parent has one unambiguous ordinary Projects membership.
- Retain genuine start evidence across bounded startup retries and compensation,
  including short turns that finish before native sidebar metadata appears.
- Reuse a snapshot only inside one reconciliation. Refresh membership before
  writing and after writing; keep an authoritative task read adjacent to the move.
- Coalesce identical in-flight list RPCs within one executor context. Native
  listing has a 35-second timeout; other RPCs keep their normal deadlines.
- Project lifecycle state synchronously on event receipt. Known duplicate state
  and turn events share the running transaction. New identities, attention,
  terminal and unknown transitions supersede obsolete prewrite work.
- Do not infer that an anonymous active event and a first explicit turn ID are
  the same turn. Preserve the real start evidence for the successor.
- Superseded reads may settle but cannot issue an obsolete write or stale retry.
  Once a write is dispatched, complete fresh readback before the next transaction.
- Discard a superseded recovery observer so lifecycle work uses its own context.
- Defer periodic repairs while lifecycle work is pending; keep repair batches
  bounded and round-robin. No model is invoked to classify tasks.
- Write private, bounded, content-free timing records. See
  [Desktop proxy diagnostics](local-desktop-proxy.md#privacy-and-permissions).

## Baseline automated verification, 2026-09-13

The default suite passed 223 tests with zero failures and 3 opt-in tests skipped.
The 3 real bundled-App-Server tests were enabled separately and passed using
isolated temporary storage and a loopback fixture model. Both syntax-check
commands and whitespace checks passed.
These counts describe accepted commit `a3dc1514fd6c36e072f2dae69c03c95bd017f165`,
before release-closeout regressions; current gate results are tracked in the
[release notes draft](release-notes-beta.2.md).

Seventeen added event/coalescing regressions cover duplicate starts, first-turn
identity, stale reads, completion and attention transitions, unloaded state,
Project tasks, protected membership, transport retries and recovery-context
replacement. Independent review found and regression-tested the recovery-context
defect before approving the corrected implementation.

## Real Desktop acceptance

The release-closeout environment identifies ChatGPT Desktop 26.908.40834 (8881)
and bundled CLI 0.154.0-alpha.6.2. The maintainer additionally confirms ordinary
GUI and ordinary-Project child lifecycle placement, unchanged `projectId`/parent
placement, Pinned Project/Pinned/For Later protection and original-icon observer
startup. This does not broaden compatibility beyond that tested build. The
timed observations below are the narrower recorded existing-task sample.

After a normal restart, process inspection confirmed the installed runtime
`6f25af2678ab8e740445d06a6f5c0490f1a3221224d8b00f95a2d876066fc96d`.

Two existing acceptance tasks (ordinary and Project-contained) were resumed with
a bounded wait-only prompt. Native Desktop snapshots observed both active in
In Progress, then completed/idle in For Review. Project association and the
Pinned/For Later membership arrays were unchanged. The organizer stayed excluded.
No controller-issued sidebar move was used.

| Existing task | Start notification to progress move | Completion notification to review move |
| --- | --- | --- |
| Ordinary | 6.341 s | 4.548 s |
| Project | 8.937 s | 5.013 s |

These measure notification entry to move RPC settlement, not pixel-render time.
The ordinary start transaction coalesced two notifications and the Project start
coalesced three. Superseded transactions stopped after one list read. All four
moves finished fresh readback without errors or duplicate unchanged start
transactions. The three list calls in each successful transaction still took
4.49–6.53 seconds; the Project start waited 4.741 seconds in the shared queue.

## Acceptance boundaries

- Lifecycle placement passed for two existing local tasks after restart.
- This was not a new-task-creation acceptance, a controlled repeated benchmark,
  or a demonstration of native-icon-speed movement.
- Prior runs showed substantially slower listing and queueing, so this small
  sample cannot establish a stable speedup or a latency SLA.
- Global listing and serialized readback remain bottlenecks. Do not remove
  protection checks or claim instantaneous/atomic movement.
- Each host needs its own installation and real acceptance. Running this proxy
  on another Mac tests that Mac's local sidebar, not cross-host organization of
  the controller's sidebar.
- This branch update does not republish the beta tag. Normal app restart is
  required after installing a new immutable runtime; installation alone does
  not prove activation.
