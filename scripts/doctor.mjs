#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOOK_MARKER } from "./setup.mjs";

export function inspectInstallation({ hooks, config, platform = process.platform, pipePath } = {}) {
  const checks = [];
  checks.push({
    level: platform === "darwin" ? "ok" : "warning",
    name: "platform",
    message: platform === "darwin" ? "macOS detected" : "Desktop adapter is only verified on macOS",
  });
  const names = Object.values(config?.sections ?? {});
  const configValid = names.length === 3 && names.every(Boolean) && new Set(names).size === 3;
  checks.push({
    level: configValid ? "ok" : "error",
    name: "config",
    message: configValid ? "Section configuration is valid" : "Three unique section names are required",
  });
  for (const event of ["UserPromptSubmit", "Stop"]) {
    const installed = (hooks?.hooks?.[event] ?? []).some((matcher) =>
      (matcher.hooks ?? []).some((hook) => hook.command?.includes(HOOK_MARKER)),
    );
    checks.push({
      level: installed ? "ok" : "error",
      name: `hook:${event}`,
      message: installed ? "Installed" : "Missing",
    });
  }
  checks.push({
    level: pipePath ? "ok" : "info",
    name: "desktop-pipe",
    message: pipePath ? "Trusted pipe environment is present" : "Expected to be absent outside a Codex hook/task",
  });
  return checks;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const homeIndex = process.argv.indexOf("--codex-home");
  const codexHome = homeIndex === -1
    ? process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
    : process.argv[homeIndex + 1];
  const [hooks, config] = await Promise.all([
    readJson(path.join(codexHome, "hooks.json")).catch(() => ({})),
    readJson(path.join(codexHome, "sidebar-flow", "config.json")).catch(() => ({})),
  ]);
  const checks = inspectInstallation({ hooks, config, pipePath: process.env.CODEX_APP_TOOLS_PIPE_PATH });
  process.stdout.write(`${JSON.stringify({ checks }, null, 2)}\n`);
  if (checks.some((check) => check.level === "error")) process.exitCode = 1;
}
