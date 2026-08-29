# Contributing

Keep changes deterministic, dependency-free, and small enough to audit.

Use TDD for policy and state-machine changes: add or tighten the failing test first, observe RED, then implement the minimum fix and rerun the relevant suites to GREEN.

Before opening a pull request:

```bash
npm test
npm run check
```

Tests must cover both sides of the `UserPromptSubmit` and `Stop` transitions, protected memberships (`Pinned`, `For Later`, archived, non-Codex, Project objects, organizer exclusion), remote `hostId` routing, Project tasks without direct membership, recursion prevention, wake failure fallback, and concurrency/deadline/probe safety.
