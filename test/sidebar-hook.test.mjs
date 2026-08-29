import assert from "node:assert/strict";
import {
  executeHookMove,
  isRetryableHookError,
  planHookMove,
} from "../scripts/sidebar-hook.mjs";

const config = {
  sections: {
    inProgress: "In Progress",
    forReview: "For Review",
    forLater: "For Later",
  },
  excludeThreadIds: ["automation"],
};

function snapshot(sectionId, { status = "idle", hostId = "local", projectId = null } = {}) {
  const key = "codex:thread:local:thread-1";
  return {
    threads: [{ id: "thread-1", hostId, kind: "codex", projectId, status }],
    sections: [
      { sectionId: "pinned", name: "Pinned", itemKeys: sectionId === "pinned" ? [key] : [] },
      { sectionId: "review", name: "For Review", itemKeys: sectionId === "review" ? [key] : [] },
      { sectionId: "progress", name: "In Progress", itemKeys: sectionId === "progress" ? [key] : [] },
      { sectionId: "later", name: "For Later", itemKeys: sectionId === "later" ? [key] : [] },
      { sectionId: "threads", name: "Projects", itemKeys: [] },
      { sectionId: "chats", name: "Tasks", itemKeys: sectionId === "chats" ? [key] : [] },
    ],
  };
}

assert.deepEqual(
  planHookMove(snapshot("chats"), { session_id: "thread-1", hook_event_name: "UserPromptSubmit" }, config),
  { threadId: "thread-1", hostId: "local", sectionId: "progress", sectionName: "In Progress" },
);

{
  const projectOnly = snapshot("chats", { projectId: "project-1" });
  projectOnly.sections.find((section) => section.sectionId === "chats").itemKeys = [];
  projectOnly.sections.find((section) => section.sectionId === "threads").itemKeys = [
    "codex:project:project-1",
  ];
  assert.equal(
    planHookMove(
      projectOnly,
      { session_id: "thread-1", hook_event_name: "UserPromptSubmit" },
      config,
    ).sectionName,
    "In Progress",
  );
}
assert.deepEqual(
  planHookMove(snapshot("review"), { session_id: "thread-1", hook_event_name: "UserPromptSubmit" }, config),
  { threadId: "thread-1", hostId: "local", sectionId: "progress", sectionName: "In Progress" },
);
assert.deepEqual(
  planHookMove(snapshot("progress"), { session_id: "thread-1", hook_event_name: "Stop" }, config),
  { threadId: "thread-1", hostId: "local", sectionId: "review", sectionName: "For Review" },
);

{
  const remote = snapshot("review");
  remote.threads[0].hostId = "remote-control:env_remote_test";
  assert.equal(
    planHookMove(
      remote,
      { session_id: "thread-1", hook_event_name: "UserPromptSubmit" },
      config,
    ).hostId,
    remote.threads[0].hostId,
  );
}

for (const protectedSection of ["pinned", "later"]) {
  assert.equal(
    planHookMove(
      snapshot(protectedSection),
      { session_id: "thread-1", hook_event_name: "UserPromptSubmit" },
      config,
    ),
    null,
  );
  assert.equal(
    planHookMove(snapshot(protectedSection), { session_id: "thread-1", hook_event_name: "Stop" }, config),
    null,
  );
}

for (const protectedSection of ["pinned", "later"]) {
  const protectedParent = snapshot("progress", { projectId: "project-1" });
  protectedParent.sections.find((section) => section.sectionId === protectedSection).itemKeys.push(
    "codex:project:project-1",
  );
  assert.equal(
    planHookMove(
      protectedParent,
      { session_id: "thread-1", hook_event_name: "Stop" },
      config,
    ),
    null,
  );
}

assert.equal(
  planHookMove(
    snapshot("progress", { status: "active" }),
    { session_id: "thread-1", hook_event_name: "Stop" },
    config,
  ),
  null,
);

