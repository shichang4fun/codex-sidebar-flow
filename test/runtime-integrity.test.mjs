import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { computeRuntimeFingerprint } from "../scripts/runtime-integrity.mjs";

const sourceRuntimeFiles = [
  "scripts/doctor.mjs",
  "scripts/event-wake.mjs",
  "scripts/runtime-integrity.mjs",
  "scripts/setup.mjs",
  "scripts/sidebar-agent-context.mjs",
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

async function writeFixture(root) {
  for (const relativePath of pluginRuntimeFiles) {
    const filePath = path.join(root, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${relativePath}\n`, { mode: 0o600 });
  }
}

test("runtime fingerprints cover the exact source and plugin execution chains", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sidebar-flow-runtime-mode-"));
  try {
    await writeFixture(root);
    const sourceBefore = await computeRuntimeFingerprint(root, "source");
    const pluginBefore = await computeRuntimeFingerprint(root, "plugin");
    assert.notEqual(pluginBefore, sourceBefore);

    await writeFile(path.join(root, ".codex-plugin/plugin.json"), "changed plugin manifest\n");
    assert.equal(await computeRuntimeFingerprint(root, "source"), sourceBefore);
    assert.notEqual(await computeRuntimeFingerprint(root, "plugin"), pluginBefore);

    await writeFile(path.join(root, "scripts/sidebar-hook.mjs"), "changed shared runtime\n");
    assert.notEqual(await computeRuntimeFingerprint(root, "source"), sourceBefore);
    assert.notEqual(await computeRuntimeFingerprint(root, "plugin"), pluginBefore);
    await assert.rejects(computeRuntimeFingerprint(root, "unknown"), /mode/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release metadata uses one version", async () => {
  const version = (await readFile("VERSION", "utf8")).trim();
  const packageMetadata = JSON.parse(await readFile("package.json", "utf8"));
  const pluginMetadata = JSON.parse(await readFile(".codex-plugin/plugin.json", "utf8"));
  const changelog = await readFile("CHANGELOG.md", "utf8");
  assert.equal(packageMetadata.version, version);
  assert.equal(pluginMetadata.version, version);
  assert.equal(changelog.includes(`## [${version}]`), true);
});

test("plugin runs Stop in the background while UserPromptSubmit stays synchronous", async () => {
  const hookConfig = JSON.parse(await readFile("hooks/hooks.json", "utf8"));
  const userPromptSubmit = hookConfig.hooks.UserPromptSubmit.at(-1).hooks.at(-1);
  const stop = hookConfig.hooks.Stop.at(-1).hooks.at(-1);
  assert.equal(userPromptSubmit.async, undefined);
  assert.equal(userPromptSubmit.timeout, 15);
  assert.equal(stop.async, true);
  assert.equal(stop.timeout, 20);
});
