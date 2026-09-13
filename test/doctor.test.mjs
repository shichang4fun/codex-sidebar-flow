import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  armEventWakeProbe,
  claimEventWakeProbe,
  inspectInstallation,
  inspectAgentTransitionInstructions,
  inspectPluginBundle,
  readEventWakeProbeResult,
  releaseEventWakeProbeClaim,
  writeEventWakeProbeResult,
} from "../scripts/doctor.mjs";
import {
  agentTransitionInstructions,
  defaultConfig,
  HOOK_MARKER,
  hookCommand,
} from "../scripts/setup.mjs";
import { computeRuntimeFingerprint, PLUGIN_RUNTIME_FILES } from "../scripts/runtime-integrity.mjs";

const execFileAsync = promisify(execFile);
const TEST_RUNTIME_FINGERPRINT = "a".repeat(64);

function runtimeDefaultConfig(codexHome, installMode) {
  return defaultConfig(codexHome, installMode, TEST_RUNTIME_FINGERPRINT);
}

function generationProbePaths(config, probeId) {
  return {
    claimFile: `${config.eventWakeProbeRequestFile}.claim.${probeId}`,
    resultFile: `${config.eventWakeProbeResultFile}.result.${probeId}`,
  };
}

const config = {
  installMode: "plugin",
  runtimeFingerprint: TEST_RUNTIME_FINGERPRINT,
  sections: { inProgress: "In Progress", forReview: "For Review", forLater: "For Later" },
};

test("doctor runtime binding requires a recomputed exact fingerprint", () => {
  const storedOnly = inspectInstallation({ config, mode: "plugin" });
  assert.equal(storedOnly.find((check) => check.name === "runtime-binding").level, "error");

  const matched = inspectInstallation({
    config,
    mode: "plugin",
    runtimeBinding: {
      mode: "plugin",
      runtimeFingerprint: TEST_RUNTIME_FINGERPRINT,
      matches: true,
    },
  });
  assert.equal(matched.find((check) => check.name === "runtime-binding").level, "ok");
});

test("doctor verifies agent-transition configuration against the active global instructions", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-doctor-agents-"));
  try {
    const expectedBlock = agentTransitionInstructions({
      runtimeRoot: "/tmp/runtime",
      configPath: "/tmp/config.json",
      nodeExecutable: "/tmp/node",
    });
    await writeFile(path.join(codexHome, "AGENTS.md"), `${expectedBlock}\n`, { mode: 0o600 });
    const agentInstructions = await inspectAgentTransitionInstructions(codexHome, { expectedBlock });
    assert.deepEqual(agentInstructions, {
      safe: true,
      installed: true,
      malformed: false,
      stale: false,
    });
    const enabledConfig = {
      ...config,
      actorThreadId: "organizer",
      excludeThreadIds: [],
      listLimit: 50,
      agentTransitions: { enabled: true },
    };
    const enabledChecks = inspectInstallation({
      config: enabledConfig,
      mode: "plugin",
      agentInstructions,
    });
    assert.equal(enabledChecks.find((check) => check.name === "agent-transitions").level, "ok");
    const disabledChecks = inspectInstallation({ config, mode: "plugin", agentInstructions });
    assert.equal(disabledChecks.find((check) => check.name === "agent-transitions").level, "error");

    for (const malformed of [
      { actorThreadId: "bad actor" },
      { excludeThreadIds: "organizer" },
      { listLimit: 51 },
    ]) {
      const malformedChecks = inspectInstallation({
        config: { ...enabledConfig, ...malformed },
        mode: "plugin",
        agentInstructions,
      });
      assert.equal(malformedChecks.find((check) => check.name === "agent-transitions").level, "error");
    }

    await writeFile(
      path.join(codexHome, "AGENTS.md"),
      `${expectedBlock.replace("/tmp/runtime", "/tmp/stale-runtime")}\n`,
      { mode: 0o600 },
    );
    assert.equal(
      (await inspectAgentTransitionInstructions(codexHome, { expectedBlock })).installed,
      false,
    );
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

async function assertDoctorFingerprints(repositoryRoot) {
  const doctorScript = path.join(repositoryRoot, "scripts/doctor.mjs");
  for (const mode of ["source", "plugin"]) {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), `sidebar-flow-doctor-binding-${mode}-`));
    const runtimeRoot = path.join(codexHome, "sidebar-flow");
    try {
      await mkdir(runtimeRoot, { recursive: true });
      if (mode === "source") {
        const command = hookCommand(repositoryRoot, process.execPath, path.join(runtimeRoot, "config.json"));
        await writeFile(path.join(codexHome, "hooks.json"), `${JSON.stringify({
          hooks: {
            UserPromptSubmit: [{ hooks: [{ type: "command", command }] }],
            Stop: [{ hooks: [{ type: "command", command }] }],
          },
        })}\n`, { mode: 0o600 });
      }
      const configPath = path.join(runtimeRoot, "config.json");
      await writeFile(configPath, `${JSON.stringify(
        defaultConfig(codexHome, mode, "f".repeat(64)),
      )}\n`, { mode: 0o600 });
      const args = [doctorScript, "--codex-home", codexHome];
      if (mode === "plugin") args.push("--plugin", "--plugin-root", repositoryRoot);
      await assert.rejects(
        execFileAsync(process.execPath, args),
        (error) => {
          const payload = JSON.parse(error.stdout);
          return error.code === 1
            && payload.checks.find((check) => check.name === "runtime-binding")?.level === "error";
        },
      );

      const actualFingerprint = await computeRuntimeFingerprint(repositoryRoot, mode);
      await writeFile(configPath, `${JSON.stringify(
        defaultConfig(codexHome, mode, actualFingerprint),
      )}\n`, { mode: 0o600 });
      const { stdout } = await execFileAsync(process.execPath, args);
      assert.equal(
        JSON.parse(stdout).checks.find((check) => check.name === "runtime-binding")?.level,
        "ok",
      );
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  }
}

