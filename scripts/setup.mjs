#!/usr/bin/env node

import { chmod, copyFile, link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const HOOK_MARKER = "/scripts/sidebar-hook.mjs";

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
  return `exec /usr/bin/env -u FORCE_COLOR ${quote(nodeExecutable)} ${quote(path.join(root, "scripts", "sidebar-hook.mjs"))}`;
}

function isOwnedHook(hook) {
  return typeof hook?.command === "string" && hook.command.includes(HOOK_MARKER);
}

function removeOwnedHandlers(matchers) {
  return (Array.isArray(matchers) ? matchers : []).flatMap((matcher) => {
    const hooks = (matcher?.hooks ?? []).filter((hook) => !isOwnedHook(hook));
    return hooks.length === 0 ? [] : [{ ...matcher, hooks }];
  });
}

export function installHooks(existing = {}, command = hookCommand()) {
  const result = structuredClone(existing);
  result.hooks ??= {};
  for (const event of ["UserPromptSubmit", "Stop"]) {
    const matchers = removeOwnedHandlers(result.hooks[event]);
    matchers.push({ hooks: [{ type: "command", command, timeout: 15 }] });
    result.hooks[event] = matchers;
  }
  return result;
}

export function removeHooks(existing = {}) {
  const result = structuredClone(existing);
  for (const event of ["UserPromptSubmit", "Stop"]) {
    if (!Array.isArray(result.hooks?.[event])) continue;
    result.hooks[event] = removeOwnedHandlers(result.hooks[event]);
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

export function defaultConfig(codexHome) {
  const runtime = path.join(codexHome, "sidebar-flow");
  return {
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
} = {}) {
  if (!new Set(["source", "plugin"]).has(mode)) throw new Error(`Unknown setup mode: ${mode}`);
  const runtimeRoot = path.join(codexHome, "sidebar-flow");
  const runtimeScripts = path.join(runtimeRoot, "scripts");
  const hooksPath = path.join(codexHome, "hooks.json");
  const backupPath = `${hooksPath}.sidebar-flow.bak`;
  const configPath = path.join(runtimeRoot, "config.json");
  const hooks = mode === "source"
    ? installHooks(await readJson(hooksPath, {}), hookCommand(runtimeRoot))
    : null;
  const existingConfig = await readJson(configPath, null);
  if (!dryRun) {
    if (mode === "source") {
      await mkdir(runtimeScripts, { recursive: true, mode: 0o700 });
      await Promise.all([
        copyFile(path.join(ROOT, "scripts", "sidebar-hook.mjs"), path.join(runtimeScripts, "sidebar-hook.mjs")),
        copyFile(path.join(ROOT, "scripts", "sidebar-realtime.mjs"), path.join(runtimeScripts, "sidebar-realtime.mjs")),
        copyFile(path.join(ROOT, "scripts", "setup.mjs"), path.join(runtimeScripts, "setup.mjs")),
      ]);
      if (existsSync(hooksPath)) await writePrivateBackup(hooksPath, backupPath);
      await writeJsonAtomic(hooksPath, hooks);
    }
    if (existingConfig == null) await writeJsonAtomic(configPath, defaultConfig(codexHome));
  }
  return { mode, hooksPath, backupPath, configPath, runtimeRoot, dryRun, nodeExecutable: detectNodeExecutable() };
}

function parseArgs(argv) {
  const result = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--dry-run") result.dryRun = true;
    else if (argv[index] === "--plugin") result.mode = "plugin";
    else if (argv[index] === "--codex-home") result.codexHome = argv[++index];
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  setup(parseArgs(process.argv.slice(2)))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.stdout.write("Create In Progress, For Review, and For Later, then restart Codex Desktop.\n");
    })
    .catch((error) => {
      process.stderr.write(`setup failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
