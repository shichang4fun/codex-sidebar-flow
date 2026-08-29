# Contributing

Keep changes deterministic, dependency-free, and small enough to audit.

Before opening a pull request:

```bash
npm test
npm run check
```

Tests must cover both sides of every state transition, remote `hostId` handling, Project tasks without direct membership, and Pinned/For Later protection.
