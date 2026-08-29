import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  armEventWakeProbe,
  claimEventWakeProbe,
  inspectInstallation,
  inspectPluginBundle,
  readEventWakeProbeResult,
  releaseEventWakeProbeClaim,
  writeEventWakeProbeResult,
} from "../scripts/doctor.mjs";
import { defaultConfig } from "../scripts/setup.mjs";

const execFileAsync = promisify(execFile);

const config = {
  installMode: "plugin",
  sections: { inProgress: "In Progress", forReview: "For Review", forLater: "For Later" },
};

test("plugin doctor rejects a missing bundle", () => {
  const checks = inspectInstallation({
    config,
    mode: "plugin",
    platform: "darwin",
    nodeExecutable: "/Applications/Codex.app/Contents/Resources/cua_node/bin/node",
    pluginBundle: {
      manifest: false, hooks: false, launcher: false, sidebarHook: false,
      sidebarRealtime: false, eventWake: false, enabledContext: false,
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
      manifest: true, hooks: true, launcher: true, sidebarHook: true,
      sidebarRealtime: true, eventWake: true, enabledContext: false,
    },
  });
  assert.equal(staticChecks.find((check) => check.name === "plugin-bundle").level, "warning");

  const activeChecks = inspectInstallation({
    config,
    mode: "plugin",
    platform: "darwin",
    nodeExecutable: "/Applications/Codex.app/Contents/Resources/cua_node/bin/node",
    pluginBundle: {
      manifest: true, hooks: true, launcher: true, sidebarHook: true,
      sidebarRealtime: true, eventWake: true, enabledContext: true,
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
      manifest: true, hooks: true, launcher: true, sidebarHook: true,
      sidebarRealtime: true, eventWake: true, enabledContext: true,
    },
    legacyHookConflicts: ["/opt/old/scripts/sidebar-hook.mjs"],
  });
  const conflict = checks.find((check) => check.name === "legacy-hook-conflict");
  assert.equal(conflict.level, "error");
  assert.match(conflict.message, /\/opt\/old\/scripts\/sidebar-hook\.mjs/);
});

test("plugin doctor requires every event-wake runtime bundle component", () => {
  const complete = {
    manifest: true,
    hooks: true,
    launcher: true,
    sidebarHook: true,
    sidebarRealtime: true,
    eventWake: true,
    enabledContext: true,
  };
  for (const missing of ["manifest", "hooks", "launcher", "sidebarHook", "sidebarRealtime", "eventWake"]) {
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
    ["sidebarHook", "scripts/sidebar-hook.mjs"],
    ["sidebarRealtime", "scripts/sidebar-realtime.mjs"],
    ["eventWake", "scripts/event-wake.mjs"],
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
      sidebarHook: true,
      sidebarRealtime: true,
      eventWake: true,
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
  const disabled = defaultConfig(codexHome, "plugin");
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

  for (const invalid of [
    { ...enabled, excludeThreadIds: [] },
    { ...enabled, eventWake: { ...enabled.eventWake, organizerThreadId: "bad\nid" } },
    { ...enabled, eventWake: { ...enabled.eventWake, organizerHostId: "bad host" } },
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
});

test("doctor arms and reads bounded private event-wake probe state", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-doctor-probe-"));
  const config = defaultConfig(codexHome, "source");
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
    assert.equal(await writeEventWakeProbeResult(config, "present", {
      runtimeRoot,
      now: () => 2_500,
      claim,
    }), true);
    await releaseEventWakeProbeClaim(config, claim, { runtimeRoot });
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
      { ...defaultConfig(codexHome, "source"), eventWakeProbeResultFile: unrelatedFile },
      {
        ...defaultConfig(codexHome, "source"),
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
      armEventWakeProbe(defaultConfig(codexHome, "source"), {
        runtimeRoot: `${runtimeRoot}/nested/..`,
      }),
      /probe path|runtime/i,
    );
    assert.equal(await readFile(unrelatedFile, "utf8"), "keep\n");
    assert.equal(await readFile(requestFile, "utf8"), "keep-request\n");

    const symlinkConfig = defaultConfig(codexHome, "source");
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

test("stale and superseded probe claims are recoverable and old commits are rejected", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-probe-recovery-"));
  const runtimeRoot = path.join(codexHome, "sidebar-flow");
  const config = defaultConfig(codexHome, "source");
  try {
    await mkdir(runtimeRoot, { recursive: true });
    await armEventWakeProbe(config, {
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

    const recovered = await claimEventWakeProbe(config, {
      runtimeRoot,
      now: () => 40_000,
      createClaimId: () => "claim-00000002",
    });
    assert.equal(recovered.status, "claimed");
    assert.notEqual(recovered.claimId, oldClaim.claimId);
    await releaseEventWakeProbeClaim(config, recovered, { runtimeRoot });

    const next = await armEventWakeProbe(config, {
      runtimeRoot,
      now: () => 50_000,
      createProbeId: () => "probe-00000002",
    });
    assert.equal(await writeEventWakeProbeResult(config, "present", {
      runtimeRoot,
      now: () => 51_000,
      claim: oldClaim,
    }), false);
    assert.deepEqual(await readEventWakeProbeResult(config, { runtimeRoot, now: () => 52_000 }), next);
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
    await writeFile(path.join(runtime, "config.json"), `${JSON.stringify(defaultConfig(codexHome, "source"))}\n`);
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
