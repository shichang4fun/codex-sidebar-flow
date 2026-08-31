import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildAgentSelfMoveHookOutput,
  executeHookEvent,
  handleHook,
  isRetryableHookError,
  managedMutationFromLifecycle,
} from "../scripts/sidebar-hook.mjs";
import * as sidebarHookModule from "../scripts/sidebar-hook.mjs";
import { AppTools } from "../scripts/sidebar-realtime.mjs";
import {
  armEventWakeProbe,
  claimEventWakeProbe,
  readEventWakeProbeResult,
  releaseEventWakeProbeClaim,
} from "../scripts/doctor.mjs";
import { defaultConfig, INSTALL_MODE_ENV, writeJsonAtomic } from "../scripts/setup.mjs";
import { computeRuntimeFingerprint } from "../scripts/runtime-integrity.mjs";

const execFileAsync = promisify(execFile);
const TEST_RUNTIME_FINGERPRINTS = {
  source: await computeRuntimeFingerprint(path.resolve("."), "source"),
  plugin: await computeRuntimeFingerprint(path.resolve("."), "plugin"),
};

function runtimeDefaultConfig(codexHome, installMode) {
  return defaultConfig(codexHome, installMode, TEST_RUNTIME_FINGERPRINTS[installMode]);
}

async function runHookProcess(codexHome, input, config, { includeConfigEnv = true } = {}) {
  const configPath = path.join(codexHome, "sidebar-flow", "config.json");
  await writeJsonAtomic(configPath, config);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("scripts/sidebar-hook.mjs")], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        HOME: codexHome,
        CODEX_HOME: codexHome,
        CODEX_APP_TOOLS_PIPE_PATH: path.join(codexHome, "missing-app-tools.sock"),
        ...(includeConfigEnv ? { CODEX_SIDEBAR_FLOW_CONFIG: configPath } : {}),
        [INSTALL_MODE_ENV]: "plugin",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`Hook process exited ${code}: ${stderr}`));
      else resolve({ stdout, stderr });
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

async function withinTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function generationProbeResultFile(config, probeId) {
  return `${config.eventWakeProbeResultFile}.result.${probeId}`;
}
const config = {
  excludeThreadIds: ["automation"],
  sections: { inProgress: "In Progress", forReview: "For Review", forLater: "For Later" },
};
const eventWakeConfig = {
  enabled: true,
  organizerThreadId: "organizer-thread",
  organizerHostId: "remote-control:env_organizer",
  wakeStateFile: path.join(os.tmpdir(), `sidebar-hook-wake-${process.pid}.json`),
};

assert.equal(typeof sidebarHookModule.boundedHookLog, "function");
assert.deepEqual(sidebarHookModule.boundedHookLog({
  event: "Stop",
  threadId: "secret-thread-id",
  execPath: "/secret/runtime/node",
  pipeBasename: "secret-app-tools.sock",
  socketPath: "/secret/app-tools.sock",
  attempts: 2,
  toolsListSucceeded: false,
  durationMs: 42,
  errorCode: "APP_TOOLS_UNAVAILABLE",
}), {
  event: "Stop",
  attempts: 2,
  toolsListSucceeded: false,
  durationMs: 42,
  errorCode: "APP_TOOLS_UNAVAILABLE",
});

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
  const output = buildAgentSelfMoveHookOutput(
    { session_id: "thread-1", hook_event_name: "UserPromptSubmit", prompt: "SECRET_PROMPT" },
    {
      excludeThreadIds: [],
      sections: config.sections,
      eventWake: { enabled: true, organizerThreadId: "organizer-thread" },
    },
  );
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(output.hookSpecificOutput.additionalContext, /thread-1/);
  assert.match(output.hookSpecificOutput.additionalContext, /list_threads/);
  assert.match(output.hookSpecificOutput.additionalContext, /move_thread_to_sidebar_section/);
  assert.match(output.hookSpecificOutput.additionalContext, /no direct membership and its parent Project is exactly in Projects or Pinned/);
  assert.match(output.hookSpecificOutput.additionalContext, /A Pinned parent Project is only an identity anchor/);
  assert.match(output.hookSpecificOutput.additionalContext, /The task itself may not be in Pinned or/);
  assert.match(output.hookSpecificOutput.additionalContext, /call read_thread for this exact thread ID and authoritative hostId/);
  assert.match(output.hookSpecificOutput.additionalContext, /make at most one move of only this task/);
  assert.equal(output.hookSpecificOutput.additionalContext.includes("SECRET_PROMPT"), false);

  const localOnlyOutput = buildAgentSelfMoveHookOutput(
    { session_id: "thread-1", hook_event_name: "UserPromptSubmit" },
    {
      excludeThreadIds: [],
      sections: config.sections,
      eventWake: { enabled: false, organizerThreadId: null },
    },
  );
  assert.equal(localOnlyOutput.hookSpecificOutput.hookEventName, "UserPromptSubmit");
}

for (const [input, runtimeConfig] of [
  [
    { session_id: "thread-1", hook_event_name: "Stop" },
    { excludeThreadIds: [], eventWake: { enabled: true, organizerThreadId: "organizer-thread" } },
  ],
  [
    { session_id: "thread-1", hook_event_name: "UserPromptSubmit" },
    { excludeThreadIds: ["thread-1"], eventWake: { enabled: true, organizerThreadId: "organizer-thread" } },
  ],
  [
    { session_id: "organizer-thread", hook_event_name: "UserPromptSubmit" },
    { excludeThreadIds: [], eventWake: { enabled: true, organizerThreadId: "organizer-thread" } },
  ],
  [
    { session_id: "bad\nthread", hook_event_name: "UserPromptSubmit" },
    { excludeThreadIds: [], eventWake: { enabled: true, organizerThreadId: "organizer-thread" } },
  ],
]) {
  assert.equal(buildAgentSelfMoveHookOutput(input, runtimeConfig), null);
}

