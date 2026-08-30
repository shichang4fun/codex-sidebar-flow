import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  defaultConfig,
  findUnmarkedSidebarHookPaths,
  HOOK_MARKER,
  installHooks,
  parseSetupArgs,
  removeHooks,
  setup,
} from "../scripts/setup.mjs";
import { parseUninstallArgs, uninstall } from "../scripts/uninstall.mjs";
import {
  armEventWakeProbe,
  claimEventWakeProbe,
  releaseEventWakeProbeClaim,
  writeEventWakeProbeResult,
} from "../scripts/doctor.mjs";

const ownedCommand = `${HOOK_MARKER} node /repo/scripts/sidebar-hook.mjs`;
const execFileAsync = promisify(execFile);
const sourceRuntimeFiles = [
  "scripts/doctor.mjs",
  "scripts/event-wake.mjs",
  "scripts/runtime-integrity.mjs",
  "scripts/setup.mjs",
  "scripts/sidebar-hook.mjs",
  "scripts/sidebar-policy.mjs",
  "scripts/sidebar-realtime.mjs",
  "scripts/uninstall.mjs",
];
const pluginRuntimeFiles = [
  ...sourceRuntimeFiles,
  ".codex-plugin/plugin.json",
  "docs/heartbeat-prompt.md",
  "hooks/hooks.json",
  "scripts/plugin-hook.sh",
  "scripts/render-heartbeat.mjs",
  "skills/sidebar-flow/SKILL.md",
].sort();

