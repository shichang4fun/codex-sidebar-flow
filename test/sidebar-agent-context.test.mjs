import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { computeRuntimeFingerprint } from "../scripts/runtime-integrity.mjs";
import { resolveAgentTransitionContext, rootTaskId } from "../scripts/sidebar-agent-context.mjs";

const execFileAsync = promisify(execFile);
const runtimeRoot = path.resolve(".");
const scriptPath = path.join(runtimeRoot, "scripts", "sidebar-agent-context.mjs");
const sections = { inProgress: "In Progress", forReview: "For Review", forLater: "For Later" };

async function fixtureConfig(directory, overrides = {}) {
  const configPath = path.join(directory, "config.json");
  const config = {
    installMode: "source",
    runtimeFingerprint: await computeRuntimeFingerprint(runtimeRoot, "source"),
    actorThreadId: "organizer",
    excludeThreadIds: ["excluded"],
    agentTransitions: { enabled: true },
    listLimit: 50,
    sections,
    ...overrides,
  };
  await writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  return configPath;
}

test("root task identity requires matching safe thread and session IDs", () => {
  assert.equal(rootTaskId({ CODEX_THREAD_ID: "task-1", CODEX_SESSION_ID: "task-1" }), "task-1");
  assert.equal(rootTaskId({ CODEX_THREAD_ID: "task-1", CODEX_SESSION_ID: "subagent-1" }), null);
  assert.equal(rootTaskId({ CODEX_THREAD_ID: "bad id", CODEX_SESSION_ID: "bad id" }), null);
});

test("agent context admits a bound root task and fails closed for a subagent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidebar-agent-context-"));
  try {
    const configPath = await fixtureConfig(directory);
    const rootEnv = {
      ...process.env,
      CODEX_THREAD_ID: "root-task",
      CODEX_SESSION_ID: "root-task",
      CODEX_APP_TOOLS_PIPE_PATH: "/tmp/fake-root-pipe",
    };
    const rootResult = await resolveAgentTransitionContext({
      phase: "start",
      env: rootEnv,
      configPath,
      runtimeRoot,
    });
    assert.deepEqual(rootResult, {
      eligible: true,
      phase: "start",
      threadId: "root-task",
      sections,
      listLimit: 50,
    });

    const { stdout: rootOutput } = await execFileAsync(
      process.execPath,
      [scriptPath, "finish", "--config", configPath],
      { env: rootEnv },
    );
    assert.equal(JSON.parse(rootOutput).eligible, true);

    const { stdout: subagentOutput } = await execFileAsync(
      process.execPath,
      [scriptPath, "start", "--config", configPath],
      {
        env: {
          ...rootEnv,
          CODEX_THREAD_ID: "parent-task",
          CODEX_SESSION_ID: "subagent-task",
          CODEX_APP_TOOLS_PIPE_PATH: "/tmp/fake-subagent-pipe",
        },
      },
    );
    assert.deepEqual(JSON.parse(subagentOutput), { eligible: false, reason: "not_root_task" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("agent context rejects exclusions, disabled configuration, and stale runtime bindings", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidebar-agent-policy-"));
  const env = { CODEX_THREAD_ID: "excluded", CODEX_SESSION_ID: "excluded" };
  try {
    let configPath = await fixtureConfig(directory);
    assert.deepEqual(
      await resolveAgentTransitionContext({ phase: "start", env, configPath, runtimeRoot }),
      { eligible: false, reason: "excluded" },
    );

    configPath = await fixtureConfig(directory, {
      excludeThreadIds: [],
      agentTransitions: { enabled: false },
    });
    assert.deepEqual(
      await resolveAgentTransitionContext({ phase: "start", env, configPath, runtimeRoot }),
      { eligible: false, reason: "disabled" },
    );

    configPath = await fixtureConfig(directory, {
      excludeThreadIds: [],
      runtimeFingerprint: "0".repeat(64),
    });
    assert.deepEqual(
      await resolveAgentTransitionContext({ phase: "start", env, configPath, runtimeRoot }),
      { eligible: false, reason: "runtime_binding" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("agent context rejects malformed identity and list configuration", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidebar-agent-invalid-config-"));
  const env = { CODEX_THREAD_ID: "root-task", CODEX_SESSION_ID: "root-task" };
  try {
    for (const overrides of [
      { actorThreadId: "bad actor" },
      { excludeThreadIds: "root-task" },
      { excludeThreadIds: ["bad id"] },
      { listLimit: 0 },
      { listLimit: 51 },
      { listLimit: 1.5 },
    ]) {
      const configPath = await fixtureConfig(directory, overrides);
      assert.deepEqual(
        await resolveAgentTransitionContext({ phase: "start", env, configPath, runtimeRoot }),
        { eligible: false, reason: "invalid_config" },
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
