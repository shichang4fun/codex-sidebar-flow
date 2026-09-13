# Local-only lifecycle implementation plan

**Later scope revision:** The user explicitly replaced manual-group and Project
ancestor protection with status-driven local grouping, then retained only direct
Pinned protection. The historical capability gate below concerns the older,
broader protection rules. The separately reviewed opt-in implementation is
documented in [local status grouping](../../local-status-grouping.md); its tests
and runtime evidence are in the [release notes](../../release-notes-beta.2.md).
Implementation and independent review are complete. After normal relaunch,
fresh user-created standalone and Project-child tasks passed start/completion
acceptance; see the [current limits](../../local-boundary-acceptance.md).
The remainder of this document records the historical design, not current gates.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Do not bypass the capability gate below.

**Goal:** Organize tasks executing on the attached local App Server without querying remote tasks or waiting for a global task list.

**Architecture:** Reuse the installed stdio relay. Process local lifecycle notifications by exact task identity, read only that task when necessary, and perform a guarded sidebar move with readback. Codex owns remote transport and synchronization; this plugin adds neither.

**Tech Stack:** Existing Node.js ESM, bundled App Server JSON-RPC, native Desktop sidebar operations, `node:test`; no new dependency, daemon, database or model.

**Review status:** Issues Found for the full redesign. Independent review permits read-only capability investigation, but does not approve Tasks 2-5 as a replacement architecture. The required target-scoped Desktop protection/movement source is not established. After the user's implementation request, a separate bounded snapshot-recovery correction was implemented and independently reviewed without blockers; see the partial implementation record below. This does not resolve the capability gap.

## Scope and invariants

- Local executing tasks only, including ordinary Project children. Do not move Project containers or change their association.
- Running without attention flags -> In Progress. Waiting for approval/input -> For Review. Completion/error after observed activity or from In Progress -> For Review.
- A directly deferred For Later task leaves only while freshly active without attention flags. An idle/unknown/attention task still in For Later remains there.
- Preserve direct Pinned, excluded organizer, archived/subagent exclusions, custom-group protection and protected Project ancestor rules. Project association is not a prerequisite for recognizing running state.
- Missing protection information blocks only that task's move. It is not evidence of inactivity, and must not stall state observation for other tasks.
- A lifecycle notification from the attached local connection identifies the local task; a sidebar key containing `local` does not establish execution ownership. Never search other hosts or fall back to one when a local read fails.
- The desired section already matching means no write. Newer events supersede obsolete prewrite work. Once a write is sent, complete its readback rather than assuming cancellation undoes it.
- Do not restore Hook/heartbeat, modify the Desktop application bundle, write native storage directly, or migrate Project data.

## Verified facts and unresolved boundary

Reference build: ChatGPT Desktop 26.908.40834 (8881), bundled CLI 0.154.0-alpha.6.2. This is not a contract for all Desktop versions.

| Information/operation | Existing source | Status |
| --- | --- | --- |
| Local lifecycle notifications | Attached stdio connection | Implemented in existing relay |
| Target runtime state | Local `thread/read`, `includeTurns:false` | Existing protocol |
| Local recovery candidates | Local `thread/list` / `thread/loaded/list` | Existing protocol; `thread/list` not yet in observer relay allowlist |
| Server-owned sections | Local `threadSection/list` | Exists, but its IDs are not Desktop logical section IDs |
| Desktop target placement and current protection | Current global `list_threads` projection | No verified local-only replacement |
| Desktop move and UI refresh | Current native move tool | Works in existing architecture; explicit `hostId` alone does not prove no internal fallback/remote dependencies |

Read-only inspection found a Project fixture whose server-owned `project_id` is null while Desktop retains an explicit Project assignment. The persisted Desktop data also contains mappings from logical section IDs to host-owned IDs. These are evidence of different data models, not authorization to reconstruct all Desktop state from a file.

Native `read_thread(hostId:local)` currently returns identity and runtime state, but does not return Project association or sidebar placement in its thread metadata. It cannot alone replace the protection snapshot.

**Consequently, this plan does not claim a complete local-only write path is available.** A design review can approve the target architecture while still blocking runtime implementation. Do not describe such approval as approval to ship or install.

## Minimal target flow

```text
local native event -> record latest state and actual start evidence
                                      |
                         target read / eligibility check
                                      |
                           guarded move -> readback

10-minute local recovery -> same task handler (lower priority)
```

Record accepted local lifecycle evidence synchronously in the existing manager event path, before asynchronous protection reads. Unknown protection must not discard a genuine short turn's start evidence. Eligibility controls only whether a move may happen; it never controls whether state was observed. Keep evidence bounded and scoped to a task/turn; retain existing exclusion and unknown-event validation.

The eligibility check needs only the target task's direct placement and, if applicable, its ancestor protection result. It does not require enumerating Projects, inspecting task content, or migrating assignments.

The following is an upstream capability requirement, NOT the name/schema of an existing API or approval to build a mock-backed provider:

