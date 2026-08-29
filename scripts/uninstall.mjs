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
  if (typeof codexHome !== "string" || /[\r\n]/.test(codexHome) || !path.isAbsolute(codexHome)) {
    const error = new Error(`CODEX_HOME must be an absolute path: ${codexHome}`);
    error.code = "INVALID_CODEX_HOME";
    throw error;
  }
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

function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 4096
    || /[\r\n]/.test(value)
    || value.startsWith("-")
  ) {
    const error = new Error(`${option} requires a value`);
    error.code = "INVALID_ARGUMENT";
    throw error;
  }
  return value;
}

export function parseUninstallArgs(argv) {
  const result = { purge: false, mode: "source" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--purge") result.purge = true;
    else if (argv[index] === "--plugin") result.mode = "plugin";
    else if (argv[index] === "--codex-home") {
      result.codexHome = optionValue(argv, index, "--codex-home");
      index += 1;
    } else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return result;
}

if (process.argv[1] != null && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  let options;
  try {
    options = parseUninstallArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`uninstall failed: ${error.message}\n`);
    process.exitCode = 1;
  }
  if (options != null) uninstall(options)
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`uninstall failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