async function expectedRuntimeFingerprint(root, mode = "source") {
  const files = mode === "source" ? sourceRuntimeFiles : pluginRuntimeFiles;
  const hash = createHash("sha256");
  for (const relativePath of files) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await readFile(path.join(root, relativePath)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function copyRuntimeFixture(sourceRoot, targetRoot) {
  for (const relativePath of sourceRuntimeFiles) {
    await mkdir(path.dirname(path.join(targetRoot, relativePath)), { recursive: true });
    await copyFile(path.join(sourceRoot, relativePath), path.join(targetRoot, relativePath));
  }
}

function setupPluginForTest(codexHome, options = {}) {
  return setup(
    { codexHome, mode: "plugin", ...options },
    { runtimeCodexHome: codexHome },
  );
}

async function recordPresentProbe(config, runtimeRoot, {
  armedAt = Date.now(),
  probeId = "probe-setup-present",
} = {}) {
  const pending = await armEventWakeProbe(config, {
    runtimeRoot,
    now: () => armedAt,
    createProbeId: () => probeId,
  });
  const claim = await claimEventWakeProbe(config, {
    runtimeRoot,
    now: () => armedAt + 100,
    createClaimId: () => `claim-${probeId}`,
  });
  assert.equal(claim.status, "claimed");
  assert.equal(await writeEventWakeProbeResult(config, "present", {
    runtimeRoot,
    now: () => armedAt + 200,
    claim,
  }), true);
  await releaseEventWakeProbeClaim(config, claim, { runtimeRoot });
  return pending;
}

test("setup and uninstall CLI parsers reject missing or flag-shaped path values", async () => {
  assert.throws(() => parseSetupArgs(["--codex-home"]), /requires a value/);
  assert.throws(() => parseSetupArgs(["--codex-home", "--dry-run"]), /requires a value/);
  assert.throws(() => parseSetupArgs(["--migrate-legacy-hook"]), /requires a value/);
  assert.throws(() => parseUninstallArgs(["--codex-home"]), /requires a value/);
  assert.throws(() => parseUninstallArgs(["--codex-home", "--purge"]), /requires a value/);
  assert.throws(
    () => parseSetupArgs(["--plugin", "--codex-home", "/tmp/custom-plugin-home"]),
    /plugin.*CODEX_HOME|CODEX_HOME.*plugin/i,
  );
  await assert.rejects(
    setup({ codexHome: "relative-home", dryRun: true }),
    (error) => error.code === "INVALID_CODEX_HOME",
  );
  await assert.rejects(
    uninstall({ codexHome: "relative-home" }),
    (error) => error.code === "INVALID_CODEX_HOME",
  );

  const setupScript = path.resolve("scripts/setup.mjs");
  const uninstallScript = path.resolve("scripts/uninstall.mjs");
  await assert.rejects(
    execFileAsync(process.execPath, [setupScript, "--dry-run", "--codex-home"]),
    (error) => error.code === 1 && /requires a value/.test(error.stderr),
  );
  await assert.rejects(
    execFileAsync(process.execPath, [uninstallScript, "--codex-home"]),
    (error) => error.code === 1 && /requires a value/.test(error.stderr),
  );
});

test("plugin setup rejects a CODEX_HOME that the runtime will not inherit", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-plugin-custom-home-"));
  try {
    await assert.rejects(
      setup({ codexHome, mode: "plugin" }),
      (error) => error.code === "PLUGIN_CODEX_HOME_MISMATCH",
    );
    const installed = await setup(
      { codexHome, mode: "plugin" },
      { runtimeCodexHome: codexHome },
    );
    assert.equal(installed.configPath, path.join(codexHome, "sidebar-flow", "config.json"));
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("setup parses explicit event-wake configuration and rejects unsafe values", () => {
  assert.deepEqual(parseSetupArgs([
    "--enable-event-wake",
    "--organizer-thread-id", "organizer-123",
    "--organizer-host-id", "remote-control:env_123",
    "--event-wake-max-per-minute", "7",
  ]), {
    dryRun: false,
    migrateLegacyHookPaths: [],
    enableEventWake: true,
    organizerThreadId: "organizer-123",
    organizerHostId: "remote-control:env_123",
    eventWakeMaxPerMinute: 7,
  });
  for (const argv of [
    ["--enable-event-wake"],
    ["--enable-event-wake", "--organizer-thread-id", "--plugin"],
    ["--enable-event-wake", "--organizer-thread-id", "bad\nid"],
    ["--enable-event-wake", "--organizer-thread-id", "organizer", "--organizer-host-id", "bad host"],
    ["--enable-event-wake", "--organizer-thread-id", "organizer", "--event-wake-max-per-minute", "0"],
    ["--enable-event-wake", "--organizer-thread-id", "organizer", "--event-wake-max-per-minute", "1.5"],
  ]) {
    assert.throws(() => parseSetupArgs(argv), /organizer|requires|invalid|positive integer/i);
  }
});

test("default configuration keeps event wake disabled with private runtime paths", () => {
  const codexHome = "/tmp/sidebar-flow-default-config";
  const runtime = path.join(codexHome, "sidebar-flow");
  const config = defaultConfig(codexHome, "source", "a".repeat(64));
  assert.deepEqual(config.eventWake, {
    enabled: false,
    organizerThreadId: null,
    organizerHostId: "local",
    maxPerMinute: 20,
  });
  assert.equal(config.wakeStateFile, path.join(runtime, "wake-state.json"));
  assert.equal(config.eventWakeProbeRequestFile, path.join(runtime, "event-wake-probe-request.json"));
  assert.equal(config.eventWakeProbeResultFile, path.join(runtime, "event-wake-probe-result.json"));
  assert.equal(config.eventWakeProbeTtlMs, 300000);
  assert.equal(config.configVersion, 2);
  assert.equal(config.hookDeadlineMs, 14000);
  assert.equal(config.stopSettleDelayMs, 3000);
});

test("setup rejects invalid event-wake options before filesystem mutation", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-invalid-options-"));
  const codexHome = path.join(parent, "not-created");
  try {
    await assert.rejects(
      setup({ codexHome, enableEventWake: true, organizerThreadId: "bad\nid" }),
      /organizerThreadId/i,
    );
    await assert.rejects(stat(codexHome), /ENOENT/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("setup requires a present probe bound to the exact mode and runtime before enabling event wake", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-event-config-"));
  const runtime = path.join(codexHome, "sidebar-flow");
  const configPath = path.join(runtime, "config.json");
  try {
    await mkdir(runtime, { recursive: true });
    await writeFile(configPath, `${JSON.stringify({
      installMode: "source",
      sections: { inProgress: "Doing", forReview: "Review", forLater: "Later" },
      excludeThreadIds: ["keep-excluded"],
      eventWake: {
        enabled: true,
        organizerThreadId: "old-organizer",
        organizerHostId: "local",
        maxPerMinute: 20,
      },
      unrelated: { keep: true },
    })}\n`, { mode: 0o600 });
    const beforeRejectedEnable = await readFile(configPath, "utf8");

    await assert.rejects(
      setup({
        codexHome,
        enableEventWake: true,
        organizerThreadId: "organizer-123",
        organizerHostId: "remote-control:env_123",
        eventWakeMaxPerMinute: 7,
      }),
      (error) => error.code === "CAPABILITY_PROBE_REQUIRED",
    );
    assert.equal(await readFile(configPath, "utf8"), beforeRejectedEnable);
    await assert.rejects(stat(path.join(codexHome, "hooks.json")), (error) => error.code === "ENOENT");
    await setup({ codexHome });
    const upgraded = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(upgraded.eventWake.enabled, false);
    assert.equal(upgraded.installMode, "source");
    assert.match(upgraded.runtimeFingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(upgraded.unrelated, { keep: true });
    await recordPresentProbe(upgraded, runtime, {
      armedAt: 1_000,
      probeId: "probe-setup-expired",
    });
    const beforeExpiredEnable = await readFile(configPath, "utf8");
    await assert.rejects(
      setup({
        codexHome,
        enableEventWake: true,
        organizerThreadId: "organizer-expired",
      }),
      (error) => error.code === "CAPABILITY_PROBE_REQUIRED",
    );
    assert.equal(await readFile(configPath, "utf8"), beforeExpiredEnable);
    await recordPresentProbe(upgraded, runtime);

    await setup({
      codexHome,
      enableEventWake: true,
      organizerThreadId: "organizer-123",
      organizerHostId: "remote-control:env_123",
      eventWakeMaxPerMinute: 7,
    });
    const once = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(once.eventWake, {
      enabled: true,
      organizerThreadId: "organizer-123",
      organizerHostId: "remote-control:env_123",
      maxPerMinute: 7,
    });
    assert.deepEqual(once.excludeThreadIds, ["keep-excluded", "old-organizer", "organizer-123"]);
    assert.deepEqual(once.unrelated, { keep: true });
    assert.equal((await stat(path.join(runtime, "releases", once.runtimeFingerprint, "scripts", "event-wake.mjs"))).isFile(), true);

    await setup({
      codexHome,
      enableEventWake: true,
      organizerThreadId: "organizer-456",
    });
    const rerun = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(rerun.eventWake, {
      enabled: true,
      organizerThreadId: "organizer-456",
      organizerHostId: "remote-control:env_123",
      maxPerMinute: 7,
    });
    assert.deepEqual(rerun.excludeThreadIds, ["keep-excluded", "old-organizer", "organizer-123", "organizer-456"]);

    await setup({ codexHome });
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), rerun);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("source setup publishes immutable fingerprinted releases before changing hooks", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-release-publish-"));
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-runtime-fixture-"));
  const sourceRoot = path.resolve(".");
  try {
    await copyRuntimeFixture(sourceRoot, fixtureRoot);
    const first = await setup({ codexHome }, { sourceRoot: fixtureRoot });
    const firstHooks = await readFile(first.hooksPath, "utf8");
    const firstFingerprint = await expectedRuntimeFingerprint(fixtureRoot);
    assert.equal(first.runtimeFingerprint, firstFingerprint);
    assert.equal(first.releaseRoot, path.join(codexHome, "sidebar-flow", "releases", firstFingerprint));
    assert.equal((await lstat(first.releaseRoot)).isSymbolicLink(), false);
    assert.equal(firstHooks.includes(first.configPath), true);
    for (const relativePath of sourceRuntimeFiles) {
      assert.equal((await stat(path.join(first.releaseRoot, relativePath))).isFile(), true);
    }
    assert.equal(firstHooks.includes(path.join(first.releaseRoot, "scripts", "sidebar-hook.mjs")), true);

    await writeFile(path.join(fixtureRoot, "scripts", "sidebar-hook.mjs"), "\n// changed runtime\n", { flag: "a" });
    let copies = 0;
    await assert.rejects(
      setup({ codexHome }, {
        sourceRoot: fixtureRoot,
        async copyRuntimeFile(source, destination) {
          copies += 1;
          if (copies === 3) throw new Error("injected staging failure");
          await copyFile(source, destination);
        },
      }),
      /injected staging failure/,
    );
    assert.equal(await readFile(first.hooksPath, "utf8"), firstHooks);
    for (const relativePath of sourceRuntimeFiles) {
      assert.equal((await stat(path.join(first.releaseRoot, relativePath))).isFile(), true);
    }

    const second = await setup({ codexHome }, { sourceRoot: fixtureRoot });
    assert.notEqual(second.runtimeFingerprint, firstFingerprint);
    assert.equal((await lstat(second.releaseRoot)).isSymbolicLink(), false);
    assert.deepEqual(
      (await readdir(path.join(codexHome, "sidebar-flow", "releases")))
        .filter((name) => /^[a-f0-9]{64}$/.test(name))
        .sort(),
      [firstFingerprint, second.runtimeFingerprint].sort(),
    );
  } finally {
    await rm(codexHome, { recursive: true, force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("source setup refuses a symlinked releases root", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-release-link-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-release-outside-"));
  const runtimeRoot = path.join(codexHome, "sidebar-flow");
  try {
    const fingerprint = await expectedRuntimeFingerprint(path.resolve("."));
    await copyRuntimeFixture(path.resolve("."), path.join(outside, fingerprint));
    const outsideBefore = await readdir(outside);
    await mkdir(runtimeRoot, { recursive: true });
    await symlink(outside, path.join(runtimeRoot, "releases"));
    await assert.rejects(
      setup({ codexHome }),
      /release.*real directory|symlink/i,
    );
    assert.deepEqual(await readdir(outside), outsideBefore);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("setup and uninstall reject a symlinked runtime root without touching its target", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-runtime-link-home-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-runtime-link-outside-"));
  const runtimeRoot = path.join(codexHome, "sidebar-flow");
  const sentinel = path.join(outside, "sentinel.txt");
  try {
    await mkdir(path.join(outside, "scripts"), { recursive: true });
    await writeFile(sentinel, "keep\n", { mode: 0o600 });
    await symlink(outside, runtimeRoot);
    await assert.rejects(
      setupPluginForTest(codexHome),
      (error) => error.code === "UNSAFE_RUNTIME_DIRECTORY",
    );
    await assert.rejects(
      uninstall({ codexHome, mode: "plugin", purge: true }),
      (error) => error.code === "UNSAFE_RUNTIME_DIRECTORY",
    );
    assert.equal(await readFile(sentinel, "utf8"), "keep\n");
    await assert.rejects(stat(path.join(outside, "config.json")), /ENOENT/);
  } finally {
    await rm(runtimeRoot, { force: true });
    await rm(codexHome, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("setup rejects configured destinations that use built-in section names", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-invalid-sections-"));
  const runtimeRoot = path.join(codexHome, "sidebar-flow");
  const configPath = path.join(runtimeRoot, "config.json");
  try {
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(configPath, `${JSON.stringify({
      sections: { inProgress: "Pinned", forReview: "Review", forLater: "Later" },
    })}\n`, { mode: 0o600 });
    await assert.rejects(
      setupPluginForTest(codexHome),
      (error) => error.code === "INVALID_SECTION_CONFIG",
    );
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).sections.inProgress, "Pinned");
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("upgrading a v0.1 configuration adds disabled event wake defaults", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-v01-upgrade-"));
  const runtime = path.join(codexHome, "sidebar-flow");
  const configPath = path.join(runtime, "config.json");
  try {
    await mkdir(runtime, { recursive: true });
    await writeFile(configPath, `${JSON.stringify({
      installMode: "plugin",
      sections: { inProgress: "In Progress", forReview: "For Review", forLater: "For Later" },
      excludeThreadIds: [],
      hookDeadlineMs: 9000,
      stopSettleDelayMs: 500,
      custom: "preserved",
    })}\n`, { mode: 0o600 });
    await setupPluginForTest(codexHome);
    const upgraded = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(upgraded.eventWake.enabled, false);
    assert.equal(upgraded.eventWake.organizerThreadId, null);
    assert.equal(upgraded.configVersion, 2);
    assert.equal(upgraded.hookDeadlineMs, 14000);
    assert.equal(upgraded.stopSettleDelayMs, 3000);
    assert.equal(upgraded.custom, "preserved");
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("timing migration preserves explicit non-legacy overrides", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-custom-timing-upgrade-"));
  const runtime = path.join(codexHome, "sidebar-flow");
  const configPath = path.join(runtime, "config.json");
  try {
    await mkdir(runtime, { recursive: true });
    await writeFile(configPath, `${JSON.stringify({
      installMode: "plugin",
      hookDeadlineMs: 18000,
      stopSettleDelayMs: 4500,
    })}\n`, { mode: 0o600 });
    await setupPluginForTest(codexHome);
    const upgraded = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(upgraded.configVersion, 2);
    assert.equal(upgraded.hookDeadlineMs, 18000);
    assert.equal(upgraded.stopSettleDelayMs, 4500);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("setup preserves timing owned by a future config version", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-future-config-"));
  const runtime = path.join(codexHome, "sidebar-flow");
  const configPath = path.join(runtime, "config.json");
  try {
    await mkdir(runtime, { recursive: true });
    await writeFile(configPath, `${JSON.stringify({
      configVersion: 3,
      installMode: "plugin",
      hookDeadlineMs: 9000,
      stopSettleDelayMs: 500,
    })}\n`, { mode: 0o600 });
    await setupPluginForTest(codexHome);
    const upgraded = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(upgraded.configVersion, 3);
    assert.equal(upgraded.hookDeadlineMs, 9000);
    assert.equal(upgraded.stopSettleDelayMs, 500);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("setup is idempotent and preserves unrelated hooks", () => {
  const existing = {
    hooks: { Stop: [{ hooks: [{ type: "command", command: "echo keep" }] }] },
  };
  const once = installHooks(existing, ownedCommand);
  const twice = installHooks(once, ownedCommand);
  assert.equal(twice.hooks.Stop.length, 2);
  assert.equal(twice.hooks.UserPromptSubmit.length, 1);
  assert.equal(twice.hooks.Stop[0].hooks[0].command, "echo keep");
  assert.equal(twice.hooks.UserPromptSubmit.at(-1).hooks[0].async, undefined);
  assert.equal(twice.hooks.UserPromptSubmit.at(-1).hooks[0].timeout, 15);
  assert.equal(twice.hooks.Stop.at(-1).hooks[0].async, true);
  assert.equal(twice.hooks.Stop.at(-1).hooks[0].timeout, 20);
});

test("uninstall removes only Sidebar Flow hooks", () => {
  const installed = installHooks(
    { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo keep" }] }] } },
    ownedCommand,
  );
  const removed = removeHooks(installed);
  assert.equal(removed.hooks.Stop.length, 1);
  assert.equal(removed.hooks.Stop[0].hooks[0].command, "echo keep");
  assert.equal(removed.hooks.UserPromptSubmit, undefined);
});

test("install and uninstall preserve unrelated handlers in a mixed matcher", () => {
  const mixed = {
    hooks: {
      Stop: [{ hooks: [
        { type: "command", command: "echo keep" },
        { type: "command", command: "node /third-party/scripts/sidebar-hook.mjs" },
      ] }],
    },
  };
  const installed = installHooks(mixed, `${HOOK_MARKER} node /new/scripts/sidebar-hook.mjs`);
  const stopCommands = installed.hooks.Stop.flatMap((matcher) => matcher.hooks.map((hook) => hook.command));
  assert.deepEqual(stopCommands, [
    "echo keep",
    "node /third-party/scripts/sidebar-hook.mjs",
    `${HOOK_MARKER} node /new/scripts/sidebar-hook.mjs`,
  ]);
  const removed = removeHooks(installed);
  assert.deepEqual(
    removed.hooks.Stop.flatMap((matcher) => matcher.hooks.map((hook) => hook.command)),
    ["echo keep", "node /third-party/scripts/sidebar-hook.mjs"],
  );
});

test("setup preserves the original backup across reruns", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-setup-"));
  try {
    await mkdir(codexHome, { recursive: true });
    const hooksPath = path.join(codexHome, "hooks.json");
    const original = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo original"}]}]}}\n';
    await writeFile(hooksPath, original, { mode: 0o600 });
    const installed = await setup({ codexHome });
    await setup({ codexHome });
    assert.equal(await readFile(`${hooksPath}.sidebar-flow.bak`, "utf8"), original);
    assert.equal((await stat(`${hooksPath}.sidebar-flow.bak`)).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(installed.releaseRoot, "scripts", "sidebar-hook.mjs"))).isFile(), true);
    assert.equal((await stat(path.join(installed.releaseRoot, "scripts", "uninstall.mjs"))).isFile(), true);
    assert.equal(JSON.parse(await readFile(path.join(codexHome, "sidebar-flow", "config.json"), "utf8")).installMode, "source");
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("source setup migrates the standard unmarked Hook and uninstall removes it", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-legacy-standard-"));
  try {
    const hooksPath = path.join(codexHome, "hooks.json");
    const legacyPath = path.join(codexHome, "sidebar-flow", "scripts", "sidebar-hook.mjs");
    const legacyCommand = `node '${legacyPath}'`;
    await writeFile(hooksPath, `${JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: legacyCommand }] }],
        Stop: [{ hooks: [{ type: "command", command: legacyCommand }] }],
      },
    })}\n`, { mode: 0o600 });

    await setup({ codexHome, mode: "source" });
    const installed = JSON.parse(await readFile(hooksPath, "utf8"));
    for (const event of ["UserPromptSubmit", "Stop"]) {
      const commands = installed.hooks[event].flatMap((matcher) =>
        matcher.hooks.map((hook) => hook.command));
      assert.equal(commands.filter((command) => command.includes(HOOK_MARKER)).length, 1);
      assert.equal(commands.filter((command) => command === legacyCommand).length, 0);
    }
    assert.deepEqual(findUnmarkedSidebarHookPaths(installed), []);

    await uninstall({ codexHome, mode: "source" });
    const uninstalled = JSON.parse(await readFile(hooksPath, "utf8"));
    assert.equal(uninstalled.hooks?.UserPromptSubmit, undefined);
    assert.equal(uninstalled.hooks?.Stop, undefined);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("plugin setup refuses the standard unmarked source Hook", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-legacy-plugin-"));
  try {
    const hooksPath = path.join(codexHome, "hooks.json");
    const legacyPath = path.join(codexHome, "sidebar-flow", "scripts", "sidebar-hook.mjs");
    await writeFile(hooksPath, `${JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: `node '${legacyPath}'` }] }] },
    })}\n`, { mode: 0o600 });
    await assert.rejects(
      setupPluginForTest(codexHome),
      (error) => error.code === "INSTALL_MODE_CONFLICT",
    );
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("setup fails closed on an unknown legacy Hook unless its exact path is authorized", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-legacy-explicit-"));
  try {
    const hooksPath = path.join(codexHome, "hooks.json");
    const legacyPath = "/opt/old-sidebar-flow/scripts/sidebar-hook.mjs";
    const unrelated = "echo keep";
    await writeFile(hooksPath, `${JSON.stringify({
      hooks: { Stop: [{ hooks: [
        { type: "command", command: unrelated },
        { type: "command", command: `node '${legacyPath}'` },
      ] }] },
    })}\n`, { mode: 0o600 });

    await assert.rejects(
      setup({ codexHome, mode: "source" }),
      (error) => error.code === "LEGACY_HOOK_CONFLICT" && error.paths.includes(legacyPath),
    );
    await setup({ codexHome, mode: "source", migrateLegacyHookPaths: [legacyPath] });
    const installed = JSON.parse(await readFile(hooksPath, "utf8"));
    const commands = installed.hooks.Stop.flatMap((matcher) =>
      matcher.hooks.map((hook) => hook.command));
    assert.equal(commands.includes(unrelated), true);
    assert.equal(commands.some((command) => command.includes(legacyPath) && !command.includes(HOOK_MARKER)), false);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("plugin setup creates configuration without global hooks", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-plugin-"));
  try {
    const result = await setupPluginForTest(codexHome);
    assert.equal(result.mode, "plugin");
    const config = JSON.parse(await readFile(result.configPath, "utf8"));
    assert.equal(config.allowSocketDiscovery, false);
    assert.equal(config.installMode, "plugin");
    assert.equal(config.runtimeFingerprint, await expectedRuntimeFingerprint(path.resolve("."), "plugin"));
    await assert.rejects(readFile(path.join(codexHome, "hooks.json"), "utf8"), /ENOENT/);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("plugin to source migration requires uninstalling plugin mode first", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-plugin-source-"));
  try {
    await setupPluginForTest(codexHome);
    await assert.rejects(setup({ codexHome, mode: "source" }), /installed in plugin mode/);
    await uninstall({ codexHome, mode: "plugin" });
    await setup({ codexHome, mode: "source" });
    const config = JSON.parse(await readFile(path.join(codexHome, "sidebar-flow", "config.json"), "utf8"));
    assert.equal(config.installMode, "source");
    assert.equal((await readFile(path.join(codexHome, "hooks.json"), "utf8")).includes("sidebar-hook.mjs"), true);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("source to plugin migration removes source hooks before plugin setup", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-source-plugin-"));
  try {
    await setup({ codexHome, mode: "source" });
    await assert.rejects(setupPluginForTest(codexHome), /installed in source mode/);
    await assert.rejects(uninstall({ codexHome, mode: "plugin", purge: true }), /installed in source mode/);
    await uninstall({ codexHome, mode: "source" });
    await setupPluginForTest(codexHome);
    const config = JSON.parse(await readFile(path.join(codexHome, "sidebar-flow", "config.json"), "utf8"));
    assert.equal(config.installMode, "plugin");
    assert.equal((await readFile(path.join(codexHome, "hooks.json"), "utf8")).includes("sidebar-hook.mjs"), false);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("plugin uninstall never edits global hooks", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-plugin-uninstall-"));
  try {
    const hooksPath = path.join(codexHome, "hooks.json");
    const original = '{"hooks":{"Stop":[{"hooks":[{"command":"echo keep"}]}]}}\n';
    await writeFile(hooksPath, original, { mode: 0o600 });
    await uninstall({ codexHome, mode: "plugin", purge: true });
    assert.equal(await readFile(hooksPath, "utf8"), original);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("normal uninstall keeps configuration and wake state while purge removes the runtime", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-uninstall-state-"));
  const runtime = path.join(codexHome, "sidebar-flow");
  try {
    await setup({ codexHome, mode: "source" });
    for (const name of ["wake-state.json", "event-wake-probe-request.json", "event-wake-probe-result.json"]) {
      await writeFile(path.join(runtime, name), "{}\n", { mode: 0o600 });
    }
    await uninstall({ codexHome, mode: "source" });
    const retainedConfig = JSON.parse(await readFile(path.join(runtime, "config.json"), "utf8"));
    assert.equal(retainedConfig.eventWake.enabled, false);
    assert.equal(Object.hasOwn(retainedConfig, "installMode"), false);
    assert.equal(Object.hasOwn(retainedConfig, "runtimeFingerprint"), false);
    assert.equal((await stat(path.join(runtime, "config.json"))).isFile(), true);
    assert.equal((await stat(path.join(runtime, "wake-state.json"))).isFile(), true);
    assert.equal((await stat(path.join(runtime, "event-wake-probe-request.json"))).isFile(), true);
    assert.equal((await stat(path.join(runtime, "event-wake-probe-result.json"))).isFile(), true);

    await setup({ codexHome, mode: "source" });
    await uninstall({ codexHome, mode: "source", purge: true });
    await assert.rejects(stat(runtime), /ENOENT/);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("installed uninstaller runs through the macOS /tmp symlink", async () => {
  const codexHome = await mkdtemp("/tmp/sidebar-flow-installed-cli-");
  try {
    const installed = await setup({ codexHome, mode: "source" });
    const installedUninstaller = path.join(installed.releaseRoot, "scripts", "uninstall.mjs");
    await execFileAsync(process.execPath, [installedUninstaller, "--codex-home", codexHome, "--purge"]);
    await assert.rejects(stat(path.join(codexHome, "sidebar-flow")), /ENOENT/);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});
