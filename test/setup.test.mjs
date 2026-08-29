import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  findUnmarkedSidebarHookPaths,
  HOOK_MARKER,
  installHooks,
  removeHooks,
  setup,
} from "../scripts/setup.mjs";
import { uninstall } from "../scripts/uninstall.mjs";

const ownedCommand = `${HOOK_MARKER} node /repo/scripts/sidebar-hook.mjs`;
const execFileAsync = promisify(execFile);

test("setup is idempotent and preserves unrelated hooks", () => {
  const existing = {
    hooks: { Stop: [{ hooks: [{ type: "command", command: "echo keep" }] }] },
  };
  const once = installHooks(existing, ownedCommand);
  const twice = installHooks(once, ownedCommand);
  assert.equal(twice.hooks.Stop.length, 2);
  assert.equal(twice.hooks.UserPromptSubmit.length, 1);
  assert.equal(twice.hooks.Stop[0].hooks[0].command, "echo keep");
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
    await setup({ codexHome });
    await setup({ codexHome });
    assert.equal(await readFile(`${hooksPath}.sidebar-flow.bak`, "utf8"), original);
    assert.equal((await stat(`${hooksPath}.sidebar-flow.bak`)).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(codexHome, "sidebar-flow", "scripts", "sidebar-hook.mjs"))).isFile(), true);
    assert.equal((await stat(path.join(codexHome, "sidebar-flow", "scripts", "uninstall.mjs"))).isFile(), true);
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
      setup({ codexHome, mode: "plugin" }),
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
    const result = await setup({ codexHome, mode: "plugin" });
    assert.equal(result.mode, "plugin");
    const config = JSON.parse(await readFile(result.configPath, "utf8"));
    assert.equal(config.allowSocketDiscovery, false);
    assert.equal(config.installMode, "plugin");
    await assert.rejects(readFile(path.join(codexHome, "hooks.json"), "utf8"), /ENOENT/);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("plugin to source migration requires uninstalling plugin mode first", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-plugin-source-"));
  try {
    await setup({ codexHome, mode: "plugin" });
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
    await assert.rejects(setup({ codexHome, mode: "plugin" }), /installed in source mode/);
    await assert.rejects(uninstall({ codexHome, mode: "plugin", purge: true }), /installed in source mode/);
    await uninstall({ codexHome, mode: "source" });
    await setup({ codexHome, mode: "plugin" });
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

test("installed uninstaller runs through the macOS /tmp symlink", async () => {
  const codexHome = await mkdtemp("/tmp/sidebar-flow-installed-cli-");
  try {
    await setup({ codexHome, mode: "source" });
    const installedUninstaller = path.join(codexHome, "sidebar-flow", "scripts", "uninstall.mjs");
    await execFileAsync(process.execPath, [installedUninstaller, "--codex-home", codexHome, "--purge"]);
    await assert.rejects(stat(path.join(codexHome, "sidebar-flow")), /ENOENT/);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});