assert.equal(
  planHookMove(snapshot("chats"), { session_id: "thread-1", hook_event_name: "Stop" }, config),
  null,
);
assert.equal(
  planHookMove(snapshot("progress"), { session_id: "thread-1", hook_event_name: "UserPromptSubmit" }, config),
  null,
);
assert.equal(
  planHookMove(snapshot("chats"), { session_id: "automation", hook_event_name: "UserPromptSubmit" }, config),
  null,
);
assert.equal(planHookMove(snapshot("chats"), {}, config), null);

assert.equal(isRetryableHookError(new Error("Codex app tools pipe closed")), true);
assert.equal(isRetryableHookError(new Error("Expected exactly one sidebar section")), false);

{
  let created = 0;
  let reset = 0;
  const moves = [];
  const result = await executeHookMove(
    { session_id: "thread-1", hook_event_name: "UserPromptSubmit" },
    config,
    {
      createAppTools() {
        created += 1;
        const currentAttempt = created;
        return {
          async listThreads() {
            if (currentAttempt === 1) throw new Error("Codex app tools pipe closed");
            return snapshot("review");
          },
          async moveThread(move) {
            moves.push(move);
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
  assert.equal(result.move.sectionName, "In Progress");
  assert.equal(created, 2);
  assert.equal(reset, 2);
  assert.equal(moves.length, 1);
}

{
  const moves = [];
  const result = await executeHookMove(
    { session_id: "thread-1", hook_event_name: "UserPromptSubmit" },
    config,
    {
      createAppTools() {
        return {
          async listThreads() {
            const missing = snapshot("review");
            missing.threads = [];
            return missing;
          },
          async readThread(threadId, hostId) {
            assert.equal(hostId, undefined);
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
          async moveThread(move) {
            moves.push(move);
          },
          reset() {},
        };
      },
      wait: async () => {},
    },
  );
  assert.equal(result.move.hostId, "remote-control:env_remote_test");
  assert.equal(moves.length, 1);
}

{
  let created = 0;
  const moves = [];
  const result = await executeHookMove(
    { session_id: "thread-1", hook_event_name: "UserPromptSubmit" },
    config,
    {
      createAppTools() {
        created += 1;
        const currentAttempt = created;
        return {
          async listThreads() {
            return snapshot(currentAttempt === 1 ? "review" : "progress");
          },
          async moveThread(move) {
            moves.push(move);
            throw new Error("Codex app tools pipe closed");
          },
          reset() {},
        };
      },
      wait: async () => {},
    },
  );
  assert.equal(result.attempts, 2);
  assert.equal(result.move, null);
  assert.equal(moves.length, 1);
}

{
  const result = await executeHookMove(
    { session_id: "thread-1", hook_event_name: "Stop" },
    config,
    {
      createAppTools() {
        return {
          async listThreads() {
            return snapshot("progress", { status: "active" });
          },
          async readThread() {
            return {
              thread: { id: "thread-1", hostId: "local", status: { type: "active" } },
              turns: [{ status: "inProgress" }],
            };
          },
          async moveThread() {
            throw new Error("must not move a continuing task");
          },
          reset() {},
        };
      },
      wait: async () => {},
    },
  );
  assert.equal(result.move, null);
}

{
  let created = 0;
  await assert.rejects(
    executeHookMove(
      { session_id: "thread-1", hook_event_name: "Stop" },
      config,
      {
        createAppTools() {
          created += 1;
          return {
            async listThreads() {
              throw new Error("Expected exactly one sidebar section");
            },
            reset() {},
          };
        },
        wait: async () => {},
      },
    ),
    /Expected exactly one sidebar section/,
  );
  assert.equal(created, 1);
}

{
  const result = await executeHookMove(
    { session_id: "thread-1", hook_event_name: "Stop" },
    config,
    {
      createAppTools() {
        return {
          async listThreads() {
            return snapshot("progress", { status: "active" });
          },
          async readThread() {
            return {
              thread: {
                id: "thread-1",
                hostId: "local",
                status: { type: "active", activeFlags: ["waitingOnUserInput"] },
              },
              turns: [{ status: "inProgress" }],
            };
          },
          async moveThread() {},
          reset() {},
        };
      },
      wait: async () => {},
    },
  );
  assert.equal(result.move.sectionName, "For Review");
}

{
  const startedAt = Date.now();
  await assert.rejects(
    executeHookMove(
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
