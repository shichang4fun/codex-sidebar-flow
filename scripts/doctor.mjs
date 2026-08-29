#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppTools } from "./sidebar-realtime.mjs";
import { detectNodeExecutable, HOOK_MARKER } from "./setup.mjs";

export function inspectInstallation({
  hooks,
  config,
  platform = process.platform,
  pipePath,
  mode = "source",
  nodeExecutable = detectNodeExecutable(),
  runtimeProbe = null,
} = {}) {
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
  if (mode === "source") {
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
  } else {
    checks.push({ level: "ok", name: "hooks", message: "Plugin bundled hooks selected" });
  }
  const bundledNode = existsSync(nodeExecutable) && nodeExecutable.includes("/cua_node/bin/node");
  checks.push({
    level: bundledNode ? "ok" : "warning",
    name: "runtime",
    message: bundledNode ? "Bundled Desktop Node selected" : "Signed bundled Desktop Node was not found",
  });
  checks.push({
    level: runtimeProbe?.ok ? "ok" : "warning",
    name: "runtime-probe",
    message: runtimeProbe?.message ?? (
      pipePath
        ? "Pipe is present, but tools/list and section existence were not probed"
        : "Not verified outside a trusted lifecycle Hook; run a real event acceptance test"
    ),
  });
  return checks;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const homeIndex = process.argv.indexOf("--codex-home");
  const mode = process.argv.includes("--plugin") ? "plugin" : "source";
  const probe = process.argv.includes("--probe");
  const codexHome = homeIndex === -1
    ? process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
    : process.argv[homeIndex + 1];
  const [hooks, config] = await Promise.all([
    readJson(path.join(codexHome, "hooks.json")).catch(() => ({})),
    readJson(path.join(codexHome, "sidebar-flow", "config.json")).catch(() => ({})),
  ]);
  let runtimeProbe = null;
  if (probe) {
    try {
      const appTools = new AppTools({ ...config, actorThreadId: "sidebar-flow-doctor", quiet: true });
      const snapshot = await appTools.listThreads();
      appTools.reset();
      const sectionNames = new Set((snapshot.sections ?? []).map((section) => section.name));
      const missing = Object.values(config.sections ?? {}).filter((name) => !sectionNames.has(name));
      runtimeProbe = missing.length === 0
        ? { ok: true, message: "tools/list succeeded and configured sections exist" }
        : { ok: false, message: `Configured sections are missing: ${missing.join(", ")}` };
    } catch (error) {
      runtimeProbe = { ok: false, message: `Runtime probe failed: ${error.code ?? "APP_TOOLS_UNAVAILABLE"}` };
    }
  }
  const checks = inspectInstallation({
    hooks,
    config,
    mode,
    pipePath: process.env.CODEX_APP_TOOLS_PIPE_PATH,
    runtimeProbe,
  });
  process.stdout.write(`${JSON.stringify({ mode, checks }, null, 2)}\n`);
  if (checks.some((check) => check.level === "error") || runtimeProbe?.ok === false) process.exitCode = 1;
}
