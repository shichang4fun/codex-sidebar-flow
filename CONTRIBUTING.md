# Contributing

Keep changes deterministic, dependency-free, and small enough to audit.

Use TDD for policy and state-machine changes: add or tighten the failing test first, observe RED, then implement the minimum fix and rerun the relevant suites to GREEN.

Before opening a pull request:

```bash
npm test
npm run check
npm run check:desktop
```

Run the full suite in both an ordinary checkout and a separate checkout whose
path contains spaces. CI runs both paths on Node 20/22/24; do not skip fingerprint
tests or weaken digest verification to pass either path. The opt-in
[three bundled App Server tests](docs/local-official-api-prototype.md#reproducible-isolated-integration-tests)
are a separate release gate, not proof of real GUI placement.

For the current Desktop proxy, cover start/completion/attention, superseded
events, retries, compensation and fresh prewrite/readback checks. Ordinary
Projects may supply local root child tasks without direct membership; only the
child moves and its Project association remains intact. Pinned tasks, other custom
sections and ambiguous membership remain protected. Parent Projects in Pinned,
For Later or other custom sections protect their children. A direct For Later
task may move only to In Progress on fresh active/no-attention evidence; cover
idle/attention/unknown states, stale starts, prewrite state/parent changes,
subsequent completion and compensation idempotency for this exception.
Keep Project containers, remote/subagent/archived tasks and excluded identities
untouched. Test real ordinary and Project-child GUI paths before claiming live
acceptance on a specific Desktop build.

Legacy-only changes must separately cover `UserPromptSubmit`/`Stop`, event versus
heartbeat terminal recovery, host routing, recursion, wake fallback and probe
safety. The legacy Pinned-Project policy differs from the current proxy; do not
copy it into the Desktop adapter or restore legacy Hooks/heartbeat during proxy
validation. Never commit private task IDs, paths, logs, tokens or databases.
