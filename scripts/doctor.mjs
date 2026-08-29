#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile, rename, unlink } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppTools } from "./sidebar-realtime.mjs";
import {
  detectNodeExecutable,
  findUnmarkedSidebarHookPaths,
  HOOK_MARKER,
  isSafeIdentifier,
  writeJsonAtomic,
} from "./setup.mjs";

export const EVENT_WAKE_PROBE_PROTOCOL = "codex-sidebar-flow/event-wake-probe-v1";
export const EVENT_WAKE_PROBE_TTL_MS = 300000;
const PROBE_RESULT_STATUSES = new Set(["present", "missing", "expired"]);

function isBoundedAbsolutePath(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 4096
    && !/[\r\n]/.test(value)
    && path.isAbsolute(value);
}

function validProbeConfig(config) {
  return isBoundedAbsolutePath(config?.eventWakeProbeRequestFile)
    && isBoundedAbsolutePath(config?.eventWakeProbeResultFile)
    && config?.eventWakeProbeTtlMs === EVENT_WAKE_PROBE_TTL_MS;
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function normalizeProbeRequest(value) {
  if (
    value?.protocol !== EVENT_WAKE_PROBE_PROTOCOL
    || !Number.isFinite(value?.createdAt)
    || !Number.isFinite(value?.expiresAt)
    || value.createdAt < 0
    || value.expiresAt - value.createdAt !== EVENT_WAKE_PROBE_TTL_MS
  ) return null;
  return { createdAt: value.createdAt, expiresAt: value.expiresAt };
}

function normalizeProbeResult(value) {
  if (
    value?.protocol !== EVENT_WAKE_PROBE_PROTOCOL
    || !PROBE_RESULT_STATUSES.has(value?.status)
    || !Number.isFinite(value?.checkedAt)
    || value.checkedAt < 0
  ) return null;
  return { status: value.status, checkedAt: value.checkedAt };
}

export async function armEventWakeProbe(config, { now = Date.now } = {}) {
  if (!validProbeConfig(config)) throw new Error("Invalid event-wake probe configuration");
  const createdAt = now();
  const request = {
    protocol: EVENT_WAKE_PROBE_PROTOCOL,
    createdAt,
    expiresAt: createdAt + EVENT_WAKE_PROBE_TTL_MS,
  };
  await unlink(config.eventWakeProbeResultFile).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  await writeJsonAtomic(config.eventWakeProbeRequestFile, request);
  return { status: "pending", createdAt: request.createdAt, expiresAt: request.expiresAt };
}

export async function readEventWakeProbeResult(config, { now = Date.now } = {}) {
  if (!validProbeConfig(config)) return { status: "missing" };
  const result = normalizeProbeResult(await readJsonIfExists(config.eventWakeProbeResultFile));
  if (result != null) return result;
  const request = normalizeProbeRequest(await readJsonIfExists(config.eventWakeProbeRequestFile));
  if (request == null) return { status: "missing" };
  return now() > request.expiresAt
    ? { status: "expired", ...request }
    : { status: "pending", ...request };
}

export async function claimEventWakeProbe(
  config,
  { now = Date.now, createToken = randomUUID } = {},
) {
  if (!validProbeConfig(config)) return { status: "none" };
  const claimPath = `${config.eventWakeProbeRequestFile}.${process.pid}.${createToken()}.claim`;
  try {
    await rename(config.eventWakeProbeRequestFile, claimPath);
  } catch (error) {
    if (error.code === "ENOENT") return { status: "none" };
    throw error;
  }
  try {
    const request = normalizeProbeRequest(await readJsonIfExists(claimPath));
    if (request == null || now() > request.expiresAt) return { status: "expired" };
    return { status: "claimed" };
  } finally {
    await unlink(claimPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function writeEventWakeProbeResult(config, status, { now = Date.now } = {}) {
  if (!validProbeConfig(config) || !PROBE_RESULT_STATUSES.has(status)) {
    throw new Error("Invalid event-wake probe result");
  }
  const result = { protocol: EVENT_WAKE_PROBE_PROTOCOL, status, checkedAt: now() };
  await writeJsonAtomic(config.eventWakeProbeResultFile, result);
  return { status, checkedAt: result.checkedAt };
}

export function inspectInstallation({
  hooks,
  config,
  platform = process.platform,
  pipePath,
  mode = "source",
  nodeExecutable = detectNodeExecutable(),
  runtimeProbe = null,
  eventWakeProbe = null,
  pluginBundle = null,
  legacyHookConflicts = [],
} = {}) {
  const checks = [];
  checks.push({
    level: platform === "darwin" ? "ok" : "warning",
    name: "platform",
    message: platform === "darwin" ? "macOS detected" : "Desktop adapter is only verified on macOS",
  });
  checks.push({
    level: legacyHookConflicts.length === 0 ? "ok" : "error",
    name: "legacy-hook-conflict",
    message: legacyHookConflicts.length === 0
      ? "No unowned legacy sidebar Hooks detected"
      : `Unowned legacy sidebar Hooks detected: ${legacyHookConflicts.join(", ")}`,
  });
  const names = Object.values(config?.sections ?? {});
  const configValid = names.length === 3 && names.every(Boolean) && new Set(names).size === 3;
  checks.push({
    level: configValid ? "ok" : "error",
    name: "config",
    message: configValid ? "Section configuration is valid" : "Three unique section names are required",
  });
  checks.push({
    level: config?.installMode === mode ? "ok" : (config?.installMode == null ? "warning" : "error"),
    name: "install-mode",
    message: config?.installMode === mode
      ? `${mode} mode recorded`
      : (config?.installMode == null ? "Install mode is not recorded" : `Configuration records ${config.installMode} mode`),
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
    const bundleComplete = pluginBundle != null && [
      "manifest",
      "hooks",
      "launcher",
      "sidebarHook",
      "sidebarRealtime",
      "eventWake",
    ].every(
      (name) => pluginBundle[name] === true,
    );
    checks.push({
      level: !bundleComplete ? "error" : (pluginBundle.enabledContext ? "ok" : "warning"),
      name: "plugin-bundle",
      message: !bundleComplete
        ? "Plugin manifest, Hook declaration, launcher, or runtime script is missing"
        : (pluginBundle.enabledContext
            ? "Plugin bundle is complete in an active plugin context"
            : "Plugin bundle is complete, but app enablement is unverified"),
    });
  }
  const bundledNode = existsSync(nodeExecutable) && nodeExecutable.includes("/cua_node/bin/node");
  checks.push({
    level: bundledNode ? "ok" : "warning",
    name: "runtime",
    message: bundledNode ? "Bundled Desktop Node path selected" : "Bundled Desktop Node path was not found",
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
  const wake = config?.eventWake;
  const eventWakeEnabled = wake?.enabled === true;
  const eventWakeValid = !eventWakeEnabled || (
    isSafeIdentifier(wake.organizerThreadId)
    && isSafeIdentifier(wake.organizerHostId)
    && Number.isInteger(wake.maxPerMinute)
    && wake.maxPerMinute > 0
    && Array.isArray(config.excludeThreadIds)
    && config.excludeThreadIds.includes(wake.organizerThreadId)
    && isBoundedAbsolutePath(config.wakeStateFile)
    && validProbeConfig(config)
  );
  checks.push({
    level: eventWakeValid ? "ok" : "error",
    name: "event-wake-config",
    message: !eventWakeEnabled
      ? "Event wake is disabled"
      : (eventWakeValid ? "Event wake configuration is valid" : "Event wake configuration is invalid"),
  });
  let capabilityLevel = "warning";
  let capabilityMessage = "No lifecycle Hook capability probe result is available";
  if (!eventWakeEnabled) {
    capabilityLevel = "ok";
    capabilityMessage = "Event wake is disabled; capability probe is not required";
  } else if (eventWakeProbe?.status === "present") {
    capabilityLevel = "ok";
    capabilityMessage = "Lifecycle Hook tools/list includes send_message_to_thread";
  } else if (eventWakeProbe?.status === "missing") {
    capabilityLevel = "error";
    capabilityMessage = "Lifecycle Hook tools/list is missing send_message_to_thread or no result exists";
  } else if (eventWakeProbe?.status === "pending") {
    capabilityMessage = "Capability probe is armed and pending the next lifecycle Hook";
  } else if (eventWakeProbe?.status === "expired") {
    capabilityMessage = "Capability probe expired before a lifecycle Hook consumed it";
  }
  checks.push({
    level: capabilityLevel,
    name: "event-wake-capability",
    message: capabilityMessage,
  });
  return checks;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export function parseDoctorArgs(argv) {
  const result = { mode: "source", probe: false, armEventWakeProbe: false, eventWakeProbeResult: false };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--plugin") result.mode = "plugin";
    else if (option === "--probe") result.probe = true;
    else if (option === "--arm-event-wake-probe") result.armEventWakeProbe = true;
    else if (option === "--event-wake-probe-result") result.eventWakeProbeResult = true;
    else if (option === "--codex-home" || option === "--plugin-root") {
      const value = argv[index + 1];
      if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\r\n]/.test(value) || value.startsWith("-")) {
        throw new Error(`${option} requires a single-line value`);
      }
      if (option === "--codex-home") result.codexHome = value;
      else result.pluginRoot = value;
      index += 1;
    } else throw new Error(`Unknown argument: ${option}`);
  }
  if (result.armEventWakeProbe && result.eventWakeProbeResult) {
    throw new Error("Choose only one event-wake probe command");
  }
  return result;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseDoctorArgs(argv);
  const mode = options.mode;
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const pluginRoot = options.pluginRoot ?? process.env.CLAUDE_PLUGIN_ROOT;
  const [hooks, config] = await Promise.all([
    readJson(path.join(codexHome, "hooks.json")).catch(() => ({})),
    readJson(path.join(codexHome, "sidebar-flow", "config.json")).catch(() => ({})),
  ]);
  if (options.armEventWakeProbe || options.eventWakeProbeResult) {
    const eventWakeProbe = options.armEventWakeProbe
      ? await armEventWakeProbe(config)
      : await readEventWakeProbeResult(config);
    process.stdout.write(`${JSON.stringify({ eventWakeProbe }, null, 2)}\n`);
    return;
  }
  let runtimeProbe = null;
  if (options.probe) {
    let appTools;
    try {
      appTools = new AppTools({ ...config, actorThreadId: "sidebar-flow-doctor", quiet: true });
      const snapshot = await appTools.listThreads();
      const sectionNames = new Set((snapshot.sections ?? []).map((section) => section.name));
      const missing = Object.values(config.sections ?? {}).filter((name) => !sectionNames.has(name));
      runtimeProbe = missing.length === 0
        ? { ok: true, message: "tools/list succeeded and configured sections exist" }
        : { ok: false, message: `Configured sections are missing: ${missing.join(", ")}` };
    } catch (error) {
      runtimeProbe = { ok: false, message: `Runtime probe failed: ${error.code ?? "APP_TOOLS_UNAVAILABLE"}` };
    } finally {
      appTools?.reset();
    }
  }
  const eventWakeProbe = await readEventWakeProbeResult(config);
  const checks = inspectInstallation({
    hooks,
    config,
    mode,
    pipePath: process.env.CODEX_APP_TOOLS_PIPE_PATH,
    runtimeProbe,
    eventWakeProbe,
    legacyHookConflicts: findUnmarkedSidebarHookPaths(hooks),
    pluginBundle: mode === "plugin"
      ? {
          manifest: pluginRoot != null && existsSync(path.join(pluginRoot, ".codex-plugin", "plugin.json")),
          hooks: pluginRoot != null && existsSync(path.join(pluginRoot, "hooks", "hooks.json")),
          launcher: pluginRoot != null && existsSync(path.join(pluginRoot, "scripts", "plugin-hook.sh")),
          sidebarHook: pluginRoot != null && existsSync(path.join(pluginRoot, "scripts", "sidebar-hook.mjs")),
          sidebarRealtime: pluginRoot != null && existsSync(path.join(pluginRoot, "scripts", "sidebar-realtime.mjs")),
          eventWake: pluginRoot != null && existsSync(path.join(pluginRoot, "scripts", "event-wake.mjs")),
          enabledContext: pluginRoot != null && process.env.CLAUDE_PLUGIN_ROOT === pluginRoot,
        }
      : null,
  });
  process.stdout.write(`${JSON.stringify({ mode, checks }, null, 2)}\n`);
  if (checks.some((check) => check.level === "error") || runtimeProbe?.ok === false) process.exitCode = 1;
}

if (process.argv[1] != null && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`doctor failed: ${error?.code ?? "INVALID_CONFIGURATION"}\n`);
    process.exitCode = 1;
  });
}