{
  let created = 0;
  let reset = 0;
  const result = await executeHookEvent(
    {
      session_id: "thread-1",
      hook_event_name: "UserPromptSubmit",
      host_id: "remote-control:env_remote_test",
    },
    {
      ...config,
      eventWake: eventWakeConfig,
    },
    {
      createAppTools() {
        created += 1;
        const currentAttempt = created;
        return {
          async listThreads() {
            if (currentAttempt === 1) throw new Error("Codex app tools pipe closed");
            return snapshot({ hostId: "remote-control:env_remote_test" });
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
  assert.deepEqual(result.observedIdentities, ["remote-control:env_remote_test:thread-1"]);
  assert.equal(created, 2);
  assert.equal(reset, 2);
}

{
  const readCalls = [];
  const result = await executeHookEvent(
    {
      session_id: "thread-1",
      hook_event_name: "UserPromptSubmit",
      host_id: "remote-control:env_remote_test",
    },
    {
      ...config,
      eventWake: eventWakeConfig,
    },
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
  assert.deepEqual(readCalls, [{
    threadId: "thread-1",
    hostId: "remote-control:env_remote_test",
  }]);
  assert.deepEqual(result.managedAdds, []);
  assert.deepEqual(result.observedIdentities, ["remote-control:env_remote_test:thread-1"]);
  assert.deepEqual(result.eventEnvelope, {
    protocol: "codex-sidebar-flow/event-v1",
    event: "UserPromptSubmit",
    threadId: "thread-1",
    hostId: "remote-control:env_remote_test",
  });
}

{
  const result = await executeHookEvent(
    {
      session_id: "thread-1",
      hook_event_name: "UserPromptSubmit",
      host_id: "bad\nhost",
    },
    {
      ...config,
      eventWake: eventWakeConfig,
    },
    {
      createAppTools() {
        return {
          async listThreads() {
            return snapshot({ includeThread: false });
          },
          async readThread() {
            assert.fail("an invalid host hint must never reach read_thread");
          },
          reset() {},
        };
      },
      wait: async () => {},
    },
  );
  assert.deepEqual(result.observedIdentities, []);
  assert.equal(result.eventEnvelope, null);
}

for (const threads of [
  [
    { id: "thread-1", hostId: "local", kind: "codex", status: "active" },
    { id: "thread-1", hostId: "remote-control:env_remote_test", kind: "codex", status: "active" },
  ],
  [
    { id: "thread-1", hostId: "remote-control:env_remote_test", kind: "codex", status: "active" },
    { id: "thread-1", hostId: "local", kind: "codex", status: "active" },
  ],
]) {
  const result = await executeHookEvent(
    {
      session_id: "thread-1",
      hook_event_name: "UserPromptSubmit",
      host_id: "remote-control:env_remote_test",
    },
    {
      ...config,
      eventWake: eventWakeConfig,
    },
    {
      createAppTools() {
        return {
          async listThreads() {
            return { threads, sections: [] };
          },
          async readThread() {
            assert.fail("an exact host-qualified list candidate must not require hydration");
          },
          reset() {},
        };
      },
      wait: async () => {},
    },
  );
  assert.deepEqual(result.observedIdentities, ["remote-control:env_remote_test:thread-1"]);
  assert.equal(result.eventEnvelope?.hostId, "remote-control:env_remote_test");
}

for (const threads of [
  [
    { id: "thread-1", hostId: "local", kind: "codex", status: "active" },
    { id: "thread-1", hostId: "remote-control:env_remote_test", kind: "codex", status: "active" },
  ],
  [
    { id: "thread-1", hostId: "remote-control:env_remote_test", kind: "codex", status: "active" },
    { id: "thread-1", hostId: "local", kind: "codex", status: "active" },
  ],
]) {
  const result = await executeHookEvent(
    { session_id: "thread-1", hook_event_name: "UserPromptSubmit" },
    {
      ...config,
      eventWake: eventWakeConfig,
    },
    {
      createAppTools() {
        return {
          async listThreads() {
            return { threads, sections: [] };
          },
          async readThread() {
            assert.fail("an ambiguous hostless identity must fail closed without hydration");
          },
          reset() {},
        };
      },
      wait: async () => {},
    },
  );
  assert.deepEqual(result.observedIdentities, []);
  assert.equal(result.eventEnvelope, null);
}

{
  const result = await executeHookEvent(
    {
      session_id: "thread-1",
      hook_event_name: "Stop",
      host_id: "remote-control:env_expected",
    },
    {
      ...config,
      stopSettleDelayMs: 0,
      eventWake: eventWakeConfig,
    },
    {
      createAppTools() {
        return {
          async listThreads() {
            return {
              threads: [{ id: "thread-1", hostId: "local", kind: "codex", status: "idle" }],
              sections: [],
            };
          },
          async readThread(threadId, hostId) {
            assert.equal(threadId, "thread-1");
            assert.equal(hostId, "remote-control:env_expected");
            return {
              thread: {
                id: "thread-other",
                hostId: "remote-control:env_expected",
                kind: "codex",
                status: { type: "idle" },
              },
              turns: [],
            };
          },
          reset() {},
        };
      },
      wait: async () => {},
    },
  );
  assert.deepEqual(result.observedIdentities, []);
  assert.equal(result.eventEnvelope, null);
}

for (const event of ["UserPromptSubmit"]) {
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
  const phases = [];
  const lifecycleSnapshot = {
    threads: [{ id: "thread-1", hostId: "local", kind: "codex", status: "idle" }],
    sections: [
      { sectionId: "pinned", name: "Pinned", itemKeys: [] },
      { sectionId: "review", name: "For Review", itemKeys: [] },
      {
        sectionId: "progress",
        name: "In Progress",
        itemKeys: ["codex:thread:local:thread-1"],
      },
      { sectionId: "later", name: "For Later", itemKeys: [] },
      { sectionId: "threads", name: "Projects", itemKeys: [] },
      { sectionId: "chats", name: "Tasks", itemKeys: [] },
    ],
  };
  const result = await executeHookEvent(
    { session_id: "thread-1", hook_event_name: "Stop" },
    {
      ...config,
      stopSettleDelayMs: 500,
      maxMovesPerRun: 10,
      eventWake: { ...eventWakeConfig, enabled: false },
    },
    {
      wait: async () => {},
      createAppTools() {
        return {
          async listThreads() {
            phases.push("list");
            return structuredClone(lifecycleSnapshot);
          },
          async readThread(threadId, hostId) {
            phases.push(`read:${threadId}:${hostId}`);
            return {
              thread: { id: threadId, hostId, kind: "codex", status: { type: "idle" } },
              turns: [],
            };
          },
          async moveThread(move) {
            phases.push(`move:${move.threadId}:${move.hostId}:${move.sectionId}`);
          },
          reset() {},
        };
      },
    },
  );
  assert.deepEqual(phases, [
    "list",
    "read:thread-1:local",
    "move:thread-1:local:review",
  ]);
  assert.deepEqual(result.move, {
    threadId: "thread-1",
    hostId: "local",
    sectionId: "review",
    sectionName: "For Review",
  });
  assert.deepEqual(result.managedRemoves, ["local:thread-1"]);
  assert.equal(result.eventEnvelope, null);
}

{
  const phases = [];
  const lifecycleSnapshot = {
    threads: [],
    sections: [
      { sectionId: "pinned", name: "Pinned", itemKeys: [] },
      { sectionId: "review", name: "For Review", itemKeys: [] },
      {
        sectionId: "progress",
        name: "In Progress",
        itemKeys: ["codex:thread:local:thread-1"],
      },
      { sectionId: "later", name: "For Later", itemKeys: [] },
      { sectionId: "threads", name: "Projects", itemKeys: [] },
      { sectionId: "chats", name: "Tasks", itemKeys: [] },
    ],
  };
  const result = await executeHookEvent(
    { session_id: "thread-1", hook_event_name: "Stop" },
    {
      ...config,
      stopSettleDelayMs: 0,
      maxMovesPerRun: 10,
      eventWake: { ...eventWakeConfig, enabled: false },
    },
    {
      wait: async () => {},
      createAppTools() {
        return {
          async listThreads() {
            phases.push("list");
            return structuredClone(lifecycleSnapshot);
          },
          async readThread(threadId, hostId) {
            phases.push(`read:${threadId}:${hostId}`);
            return {
              thread: { id: threadId, hostId, kind: "codex", status: { type: "idle" } },
              turns: [],
            };
          },
          async moveThread(move) {
            phases.push(`move:${move.threadId}:${move.hostId}:${move.sectionId}`);
          },
          reset() {},
        };
      },
    },
  );
  assert.deepEqual(phases, [
    "list",
    "read:thread-1:local",
    "read:thread-1:local",
    "move:thread-1:local:review",
  ]);
  assert.deepEqual(result.move, {
    threadId: "thread-1",
    hostId: "local",
    sectionId: "review",
    sectionName: "For Review",
  });
}

{
  const phases = [];
  const lifecycleSnapshot = {
    threads: [{
      id: "other-thread",
      hostId: "remote-control:env_remote",
      kind: "codex",
      status: "idle",
    }],
    sections: [
      { sectionId: "pinned", name: "Pinned", itemKeys: [] },
      { sectionId: "review", name: "For Review", itemKeys: [] },
      {
        sectionId: "progress",
        name: "In Progress",
        itemKeys: ["codex:thread:local:thread-1"],
      },
      { sectionId: "later", name: "For Later", itemKeys: [] },
      { sectionId: "threads", name: "Projects", itemKeys: [] },
      { sectionId: "chats", name: "Tasks", itemKeys: [] },
    ],
  };
  const result = await executeHookEvent(
    { session_id: "thread-1", hook_event_name: "Stop" },
    { ...config, stopSettleDelayMs: 0, eventWake: { ...eventWakeConfig, enabled: false } },
    {
      wait: async () => {},
      createAppTools() {
        return {
          async listThreads() {
            phases.push("list");
            return structuredClone(lifecycleSnapshot);
          },
          async readThread(threadId, hostId) {
            phases.push(`read:${threadId}:${hostId}`);
            if (hostId === "local") return { thread: null, turns: [] };
            return {
              thread: { id: threadId, hostId, kind: "codex", status: { type: "idle" } },
              turns: [],
            };
          },
          async moveThread(move) {
            phases.push(`move:${move.threadId}:${move.hostId}:${move.sectionId}`);
          },
          reset() {},
        };
      },
    },
  );
  assert.deepEqual(phases, [
    "list",
    "read:thread-1:remote-control:env_remote",
    "read:thread-1:local",
    "read:thread-1:remote-control:env_remote",
    "move:thread-1:remote-control:env_remote:review",
  ]);
  assert.equal(result.move?.hostId, "remote-control:env_remote");
}

{
  const reads = [];
  const result = await executeHookEvent(
    { session_id: "thread-1", hook_event_name: "Stop" },
    { ...config, stopSettleDelayMs: 0, eventWake: { ...eventWakeConfig, enabled: false } },
    {
      wait: async () => {},
      createAppTools() {
        return {
          async listThreads() {
            return {
              threads: [{
                id: "other-thread",
                hostId: "remote-control:env_remote",
                kind: "codex",
                status: "idle",
              }],
              sections: [{
                sectionId: "progress",
                name: "In Progress",
                itemKeys: ["codex:thread:local:thread-1"],
              }],
            };
          },
          async readThread(threadId, hostId) {
            reads.push(hostId);
            return {
              thread: { id: threadId, hostId, kind: "codex", status: { type: "idle" } },
              turns: [],
            };
          },
          async moveThread() {
            assert.fail("duplicate IDs confirmed on multiple hosts must fail closed");
          },
          reset() {},
        };
      },
    },
  );
  assert.deepEqual(reads, ["remote-control:env_remote", "local"]);
  assert.equal(result.move, null);
}

{
  let created = 0;
  const reads = [];
  const moves = [];
  const lifecycleSnapshot = {
    threads: [],
    sections: [
      { sectionId: "pinned", name: "Pinned", itemKeys: [] },
      { sectionId: "review", name: "For Review", itemKeys: [] },
      {
        sectionId: "progress",
        name: "In Progress",
        itemKeys: ["codex:thread:local:thread-1"],
      },
      { sectionId: "later", name: "For Later", itemKeys: [] },
      { sectionId: "threads", name: "Projects", itemKeys: [] },
      { sectionId: "chats", name: "Tasks", itemKeys: [] },
    ],
  };
  const result = await executeHookEvent(
    { session_id: "thread-1", hook_event_name: "Stop" },
    { ...config, stopSettleDelayMs: 0, eventWake: { ...eventWakeConfig, enabled: false } },
    {
      wait: async () => {},
      createAppTools() {
        created += 1;
        const currentAttempt = created;
        return {
          async listThreads() {
            return structuredClone(lifecycleSnapshot);
          },
          async readThread(threadId, hostId) {
            reads.push({ currentAttempt, hostId });
            if (currentAttempt === 1) {
              const error = new Error("socket reset during candidate hydration");
              error.code = "ECONNRESET";
              throw error;
            }
            return {
              thread: { id: threadId, hostId, kind: "codex", status: { type: "idle" } },
              turns: [],
            };
          },
          async moveThread(move) {
            moves.push(move);
          },
          reset() {},
        };
      },
    },
  );
  assert.equal(result.attempts, 2);
  assert.equal(created, 2);
  assert.deepEqual(reads, [
    { currentAttempt: 1, hostId: "local" },
    { currentAttempt: 2, hostId: "local" },
    { currentAttempt: 2, hostId: "local" },
  ]);
  assert.equal(moves.length, 1);
}

{
  let created = 0;
  const moves = [];
  await assert.rejects(
    executeHookEvent(
      { session_id: "thread-1", hook_event_name: "Stop" },
      { ...config, stopSettleDelayMs: 0, eventWake: { ...eventWakeConfig, enabled: false } },
      {
        wait: async () => {},
        createAppTools() {
          created += 1;
          return {
            async listThreads() {
              return {
                threads: [{
                  id: "other-thread",
                  hostId: "remote-control:env_remote",
                  kind: "codex",
                  status: "idle",
                }],
                sections: [{
                  sectionId: "progress",
                  name: "In Progress",
                  itemKeys: ["codex:thread:local:thread-1"],
                }],
              };
            },
            async readThread(threadId, hostId) {
              if (hostId === "local") {
                const error = new Error("socket reset before ambiguity was excluded");
                error.code = "ECONNRESET";
                throw error;
              }
              return {
                thread: { id: threadId, hostId, kind: "codex", status: { type: "idle" } },
                turns: [],
              };
            },
            async moveThread(move) {
              moves.push(move);
            },
            reset() {},
          };
        },
      },
    ),
    (error) => error.code === "ECONNRESET" && error.hookAttempts === 2,
  );
  assert.equal(created, 2);
  assert.deepEqual(moves, []);
}

{
  const phases = [];
  const result = await executeHookEvent(
    { session_id: "thread-1", hook_event_name: "Stop" },
    {
      ...config,
      stopSettleDelayMs: 500,
      maxMovesPerRun: 10,
      eventWake: eventWakeConfig,
    },
    {
      wait: async (delayMs) => {
        phases.push(`wait:${delayMs}`);
      },
      createAppTools() {
        return {
          async listThreads() {
            phases.push("list");
            return {
              threads: [{
                id: "thread-1",
                hostId: "local",
                kind: "codex",
                status: "idle",
                activeFlags: [],
              }],
              sections: [
                { sectionId: "pinned", name: "Pinned", itemKeys: [] },
                { sectionId: "review", name: "For Review", itemKeys: [] },
                {
                  sectionId: "progress",
                  name: "In Progress",
                  itemKeys: ["codex:thread:local:thread-1"],
                },
                { sectionId: "later", name: "For Later", itemKeys: [] },
                { sectionId: "threads", name: "Projects", itemKeys: [] },
                { sectionId: "chats", name: "Tasks", itemKeys: [] },
              ],
            };
          },
          async readThread(threadId, hostId) {
            phases.push(`read:${threadId}:${hostId}`);
            return {
              thread: {
                id: threadId,
                hostId,
                kind: "codex",
                status: { type: "idle" },
              },
              turns: [{ id: "turn-1", status: "inProgress", completedAt: null }],
            };
          },
          async moveThread(move) {
            phases.push(`move:${move.threadId}:${move.hostId}:${move.sectionId}`);
          },
          reset() {},
        };
      },
    },
  );
  assert.deepEqual(phases, [
    "wait:500",
    "list",
    "read:thread-1:local",
  ]);
  assert.equal(result.move, null);
  assert.equal(result.eventEnvelope.event, "Stop");
}

{
  const phases = [];
  const result = await executeHookEvent(
    {
      session_id: "thread-1",
      hook_event_name: "Stop",
      host_id: "remote-control:env_input",
    },
    {
      ...config,
      stopSettleDelayMs: 500,
      eventWake: eventWakeConfig,
    },
    {
      wait: async (delayMs) => {
        phases.push(`wait:${delayMs}`);
      },
      createAppTools() {
        return {
          async listThreads() {
            phases.push("list");
            return snapshot({ includeThread: false });
          },
          async readThread(threadId, hostId) {
            phases.push(`read:${threadId}:${hostId}`);
            return {
              thread: {
                id: threadId,
                kind: "codex",
                hostId: "remote-control:env_actual",
                status: { type: "idle" },
              },
              turns: [],
            };
          },
          reset() {},
        };
      },
    },
  );
  assert.deepEqual(phases, ["wait:500", "list", "read:thread-1:remote-control:env_input"]);
  assert.deepEqual(result.observedIdentities, []);
  assert.equal(result.eventEnvelope, null);
}

{
  const phases = [];
  const result = await executeHookEvent(
    {
      session_id: "thread-1",
      hook_event_name: "Stop",
    },
    {
      ...config,
      stopSettleDelayMs: 500,
      hookDeadlineMs: 400,
    },
    {
      now: (() => {
        let value = 0;
        return () => {
          value += 450;
          return value;
        };
      })(),
      wait: async (delayMs) => {
        phases.push(`wait:${delayMs}`);
      },
      createAppTools() {
        return {
          async listThreads() {
            phases.push("list");
            return snapshot();
          },
          reset() {},
        };
      },
    },
  );
  assert.deepEqual(phases, []);
  assert.equal(result.eventEnvelope, null);
}

{
  let waitCalls = 0;
  const result = await executeHookEvent(
    {
      session_id: "thread-1",
      hook_event_name: "Stop",
    },
    {
      ...config,
      stopSettleDelayMs: 500,
      hookDeadlineMs: 400,
      eventWake: eventWakeConfig,
    },
    {
      now: () => 0,
      deadlineAt: 400,
      wait: async (delayMs) => {
        waitCalls += 1;
        assert.equal(delayMs, 400);
      },
      createAppTools() {
        return {
          async listThreads() {
            assert.fail("dispatch must be skipped when full settle cannot complete before deadline");
          },
          reset() {},
        };
      },
    },
  );
  assert.equal(waitCalls, 1);
  assert.equal(result.eventEnvelope, null);
}

{
  const result = await executeHookEvent(
    {
      session_id: "thread-1",
      hook_event_name: "Stop",
      host_id: "remote-control:env_hint",
    },
    {
      ...config,
      eventWake: eventWakeConfig,
    },
    {
      wait: async () => {},
      createAppTools() {
        return {
          async listThreads() {
            return snapshot({ includeThread: false });
          },
          async readThread() {
            return { thread: null, turns: [] };
          },
          reset() {},
        };
      },
    },
  );
  assert.equal(result.eventEnvelope, null);
}

{
  const result = await executeHookEvent(
    {
      session_id: "thread-1",
      hook_event_name: "Stop",
      host_id: "remote-control:env_hint",
    },
    {
      ...config,
      eventWake: eventWakeConfig,
    },
    {
      wait: async () => {},
      createAppTools() {
        return {
          async listThreads() {
            return snapshot({ includeThread: false });
          },
          async readThread(threadId, hostId) {
            assert.equal(threadId, "thread-1");
            assert.equal(hostId, "remote-control:env_hint");
            return {
              thread: {
                id: threadId,
                status: { type: "idle" },
              },
              turns: [],
            };
          },
          reset() {},
        };
      },
    },
  );
  assert.equal(result.eventEnvelope, null);
}

{
  const result = await executeHookEvent(
    {
      session_id: "thread-1",
      hook_event_name: "UserPromptSubmit",
    },
    {
      ...config,
      excludeThreadIds: ["thread-1"],
      eventWake: eventWakeConfig,
    },
    {
      createAppTools() {
        return {
          async listThreads() {
            return snapshot();
          },
          reset() {},
        };
      },
      wait: async () => {},
    },
  );
  assert.equal(result.eventEnvelope, null);
}

{
  const result = await executeHookEvent(
    {
      session_id: "thread-1",
      hook_event_name: "UserPromptSubmit",
    },
    {
      ...config,
      eventWake: eventWakeConfig,
    },
    {
      createAppTools() {
        return {
          async listThreads() {
            return snapshot({ kind: "chatgpt" });
          },
          reset() {},
        };
      },
      wait: async () => {},
    },
  );
  assert.equal(result.eventEnvelope, null);
}

{
  const result = await executeHookEvent(
    {
      session_id: "thread-1",
      hook_event_name: "Stop",
    },
    {
      ...config,
      eventWake: eventWakeConfig,
    },
    {
      createAppTools() {
        return {
          async listThreads() {
            return snapshot({ hostId: "" });
          },
          reset() {},
        };
      },
      wait: async () => {},
    },
  );
  assert.equal(result.eventEnvelope, null);
}

{
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-hook-agent-fallback-"));
  const configPath = path.join(codexHome, "sidebar-flow", "config.json");
  const hookLogFile = path.join(codexHome, "sidebar-flow", "hook.log");
  const previousMode = process.env[INSTALL_MODE_ENV];
  process.env[INSTALL_MODE_ENV] = "plugin";
  try {
    await writeJsonAtomic(configPath, {
      ...runtimeDefaultConfig(codexHome, "plugin"),
      hookLogFile,
      eventWake: {
        ...eventWakeConfig,
        enabled: false,
        wakeStateFile: path.join(codexHome, "sidebar-flow", "wake.json"),
      },
    });
    const output = await handleHook(
      { session_id: "thread-1", hook_event_name: "UserPromptSubmit", prompt: "SECRET_PROMPT" },
      configPath,
      {
        async wake() {
          assert.fail("local fallback must not wake the organizer when event wake is disabled");
        },
        async execute(_input, _config, options) {
          assert.equal(options.attempts, 1);
          const error = new Error("Codex app tools pipe closed");
          error.code = "EPIPE";
          error.hookAttempts = 1;
          throw error;
        },
      },
    );
    assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.equal(output.hookSpecificOutput.additionalContext.includes("SECRET_PROMPT"), false);
    const record = JSON.parse((await readFile(hookLogFile, "utf8")).trim());
    assert.equal(record.agentFallback, true);
    assert.equal(record.toolsListSucceeded, false);
    assert.equal(record.errorCode, "EPIPE");
  } finally {
    if (previousMode == null) delete process.env[INSTALL_MODE_ENV];
    else process.env[INSTALL_MODE_ENV] = previousMode;
    await rm(codexHome, { recursive: true, force: true });
  }
}

{
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-hook-fallback-guards-"));
  const configPath = path.join(codexHome, "sidebar-flow", "config.json");
  const previousMode = process.env[INSTALL_MODE_ENV];
  process.env[INSTALL_MODE_ENV] = "plugin";
  try {
    await writeJsonAtomic(configPath, {
      ...runtimeDefaultConfig(codexHome, "plugin"),
      eventWake: eventWakeConfig,
    });
    await assert.rejects(
      handleHook(
        { session_id: "thread-1", hook_event_name: "UserPromptSubmit" },
        configPath,
        {
          async execute() {
            const error = new Error("Invalid app tool response");
            error.code = "APP_TOOL_ERROR";
            throw error;
          },
        },
      ),
      (error) => error.code === "APP_TOOL_ERROR",
    );

    await assert.rejects(
      handleHook(
        { session_id: "thread-1", hook_event_name: "UserPromptSubmit" },
        configPath,
        {
          claimProbe: async () => ({ status: "claimed" }),
          inspectCapability: async () => true,
          writeProbeResult: async () => true,
          releaseProbeClaim: async () => true,
          createAppTools: () => ({ reset() {} }),
          async execute() {
            const error = new Error("Codex app tools pipe closed");
            error.code = "EPIPE";
            throw error;
          },
        },
      ),
      (error) => error.code === "EPIPE",
    );

    let excludedExecutions = 0;
    let excludedStateLoads = 0;
    assert.equal(await handleHook(
      { session_id: "organizer-thread", hook_event_name: "UserPromptSubmit" },
      configPath,
      {
        async execute() { excludedExecutions += 1; },
        async loadState() { excludedStateLoads += 1; },
      },
    ), null);
    assert.equal(excludedExecutions, 0);
    assert.equal(excludedStateLoads, 0);

    let stateUpdates = 0;
    await handleHook(
      { session_id: "thread-1", hook_event_name: "Stop" },
      configPath,
      {
        async execute() {
          return {
            attempts: 1,
            managedAdds: [],
            managedRemoves: [],
            observedIdentities: [],
            eventEnvelope: null,
          };
        },
        async updateManaged() { stateUpdates += 1; },
      },
    );
    assert.equal(stateUpdates, 0);
  } finally {
    if (previousMode == null) delete process.env[INSTALL_MODE_ENV];
    else process.env[INSTALL_MODE_ENV] = previousMode;
    await rm(codexHome, { recursive: true, force: true });
  }
}

{
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-hook-process-output-"));
  try {
    const runtimeConfig = {
      ...runtimeDefaultConfig(codexHome, "plugin"),
      eventWake: eventWakeConfig,
    };
    const fallback = await runHookProcess(
      codexHome,
      { session_id: "thread-process", hook_event_name: "UserPromptSubmit", prompt: "PROCESS_SECRET" },
      runtimeConfig,
      { includeConfigEnv: false },
    );
    const output = JSON.parse(fallback.stdout.trim());
    assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.equal(output.hookSpecificOutput.additionalContext.includes("PROCESS_SECRET"), false);
    assert.equal(fallback.stdout.trim().split("\n").length, 1);

    const noOutput = await runHookProcess(
      codexHome,
      { session_id: "thread-process", hook_event_name: "Notification" },
      runtimeConfig,
    );
    assert.deepEqual(JSON.parse(noOutput.stdout.trim()), {});
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}

{
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-hook-wake-order-"));
  const configPath = path.join(codexHome, "sidebar-flow", "config.json");
  const stateFile = path.join(codexHome, "sidebar-flow", "state.json");
  const hookLogFile = path.join(codexHome, "sidebar-flow", "hook.log");
  const previousMode = process.env[INSTALL_MODE_ENV];
  const previousPipe = process.env.CODEX_APP_TOOLS_PIPE_PATH;
  process.env[INSTALL_MODE_ENV] = "plugin";
  process.env.CODEX_APP_TOOLS_PIPE_PATH = "/private/tmp/secret-app-tools.sock";
  const wakeCalls = [];
  try {
    await writeJsonAtomic(configPath, {
      ...runtimeDefaultConfig(codexHome, "plugin"),
      stateFile,
      hookLogFile,
      eventWake: {
        ...eventWakeConfig,
        wakeStateFile: path.join(codexHome, "sidebar-flow", "wake.json"),
      },
    });
    await handleHook(
      { session_id: "thread-1", hook_event_name: "UserPromptSubmit" },
      configPath,
      {
        async execute() {
          return {
            attempts: 1,
            managedAdds: [],
            managedRemoves: [],
            observedIdentities: ["local:thread-1"],
            eventEnvelope: {
              protocol: "codex-sidebar-flow/event-v1",
              event: "UserPromptSubmit",
              threadId: "thread-1",
              hostId: "local",
            },
          };
        },
        async wake(envelope, wakeConfig) {
          wakeCalls.push({
            envelope,
            wakeConfig,
            persisted: JSON.parse(await readFile(stateFile, "utf8")),
          });
          return { status: "sent" };
        },
      },
    );
    assert.equal(wakeCalls.length, 1);
    assert.deepEqual(wakeCalls[0].persisted.knownThreadIdentities, ["local:thread-1"]);
    const records = (await readFile(hookLogFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.at(-1).wakeStatus, "sent");
    assert.equal(records.at(-1).observationOnly, true);
    assert.equal("wakeErrorCode" in records.at(-1), false);
    for (const field of ["threadId", "execPath", "pipeBasename", "socketPath"]) {
      assert.equal(Object.hasOwn(records.at(-1), field), false, field);
    }
    assert.equal(JSON.stringify(records.at(-1)).includes("secret-app-tools.sock"), false);

    await handleHook(
      { session_id: "thread-2", hook_event_name: "Stop" },
      configPath,
      {
        async execute() {
          return {
            attempts: 1,
            move: {
              threadId: "thread-2",
              hostId: "local",
              sectionId: "review",
              sectionName: "For Review",
            },
            moves: [{
              threadId: "thread-2",
              hostId: "local",
              sectionId: "review",
              sectionName: "For Review",
            }],
            managedAdds: [],
            managedRemoves: ["local:thread-2"],
            observedIdentities: [],
            eventEnvelope: null,
          };
        },
        async updateManaged() {},
      },
    );
    const moveRecord = JSON.parse((await readFile(hookLogFile, "utf8")).trim().split("\n").at(-1));
    assert.equal(moveRecord.observationOnly, false);

  } finally {
    if (previousMode == null) delete process.env[INSTALL_MODE_ENV];
    else process.env[INSTALL_MODE_ENV] = previousMode;
    if (previousPipe == null) delete process.env.CODEX_APP_TOOLS_PIPE_PATH;
    else process.env.CODEX_APP_TOOLS_PIPE_PATH = previousPipe;
    await rm(codexHome, { recursive: true, force: true });
  }
}

{
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-hook-wake-deadline-"));
  const configPath = path.join(codexHome, "sidebar-flow", "config.json");
  const hookLogFile = path.join(codexHome, "sidebar-flow", "hook.log");
  const previousMode = process.env[INSTALL_MODE_ENV];
  process.env[INSTALL_MODE_ENV] = "plugin";
  let currentTime = 0;
  let released = false;
  try {
    await writeJsonAtomic(configPath, {
      ...runtimeDefaultConfig(codexHome, "plugin"),
      hookDeadlineMs: 20,
      hookLogFile,
      eventWake: {
        ...eventWakeConfig,
        wakeStateFile: path.join(codexHome, "sidebar-flow", "wake.json"),
      },
    });
    await handleHook(
      { session_id: "thread-1", hook_event_name: "UserPromptSubmit" },
      configPath,
      {
        now: () => currentTime,
        async execute() {
          return {
            attempts: 1,
            managedAdds: [],
            managedRemoves: [],
            observedIdentities: [],
            eventEnvelope: {
              protocol: "codex-sidebar-flow/event-v1",
              event: "UserPromptSubmit",
              threadId: "thread-1",
              hostId: "local",
            },
          };
        },
        async wake() {
          return new Promise((resolve) => {
            setTimeout(() => {
              currentTime = 100;
              released = true;
              resolve({ status: "sent" });
            }, 100);
          });
        },
        async updateManaged() {},
      },
    );
    assert.equal(released, false);
    const record = JSON.parse((await readFile(hookLogFile, "utf8")).trim().split("\n").at(-1));
    assert.equal(record.wakeStatus, "failed");
    assert.equal(record.wakeErrorCode, "wake_deadline");
  } finally {
    if (previousMode == null) delete process.env[INSTALL_MODE_ENV];
    else process.env[INSTALL_MODE_ENV] = previousMode;
    await rm(codexHome, { recursive: true, force: true });
  }
}

{
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-hook-wake-candispatch-"));
  const configPath = path.join(codexHome, "sidebar-flow", "config.json");
  const hookLogFile = path.join(codexHome, "sidebar-flow", "hook.log");
  const previousMode = process.env[INSTALL_MODE_ENV];
  process.env[INSTALL_MODE_ENV] = "plugin";
  let currentTime = 0;
  let sends = 0;
  try {
    await writeJsonAtomic(configPath, {
      ...runtimeDefaultConfig(codexHome, "plugin"),
      hookDeadlineMs: 20,
      hookLogFile,
      eventWake: {
        ...eventWakeConfig,
        wakeStateFile: path.join(codexHome, "sidebar-flow", "wake.json"),
      },
    });
    await handleHook(
      { session_id: "thread-1", hook_event_name: "UserPromptSubmit" },
      configPath,
      {
        now: () => currentTime,
        async execute() {
          return {
            attempts: 1,
            managedAdds: [],
            managedRemoves: [],
            observedIdentities: [],
            eventEnvelope: {
              protocol: "codex-sidebar-flow/event-v1",
              event: "UserPromptSubmit",
              threadId: "thread-1",
              hostId: "local",
            },
          };
        },
        async wake(_envelope, _wakeConfig, wakeTools, wakeDependencies = {}) {
          currentTime = 25;
          assert.equal(typeof wakeDependencies.signal?.aborted, "boolean");
          assert.equal(wakeDependencies.canDispatch(), false);
          assert.equal(typeof wakeTools.sendMessageToThread, "function");
          return { status: "failed", errorCode: "wake_deadline" };
        },
        createAppTools(_configArg, options) {
          const requiredTools = options?.requiredTools ?? [];
          if (requiredTools.includes("send_message_to_thread")) {
            return {
              async sendMessageToThread() {
                sends += 1;
              },
              reset() {},
            };
          }
          return {
            async listThreads() {
              return snapshot();
            },
            reset() {},
          };
        },
        async updateManaged() {},
      },
    );
    const record = JSON.parse((await readFile(hookLogFile, "utf8")).trim().split("\n").at(-1));
    assert.equal(record.wakeStatus, "failed");
    assert.equal(record.wakeErrorCode, "wake_deadline");
    assert.equal(sends, 0);
  } finally {
    if (previousMode == null) delete process.env[INSTALL_MODE_ENV];
    else process.env[INSTALL_MODE_ENV] = previousMode;
    await rm(codexHome, { recursive: true, force: true });
  }
}

{
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-hook-real-apptools-deadline-"));
  const configPath = path.join(codexHome, "sidebar-flow", "config.json");
  const hookLogFile = path.join(codexHome, "sidebar-flow", "hook.log");
  const previousMode = process.env[INSTALL_MODE_ENV];
  process.env[INSTALL_MODE_ENV] = "plugin";
  const createdTools = [];
  let sendCalls = 0;
  let closedHosts = 0;
  try {
    await writeJsonAtomic(configPath, {
      ...runtimeDefaultConfig(codexHome, "plugin"),
      hookDeadlineMs: 20,
      hookLogFile,
      eventWake: {
        ...eventWakeConfig,
        wakeStateFile: path.join(codexHome, "sidebar-flow", "wake.json"),
      },
    });
    await handleHook(
      { session_id: "thread-1", hook_event_name: "UserPromptSubmit" },
      configPath,
      {
        async execute() {
          return {
            attempts: 1,
            managedAdds: [],
            managedRemoves: [],
            observedIdentities: [],
            eventEnvelope: {
              protocol: "codex-sidebar-flow/event-v1",
              event: "UserPromptSubmit",
              threadId: "thread-1",
              hostId: "local",
            },
          };
        },
        createAppTools(configArg, options) {
          const tools = new AppTools(
            {
              ...configArg,
              quiet: true,
              socketProbeTimeoutMs: 200,
              requestTimeoutMs: 200,
              discoveryTimeoutMs: 200,
            },
            {
              ...options,
              discoverHost: async () => {
                await new Promise((resolve) => setTimeout(resolve, 80));
                return {
                  socketPath: "/tmp/fake.sock",
                  toolMap: new Map([
                    ["send_message_to_thread", { name: "send_message_to_thread", namespace: "codex" }],
                  ]),
                  client: {
                    timeoutMs: 200,
                    close() {
                      closedHosts += 1;
                    },
                    async request(method) {
                      if (method === "tools/call") sendCalls += 1;
                      return { success: true, contentItems: [] };
                    },
                  },
                };
              },
            },
          );
          createdTools.push(tools);
          return tools;
        },
        now: Date.now,
      },
    );
    const record = JSON.parse((await readFile(hookLogFile, "utf8")).trim().split("\n").at(-1));
    assert.equal(record.wakeStatus, "failed");
    assert.equal(record.wakeErrorCode, "wake_deadline");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(sendCalls, 0);
    assert.equal(closedHosts, 1);
    assert.equal(createdTools.at(-1)?.host, null);
  } finally {
    if (previousMode == null) delete process.env[INSTALL_MODE_ENV];
    else process.env[INSTALL_MODE_ENV] = previousMode;
    await rm(codexHome, { recursive: true, force: true });
  }
}

{
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-hook-wake-failure-"));
  const configPath = path.join(codexHome, "sidebar-flow", "config.json");
  const hookLogFile = path.join(codexHome, "sidebar-flow", "hook.log");
  const previousMode = process.env[INSTALL_MODE_ENV];
  process.env[INSTALL_MODE_ENV] = "plugin";
  try {
    await writeJsonAtomic(configPath, {
      ...runtimeDefaultConfig(codexHome, "plugin"),
      hookLogFile,
      eventWake: {
        ...eventWakeConfig,
        wakeStateFile: path.join(codexHome, "sidebar-flow", "wake.json"),
      },
    });
    await handleHook(
      { session_id: "thread-1", hook_event_name: "UserPromptSubmit" },
      configPath,
      {
        async execute() {
          return {
            attempts: 1,
            managedAdds: [],
            managedRemoves: [],
            observedIdentities: [],
            eventEnvelope: {
              protocol: "codex-sidebar-flow/event-v1",
              event: "UserPromptSubmit",
              threadId: "thread-1",
              hostId: "local",
            },
          };
        },
        async wake() {
          throw Object.assign(new Error("secret prompt body with thread-1 remote-control:env crash"), {
            code: "bad\ncode:secret-thread-1",
          });
        },
      },
    );
    const record = JSON.parse((await readFile(hookLogFile, "utf8")).trim().split("\n").at(-1));
    assert.equal(record.wakeStatus, "failed");
    assert.equal(record.wakeErrorCode, "wake_failed");
    assert.equal(JSON.stringify(record).includes("thread-1"), false);
    assert.equal(JSON.stringify(record).includes("remote-control:env"), false);
    assert.equal(JSON.stringify(record).includes("secret prompt body"), false);
  } finally {
    if (previousMode == null) delete process.env[INSTALL_MODE_ENV];
    else process.env[INSTALL_MODE_ENV] = previousMode;
    await rm(codexHome, { recursive: true, force: true });
  }
}

{
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-hook-organizer-recursion-"));
  const configPath = path.join(codexHome, "sidebar-flow", "config.json");
  const hookLogFile = path.join(codexHome, "sidebar-flow", "hook.log");
  const previousMode = process.env[INSTALL_MODE_ENV];
  process.env[INSTALL_MODE_ENV] = "plugin";
  let wakeCalls = 0;
  try {
    await writeJsonAtomic(configPath, {
      ...runtimeDefaultConfig(codexHome, "plugin"),
      hookLogFile,
      eventWake: {
        ...eventWakeConfig,
        organizerThreadId: "thread-1",
        wakeStateFile: path.join(codexHome, "sidebar-flow", "wake.json"),
      },
    });
    await handleHook(
      { session_id: "thread-1", hook_event_name: "UserPromptSubmit" },
      configPath,
      {
        createAppTools(_configArg, options) {
          const requiredTools = options?.requiredTools ?? [];
          if (requiredTools.includes("send_message_to_thread")) {
            return {
              async sendMessageToThread() {
                wakeCalls += 1;
              },
              reset() {},
            };
          }
          return {
            async listThreads() {
              return {
                threads: [{ id: "thread-1", hostId: "local", kind: "codex", status: "active" }],
                sections: [],
              };
            },
            reset() {},
          };
        },
        async updateManaged() {},
        async wake() {
          wakeCalls += 1;
          return { status: "sent" };
        },
      },
    );
    assert.equal(wakeCalls, 0);
    const record = JSON.parse((await readFile(hookLogFile, "utf8")).trim().split("\n").at(-1));
    assert.equal("wakeStatus" in record, false);
  } finally {
    if (previousMode == null) delete process.env[INSTALL_MODE_ENV];
    else process.env[INSTALL_MODE_ENV] = previousMode;
    await rm(codexHome, { recursive: true, force: true });
  }
}

{
  const previousMode = process.env[INSTALL_MODE_ENV];
  process.env[INSTALL_MODE_ENV] = "plugin";
  try {
    let capturedRequiredTools = null;
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-hook-capabilities-"));
    await handleHook(
      { session_id: "thread-1", hook_event_name: "UserPromptSubmit" },
      path.join(codexHome, "sidebar-flow", "config.json"),
      {
        async loadConfig() {
          return {
            ...runtimeDefaultConfig(codexHome, "plugin"),
            installMode: "plugin",
            eventWake: {
              ...eventWakeConfig,
              wakeStateFile: path.join(codexHome, "sidebar-flow", "wake.json"),
            },
          };
        },
        createAppTools(configArg, options) {
          capturedRequiredTools = options?.requiredTools ?? null;
          return {
            async listThreads() {
              return snapshot();
            },
            reset() {},
          };
        },
        async updateManaged() {},
      },
    );
    assert.deepEqual(capturedRequiredTools, ["list_threads", "read_thread", "send_message_to_thread"]);
    await rm(codexHome, { recursive: true, force: true });
  } finally {
    if (previousMode == null) delete process.env[INSTALL_MODE_ENV];
    else process.env[INSTALL_MODE_ENV] = previousMode;
  }
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

{
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-hook-bootstrap-"));
  const configPath = path.join(codexHome, "sidebar-flow", "config.json");
  const previousMode = process.env[INSTALL_MODE_ENV];
  process.env[INSTALL_MODE_ENV] = "plugin";
  try {
    await handleHook(
      { session_id: "thread-1", hook_event_name: "UserPromptSubmit" },
      configPath,
      {
        async execute(_input, loadedConfig) {
          assert.equal(loadedConfig.installMode, "plugin");
          return {
            attempts: 1,
            managedAdds: [],
            managedRemoves: [],
            observedIdentities: [],
          };
        },
      },
    );
    const bootstrapped = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(bootstrapped.installMode, "plugin");
  } finally {
    if (previousMode == null) delete process.env[INSTALL_MODE_ENV];
    else process.env[INSTALL_MODE_ENV] = previousMode;
    await rm(codexHome, { recursive: true, force: true });
  }
}

for (const [configuredMode, launcherMode] of [
  ["source", "plugin"],
  ["plugin", "source"],
]) {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-hook-mode-"));
  const configPath = path.join(codexHome, "sidebar-flow", "config.json");
  const previousMode = process.env[INSTALL_MODE_ENV];
  process.env[INSTALL_MODE_ENV] = launcherMode;
  let executed = false;
  try {
    await writeJsonAtomic(configPath, runtimeDefaultConfig(codexHome, configuredMode));
    await assert.rejects(
      handleHook(
        { session_id: "thread-1", hook_event_name: "UserPromptSubmit" },
        configPath,
        {
          async execute() {
            executed = true;
            return {
              attempts: 1,
              managedAdds: [],
              managedRemoves: [],
              observedIdentities: [],
            };
          },
        },
      ),
      (error) => error.code === "INSTALL_MODE_MISMATCH",
    );
    assert.equal(executed, false, `${configuredMode} config must reject ${launcherMode} Hook`);
  } finally {
    if (previousMode == null) delete process.env[INSTALL_MODE_ENV];
    else process.env[INSTALL_MODE_ENV] = previousMode;
    await rm(codexHome, { recursive: true, force: true });
  }
}

{
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-hook-runtime-binding-"));
  const configPath = path.join(codexHome, "sidebar-flow", "config.json");
  const previousMode = process.env[INSTALL_MODE_ENV];
  process.env[INSTALL_MODE_ENV] = "source";
  let probeWrites = 0;
  try {
    await writeJsonAtomic(configPath, {
      ...runtimeDefaultConfig(codexHome, "source"),
      runtimeFingerprint: "a".repeat(64),
    });
    await assert.rejects(
      handleHook(
        { session_id: "thread-1", hook_event_name: "UserPromptSubmit" },
        configPath,
        {
          computeRuntimeFingerprint: async () => "b".repeat(64),
          claimProbe: async () => ({ status: "claimed" }),
          releaseProbeClaim: async () => true,
          inspectCapability: async () => true,
          writeProbeResult: async () => {
            probeWrites += 1;
            return true;
          },
          loadState: async () => ({ managedThreadIds: [] }),
          updateManaged: async () => {},
          execute: async () => ({
            attempts: 1,
            managedAdds: [],
            managedRemoves: [],
            observedIdentities: [],
          }),
        },
      ),
      (error) => error.code === "RUNTIME_FINGERPRINT_MISMATCH",
    );
    assert.equal(probeWrites, 0);
  } finally {
    if (previousMode == null) delete process.env[INSTALL_MODE_ENV];
    else process.env[INSTALL_MODE_ENV] = previousMode;
    await rm(codexHome, { recursive: true, force: true });
  }
}

for (const [capabilityPresent, expectedStatus] of [[true, "present"], [false, "missing"]]) {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), `sidebar-flow-hook-probe-${expectedStatus}-`));
  const runtime = path.join(codexHome, "sidebar-flow");
  const configPath = path.join(runtime, "config.json");
  const previousMode = process.env[INSTALL_MODE_ENV];
  process.env[INSTALL_MODE_ENV] = "source";
  let wakeCalls = 0;
  let sendCalls = 0;
  try {
    const runtimeConfig = {
      ...runtimeDefaultConfig(codexHome, "source"),
      excludeThreadIds: ["organizer-thread"],
      eventWake: {
        enabled: true,
        organizerThreadId: "organizer-thread",
        organizerHostId: "local",
        maxPerMinute: 20,
      },
    };
    await writeJsonAtomic(configPath, runtimeConfig);
    const armed = await armEventWakeProbe(runtimeConfig, {
      runtimeRoot: runtime,
      now: () => 1_000,
      createProbeId: () => `probe-${expectedStatus}-0001`,
    });
    const probeResultFile = generationProbeResultFile(runtimeConfig, armed.probeId);

    await handleHook(
      { session_id: "thread-1", hook_event_name: "UserPromptSubmit", prompt: "raw secret task content" },
      configPath,
      {
        now: () => 2_000,
        async execute() {
          return {
            attempts: 1,
            managedAdds: [],
            managedRemoves: [],
            observedIdentities: [],
            eventEnvelope: {
              protocol: "codex-sidebar-flow/event-v1",
              event: "UserPromptSubmit",
              threadId: "thread-1",
              hostId: "local",
            },
          };
        },
        createAppTools() {
          return {
            async connect() {
              return {
                toolMap: new Map(capabilityPresent
                  ? [["send_message_to_thread", { name: "send_message_to_thread" }]]
                  : []),
              };
            },
            async sendMessageToThread() {
              sendCalls += 1;
            },
            reset() {},
          };
        },
        async updateManaged() {},
        async wake() {
          wakeCalls += 1;
          return { status: "sent" };
        },
      },
    );

    const probeResult = JSON.parse(await readFile(probeResultFile, "utf8"));
    assert.equal(probeResult.status, expectedStatus);
    assert.equal(probeResult.probeId, `probe-${expectedStatus}-0001`);
    assert.equal(probeResult.observedAt, 2_000);
    assert.equal((await stat(probeResultFile)).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(probeResult).includes("raw secret"), false);
    assert.equal(JSON.stringify(probeResult).includes(codexHome), false);
    assert.equal(sendCalls, 0);
    assert.equal(wakeCalls, 0);
  } finally {
    if (previousMode == null) delete process.env[INSTALL_MODE_ENV];
    else process.env[INSTALL_MODE_ENV] = previousMode;
    await rm(codexHome, { recursive: true, force: true });
  }
}

{
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-hook-probe-retry-"));
  const runtime = path.join(codexHome, "sidebar-flow");
  const configPath = path.join(runtime, "config.json");
  const previousMode = process.env[INSTALL_MODE_ENV];
  process.env[INSTALL_MODE_ENV] = "source";
  let wakeCalls = 0;
  let connectionAttempts = 0;
  try {
    const runtimeConfig = {
      ...runtimeDefaultConfig(codexHome, "source"),
      excludeThreadIds: ["organizer-thread"],
      eventWake: {
        enabled: true,
        organizerThreadId: "organizer-thread",
        organizerHostId: "local",
        maxPerMinute: 20,
      },
    };
    await writeJsonAtomic(configPath, runtimeConfig);
    await armEventWakeProbe(runtimeConfig, {
      runtimeRoot: runtime,
      now: () => 1_000,
      createProbeId: () => "probe-retry-0001",
    });
    const dependencies = {
      now: () => 2_000,
      async execute() {
        return {
          attempts: 1,
          managedAdds: [], managedRemoves: [], observedIdentities: [],
          eventEnvelope: {
            protocol: "codex-sidebar-flow/event-v1",
            event: "UserPromptSubmit",
            threadId: "thread-1",
            hostId: "local",
          },
        };
      },
      createAppTools(_config, options) {
        if ((options?.requiredTools ?? []).includes("send_message_to_thread")) return { reset() {} };
        return {
          async connect() {
            connectionAttempts += 1;
            if (connectionAttempts === 1) throw new Error("App tools pipe closed");
            return { toolMap: new Map() };
          },
          reset() {},
        };
      },
      async updateManaged() {},
      async wake() {
        wakeCalls += 1;
        return { status: "sent" };
      },
    };

    await handleHook({ session_id: "thread-1", hook_event_name: "UserPromptSubmit" }, configPath, dependencies);
    assert.deepEqual(await readEventWakeProbeResult(runtimeConfig, {
      runtimeRoot: runtime,
      now: () => 2_100,
    }), {
      status: "pending",
      probeId: "probe-retry-0001",
      armedAt: 1_000,
      expiresAt: 301_000,
    });
    assert.equal(wakeCalls, 0, "the Hook event claimed for an attempted probe stays suppressed");

    await handleHook({ session_id: "thread-1", hook_event_name: "UserPromptSubmit" }, configPath, dependencies);
    assert.equal((await readEventWakeProbeResult(runtimeConfig, {
      runtimeRoot: runtime,
      now: () => 2_100,
    })).status, "missing");
    assert.equal(connectionAttempts, 2);
    assert.equal(wakeCalls, 0);
  } finally {
    if (previousMode == null) delete process.env[INSTALL_MODE_ENV];
    else process.env[INSTALL_MODE_ENV] = previousMode;
    await rm(codexHome, { recursive: true, force: true });
  }
}

{
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-hook-probe-superseded-"));
  const runtime = path.join(codexHome, "sidebar-flow");
  const configPath = path.join(runtime, "config.json");
  const previousMode = process.env[INSTALL_MODE_ENV];
  process.env[INSTALL_MODE_ENV] = "source";
  let wakeCalls = 0;
  try {
    const runtimeConfig = {
      ...runtimeDefaultConfig(codexHome, "source"),
      excludeThreadIds: ["organizer-thread"],
      eventWake: {
        enabled: true,
        organizerThreadId: "organizer-thread",
        organizerHostId: "local",
        maxPerMinute: 20,
      },
    };
    await writeJsonAtomic(configPath, runtimeConfig);
    await armEventWakeProbe(runtimeConfig, {
      runtimeRoot: runtime,
      now: () => 1_000,
      createProbeId: () => "probe-superseded-old",
    });
    await handleHook(
      { session_id: "thread-1", hook_event_name: "UserPromptSubmit" },
      configPath,
      {
        now: () => 2_000,
        async execute() {
          return {
            attempts: 1,
            managedAdds: [], managedRemoves: [], observedIdentities: [],
            eventEnvelope: {
              protocol: "codex-sidebar-flow/event-v1",
              event: "UserPromptSubmit",
              threadId: "thread-1",
              hostId: "local",
            },
          };
        },
        createAppTools() { return { reset() {} }; },
        async inspectCapability() {
          await armEventWakeProbe(runtimeConfig, {
            runtimeRoot: runtime,
            now: () => 2_100,
            createProbeId: () => "probe-superseded-new",
          });
          return true;
        },
        async updateManaged() {},
        async wake() {
          wakeCalls += 1;
          return { status: "sent" };
        },
      },
    );
    assert.deepEqual(await readEventWakeProbeResult(runtimeConfig, {
      runtimeRoot: runtime,
      now: () => 2_200,
    }), {
      status: "pending",
      probeId: "probe-superseded-new",
      armedAt: 2_100,
      expiresAt: 302_100,
    });
    assert.equal(wakeCalls, 0);
  } finally {
    if (previousMode == null) delete process.env[INSTALL_MODE_ENV];
    else process.env[INSTALL_MODE_ENV] = previousMode;
    await rm(codexHome, { recursive: true, force: true });
  }
}

{
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-hook-expired-probe-"));
  const runtime = path.join(codexHome, "sidebar-flow");
  const configPath = path.join(runtime, "config.json");
  const previousMode = process.env[INSTALL_MODE_ENV];
  process.env[INSTALL_MODE_ENV] = "source";
  let wakeCalls = 0;
  let probeConnections = 0;
  try {
    const runtimeConfig = {
      ...runtimeDefaultConfig(codexHome, "source"),
      excludeThreadIds: ["organizer-thread"],
      eventWake: {
        enabled: true,
        organizerThreadId: "organizer-thread",
        organizerHostId: "local",
        maxPerMinute: 20,
      },
    };
    await writeJsonAtomic(configPath, runtimeConfig);
    await armEventWakeProbe(runtimeConfig, {
      runtimeRoot: runtime,
      now: () => 1_000,
      createProbeId: () => "probe-expired-0001",
    });
    await handleHook(
      { session_id: "thread-1", hook_event_name: "UserPromptSubmit" },
      configPath,
      {
        now: () => 400_000,
        async execute() {
          return {
            attempts: 1,
            managedAdds: [], managedRemoves: [], observedIdentities: [],
            eventEnvelope: {
              protocol: "codex-sidebar-flow/event-v1",
              event: "UserPromptSubmit",
              threadId: "thread-1",
              hostId: "local",
            },
          };
        },
        createAppTools(_config, options) {
          if ((options?.requiredTools ?? []).includes("send_message_to_thread")) {
            return { reset() {} };
          }
          probeConnections += 1;
          return { async connect() { return { toolMap: new Map() }; }, reset() {} };
        },
        async updateManaged() {},
        async wake() {
          wakeCalls += 1;
          return { status: "sent" };
        },
      },
    );
    assert.equal(probeConnections, 0);
    assert.equal(wakeCalls, 1);
    const result = await readEventWakeProbeResult(runtimeConfig, {
      runtimeRoot: runtime,
      now: () => 400_000,
    });
    assert.equal(result.status, "expired");
    assert.equal(result.probeId, "probe-expired-0001");
  } finally {
    if (previousMode == null) delete process.env[INSTALL_MODE_ENV];
    else process.env[INSTALL_MODE_ENV] = previousMode;
    await rm(codexHome, { recursive: true, force: true });
  }
}

{
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-hook-invalid-result-"));
  const runtime = path.join(codexHome, "sidebar-flow");
  const configPath = path.join(runtime, "config.json");
  const previousMode = process.env[INSTALL_MODE_ENV];
  process.env[INSTALL_MODE_ENV] = "source";
  let wakeCalls = 0;
  let managedUpdate = null;
  const unrelatedFile = path.join(codexHome, "unrelated.txt");
  try {
    const runtimeConfig = {
      ...runtimeDefaultConfig(codexHome, "source"),
      excludeThreadIds: ["organizer-thread"],
      eventWake: {
        enabled: true,
        organizerThreadId: "organizer-thread",
        organizerHostId: "local",
        maxPerMinute: 20,
      },
    };
    await writeJsonAtomic(configPath, runtimeConfig);
    await writeFile(unrelatedFile, "keep\n", { mode: 0o600 });
    const armed = await armEventWakeProbe(runtimeConfig, {
      runtimeRoot: runtime,
      now: () => 1_000,
      createProbeId: () => "probe-invalid-hook",
    });
    await symlink(unrelatedFile, generationProbeResultFile(runtimeConfig, armed.probeId));

    await handleHook(
      { session_id: "thread-1", hook_event_name: "UserPromptSubmit" },
      configPath,
      {
        now: () => 400_000,
        async execute() {
          return {
            attempts: 1,
            managedAdds: [],
            managedRemoves: [],
            observedIdentities: ["local:thread-1"],
            eventEnvelope: {
              protocol: "codex-sidebar-flow/event-v1",
              event: "UserPromptSubmit",
              threadId: "thread-1",
              hostId: "local",
            },
          };
        },
        createAppTools(_config, options) {
          if ((options?.requiredTools ?? []).includes("send_message_to_thread")) return { reset() {} };
          return {
            async connect() {
              throw new Error("expired invalid probe result must not inspect capability");
            },
            reset() {},
          };
        },
        async updateManaged(_stateFile, update) {
          managedUpdate = update;
        },
        async wake() {
          wakeCalls += 1;
          return { status: "sent" };
        },
      },
    );

    assert.deepEqual(managedUpdate, {
      add: [],
      remove: [],
      observe: ["local:thread-1"],
    });
    assert.equal(wakeCalls, 1);
    assert.deepEqual(await readEventWakeProbeResult(runtimeConfig, {
      runtimeRoot: runtime,
      now: () => 400_000,
    }), {
      status: "expired",
      probeId: armed.probeId,
      armedAt: armed.armedAt,
      expiresAt: armed.expiresAt,
    });
    assert.equal(await readFile(unrelatedFile, "utf8"), "keep\n");
    assert.equal((await lstat(generationProbeResultFile(runtimeConfig, armed.probeId))).isSymbolicLink(), true);
  } finally {
    if (previousMode == null) delete process.env[INSTALL_MODE_ENV];
    else process.env[INSTALL_MODE_ENV] = previousMode;
    await rm(codexHome, { recursive: true, force: true });
  }
}

{
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-hook-probe-post-claim-race-"));
  const runtime = path.join(codexHome, "sidebar-flow");
  const configPath = path.join(runtime, "config.json");
  const previousMode = process.env[INSTALL_MODE_ENV];
  process.env[INSTALL_MODE_ENV] = "source";
  let resolveWinnerClaimed;
  let resolveContenderChecked;
  let resolveWinnerReleased;
  const winnerClaimed = new Promise((resolve) => { resolveWinnerClaimed = resolve; });
  const contenderChecked = new Promise((resolve) => { resolveContenderChecked = resolve; });
  const winnerReleased = new Promise((resolve) => { resolveWinnerReleased = resolve; });
  const claimStatuses = [];
  let toolsListCalls = 0;
  let wakeCalls = 0;
  try {
    const runtimeConfig = {
      ...runtimeDefaultConfig(codexHome, "source"),
      excludeThreadIds: ["organizer-thread"],
      eventWake: {
        enabled: true,
        organizerThreadId: "organizer-thread",
        organizerHostId: "local",
        maxPerMinute: 20,
      },
    };
    await writeJsonAtomic(configPath, runtimeConfig);
    const armed = await armEventWakeProbe(runtimeConfig, {
      runtimeRoot: runtime,
      now: () => 1_000,
      createProbeId: () => "probe-hook-post-claim",
    });
    const eventResult = {
      attempts: 1,
      managedAdds: [], managedRemoves: [], observedIdentities: [],
      eventEnvelope: {
        protocol: "codex-sidebar-flow/event-v1",
        event: "UserPromptSubmit",
        threadId: "thread-1",
        hostId: "local",
      },
    };
    const commonDependencies = {
      async execute() { return eventResult; },
      async updateManaged() {},
      async wake() {
        wakeCalls += 1;
        return { status: "sent" };
      },
    };
    const winnerRun = handleHook(
      { session_id: "thread-1", hook_event_name: "UserPromptSubmit" },
      configPath,
      {
        ...commonDependencies,
        now: () => 2_000,
        async claimProbe(probeConfig, options) {
          const outcome = await claimEventWakeProbe(probeConfig, {
            ...options,
            createClaimId: () => "claim-hook-winner",
          });
          claimStatuses.push(outcome.status);
          resolveWinnerClaimed();
          return outcome;
        },
        createAppTools(_config, options) {
          if ((options?.requiredTools ?? []).includes("send_message_to_thread")) return { reset() {} };
          return {
            async connect() {
              toolsListCalls += 1;
              return { toolMap: new Map([["send_message_to_thread", { name: "send_message_to_thread" }]]) };
            },
            reset() {},
          };
        },
        async inspectCapability(appTools) {
          await contenderChecked;
          const host = await appTools.connect();
          return host.toolMap.has("send_message_to_thread");
        },
        async releaseProbeClaim(probeConfig, claim, options) {
          try {
            return await releaseEventWakeProbeClaim(probeConfig, claim, options);
          } finally {
            resolveWinnerReleased();
          }
        },
      },
    );
    await winnerClaimed;
    const contenderRun = handleHook(
      { session_id: "thread-1", hook_event_name: "UserPromptSubmit" },
      configPath,
      {
        ...commonDependencies,
        now: () => 3_000,
        async claimProbe(probeConfig, options) {
          let interleaved = false;
          const outcome = await claimEventWakeProbe(probeConfig, {
            ...options,
            createClaimId: () => "claim-hook-contender",
            async afterInitialResultRead() {
              interleaved = true;
              resolveContenderChecked();
              await winnerReleased;
            },
          });
          if (!interleaved) resolveContenderChecked();
          claimStatuses.push(outcome.status);
          return outcome;
        },
        createAppTools() {
          return { reset() {} };
        },
        async inspectCapability() {
          toolsListCalls += 1;
          throw new Error("completed probe must not be inspected again");
        },
      },
    );
    await withinTimeout(
      Promise.all([winnerRun, contenderRun]),
      2_000,
      "post-claim probe interleaving timed out",
    );

    assert.deepEqual(claimStatuses, ["claimed", "complete"]);
    assert.equal(toolsListCalls, 1);
    assert.equal(wakeCalls, 1);
    const result = JSON.parse(await readFile(generationProbeResultFile(runtimeConfig, armed.probeId), "utf8"));
    assert.equal(result.status, "present");
    assert.equal(result.claimedAt, 2_000);
    assert.equal(result.observedAt, 2_000);
  } finally {
    resolveContenderChecked();
    resolveWinnerReleased();
    if (previousMode == null) delete process.env[INSTALL_MODE_ENV];
    else process.env[INSTALL_MODE_ENV] = previousMode;
    await rm(codexHome, { recursive: true, force: true });
  }
}

{
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-hook-probe-race-"));
  const runtime = path.join(codexHome, "sidebar-flow");
  const configPath = path.join(runtime, "config.json");
  const previousMode = process.env[INSTALL_MODE_ENV];
  process.env[INSTALL_MODE_ENV] = "source";
  let probeConnections = 0;
  let wakeCalls = 0;
  try {
    const runtimeConfig = {
      ...runtimeDefaultConfig(codexHome, "source"),
      excludeThreadIds: ["organizer-thread"],
      eventWake: {
        enabled: true,
        organizerThreadId: "organizer-thread",
        organizerHostId: "local",
        maxPerMinute: 20,
      },
    };
    await writeJsonAtomic(configPath, runtimeConfig);
    const armed = await armEventWakeProbe(runtimeConfig, {
      runtimeRoot: runtime,
      now: () => 1_000,
      createProbeId: () => "probe-race-0001",
    });
    const dependencies = {
      now: () => 2_000,
      async execute() {
        return {
          attempts: 1,
          managedAdds: [], managedRemoves: [], observedIdentities: [],
          eventEnvelope: {
            protocol: "codex-sidebar-flow/event-v1",
            event: "UserPromptSubmit",
            threadId: "thread-1",
            hostId: "local",
          },
        };
      },
      createAppTools(_config, options) {
        if ((options?.requiredTools ?? []).includes("send_message_to_thread")) {
          return { reset() {} };
        }
        return {
          async connect() {
            probeConnections += 1;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { toolMap: new Map([["send_message_to_thread", { name: "send_message_to_thread" }]]) };
          },
          reset() {},
        };
      },
      async updateManaged() {},
      async wake() {
        wakeCalls += 1;
        return { status: "sent" };
      },
    };
    await Promise.all([
      handleHook({ session_id: "thread-1", hook_event_name: "UserPromptSubmit" }, configPath, dependencies),
      handleHook({ session_id: "thread-1", hook_event_name: "UserPromptSubmit" }, configPath, dependencies),
    ]);
    assert.equal(probeConnections, 1);
    assert.equal(wakeCalls, 1);
    const result = JSON.parse(await readFile(generationProbeResultFile(runtimeConfig, armed.probeId), "utf8"));
    assert.equal(result.status, "present");
  } finally {
    if (previousMode == null) delete process.env[INSTALL_MODE_ENV];
    else process.env[INSTALL_MODE_ENV] = previousMode;
    await rm(codexHome, { recursive: true, force: true });
  }
}

{
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-hook-probe-process-race-"));
  const runtime = path.join(codexHome, "sidebar-flow");
  const configPath = path.join(runtime, "config.json");
  const fixture = path.resolve("fixtures/event-wake-probe.mjs");
  const controller = new AbortController();
  let childrenSettled = Promise.resolve([]);
  try {
    const runtimeConfig = {
      ...runtimeDefaultConfig(codexHome, "source"),
      excludeThreadIds: ["organizer-thread"],
      eventWake: {
        enabled: true,
        organizerThreadId: "organizer-thread",
        organizerHostId: "local",
        maxPerMinute: 20,
      },
    };
    await writeJsonAtomic(configPath, runtimeConfig);
    const armed = await armEventWakeProbe(runtimeConfig, {
      runtimeRoot: runtime,
      now: () => 1_000,
      createProbeId: () => "probe-process-race-0001",
    });

    const children = [
      execFileAsync(process.execPath, [fixture, configPath, runtime], {
        signal: controller.signal,
        timeout: 5_000,
        killSignal: "SIGKILL",
      }),
      execFileAsync(process.execPath, [fixture, configPath, runtime], {
        signal: controller.signal,
        timeout: 5_000,
        killSignal: "SIGKILL",
      }),
    ];
    childrenSettled = Promise.allSettled(children);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const readyCount = (await readdir(runtime)).filter((name) => name.startsWith("ready-")).length;
      if (readyCount === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal((await readdir(runtime)).filter((name) => name.startsWith("ready-")).length, 2);
    await writeFile(path.join(runtime, "release"), "\n", { mode: 0o600 });
    const settled = await childrenSettled;
    for (const child of settled) assert.equal(child.status, "fulfilled", child.reason?.message);
    const outcomes = settled.map(({ value }) => JSON.parse(value.stdout));
    assert.equal(outcomes.reduce((sum, result) => sum + result.probeConnections, 0), 1);
    assert.equal(outcomes.reduce((sum, result) => sum + result.wakeCalls, 0), 1);
    const result = JSON.parse(await readFile(generationProbeResultFile(runtimeConfig, armed.probeId), "utf8"));
    assert.equal(result.status, "present");
  } finally {
    controller.abort();
    await childrenSettled;
    await rm(codexHome, { recursive: true, force: true });
  }
}

process.stdout.write("sidebar-hook tests passed\n");