```js
// A verified Desktop projection must provide all fields authoritatively.
const view = {
  hostId: 'local', threadId: 'example-task',
  status: { type: 'active', activeFlags: [] },
  sectionId: 'desktop-section-id',
  pinned: false,
  projectId: null, // explicit known-null, never inferred from incomplete migration
  ancestorProtection: 'allowed', // allowed | protected | unknown
};
```

The provider must also bind this data to the currently active Desktop account and the correct logical section IDs. Reading persisted JSON, taking a partial global list, or assuming raw IDs match does not satisfy that requirement.

## Task 1: Capability gate and independent review (no runtime changes)

**Files:** This plan; existing `docs/local-official-api-prototype.md` and `experimental/desktop-mcp-adapter.mjs` as evidence. No application patches or native storage writes.

- [x] Inspect branch/HEAD/dirty state and preserve existing work. Base is `cc779d88f912a1a177756206e044599e15e9b487` on `feat/local-periodic-reconciliation`.
- [x] Confirm which required fields the current native targeted read actually returns; inspect raw schemas and known Project/section mismatches without requesting remote lists.
- [x] Independent agent reviews this plan against scope, feasibility and necessary safeguards. Result: Issues Found; capability gate not passed.
- [ ] Resolve an existing, verifiable local-only source for target placement, active-account binding and ancestor protection, plus a move that does not fall back to another host.
- [ ] Establish section mapping and UI invalidation from authoritative implementation or existing acceptance evidence. This task remains read-only: a new real move belongs to the later, scoped GUI acceptance step, and cannot be claimed from a schema or server-only test.

**Stop condition:** If no equivalent source exists, return the specific missing capability and review result. Do not begin Tasks 2-5, add a fake provider, weaken protection, or build a private-state migration layer. Further implementation would need an upstream target-scoped sidebar API or separately approved changes to product constraints. Merely replacing the status read is not completion of this task.

## Task 2: Replace hot-path global reads (only after Task 1 passes)

**Files:** Modify `experimental/desktop-mcp-adapter.mjs`, `experimental/stdio-relay.mjs`, `experimental/desktop-observer-manager.mjs`, `experimental/app-server-observer.mjs`; tests in `test/desktop-mcp-adapter.test.mjs`, `test/desktop-adapter-performance.test.mjs`, `test/stdio-relay.test.mjs`, `test/desktop-event-coalescing.test.mjs`.

- [ ] Add failing tests that reject any `list_threads` call on a local event path and any nonlocal request/fallback. Assert target-scoped protection and readback still happen; do not preserve the old three-global-lists count as a requirement.
- [ ] Run `node --test test/desktop-mcp-adapter.test.mjs test/desktop-adapter-performance.test.mjs test/stdio-relay.test.mjs`; observe failures for the missing local provider.
- [ ] Implement only the provider established by Task 1. Reuse current policy semantics; whitelist only read methods actually needed. Retain relay framing, initialization gate, request-ID isolation and late-response handling.
- [ ] Before changing observer behavior, write a failing short-turn regression: start arrives while protection metadata is unavailable; completion arrives; protection later becomes authoritative. Actual start evidence survives, but no move is authorized while protection is unknown, and an idle task still in For Later remains deferred. Reuse the manager's synchronous event bookkeeping; remove the observer's dependence on `eligible()` to preserve that evidence. Do not manufacture events or add a second event store.
- [ ] Recheck current state/protection before dispatch and verify destination plus unchanged Project association after dispatch. Never use a cached snapshot across independent events.
- [ ] Rerun the tests above. Add races for pinning, protected ancestor changes, new turn IDs, completion during a read, account changes and missing metadata.

## Task 3: Local recovery and bounded scheduling

**Files:** Modify `experimental/desktop-observer-manager.mjs`, `experimental/desktop-reconciliation-timer.mjs`, `experimental/desktop-proxy-config.mjs`; test corresponding manager/reconciliation/coalescing files.

- [ ] Write a failing test with a never-settling global-list stub: local lifecycle handling and local recovery must never invoke it.
- [ ] Write tests for paged local recovery, per-RPC deadlines, event priority and a slow task not blocking observation of another task's new state.
- [ ] Use local candidate IDs, a bounded rotating recovery batch and the same guarded handler. Remove borrowed MCP contexts only if the verified provider no longer needs them.
- [ ] Use the configured 600-second compensation interval. Do not silently rewrite existing user configuration. No heartbeat/model and no remote scan.
- [ ] Remove list-specific long timeout/coalescing branches after their production callers are gone. Keep finite retries, idempotency and stale-event suppression; do not add parallel writes to shared sidebar state without a verified ordering contract.
- [ ] Run `node --test test/desktop-observer-manager.test.mjs test/desktop-event-coalescing.test.mjs test/desktop-reconciliation.test.mjs test/desktop-reconciliation-timer.test.mjs test/desktop-proxy-config.test.mjs`.

## Task 4: Trim temporary scaffolding and document actual scope

