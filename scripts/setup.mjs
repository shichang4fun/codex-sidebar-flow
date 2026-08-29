#!/usr/bin/env node

import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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

function isOurs(matcher) {
  return (matcher?.hooks ?? []).some(
    (hook) => typeof hook?.command === "string" && hook.command.includes(HOOK_MARKER),
  );
}

export function installHooks(existing = {}, command = hookCommand()) {
  const result = structuredClone(existing);
  result.hooks ??= {};
  for (const event of ["UserPromptSubmit", "Stop"]) {
    const matchers = Array.isArray(result.hooks[event])
      ? result.hooks[event].filter((matcher) => !isOurs(matcher))
      : [];
    matchers.push({ hooks: [{ type: "command", command, timeout: 20 }] });
    result.hooks[event] = matchers;
  }
  return result;
}

export function removeHooks(existing = {}) {
  const result = structuredClone(existing);
  for (const event of ["UserPromptSubmit", "Stop"]) {
    if (!Array.isArray(result.hooks?.[event])) continue;
    result.hooks[event] = result.hooks[event].filter((matcher) => !isOurs(matcher));
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
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, filePath);
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
    ignoreSummaryContains: ["Automation ID: codex-sidebar-flow"],
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
  };
}

export async function setup({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), dryRun = false } = {}) {
  const hooksPath = path.join(codexHome, "hooks.json");
  const backupPath = `${hooksPath}.sidebar-flow.bak`;
  const configPath = path.join(codexHome, "sidebar-flow", "config.json");
  const hooks = installHooks(await readJson(hooksPath, {}));
  const existingConfig = await readJson(configPath, null);
  if (!dryRun) {
    if (existsSync(hooksPath) && !existsSync(backupPath)) await copyFile(hooksPath, backupPath);
    await writeJsonAtomic(hooksPath, hooks);
    if (existingConfig == null) await writeJsonAtomic(configPath, defaultConfig(codexHome));
  }
  return { hooksPath, backupPath, configPath, dryRun, nodeExecutable: detectNodeExecutable() };
}

function parseArgs(argv) {
  const result = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--dry-run") result.dryRun = true;
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
