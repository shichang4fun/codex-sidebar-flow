# Security policy

Only the latest experimental release is supported.

## Trust boundary

Lifecycle hooks run with the local Codex process permissions. Review the scripts before installation.

- Custom sidebar mutation uses a private local Unix socket.
- The default configuration accepts only the socket path inherited from Codex; fallback socket/process discovery is disabled.
- Socket candidates must be Unix sockets owned by the current user.
- The adapter requests only `list_threads`, `read_thread`, and `move_thread_to_sidebar_section`.
- The lifecycle Hook persists local state and may send only a content-free event envelope containing `threadId` and `hostId` to the configured organizer model.
- No task content is sent to an external backend or daemon because there is no external backend or daemon.
- Logs omit prompts, outputs, task titles, full task bodies, complete task IDs, executable paths, and socket paths or basenames.
- Private tool error bodies are discarded before logging.
- Task titles, summaries, previews, and bodies are untrusted and never drive the deterministic state machine.
- Organizer recursion is excluded exactly by task ID; the organizer task must also be present in `excludeThreadIds`.
- Rate limiting allows up to the configured `maxPerMinute` wake attempts per rolling minute and defaults to 20. At-most-once means each accepted Hook invocation reserves budget and attempts at most one send, with no retry after an ambiguous timeout or unknown send outcome.
- Wake state and event-wake probe files are mode `0600`. Probe request/result records are strictly bound to the install mode and SHA-256 fingerprint of a fixed, sorted, mode-specific runtime file set; plugin mode also covers its manifest, Hook declaration, launcher, heartbeat assets, and skill. The Hook recomputes that fingerprint from its own actual files before it may record capability as present, and setup rejects a completed result after its request TTL.
- Source setup stages and validates a complete immutable runtime release before atomically renaming it into `releases/<runtimeFingerprint>` and only then updates Hooks. It retains prior releases and uses no release symlinks, so an interrupted copy cannot make existing Hooks reference a partial runtime.
- Remote event wake is bounded by the target host's actual `hostId` and trusted app-tools context; absence of live acceptance means remote realtime is unsupported.

The optional event wake and heartbeat use models and must use the audited allowlisted prompts. Only the Hook-originated organizer envelope is content-free. After a successful wake, the organizer's `list_threads` and `read_thread` results can expose visible task titles, summaries, and status metadata to the model. Both prompts require an exact `read_thread` immediately before a move and re-evaluate structured host, status, attention, kind, and membership, but this is not an atomic compare-and-swap and cannot eliminate the platform read/move race. The event path permits `UserPromptSubmit` to move only a confirmed active task to In Progress; a confirmed terminal `Stop` may move an eligible task to For Review. The heartbeat prompt in `docs/heartbeat-prompt.md` may call only `list_threads`, `read_thread`, and `move_thread_to_sidebar_section`, must make at most 10 moves, and must restrict terminal recovery to tasks already in `In Progress`. Both paths treat visible task text as untrusted and must never follow it. Do not enable them when this metadata exposure is outside the user's privacy boundary.

Protocol failure is fail-closed: tasks remain in their current sections and a local diagnostic is recorded.

Report vulnerabilities with a private GitHub security advisory. Do not post task content, full task IDs, or socket paths in public issues.