**Files:** The untracked `experimental/local-snapshot-probe.mjs` and `test/local-snapshot-probe.test.mjs`; `docs/local-desktop-proxy.md`, `docs/local-official-api-prototype.md`, `docs/release-notes-beta.2.md`.

- [x] Remove only the two unused untracked diagnostic files created by this task. They were never installed and are not needed for the capability investigation; no replacement runtime layer was added.
- [ ] Document the exact verified provider/build, no-remote boundary, task behavior, remaining read/write race, ten-minute local recovery and rollback.
- [ ] Preserve the existing release-note query-stall evidence until real acceptance demonstrates resolution. Do not generalize support or replace acceptance with mock tests.

## Task 5: Validation and release boundary

**Files:** Relevant existing tests, `test/app-server-live.test.mjs`, installer manifest only if new production files are actually necessary.

- [ ] Run `npm test`, `npm run check`, `npm run check:desktop`, and `git diff --check` with zero failures.
- [ ] Run the full suite from a temporary source copy whose path contains spaces. Preserve fingerprint verification and all protection tests.
- [ ] Run `SIDEBAR_TEST_CODEX_BINARY=/absolute/path/to/bundled/codex node --test test/app-server-live.test.mjs`; all three opt-in transports must pass. This proves protocol behavior, not Desktop UI movement.
- [ ] Independently review final implementation/tests/security against this plan; address blockers before installation.
- [ ] Install only the reviewed candidate using the existing installer. A normal user relaunch may be necessary; never force-quit ongoing work.
- [ ] Real local GUI acceptance: ordinary and Project-contained tasks, active/completed/attention, short turns, direct For Later, Pinned/protected ancestors, and two local tasks where one read is slow. Do not make remote requests or manually perform the expected destination move as proof.
- [ ] Measure notification arrival to move/readback; verify zero plugin-originated global/remote discovery calls. Define a latency target from the measured local API baseline, not an invented guarantee.
- [ ] Report source SHA/runtime fingerprint/test counts/actual acceptance separately. Do not commit, push, tag or publish as part of this plan without explicit authorization for those actions.

Rollback uses the existing prior immutable runtime and normal relaunch. No native data restoration, Project migration reversal, remote change, Hook or heartbeat is required.

## Independent review findings

- **P1, unresolved:** The current adapter derives direct Pinned, custom placement and Project ancestor protection from global `list_threads`. Targeted runtime reads lack equivalent Desktop fields. Removing that source now would either prevent moves or weaken protection.
- **P1, unresolved:** Server-only section readback does not establish logical Desktop section mapping/UI refresh. Native move with a local host parameter alone does not attest absence of internal remote fallback.
- **P2, plan corrected:** Activity evidence must be recorded before protection checks; manager/observer changes and the unavailable-protection short-turn regression are now explicitly included.

No runtime change, installation, new test-pass claim or release is authorized by the architecture review alone. A future revision must name and verify the actual provider before marking the capability gate passed.

## Partial implementation record (not completion of Tasks 2-5)

- Reproduced loss of genuine start evidence when a Desktop snapshot omits protection metadata and a short turn completes before the metadata recovers.
- Changed only the snapshot error classification to the existing transient `DESKTOP_MCP_UNAVAILABLE`. The manager retains its existing evidence and four retries (250, 750, 2000, 5000 ms). Unknown protection still prevents movement; exhausted retries can still discard evidence.
- Added six regressions covering ordinary/Project completion recovery, direct Pinned/For Later and Pinned Project protection, and finite retry exhaustion. No second event store, new queue or dependency.
- Independent implementation review found no P1/P2 blocker for this limited correction. It explicitly did not approve the global-query replacement.
- Removed the two unused research probes listed in Task 4. No installed files or native task data changed.
- Instrumented the three isolated bundled App Server tests: raw section writes read back correctly, with no notification observed between the write and readback. This observation window does not prove notifications can never occur and does not verify Desktop refresh.
- Read-only inspection of the reference Desktop build shows its native section action also invalidates Desktop window/query state. The raw server method bypasses that action; schema/readback alone is not an equivalent UI contract.

The hot path still calls global `list_threads`; query-stall latency and the complete local-only requirement remain unresolved. Do not install or present this correction as the local-only architecture. Validation counts are recorded separately in the candidate release notes.

### Follow-up: bounded query handoff, not a local-only replacement

After real acceptance still showed multi-second query waits, the user requested
a latency optimization. A superseded prewrite transaction now releases its
logical read wait immediately. The existing relay can share an identical
unresolved list in the same task context with its successor; no completed data
is cached. A new transaction still performs fresh protection/status checks before
writing and a fresh postwrite readback. Dispatched writes remain serialized.

Regression scope: immediate handoff, no duplicate initial wire read, late success
and failure isolation, immutable timing records, pinned task/Project and idle
For Later protection, write/readback serialization, and recovery-context handoff.
The original local-only capability gate remains unresolved. No new read API,
remote handling, storage layer or dependency was added.
