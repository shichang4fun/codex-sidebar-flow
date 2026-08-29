#!/usr/bin/env node

import { readFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasOwnedHooks, removeHooks, writeJsonAtomic } from "./setup.mjs";

export async function uninstall({
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  purge = false,
  mode = "source",
} = {}) {
  if (!new Set(["source", "plugin"]).has(mode)) throw new Error(`Unknown uninstall mode: ${mode}`);
  const hooksPath = path.join(codexHome, "hooks.json");
  const configPath = path.join(codexHome, "sidebar-flow", "config.json");
  const legacyHookPath = path.join(codexHome, "sidebar-flow", "scripts", "sidebar-hook.mjs");
  let hooks = {};
  let config = null;
  try {
    hooks = JSON.parse(await readFile(hooksPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const installedMode = config?.installMode ?? (hasOwnedHooks(hooks, legacyHookPath) ? "source" : null);
  if (installedMode != null && installedMode !== mode) {
    const error = new Error(
      `Sidebar Flow is installed in ${installedMode} mode; uninstall with ${installedMode} mode`,
    );
    error.code = "INSTALL_MODE_CONFLICT";
    throw error;
  }
  if (mode === "source") {
    await writeJsonAtomic(hooksPath, removeHooks(hooks, legacyHookPath));
  }
  if (purge) {
    await rm(path.join(codexHome, "sidebar-flow"), { recursive: true, force: true });
  } else if (config != null) {
    const { installMode: _installMode, ...remainingConfig } = config;
    await writeJsonAtomic(configPath, remainingConfig);
  }
  return { mode, hooksPath, purged: purge };
}

if (process.argv[1] != null && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const purge = process.argv.includes("--purge");
  const mode = process.argv.includes("--plugin") ? "plugin" : "source";
  const homeIndex = process.argv.indexOf("--codex-home");
  const codexHome = homeIndex === -1 ? undefined : process.argv[homeIndex + 1];
  uninstall({ codexHome, purge, mode })
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`uninstall failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
