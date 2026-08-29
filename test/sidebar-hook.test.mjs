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

function snapshot(sectionId) {
  const key = "codex:thread:local:thread-1";
  return {
    threads: [{ id: "thread-1", hostId: "local", kind: "codex" }],
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

process.stdout.write("sidebar-hook tests passed\n");
