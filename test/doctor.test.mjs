import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  armEventWakeProbe,
  inspectInstallation,
  readEventWakeProbeResult,
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
    { ...enabled, eventWakeProbeResultFile: "relative.json" },
    { ...enabled, eventWakeProbeTtlMs: 0 },
  ]) {
    const invalidChecks = inspectInstallation({ config: invalid, mode: "plugin" });
    assert.equal(invalidChecks.find((check) => check.name === "event-wake-config").level, "error");
  }

  const missing = inspectInstallation({
    config: enabled,
    mode: "plugin",
    eventWakeProbe: { status: "missing", checkedAt: 100 },
  });
  assert.equal(missing.find((check) => check.name === "event-wake-capability").level, "error");
});

test("doctor arms and reads bounded private event-wake probe state", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-doctor-probe-"));
  const config = defaultConfig(codexHome, "source");
  try {
    await mkdir(path.dirname(config.eventWakeProbeRequestFile), { recursive: true });
    const pending = await armEventWakeProbe(config, { now: () => 1_000 });
    assert.deepEqual(pending, { status: "pending", createdAt: 1_000, expiresAt: 301_000 });
    assert.equal((await stat(config.eventWakeProbeRequestFile)).mode & 0o777, 0o600);
    assert.deepEqual(await readEventWakeProbeResult(config, { now: () => 2_000 }), pending);

    await writeFile(config.eventWakeProbeResultFile, `${JSON.stringify({
      protocol: "codex-sidebar-flow/event-wake-probe-v1",
      status: "present",
      checkedAt: 2_500,
    })}\n`, { mode: 0o644 });
    await chmod(config.eventWakeProbeResultFile, 0o600);
    assert.deepEqual(await readEventWakeProbeResult(config, { now: () => 3_000 }), {
      status: "present",
      checkedAt: 2_500,
    });

    await rm(config.eventWakeProbeResultFile);
    assert.deepEqual(await readEventWakeProbeResult(config, { now: () => 400_000 }), {
      status: "expired",
      createdAt: 1_000,
      expiresAt: 301_000,
    });

    await rm(config.eventWakeProbeRequestFile);
    await writeFile(config.eventWakeProbeResultFile, "{malformed\n", { mode: 0o600 });
    assert.deepEqual(await readEventWakeProbeResult(config), { status: "missing" });
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
