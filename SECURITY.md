# Security policy

Only the latest experimental release is supported.

## Trust boundary

Lifecycle hooks run with the local Codex process permissions. Review the scripts before installation.

- Custom sidebar mutation uses a private local Unix socket.
- The default configuration accepts only the socket path inherited from Codex; fallback socket/process discovery is disabled.
- Socket candidates must be Unix sockets owned by the current user.
- The adapter requests only `list_threads`, `read_thread`, and `move_thread_to_sidebar_section`.
- No task content is sent to a model or external service by the deterministic classifier.
- Logs omit prompts, outputs, task titles, and full task bodies.
- Private tool error bodies are discarded before logging.
- Task titles, summaries, previews, and bodies are untrusted and never drive the deterministic state machine.

The optional heartbeat uses a model and must use the audited allowlisted prompt in `docs/heartbeat-prompt.md`. It may call only task-management tools, must make at most 10 moves, and must fail closed on ambiguous host or membership data.

Protocol failure is fail-closed: tasks remain in their current sections and a local diagnostic is recorded.

Report vulnerabilities with a private GitHub security advisory. Do not post task content, full task IDs, or socket paths in public issues.