test("doctor CLI recomputes source Hook and plugin-root fingerprints", async () => {
  await assertDoctorFingerprints(fileURLToPath(new URL("../", import.meta.url)));
});

test("doctor CLI accepts exact source and plugin fingerprints under a checkout path with spaces", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-doctor-spaces-"));
  const repositoryRoot = path.join(temporaryRoot, "checkout with  spaces");
  const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
  try {
    for (const relativePath of PLUGIN_RUNTIME_FILES) {
      const destination = path.join(repositoryRoot, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(sourceRoot, relativePath), destination);
    }
    // Run the actual CLI against real copied files, rejecting a wrong digest
    // before accepting the exact digest in both installation modes.
    await assertDoctorFingerprints(repositoryRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("plugin doctor rejects a missing bundle", () => {
  const checks = inspectInstallation({
    config,
    mode: "plugin",
    platform: "darwin",
    nodeExecutable: "/Applications/Codex.app/Contents/Resources/cua_node/bin/node",
    pluginBundle: {
      manifest: false, hooks: false, launcher: false, agentContext: false, sidebarHook: false,
      sidebarPolicy: false, sidebarRealtime: false, eventWake: false, setup: false, uninstall: false,
      doctor: false, runtimeIntegrity: false, renderHeartbeat: false, skill: false,
      heartbeatPrompt: false, enabledContext: false,
    },
  });
  assert.equal(checks.find((check) => check.name === "plugin-bundle").level, "error");
});

test("plugin doctor distinguishes a complete bundle from verified enablement", () => {
  const staticChecks = inspectInstallation({
    config,
    mode: "plugin",
    platform: "darwin",
    nodeExecutable: "/Applications/Codex.app/Contents/Resources/cua_node/bin/node",
    pluginBundle: {
      manifest: true, hooks: true, launcher: true, agentContext: true, sidebarHook: true,
      sidebarPolicy: true, sidebarRealtime: true, eventWake: true, setup: true, uninstall: true,
      doctor: true, runtimeIntegrity: true, renderHeartbeat: true, skill: true,
      heartbeatPrompt: true, enabledContext: false,
    },
  });
  assert.equal(staticChecks.find((check) => check.name === "plugin-bundle").level, "warning");

  const activeChecks = inspectInstallation({
    config,
    mode: "plugin",
    platform: "darwin",
    nodeExecutable: "/Applications/Codex.app/Contents/Resources/cua_node/bin/node",
    pluginBundle: {
      manifest: true, hooks: true, launcher: true, agentContext: true, sidebarHook: true,
      sidebarPolicy: true, sidebarRealtime: true, eventWake: true, setup: true, uninstall: true,
      doctor: true, runtimeIntegrity: true, renderHeartbeat: true, skill: true,
      heartbeatPrompt: true, enabledContext: true,
    },
  });
  assert.equal(activeChecks.find((check) => check.name === "plugin-bundle").level, "ok");
});

test("doctor reports unowned legacy sidebar Hooks as an error", () => {
  const checks = inspectInstallation({
    config,
    mode: "plugin",
    platform: "darwin",
    nodeExecutable: "/Applications/Codex.app/Contents/Resources/cua_node/bin/node",
    pluginBundle: {
      manifest: true, hooks: true, launcher: true, agentContext: true, sidebarHook: true,
      sidebarRealtime: true, eventWake: true, setup: true, uninstall: true,
      doctor: true, runtimeIntegrity: true, renderHeartbeat: true, skill: true,
      heartbeatPrompt: true, enabledContext: true,
    },
    legacyHookConflicts: ["/opt/old/scripts/sidebar-hook.mjs"],
  });
  const conflict = checks.find((check) => check.name === "legacy-hook-conflict");
  assert.equal(conflict.level, "error");
  assert.match(conflict.message, /\/opt\/old\/scripts\/sidebar-hook\.mjs/);
});

test("plugin doctor requires every runtime and administration bundle component", () => {
  const complete = {
    manifest: true,
    hooks: true,
    launcher: true,
    agentContext: true,
    sidebarHook: true,
    sidebarRealtime: true,
    eventWake: true,
    setup: true,
    uninstall: true,
    doctor: true,
    runtimeIntegrity: true,
    renderHeartbeat: true,
    skill: true,
    heartbeatPrompt: true,
    enabledContext: true,
  };
  for (const missing of [
    "manifest", "hooks", "launcher", "agentContext", "sidebarHook", "sidebarRealtime", "eventWake",
    "setup", "uninstall", "doctor", "runtimeIntegrity", "renderHeartbeat", "skill",
    "heartbeatPrompt",
  ]) {
    const checks = inspectInstallation({
      config,
      mode: "plugin",
      platform: "darwin",
      nodeExecutable: "/Applications/Codex.app/Contents/Resources/cua_node/bin/node",
      pluginBundle: { ...complete, [missing]: false },
    });
    assert.equal(checks.find((check) => check.name === "plugin-bundle").level, "error", missing);
  }
});

test("plugin bundle inspection rejects directories, symlinks, and unreadable entries", async () => {
  const pluginRoot = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-plugin-bundle-"));
  const entries = [
    ["manifest", ".codex-plugin/plugin.json"],
    ["hooks", "hooks/hooks.json"],
    ["launcher", "scripts/plugin-hook.sh"],
    ["agentContext", "scripts/sidebar-agent-context.mjs"],
    ["sidebarHook", "scripts/sidebar-hook.mjs"],
    ["sidebarPolicy", "scripts/sidebar-policy.mjs"],
    ["sidebarRealtime", "scripts/sidebar-realtime.mjs"],
    ["eventWake", "scripts/event-wake.mjs"],
    ["setup", "scripts/setup.mjs"],
    ["uninstall", "scripts/uninstall.mjs"],
    ["doctor", "scripts/doctor.mjs"],
    ["runtimeIntegrity", "scripts/runtime-integrity.mjs"],
    ["renderHeartbeat", "scripts/render-heartbeat.mjs"],
    ["skill", "skills/sidebar-flow/SKILL.md"],
    ["heartbeatPrompt", "docs/heartbeat-prompt.md"],
  ];
  try {
    for (const [, relativePath] of entries) {
      const filePath = path.join(pluginRoot, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "fixture\n", { mode: 0o600 });
    }
    assert.deepEqual(await inspectPluginBundle(pluginRoot, { enabledContext: true }), {
      manifest: true,
      hooks: true,
      launcher: true,
      agentContext: true,
      sidebarHook: true,
      sidebarPolicy: true,
      sidebarRealtime: true,
      eventWake: true,
      setup: true,
      uninstall: true,
      doctor: true,
      runtimeIntegrity: true,
      renderHeartbeat: true,
      skill: true,
      heartbeatPrompt: true,
      enabledContext: true,
    });

    await rm(path.join(pluginRoot, "scripts/event-wake.mjs"));
    await mkdir(path.join(pluginRoot, "scripts/event-wake.mjs"));
    assert.equal((await inspectPluginBundle(pluginRoot)).eventWake, false);
    await rm(path.join(pluginRoot, "scripts/event-wake.mjs"), { recursive: true });
    await symlink(path.join(pluginRoot, "scripts/sidebar-hook.mjs"), path.join(pluginRoot, "scripts/event-wake.mjs"));
    assert.equal((await inspectPluginBundle(pluginRoot)).eventWake, false);

    await chmod(path.join(pluginRoot, "scripts/sidebar-realtime.mjs"), 0o000);
    assert.equal((await inspectPluginBundle(pluginRoot)).sidebarRealtime, false);
  } finally {
    await chmod(path.join(pluginRoot, "scripts/sidebar-realtime.mjs"), 0o600).catch(() => {});
    await rm(pluginRoot, { recursive: true, force: true });
  }
});

test("doctor validates event-wake configuration and reports capability separately", () => {
  const codexHome = "/tmp/sidebar-flow-doctor";
  const disabled = runtimeDefaultConfig(codexHome, "plugin");
  const disabledChecks = inspectInstallation({ config: disabled, mode: "plugin" });
  assert.equal(disabledChecks.find((check) => check.name === "event-wake-config").level, "ok");
  assert.equal(disabledChecks.find((check) => check.name === "event-wake-capability").level, "ok");

  const enabled = {
    ...disabled,
    excludeThreadIds: ["organizer-123"],
    eventWake: {
      enabled: true,
      organizerThreadId: "organizer-123",
      organizerHostId: "remote-control:env_123",
      maxPerMinute: 7,
    },
  };
  const checks = inspectInstallation({
    config: enabled,
    mode: "plugin",
    runtimeRoot: path.join(codexHome, "sidebar-flow"),
    eventWakeProbe: { status: "present", checkedAt: 100 },
  });
  assert.equal(checks.find((check) => check.name === "event-wake-config").level, "ok");
  assert.equal(checks.find((check) => check.name === "event-wake-capability").level, "ok");

  const bridged = {
    ...enabled,
    agentTransitions: { enabled: false },
    eventWake: {
      ...enabled.eventWake,
      organizerHostId: null,
      routingMode: "controller-bridge",
    },
  };
  const bridgeChecks = inspectInstallation({
    config: bridged,
    mode: "plugin",
    runtimeRoot: path.join(codexHome, "sidebar-flow"),
    eventWakeProbe: { status: "present", checkedAt: 100 },
  });
  assert.equal(bridgeChecks.find((check) => check.name === "event-wake-config").level, "ok");
  const dormantBridgeChecks = inspectInstallation({
    config: { ...bridged, eventWake: { ...bridged.eventWake, enabled: false } },
    mode: "plugin",
    runtimeRoot: path.join(codexHome, "sidebar-flow"),
  });
  assert.equal(dormantBridgeChecks.find((check) => check.name === "event-wake-config").level, "ok");

  for (const invalid of [
    { ...enabled, excludeThreadIds: [] },
    { ...enabled, eventWake: { ...enabled.eventWake, organizerThreadId: "bad\nid" } },
    { ...enabled, eventWake: { ...enabled.eventWake, organizerHostId: "bad host" } },
    { ...bridged, eventWake: { ...bridged.eventWake, organizerHostId: "local" } },
    { ...bridged, agentTransitions: { enabled: true } },
    { ...bridged, eventWake: { ...bridged.eventWake, enabled: false }, agentTransitions: { enabled: true } },
    { ...bridged, listLimit: 0 },
    { ...enabled, eventWake: { ...enabled.eventWake, maxPerMinute: 0 } },
    { ...enabled, wakeStateFile: "relative.json" },
    { ...enabled, wakeStateFile: "/tmp/wake\nstate.json" },
    { ...enabled, eventWakeProbeRequestFile: "relative.json" },
    { ...enabled, eventWakeProbeRequestFile: "/tmp/request\nprobe.json" },
    { ...enabled, eventWakeProbeRequestFile: "/tmp/unrelated-request.json" },
    { ...enabled, eventWakeProbeResultFile: "relative.json" },
    { ...enabled, eventWakeProbeResultFile: "/tmp/unrelated-result.json" },
    { ...enabled, eventWakeProbeTtlMs: 0 },
  ]) {
    const invalidChecks = inspectInstallation({
      config: invalid,
      mode: "plugin",
      runtimeRoot: path.join(codexHome, "sidebar-flow"),
    });
    assert.equal(invalidChecks.find((check) => check.name === "event-wake-config").level, "error");
  }

  const missing = inspectInstallation({
    config: enabled,
    mode: "plugin",
    runtimeRoot: path.join(codexHome, "sidebar-flow"),
    eventWakeProbe: { status: "missing", checkedAt: 100 },
  });
  assert.equal(missing.find((check) => check.name === "event-wake-capability").level, "error");

  const pending = inspectInstallation({
    config: enabled,
    mode: "plugin",
    runtimeRoot: path.join(codexHome, "sidebar-flow"),
    eventWakeProbe: { status: "pending", checkedAt: 100 },
  });
  assert.equal(pending.find((check) => check.name === "event-wake-capability").level, "error");

  const expired = inspectInstallation({
    config: enabled,
    mode: "plugin",
    runtimeRoot: path.join(codexHome, "sidebar-flow"),
    eventWakeProbe: { status: "expired", checkedAt: 100 },
  });
  assert.equal(expired.find((check) => check.name === "event-wake-capability").level, "warning");
});

test("doctor arms and reads bounded private event-wake probe state", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-doctor-probe-"));
  const config = runtimeDefaultConfig(codexHome, "source");
  const runtimeRoot = path.join(codexHome, "sidebar-flow");
  try {
    await mkdir(runtimeRoot, { recursive: true });
    const pending = await armEventWakeProbe(config, {
      runtimeRoot,
      now: () => 1_000,
      createProbeId: () => "probe-00000001",
    });
    assert.deepEqual(pending, {
      status: "pending",
      probeId: "probe-00000001",
      armedAt: 1_000,
      expiresAt: 301_000,
    });
    assert.equal((await stat(config.eventWakeProbeRequestFile)).mode & 0o777, 0o600);
    assert.deepEqual(await readEventWakeProbeResult(config, { runtimeRoot, now: () => 2_000 }), pending);

    const claim = await claimEventWakeProbe(config, {
      runtimeRoot,
      now: () => 2_000,
      createClaimId: () => "claim-00000001",
    });
    assert.equal(claim.status, "claimed");
    assert.equal(claim.probeId, pending.probeId);
    const paths = generationProbePaths(config, pending.probeId);
    assert.equal((await stat(paths.claimFile)).mode & 0o777, 0o600);
    assert.equal(await writeEventWakeProbeResult(config, "present", {
      runtimeRoot,
      now: () => 2_500,
      claim,
    }), true);
    await releaseEventWakeProbeClaim(config, claim, { runtimeRoot });
    assert.equal((await stat(paths.resultFile)).mode & 0o777, 0o600);
    await assert.rejects(stat(config.eventWakeProbeResultFile), (error) => error.code === "ENOENT");
    assert.deepEqual(await readEventWakeProbeResult(config, { runtimeRoot, now: () => 3_000 }), {
      status: "present",
      probeId: "probe-00000001",
      armedAt: 1_000,
      claimedAt: 2_000,
      observedAt: 2_500,
      expiresAt: 301_000,
    });
    assert.deepEqual(await readEventWakeProbeResult(config, { runtimeRoot, now: () => 400_000 }), {
      status: "expired",
      probeId: "probe-00000001",
      armedAt: 1_000,
      expiresAt: 301_000,
    });
    assert.deepEqual(await claimEventWakeProbe(config, { runtimeRoot, now: () => 400_000 }), {
      status: "expired",
      probeId: "probe-00000001",
      armedAt: 1_000,
      expiresAt: 301_000,
    });

    const next = await armEventWakeProbe(config, {
      runtimeRoot,
      now: () => 4_000,
      createProbeId: () => "probe-00000002",
    });
    assert.notEqual(next.probeId, pending.probeId);
    assert.deepEqual(await readEventWakeProbeResult(config, { runtimeRoot, now: () => 5_000 }), next);

    await rm(config.eventWakeProbeRequestFile);
    await writeFile(config.eventWakeProbeResultFile, "{malformed\n", { mode: 0o600 });
    assert.deepEqual(await readEventWakeProbeResult(config, { runtimeRoot }), { status: "missing" });
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("probe records are strictly bound to install mode and runtime fingerprint", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-doctor-binding-"));
  const runtimeRoot = path.join(codexHome, "sidebar-flow");
  const boundConfig = {
    ...runtimeDefaultConfig(codexHome, "source"),
    installMode: "source",
    runtimeFingerprint: TEST_RUNTIME_FINGERPRINT,
  };
  try {
    await mkdir(runtimeRoot, { recursive: true });
    const pending = await armEventWakeProbe(boundConfig, {
      runtimeRoot,
      now: () => 1_000,
      createProbeId: () => "probe-runtime-bound",
    });
    const request = JSON.parse(await readFile(boundConfig.eventWakeProbeRequestFile, "utf8"));
    assert.deepEqual(Object.keys(request).sort(), [
      "armedAt", "expiresAt", "installMode", "probeId", "protocol", "runtimeFingerprint",
    ]);
    assert.equal(request.installMode, "source");
    assert.equal(request.runtimeFingerprint, TEST_RUNTIME_FINGERPRINT);

    const claim = await claimEventWakeProbe(boundConfig, {
      runtimeRoot,
      now: () => 2_000,
      createClaimId: () => "claim-runtime-bound",
    });
    assert.equal(claim.status, "claimed");
    assert.equal(await writeEventWakeProbeResult(boundConfig, "present", {
      runtimeRoot,
      now: () => 2_500,
      claim,
    }), true);
    await releaseEventWakeProbeClaim(boundConfig, claim, { runtimeRoot });
    const resultPath = generationProbePaths(boundConfig, pending.probeId).resultFile;
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    assert.deepEqual(Object.keys(result).sort(), [
      "armedAt", "claimedAt", "expiresAt", "installMode", "observedAt", "probeId",
      "protocol", "runtimeFingerprint", "status",
    ]);
    assert.equal(result.installMode, "source");
    assert.equal(result.runtimeFingerprint, TEST_RUNTIME_FINGERPRINT);

    assert.deepEqual(await readEventWakeProbeResult({
      ...boundConfig,
      runtimeFingerprint: "b".repeat(64),
    }, { runtimeRoot, now: () => 3_000 }), { status: "missing" });

    await writeFile(resultPath, `${JSON.stringify({ ...result, unexpected: true })}\n`, { mode: 0o600 });
    assert.equal((await readEventWakeProbeResult(boundConfig, { runtimeRoot, now: () => 3_000 })).status, "pending");
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("a completed present probe expires with its request ttl", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-doctor-cli-present-"));
  const runtimeRoot = path.join(codexHome, "sidebar-flow");
  const config = runtimeDefaultConfig(codexHome, "source");
  try {
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(path.join(codexHome, "hooks.json"), `${JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: `${HOOK_MARKER} node /tmp/sidebar-hook.mjs` }] }],
        Stop: [{ hooks: [{ type: "command", command: `${HOOK_MARKER} node /tmp/sidebar-hook.mjs` }] }],
      },
    })}\n`, { mode: 0o600 });
    await writeFile(path.join(runtimeRoot, "config.json"), `${JSON.stringify({
      ...config,
      installMode: "source",
      excludeThreadIds: ["organizer-123"],
      eventWake: {
        enabled: true,
        organizerThreadId: "organizer-123",
        organizerHostId: "local",
        maxPerMinute: 20,
      },
    })}\n`, { mode: 0o600 });
    await writeFile(config.eventWakeProbeRequestFile, `${JSON.stringify({
      protocol: "codex-sidebar-flow/event-wake-probe-v1",
      probeId: "probe-00000001",
      armedAt: 1_000,
      expiresAt: 301_000,
      installMode: "source",
      runtimeFingerprint: TEST_RUNTIME_FINGERPRINT,
    })}\n`, { mode: 0o600 });
    await writeFile(`${config.eventWakeProbeResultFile}.result.probe-00000001`, `${JSON.stringify({
      protocol: "codex-sidebar-flow/event-wake-probe-v1",
      status: "present",
      probeId: "probe-00000001",
      armedAt: 1_000,
      claimedAt: 2_000,
      observedAt: 2_500,
      expiresAt: 301_000,
      installMode: "source",
      runtimeFingerprint: TEST_RUNTIME_FINGERPRINT,
    })}\n`, { mode: 0o600 });

    assert.deepEqual(
      await readEventWakeProbeResult(config, { runtimeRoot, now: () => 400_000 }),
      {
        status: "expired",
        probeId: "probe-00000001",
        armedAt: 1_000,
        expiresAt: 301_000,
      },
    );
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("invalid generation result files never mask expiry or pending probe state", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-doctor-invalid-result-"));
  const runtimeRoot = path.join(codexHome, "sidebar-flow");
  const config = runtimeDefaultConfig(codexHome, "source");
  const unrelatedFile = path.join(codexHome, "unrelated.txt");
  try {
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(unrelatedFile, "keep\n", { mode: 0o600 });

    const expired = await armEventWakeProbe(config, {
      runtimeRoot,
      now: () => 1_000,
      createProbeId: () => "probe-invalid-expired",
    });
    await symlink(unrelatedFile, generationProbePaths(config, expired.probeId).resultFile);
    assert.deepEqual(await readEventWakeProbeResult(config, { runtimeRoot, now: () => 400_000 }), {
      status: "expired",
      probeId: expired.probeId,
      armedAt: expired.armedAt,
      expiresAt: expired.expiresAt,
    });
    assert.deepEqual(await claimEventWakeProbe(config, { runtimeRoot, now: () => 400_000 }), {
      status: "expired",
      probeId: expired.probeId,
      armedAt: expired.armedAt,
      expiresAt: expired.expiresAt,
    });
    assert.equal(await readFile(unrelatedFile, "utf8"), "keep\n");

    await rm(config.eventWakeProbeRequestFile, { force: true });
    await rm(generationProbePaths(config, expired.probeId).resultFile, { force: true });
    const pending = await armEventWakeProbe(config, {
      runtimeRoot,
      now: () => 500_000,
      createProbeId: () => "probe-invalid-pending",
    });
    await mkdir(generationProbePaths(config, pending.probeId).resultFile);
    assert.deepEqual(await readEventWakeProbeResult(config, { runtimeRoot, now: () => 500_100 }), {
      status: "pending",
      probeId: pending.probeId,
      armedAt: pending.armedAt,
      expiresAt: pending.expiresAt,
    });
    const claim = await claimEventWakeProbe(config, { runtimeRoot, now: () => 500_100 });
    assert.equal(claim.status, "claimed");
    await releaseEventWakeProbeClaim(config, claim, { runtimeRoot });
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("probe paths are exact runtime files and unsafe targets are untouched", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-doctor-paths-"));
  const runtimeRoot = path.join(codexHome, "sidebar-flow");
  const unrelatedFile = path.join(codexHome, "unrelated.json");
  const requestFile = path.join(runtimeRoot, "event-wake-probe-request.json");
  try {
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(unrelatedFile, "keep\n", { mode: 0o600 });
    await writeFile(requestFile, "keep-request\n", { mode: 0o600 });
    for (const unsafe of [
      { ...runtimeDefaultConfig(codexHome, "source"), eventWakeProbeResultFile: unrelatedFile },
      {
        ...runtimeDefaultConfig(codexHome, "source"),
        eventWakeProbeRequestFile: `${runtimeRoot}/nested/../event-wake-probe-request.json`,
      },
    ]) {
      await assert.rejects(
        armEventWakeProbe(unsafe, { runtimeRoot }),
        /probe path|runtime/i,
      );
      assert.equal(await readFile(unrelatedFile, "utf8"), "keep\n");
      assert.equal(await readFile(requestFile, "utf8"), "keep-request\n");
    }
    await assert.rejects(
      armEventWakeProbe(runtimeDefaultConfig(codexHome, "source"), {
        runtimeRoot: `${runtimeRoot}/nested/..`,
      }),
      /probe path|runtime/i,
    );
    assert.equal(await readFile(unrelatedFile, "utf8"), "keep\n");
    assert.equal(await readFile(requestFile, "utf8"), "keep-request\n");

    const symlinkConfig = runtimeDefaultConfig(codexHome, "source");
    await symlink(unrelatedFile, symlinkConfig.eventWakeProbeResultFile);
    await assert.rejects(
      armEventWakeProbe(symlinkConfig, { runtimeRoot }),
      /symlink|regular file|probe path/i,
    );
    assert.equal(await readFile(unrelatedFile, "utf8"), "keep\n");
    assert.equal(await readFile(requestFile, "utf8"), "keep-request\n");
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("a dead old generation never blocks or deletes a newly armed generation", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-probe-recovery-"));
  const runtimeRoot = path.join(codexHome, "sidebar-flow");
  const config = runtimeDefaultConfig(codexHome, "source");
  try {
    await mkdir(runtimeRoot, { recursive: true });
    const old = await armEventWakeProbe(config, {
      runtimeRoot,
      now: () => 1_000,
      createProbeId: () => "probe-00000001",
    });
    const oldClaim = await claimEventWakeProbe(config, {
      runtimeRoot,
      now: () => 2_000,
      createClaimId: () => "claim-00000001",
    });
    assert.equal(oldClaim.status, "claimed");
    const oldPaths = generationProbePaths(config, old.probeId);
    await assert.rejects(
      armEventWakeProbe(config, {
        runtimeRoot,
        now: () => 2_500,
        createProbeId: () => old.probeId,
      }),
      /unique|probe identity/i,
    );
    assert.equal((await readEventWakeProbeResult(config, { runtimeRoot, now: () => 2_600 })).probeId, old.probeId);

    const next = await armEventWakeProbe(config, {
      runtimeRoot,
      now: () => 3_000,
      createProbeId: () => "probe-00000002",
    });
    const nextClaim = await claimEventWakeProbe(config, {
      runtimeRoot,
      now: () => 4_000,
      createClaimId: () => "claim-00000002",
    });
    assert.equal(nextClaim.status, "claimed");
    const nextPaths = generationProbePaths(config, next.probeId);
    assert.equal((await stat(oldPaths.claimFile)).isFile(), true);
    assert.equal((await stat(nextPaths.claimFile)).isFile(), true);

    assert.equal(await writeEventWakeProbeResult(config, "present", {
      runtimeRoot,
      now: () => 5_000,
      claim: oldClaim,
    }), false);
    assert.equal(await writeEventWakeProbeResult(config, "present", {
      runtimeRoot,
      now: () => 5_100,
      claim: nextClaim,
    }), true);
    assert.equal(await releaseEventWakeProbeClaim(config, oldClaim, { runtimeRoot }), true);
    assert.equal((await stat(nextPaths.claimFile)).isFile(), true);
    await releaseEventWakeProbeClaim(config, nextClaim, { runtimeRoot });
    assert.equal((await readEventWakeProbeResult(config, { runtimeRoot, now: () => 5_200 })).probeId, next.probeId);
    assert.equal((await stat(nextPaths.resultFile)).isFile(), true);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("a contender rechecks the completed result after acquiring the generation claim", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-probe-post-claim-"));
  const runtimeRoot = path.join(codexHome, "sidebar-flow");
  const config = runtimeDefaultConfig(codexHome, "source");
  let winnerClaim;
  try {
    await mkdir(runtimeRoot, { recursive: true });
    const armed = await armEventWakeProbe(config, {
      runtimeRoot,
      now: () => 1_000,
      createProbeId: () => "probe-post-claim",
    });
    winnerClaim = await claimEventWakeProbe(config, {
      runtimeRoot,
      now: () => 2_000,
      createClaimId: () => "claim-post-winner",
    });
    const contender = await claimEventWakeProbe(config, {
      runtimeRoot,
      now: () => 3_000,
      createClaimId: () => "claim-post-contender",
      async afterInitialResultRead() {
        assert.equal(await writeEventWakeProbeResult(config, "present", {
          runtimeRoot,
          now: () => 2_500,
          claim: winnerClaim,
        }), true);
        assert.equal(await releaseEventWakeProbeClaim(config, winnerClaim, { runtimeRoot }), true);
      },
    });

    assert.equal(contender.status, "complete");
    assert.equal(contender.result.status, "present");
    assert.equal(contender.result.claimedAt, 2_000);
    assert.deepEqual(await readEventWakeProbeResult(config, { runtimeRoot, now: () => 3_100 }), contender.result);
    await assert.rejects(
      stat(generationProbePaths(config, armed.probeId).claimFile),
      (error) => error.code === "ENOENT",
    );
  } finally {
    await releaseEventWakeProbeClaim(config, winnerClaim, { runtimeRoot }).catch(() => false);
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("opportunistic cleanup removes only expired orphan probe generations", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-probe-cleanup-"));
  const runtimeRoot = path.join(codexHome, "sidebar-flow");
  const config = runtimeDefaultConfig(codexHome, "source");
  let oldClaim;
  let currentClaim;
  try {
    await mkdir(runtimeRoot, { recursive: true });
    const old = await armEventWakeProbe(config, {
      runtimeRoot,
      now: () => 1_000,
      createProbeId: () => "probe-cleanup-old",
    });
    oldClaim = await claimEventWakeProbe(config, {
      runtimeRoot,
      now: () => 2_000,
      createClaimId: () => "claim-cleanup-old",
    });
    assert.equal(await writeEventWakeProbeResult(config, "present", {
      runtimeRoot,
      now: () => 2_500,
      claim: oldClaim,
    }), true);
    const current = await armEventWakeProbe(config, {
      runtimeRoot,
      now: () => 3_000,
      createProbeId: () => "probe-cleanup-current",
    });
    currentClaim = await claimEventWakeProbe(config, {
      runtimeRoot,
      now: () => 4_000,
      createClaimId: () => "claim-cleanup-current",
    });

    const oldPaths = generationProbePaths(config, old.probeId);
    const currentPaths = generationProbePaths(config, current.probeId);
    await Promise.all([
      utimes(oldPaths.claimFile, 0, 0),
      utimes(oldPaths.resultFile, 0, 0),
      utimes(currentPaths.claimFile, 0, 0),
    ]);
    const unrelatedFile = path.join(codexHome, "unrelated.txt");
    const symlinkPath = generationProbePaths(config, "probe-cleanup-link").claimFile;
    const invalidName = `${config.eventWakeProbeRequestFile}.claim.short`;
    await writeFile(unrelatedFile, "keep\n", { mode: 0o600 });
    await symlink(unrelatedFile, symlinkPath);
    await writeFile(invalidName, "keep-invalid\n", { mode: 0o600 });
    await utimes(invalidName, 0, 0);

    assert.equal((await readEventWakeProbeResult(config, {
      runtimeRoot,
      now: () => 302_000,
    })).probeId, current.probeId);
    await assert.rejects(stat(oldPaths.claimFile), (error) => error.code === "ENOENT");
    await assert.rejects(stat(oldPaths.resultFile), (error) => error.code === "ENOENT");
    assert.equal((await stat(currentPaths.claimFile)).isFile(), true);
    assert.equal((await lstat(symlinkPath)).isSymbolicLink(), true);
    assert.equal(await readFile(unrelatedFile, "utf8"), "keep\n");
    assert.equal(await readFile(invalidName, "utf8"), "keep-invalid\n");

    const next = await armEventWakeProbe(config, {
      runtimeRoot,
      now: () => 400_000,
      createProbeId: () => "probe-cleanup-next",
    });
    await assert.rejects(stat(currentPaths.claimFile), (error) => error.code === "ENOENT");
    assert.deepEqual(await readEventWakeProbeResult(config, {
      runtimeRoot,
      now: () => 400_100,
    }), next);
  } finally {
    await releaseEventWakeProbeClaim(config, oldClaim, { runtimeRoot }).catch(() => false);
    await releaseEventWakeProbeClaim(config, currentClaim, { runtimeRoot }).catch(() => false);
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("claim release verifies open-handle ownership before removing its generation path", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-probe-owner-"));
  const runtimeRoot = path.join(codexHome, "sidebar-flow");
  const config = runtimeDefaultConfig(codexHome, "source");
  try {
    await mkdir(runtimeRoot, { recursive: true });
    const pending = await armEventWakeProbe(config, {
      runtimeRoot,
      now: () => 1_000,
      createProbeId: () => "probe-owner-0001",
    });
    const claim = await claimEventWakeProbe(config, {
      runtimeRoot,
      now: () => 2_000,
      createClaimId: () => "claim-owner-0001",
    });
    const { claimFile } = generationProbePaths(config, pending.probeId);
    const originalBytes = await readFile(claimFile);
    const movedOwner = `${claimFile}.original`;
    await rename(claimFile, movedOwner);
    await writeFile(claimFile, originalBytes, { mode: 0o600 });

    assert.equal(await releaseEventWakeProbeClaim(config, claim, { runtimeRoot }), false);
    assert.equal((await stat(claimFile)).isFile(), true);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("generation result publication rejects symlink targets without touching their destination", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-probe-result-path-"));
  const runtimeRoot = path.join(codexHome, "sidebar-flow");
  const config = runtimeDefaultConfig(codexHome, "source");
  const unrelatedFile = path.join(codexHome, "unrelated.json");
  try {
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(unrelatedFile, "keep\n", { mode: 0o600 });
    const pending = await armEventWakeProbe(config, {
      runtimeRoot,
      now: () => 1_000,
      createProbeId: () => "probe-result-path",
    });
    const claim = await claimEventWakeProbe(config, {
      runtimeRoot,
      now: () => 2_000,
      createClaimId: () => "claim-result-path",
    });
    await symlink(unrelatedFile, generationProbePaths(config, pending.probeId).resultFile);
    await assert.rejects(
      writeEventWakeProbeResult(config, "present", {
        runtimeRoot,
        now: () => 2_500,
        claim,
      }),
      /symlink|regular file|probe path/i,
    );
    assert.equal(await readFile(unrelatedFile, "utf8"), "keep\n");
    await releaseEventWakeProbeClaim(config, claim, { runtimeRoot });
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("old result publication cannot overwrite or unlink a newer generation result", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-probe-publish-race-"));
  const runtimeRoot = path.join(codexHome, "sidebar-flow");
  const config = runtimeDefaultConfig(codexHome, "source");
  try {
    await mkdir(runtimeRoot, { recursive: true });
    const old = await armEventWakeProbe(config, {
      runtimeRoot,
      now: () => 1_000,
      createProbeId: () => "probe-publish-old",
    });
    const oldClaim = await claimEventWakeProbe(config, {
      runtimeRoot,
      now: () => 2_000,
      createClaimId: () => "claim-publish-old",
    });
    let next;
    let nextClaim;
    const oldCommitted = await writeEventWakeProbeResult(config, "present", {
      runtimeRoot,
      now: () => 5_000,
      claim: oldClaim,
      async afterRequestValidation() {
        next = await armEventWakeProbe(config, {
          runtimeRoot,
          now: () => 3_000,
          createProbeId: () => "probe-publish-new",
        });
        nextClaim = await claimEventWakeProbe(config, {
          runtimeRoot,
          now: () => 4_000,
          createClaimId: () => "claim-publish-new",
        });
        assert.equal(await writeEventWakeProbeResult(config, "missing", {
          runtimeRoot,
          now: () => 4_500,
          claim: nextClaim,
        }), true);
      },
    });

    assert.equal(oldCommitted, false);
    assert.equal((await readEventWakeProbeResult(config, { runtimeRoot, now: () => 5_100 })).status, "missing");
    assert.equal((await readEventWakeProbeResult(config, { runtimeRoot, now: () => 5_100 })).probeId, next.probeId);
    assert.equal((await stat(generationProbePaths(config, next.probeId).resultFile)).isFile(), true);
    await releaseEventWakeProbeClaim(config, oldClaim, { runtimeRoot });
    await releaseEventWakeProbeClaim(config, nextClaim, { runtimeRoot });
    assert.equal((await stat(generationProbePaths(config, next.probeId).resultFile)).isFile(), true);
    assert.notEqual(old.probeId, next.probeId);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("doctor retries when request generation changes during its result snapshot", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-probe-read-race-"));
  const runtimeRoot = path.join(codexHome, "sidebar-flow");
  const config = runtimeDefaultConfig(codexHome, "source");
  try {
    await mkdir(runtimeRoot, { recursive: true });
    await armEventWakeProbe(config, {
      runtimeRoot,
      now: () => 1_000,
      createProbeId: () => "probe-read-old",
    });
    const oldClaim = await claimEventWakeProbe(config, {
      runtimeRoot,
      now: () => 2_000,
      createClaimId: () => "claim-read-old",
    });
    await writeEventWakeProbeResult(config, "present", {
      runtimeRoot,
      now: () => 2_500,
      claim: oldClaim,
    });
    let next;
    const observed = await readEventWakeProbeResult(config, {
      runtimeRoot,
      now: () => 5_000,
      async afterResultRead() {
        if (next != null) return;
        next = await armEventWakeProbe(config, {
          runtimeRoot,
          now: () => 3_000,
          createProbeId: () => "probe-read-new",
        });
        const nextClaim = await claimEventWakeProbe(config, {
          runtimeRoot,
          now: () => 4_000,
          createClaimId: () => "claim-read-new",
        });
        await writeEventWakeProbeResult(config, "missing", {
          runtimeRoot,
          now: () => 4_500,
          claim: nextClaim,
        });
        await releaseEventWakeProbeClaim(config, nextClaim, { runtimeRoot });
      },
    });
    assert.equal(observed.status, "missing");
    assert.equal(observed.probeId, next.probeId);
    await releaseEventWakeProbeClaim(config, oldClaim, { runtimeRoot });
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("doctor CLI arms a probe without claiming access to the Hook pipe", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-doctor-cli-"));
  const runtime = path.join(codexHome, "sidebar-flow");
  const doctorScript = path.resolve("scripts/doctor.mjs");
  try {
    await mkdir(runtime, { recursive: true });
    await writeFile(path.join(runtime, "config.json"), `${JSON.stringify(runtimeDefaultConfig(codexHome, "source"))}\n`);
    const armed = JSON.parse((await execFileAsync(process.execPath, [
      doctorScript,
      "--codex-home", codexHome,
      "--arm-event-wake-probe",
    ], { env: { ...process.env, CODEX_APP_TOOLS_PIPE_PATH: "/tmp/untrusted.pipe" } })).stdout);
    assert.equal(armed.eventWakeProbe.status, "pending");
    assert.equal(JSON.stringify(armed).includes("send_message_to_thread"), false);

    const result = JSON.parse((await execFileAsync(process.execPath, [
      doctorScript,
      "--codex-home", codexHome,
      "--event-wake-probe-result",
    ])).stdout);
    assert.equal(result.eventWakeProbe.status, "pending");
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});
