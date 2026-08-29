import assert from "node:assert/strict";
import {
  executeHookEvent,
  isRetryableHookError,
  managedMutationFromLifecycle,
} from "../scripts/sidebar-hook.mjs";

const config = { excludeThreadIds: ["automation"] };

function snapshot({ hostId = "local", kind = "codex", includeThread = true } = {}) {
  return {
    threads: includeThread ? [{ id: "thread-1", hostId, kind, status: "idle" }] : [],
    sections: [],
  };
}

assert.deepEqual(
  managedMutationFromLifecycle(
    snapshot({ hostId: "remote-control:env_remote_test" }),
    { session_id: "thread-1", hook_event_name: "UserPromptSubmit" },
    config,
  ),
  {
    action: "observe",
    identity: "remote-control:env_remote_test:thread-1",
    threadId: "thread-1",
    hostId: "remote-control:env_remote_test",
  },
);
assert.equal(
  managedMutationFromLifecycle(
    snapshot(),
    { session_id: "thread-1", hook_event_name: "Stop" },
    config,
  ),
  null,
);
assert.equal(
  managedMutationFromLifecycle(
    snapshot(),
    { session_id: "automation", hook_event_name: "UserPromptSubmit" },
    config,
  ),
  null,
);
assert.equal(isRetryableHookError(new Error("Codex app tools pipe closed")), true);
assert.equal(isRetryableHookError(new Error("Invalid lifecycle input")), false);

{
  let created = 0;
  let reset = 0;
  const result = await executeHookEvent(
    { session_id: "thread-1", hook_event_name: "UserPromptSubmit" },
    config,
    {
      createAppTools() {
        created += 1;
        const currentAttempt = created;
        return {
          async listThreads() {
            if (currentAttempt === 1) throw new Error("Codex app tools pipe closed");
            return snapshot();
          },
          async moveThread() {
            throw new Error("lifecycle hooks must not mutate sidebar state");
          },
          reset() {
            reset += 1;
          },
        };
      },
      wait: async () => {},
    },
  );
  assert.equal(result.attempts, 2);
  assert.equal(result.move, null);
  assert.deepEqual(result.managedAdds, []);
  assert.deepEqual(result.observedIdentities, ["local:thread-1"]);
  assert.equal(created, 2);
  assert.equal(reset, 2);
}

{
  const readCalls = [];
  const result = await executeHookEvent(
    { session_id: "thread-1", hook_event_name: "UserPromptSubmit" },
    config,
    {
      createAppTools() {
        return {
          async listThreads() {
            return snapshot({ includeThread: false });
          },
          async readThread(threadId, hostId) {
            readCalls.push({ threadId, hostId });
            return {
              thread: {
                id: threadId,
                kind: "codex",
                hostId: "remote-control:env_remote_test",
                status: { type: "idle" },
              },
              turns: [],
            };
          },
          async moveThread() {
            throw new Error("must remain observation-only");
          },
          reset() {},
        };
      },
      wait: async () => {},
    },
  );
  assert.deepEqual(readCalls, [{ threadId: "thread-1", hostId: undefined }]);
  assert.deepEqual(result.managedAdds, []);
  assert.deepEqual(result.observedIdentities, ["remote-control:env_remote_test:thread-1"]);
}

for (const event of ["UserPromptSubmit", "Stop"]) {
  let moved = false;
  const result = await executeHookEvent(
    { session_id: "thread-1", hook_event_name: event },
    config,
    {
      createAppTools() {
        return {
          async listThreads() {
            return snapshot();
          },
          async moveThread() {
            moved = true;
          },
          reset() {},
        };
      },
      wait: async () => {},
    },
  );
  assert.equal(moved, false, `${event} must not commit before sibling Hook outcomes are known`);
  assert.equal(result.move, null);
  assert.deepEqual(result.managedRemoves, []);
}

{
  const startedAt = Date.now();
  await assert.rejects(
    executeHookEvent(
      { session_id: "thread-1", hook_event_name: "UserPromptSubmit" },
      config,
      {
        createAppTools() {
          return {
            async listThreads() {
              return new Promise(() => {});
            },
            reset() {},
          };
        },
        deadlineMs: 25,
      },
    ),
    /Hook deadline exceeded/,
  );
  assert.equal(Date.now() - startedAt < 200, true);
}

process.stdout.write("sidebar-hook tests passed\n");
