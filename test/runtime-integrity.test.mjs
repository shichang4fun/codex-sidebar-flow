import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { computeRuntimeFingerprint } from "../scripts/runtime-integrity.mjs";

const sourceRuntimeFiles = [
  "scripts/doctor.mjs",
  "scripts/event-wake.mjs",
  "scripts/runtime-integrity.mjs",
  "scripts/setup.mjs",
  "scripts/sidebar-hook.mjs",
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
