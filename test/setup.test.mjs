import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installHooks, removeHooks, setup } from "../scripts/setup.mjs";
import { uninstall } from "../scripts/uninstall.mjs";

test("setup is idempotent and preserves unrelated hooks", () => {
  const existing = {
    hooks: { Stop: [{ hooks: [{ type: "command", command: "echo keep" }] }] },
  };
  const once = installHooks(existing, "node /repo/scripts/sidebar-hook.mjs");
  const twice = installHooks(once, "node /repo/scripts/sidebar-hook.mjs");
  assert.equal(twice.hooks.Stop.length, 2);
  assert.equal(twice.hooks.UserPromptSubmit.length, 1);
  assert.equal(twice.hooks.Stop[0].hooks[0].command, "echo keep");
});

test("uninstall removes only Sidebar Flow hooks", () => {
  const installed = installHooks(
    { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo keep" }] }] } },
    "node /repo/scripts/sidebar-hook.mjs",
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
        { type: "command", command: "node /old/scripts/sidebar-hook.mjs" },
      ] }],
    },
  };
  const installed = installHooks(mixed, "node /new/scripts/sidebar-hook.mjs");
  const stopCommands = installed.hooks.Stop.flatMap((matcher) => matcher.hooks.map((hook) => hook.command));
  assert.deepEqual(stopCommands, ["echo keep", "node /new/scripts/sidebar-hook.mjs"]);
  const removed = removeHooks(installed);
  assert.deepEqual(
    removed.hooks.Stop.flatMap((matcher) => matcher.hooks.map((hook) => hook.command)),
    ["echo keep"],
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
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("plugin setup creates configuration without global hooks", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-plugin-"));
  try {
    const result = await setup({ codexHome, mode: "plugin" });
    assert.equal(result.mode, "plugin");
    assert.equal(JSON.parse(await readFile(result.configPath, "utf8")).allowSocketDiscovery, false);
    await assert.rejects(readFile(path.join(codexHome, "hooks.json"), "utf8"), /ENOENT/);
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
