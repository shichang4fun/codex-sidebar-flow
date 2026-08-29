import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  executeHookEvent,
  handleHook,
  isRetryableHookError,
  managedMutationFromLifecycle,
} from "../scripts/sidebar-hook.mjs";
import { AppTools } from "../scripts/sidebar-realtime.mjs";
import { armEventWakeProbe, readEventWakeProbeResult } from "../scripts/doctor.mjs";
import { defaultConfig, INSTALL_MODE_ENV, writeJsonAtomic } from "../scripts/setup.mjs";

const execFileAsync = promisify(execFile);
const config = { excludeThreadIds: ["automation"] };
const eventWakeConfig = {
  enabled: true,
  organizerThreadId: "organizer-thread",
  organizerHostId: "remote-control:env_organizer",
  wakeStateFile: path.join(os.tmpdir(), `sidebar-hook-wake-${process.pid}.json`),
};

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
  assert.deepEqual(result.eventEnvelope, {
    protocol: "codex-sidebar-flow/event-v1",
    event: "Stop",
    threadId: "thread-1",
    hostId: "remote-control:env_actual",
  });
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
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-hook-wake-order-"));
  const configPath = path.join(codexHome, "sidebar-flow", "config.json");
  const stateFile = path.join(codexHome, "sidebar-flow", "state.json");
  const hookLogFile = path.join(codexHome, "sidebar-flow", "hook.log");
  const previousMode = process.env[INSTALL_MODE_ENV];
  process.env[INSTALL_MODE_ENV] = "plugin";
  const wakeCalls = [];
  try {
    await writeJsonAtomic(configPath, {
      ...defaultConfig(codexHome, "plugin"),
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
    assert.equal("wakeErrorCode" in records.at(-1), false);
  } finally {
    if (previousMode == null) delete process.env[INSTALL_MODE_ENV];
    else process.env[INSTALL_MODE_ENV] = previousMode;
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
      ...defaultConfig(codexHome, "plugin"),
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
      ...defaultConfig(codexHome, "plugin"),
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
      ...defaultConfig(codexHome, "plugin"),
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
      ...defaultConfig(codexHome, "plugin"),
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
      ...defaultConfig(codexHome, "plugin"),
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
            ...defaultConfig(codexHome, "plugin"),
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
    await writeJsonAtomic(configPath, defaultConfig(codexHome, configuredMode));
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

for (const [capabilityPresent, expectedStatus] of [[true, "present"], [false, "missing"]]) {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), `sidebar-flow-hook-probe-${expectedStatus}-`));
  const runtime = path.join(codexHome, "sidebar-flow");
  const configPath = path.join(runtime, "config.json");
  const probeResultFile = path.join(runtime, "event-wake-probe-result.json");
  const previousMode = process.env[INSTALL_MODE_ENV];
  process.env[INSTALL_MODE_ENV] = "source";
  let wakeCalls = 0;
  let sendCalls = 0;
  try {
    const runtimeConfig = {
      ...defaultConfig(codexHome, "source"),
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
      createProbeId: () => `probe-${expectedStatus}-0001`,
    });

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
      ...defaultConfig(codexHome, "source"),
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
      ...defaultConfig(codexHome, "source"),
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
      ...defaultConfig(codexHome, "source"),
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
    const result = JSON.parse(await readFile(runtimeConfig.eventWakeProbeResultFile, "utf8"));
    assert.equal(result.status, "expired");
    assert.equal(result.probeId, "probe-expired-0001");
  } finally {
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
      ...defaultConfig(codexHome, "source"),
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
    const result = JSON.parse(await readFile(runtimeConfig.eventWakeProbeResultFile, "utf8"));
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
      ...defaultConfig(codexHome, "source"),
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
    const result = JSON.parse(await readFile(runtimeConfig.eventWakeProbeResultFile, "utf8"));
    assert.equal(result.status, "present");
  } finally {
    controller.abort();
    await childrenSettled;
    await rm(codexHome, { recursive: true, force: true });
  }
}

process.stdout.write("sidebar-hook tests passed\n");
