#!/usr/bin/env node

import { chmod, copyFile, link, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const HOOK_MARKER = "CODEX_SIDEBAR_FLOW_OWNER=codex-sidebar-flow-v1";
export const INSTALL_MODE_ENV = "CODEX_SIDEBAR_FLOW_INSTALL_MODE";

function quote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function detectNodeExecutable() {
  const candidates = [
    process.env.CODEX_SIDEBAR_FLOW_NODE,
    "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
    "/Applications/Codex.app/Contents/Resources/cua_node/bin/node",
    process.execPath,
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? process.execPath;
}

export function hookCommand(root = ROOT, nodeExecutable = detectNodeExecutable()) {
  return `exec /usr/bin/env -u FORCE_COLOR ${HOOK_MARKER} ${INSTALL_MODE_ENV}=source ${quote(nodeExecutable)} ${quote(path.join(root, "scripts", "sidebar-hook.mjs"))}`;
}

function normalizeLegacyHookPaths(paths = []) {
  return [...new Set((Array.isArray(paths) ? paths : [paths])
    .filter((candidate) => typeof candidate === "string" && candidate.length > 0)
    .map((candidate) => path.normalize(candidate)))];
}

function commandContainsExactPath(command, targetPath) {
  if (typeof command !== "string" || typeof targetPath !== "string") return false;
  const escaped = targetPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)(?:"${escaped}"|'${escaped}'|${escaped})(?=\\s|$)`).test(command);
}

function sidebarHookPaths(command) {
  if (typeof command !== "string") return [];
  const matches = [];
  for (const token of command.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []) {
    let candidate = token;
    if ((candidate.startsWith('"') && candidate.endsWith('"'))
      || (candidate.startsWith("'") && candidate.endsWith("'"))) {
      candidate = candidate.slice(1, -1);
    }
    candidate = candidate.replace(/[;&|]+$/, "");
    if (path.isAbsolute(candidate) && path.basename(candidate) === "sidebar-hook.mjs") {
      matches.push(path.normalize(candidate));
    }
  }
  return matches;
}

export function findUnmarkedSidebarHookPaths(existing = {}) {
  const paths = new Set();
  for (const event of ["UserPromptSubmit", "Stop"]) {
    for (const matcher of existing.hooks?.[event] ?? []) {
      for (const hook of matcher?.hooks ?? []) {
        if (typeof hook?.command !== "string" || hook.command.includes(HOOK_MARKER)) continue;
        for (const candidate of sidebarHookPaths(hook.command)) paths.add(candidate);
      }
    }
  }
  return [...paths];
}

function isOwnedHook(hook, legacyHookPaths = []) {
  return typeof hook?.command === "string" && (
    hook.command.includes(HOOK_MARKER)
    || normalizeLegacyHookPaths(legacyHookPaths).some((candidate) =>
      commandContainsExactPath(hook.command, candidate))
  );
}

export function hasOwnedHooks(existing = {}, legacyHookPaths = []) {
  return ["UserPromptSubmit", "Stop"].some((event) =>
    (existing.hooks?.[event] ?? []).some((matcher) =>
      (matcher.hooks ?? []).some((hook) => isOwnedHook(hook, legacyHookPaths)),
    ),
  );
}

function removeOwnedHandlers(matchers, legacyHookPaths = []) {
  return (Array.isArray(matchers) ? matchers : []).flatMap((matcher) => {
    const hooks = (matcher?.hooks ?? []).filter((hook) => !isOwnedHook(hook, legacyHookPaths));
    return hooks.length === 0 ? [] : [{ ...matcher, hooks }];
  });
}

export function installHooks(existing = {}, command = hookCommand(), legacyHookPaths = []) {
  const result = structuredClone(existing);
  result.hooks ??= {};
  for (const event of ["UserPromptSubmit", "Stop"]) {
    const matchers = removeOwnedHandlers(result.hooks[event], legacyHookPaths);
    matchers.push({ hooks: [{ type: "command", command, timeout: 15 }] });
    result.hooks[event] = matchers;
  }
  return result;
}

export function removeHooks(existing = {}, legacyHookPaths = []) {
  const result = structuredClone(existing);
  for (const event of ["UserPromptSubmit", "Stop"]) {
    if (!Array.isArray(result.hooks?.[event])) continue;
    result.hooks[event] = removeOwnedHandlers(result.hooks[event], legacyHookPaths);
    if (result.hooks[event].length === 0) delete result.hooks[event];
  }
  return result;
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, filePath);
}

async function writePrivateBackup(sourcePath, backupPath) {
  if (existsSync(backupPath)) return false;
  const temporaryPath = `${backupPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, await readFile(sourcePath), { mode: 0o600, flag: "wx" });
  try {
    await link(temporaryPath, backupPath);
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return false;
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

export function defaultConfig(codexHome, installMode = null) {
  const runtime = path.join(codexHome, "sidebar-flow");
  return {
    ...(installMode == null ? {} : { installMode }),
    actorThreadId: "codex-sidebar-flow",
    sections: {
      inProgress: "In Progress",
      forReview: "For Review",
      forLater: "For Later",
    },
    excludeThreadIds: [],
    healthFile: path.join(runtime, "health.json"),
    hookLogFile: path.join(runtime, "hook.log"),
    stateFile: path.join(runtime, "state.json"),
    sessionsDir: path.join(codexHome, "sessions"),
    fallbackIntervalMs: 60000,
    listLimit: 50,
    maxMovesPerRun: 10,
    requestTimeoutMs: 15000,
    socketProbeTimeoutMs: 1500,
    discoveryTimeoutMs: 6000,
    maxSocketCandidates: 8,
    allowSocketDiscovery: false,
    hookDeadlineMs: 9000,
    stopSettleDelayMs: 500,
  };
}

export async function setup({
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  dryRun = false,
  mode = "source",
  migrateLegacyHookPaths = [],
} = {}) {
  if (!new Set(["source", "plugin"]).has(mode)) throw new Error(`Unknown setup mode: ${mode}`);
  if (!path.isAbsolute(codexHome)) {
    const error = new Error(`CODEX_HOME must be an absolute path: ${codexHome}`);
    error.code = "INVALID_CODEX_HOME";
    throw error;
  }
  const runtimeRoot = path.join(codexHome, "sidebar-flow");
  const runtimeScripts = path.join(runtimeRoot, "scripts");
  const hooksPath = path.join(codexHome, "hooks.json");
  const backupPath = `${hooksPath}.sidebar-flow.bak`;
  const configPath = path.join(runtimeRoot, "config.json");
  const standardLegacyHookPath = path.join(runtimeScripts, "sidebar-hook.mjs");
  const authorizedLegacyHookPaths = normalizeLegacyHookPaths(migrateLegacyHookPaths);
  for (const candidate of authorizedLegacyHookPaths) {
    if (!path.isAbsolute(candidate) || path.basename(candidate) !== "sidebar-hook.mjs") {
      const error = new Error(`Legacy Hook migration requires an absolute sidebar-hook.mjs path: ${candidate}`);
      error.code = "INVALID_LEGACY_HOOK_PATH";
      throw error;
    }
  }
  const existingHooks = await readJson(hooksPath, {});
  const existingConfig = await readJson(configPath, null);
  const ownedLegacyHookPaths = normalizeLegacyHookPaths([
    standardLegacyHookPath,
    ...authorizedLegacyHookPaths,
  ]);
  const allowedLegacyHookPaths = new Set(ownedLegacyHookPaths);
  const legacyHookConflicts = findUnmarkedSidebarHookPaths(existingHooks)
    .filter((candidate) => !allowedLegacyHookPaths.has(candidate));
  if (legacyHookConflicts.length > 0) {
    const error = new Error(
      `Unowned legacy sidebar Hook detected: ${legacyHookConflicts.join(", ")}. `
      + "Review it, then pass --migrate-legacy-hook with that exact absolute path if it belongs to Sidebar Flow.",
    );
    error.code = "LEGACY_HOOK_CONFLICT";
    error.paths = legacyHookConflicts;
    throw error;
  }
  const installedMode = existingConfig?.installMode ?? (
    hasOwnedHooks(existingHooks, ownedLegacyHookPaths) ? "source" : null
  );
  if (installedMode != null && installedMode !== mode) {
    const error = new Error(
      `Sidebar Flow is installed in ${installedMode} mode; uninstall that mode before installing ${mode} mode`,
    );
    error.code = "INSTALL_MODE_CONFLICT";
    throw error;
  }
  if (mode === "plugin" && hasOwnedHooks(existingHooks, ownedLegacyHookPaths)) {
    const error = new Error("Source hooks are still installed; run source uninstall before plugin setup");
    error.code = "MIXED_INSTALLATION";
    throw error;
  }
  const hooks = mode === "source"
    ? installHooks(existingHooks, hookCommand(runtimeRoot), ownedLegacyHookPaths)
    : null;
  if (!dryRun) {
    if (mode === "source") {
      await mkdir(runtimeScripts, { recursive: true, mode: 0o700 });
      await Promise.all([
        copyFile(path.join(ROOT, "scripts", "sidebar-hook.mjs"), path.join(runtimeScripts, "sidebar-hook.mjs")),
        copyFile(path.join(ROOT, "scripts", "sidebar-realtime.mjs"), path.join(runtimeScripts, "sidebar-realtime.mjs")),
        copyFile(path.join(ROOT, "scripts", "setup.mjs"), path.join(runtimeScripts, "setup.mjs")),
        copyFile(path.join(ROOT, "scripts", "uninstall.mjs"), path.join(runtimeScripts, "uninstall.mjs")),
        copyFile(path.join(ROOT, "scripts", "doctor.mjs"), path.join(runtimeScripts, "doctor.mjs")),
      ]);
      if (existsSync(hooksPath)) await writePrivateBackup(hooksPath, backupPath);
      await writeJsonAtomic(hooksPath, hooks);
    }
    await writeJsonAtomic(configPath, {
      ...(existingConfig ?? defaultConfig(codexHome, mode)),
      installMode: mode,
    });
    if (mode === "plugin") await rm(runtimeScripts, { recursive: true, force: true });
  }
  return {
    mode,
    hooksPath,
    backupPath,
    configPath,
    runtimeRoot,
    dryRun,
    migratedLegacyHookPaths: authorizedLegacyHookPaths,
    nodeExecutable: detectNodeExecutable(),
  };
}

function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
    const error = new Error(`${option} requires a value`);
    error.code = "INVALID_ARGUMENT";
    throw error;
  }
  return value;
}

export function parseSetupArgs(argv) {
  const result = { dryRun: false, migrateLegacyHookPaths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--dry-run") result.dryRun = true;
    else if (argv[index] === "--plugin") result.mode = "plugin";
    else if (argv[index] === "--codex-home") {
      result.codexHome = optionValue(argv, index, "--codex-home");
      index += 1;
    } else if (argv[index] === "--migrate-legacy-hook") {
      result.migrateLegacyHookPaths.push(optionValue(argv, index, "--migrate-legacy-hook"));
      index += 1;
    }
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return result;
}

if (process.argv[1] != null && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  let options;
  try {
    options = parseSetupArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`setup failed: ${error.message}\n`);
    process.exitCode = 1;
  }
  if (options != null) setup(options)
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.stdout.write("Create In Progress, For Review, and For Later, then restart Codex Desktop.\n");
    })
    .catch((error) => {
      process.stderr.write(`setup failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
