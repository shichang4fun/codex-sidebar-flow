#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { constants, existsSync, realpathSync } from "node:fs";
import { access, link, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppTools } from "./sidebar-realtime.mjs";
import {
  detectNodeExecutable,
  findUnmarkedSidebarHookPaths,
  HOOK_MARKER,
  isSafeIdentifier,
} from "./setup.mjs";

export const EVENT_WAKE_PROBE_PROTOCOL = "codex-sidebar-flow/event-wake-probe-v1";
export const EVENT_WAKE_PROBE_TTL_MS = 300000;
export const EVENT_WAKE_PROBE_CLAIM_TTL_MS = 30000;
const PROBE_RESULT_STATUSES = new Set(["present", "missing", "expired"]);
const PROBE_COMPLETION_STATUSES = new Set(["present", "missing"]);
const PROBE_REQUEST_NAME = "event-wake-probe-request.json";
const PROBE_RESULT_NAME = "event-wake-probe-result.json";
const PROBE_CLAIM_NAME = "event-wake-probe-claim.json";
const MAX_PROBE_FILE_BYTES = 4096;

function isBoundedAbsolutePath(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 4096
    && !/[\r\n]/.test(value)
    && path.isAbsolute(value);
}

function validProbeId(value) {
  return typeof value === "string"
    && value.length >= 8
    && value.length <= 128
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

function validTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function probePaths(config, runtimeRoot) {
  if (!isBoundedAbsolutePath(runtimeRoot) || path.normalize(runtimeRoot) !== runtimeRoot) return null;
  const requestFile = path.join(runtimeRoot, PROBE_REQUEST_NAME);
  const resultFile = path.join(runtimeRoot, PROBE_RESULT_NAME);
  if (
    config?.eventWakeProbeRequestFile !== requestFile
    || config?.eventWakeProbeResultFile !== resultFile
  ) return null;
  return {
    runtimeRoot,
    requestFile,
    resultFile,
    claimFile: path.join(runtimeRoot, PROBE_CLAIM_NAME),
  };
}

function validProbeConfig(config, runtimeRoot) {
  return probePaths(config, runtimeRoot) != null
    && config?.eventWakeProbeTtlMs === EVENT_WAKE_PROBE_TTL_MS;
}

async function validateProbeFiles(config, runtimeRoot) {
  const paths = probePaths(config, runtimeRoot);
  if (paths == null || config?.eventWakeProbeTtlMs !== EVENT_WAKE_PROBE_TTL_MS) {
    throw new Error("Invalid event-wake probe path or runtime configuration");
  }
  const runtimeMetadata = await lstat(runtimeRoot).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (runtimeMetadata == null || !runtimeMetadata.isDirectory() || runtimeMetadata.isSymbolicLink()) {
    throw new Error("Event-wake probe runtime must be a real directory");
  }
  for (const filePath of [paths.requestFile, paths.resultFile, paths.claimFile]) {
    const metadata = await lstat(filePath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (metadata == null) continue;
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("Event-wake probe path must be a regular file, not a symlink");
    }
    await access(filePath, constants.R_OK | constants.W_OK);
  }
  return paths;
}

async function readJsonIfExists(filePath) {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_PROBE_FILE_BYTES) return null;
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

function normalizeProbeRequest(value) {
  if (
    value?.protocol !== EVENT_WAKE_PROBE_PROTOCOL
    || !validProbeId(value?.probeId)
    || !validTimestamp(value?.armedAt)
    || !validTimestamp(value?.expiresAt)
    || value.expiresAt - value.armedAt !== EVENT_WAKE_PROBE_TTL_MS
  ) return null;
  return { probeId: value.probeId, armedAt: value.armedAt, expiresAt: value.expiresAt };
}

function normalizeProbeResult(value) {
  if (
    value?.protocol !== EVENT_WAKE_PROBE_PROTOCOL
    || !PROBE_RESULT_STATUSES.has(value?.status)
    || !validProbeId(value?.probeId)
    || !validTimestamp(value?.armedAt)
    || !validTimestamp(value?.observedAt)
    || !validTimestamp(value?.expiresAt)
    || value.expiresAt - value.armedAt !== EVENT_WAKE_PROBE_TTL_MS
  ) return null;
  if (value.status === "expired") {
    if (value.claimedAt !== null || value.observedAt <= value.expiresAt) return null;
  } else if (
    !validTimestamp(value?.claimedAt)
    || value.claimedAt < value.armedAt
    || value.observedAt < value.claimedAt
    || value.observedAt > value.expiresAt
  ) return null;
  return {
    status: value.status,
    probeId: value.probeId,
    armedAt: value.armedAt,
    claimedAt: value.claimedAt,
    observedAt: value.observedAt,
    expiresAt: value.expiresAt,
  };
}

function normalizeProbeClaim(value) {
  if (
    value?.protocol !== EVENT_WAKE_PROBE_PROTOCOL
    || !validProbeId(value?.probeId)
    || !validProbeId(value?.claimId)
    || !validTimestamp(value?.armedAt)
    || !validTimestamp(value?.claimedAt)
    || !validTimestamp(value?.claimExpiresAt)
    || !validTimestamp(value?.expiresAt)
    || value.expiresAt - value.armedAt !== EVENT_WAKE_PROBE_TTL_MS
    || value.claimedAt < value.armedAt
    || value.claimExpiresAt !== Math.min(value.expiresAt, value.claimedAt + EVENT_WAKE_PROBE_CLAIM_TTL_MS)
  ) return null;
  return {
    probeId: value.probeId,
    claimId: value.claimId,
    armedAt: value.armedAt,
    claimedAt: value.claimedAt,
    claimExpiresAt: value.claimExpiresAt,
    expiresAt: value.expiresAt,
  };
}

async function writeProbeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.close();
    handle = null;
    await rename(temporaryPath, filePath);
  } finally {
    await handle?.close();
    await unlink(temporaryPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function createClaimFile(filePath, value) {
  const candidatePath = `${filePath}.${process.pid}.${randomUUID()}.candidate`;
  let handle;
  try {
    handle = await open(
      candidatePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.close();
    handle = null;
    await link(candidatePath, filePath);
  } finally {
    await handle?.close();
    await unlink(candidatePath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function sameRequest(left, right) {
  return left != null
    && right != null
    && left.probeId === right.probeId
    && left.armedAt === right.armedAt
    && left.expiresAt === right.expiresAt;
}

function sameClaim(left, right) {
  return left != null
    && right != null
    && left.probeId === right.probeId
    && left.claimId === right.claimId
    && left.claimedAt === right.claimedAt;
}

async function retireClaim(paths, expectedClaim) {
  const retiredPath = `${paths.claimFile}.${process.pid}.${randomUUID()}.retired`;
  try {
    await rename(paths.claimFile, retiredPath);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  const retiredClaim = normalizeProbeClaim(await readJsonIfExists(retiredPath));
  if (!sameClaim(retiredClaim, expectedClaim)) {
    try {
      await link(retiredPath, paths.claimFile);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  await unlink(retiredPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  return sameClaim(retiredClaim, expectedClaim);
}

async function retireInvalidClaim(paths, request, observedAt) {
  const retiredPath = `${paths.claimFile}.${process.pid}.${randomUUID()}.invalid`;
  try {
    await rename(paths.claimFile, retiredPath);
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
  const retiredClaim = normalizeProbeClaim(await readJsonIfExists(retiredPath));
  const shouldRestore = sameRequest(retiredClaim, request)
    && retiredClaim.claimExpiresAt >= observedAt;
  if (shouldRestore) {
    try {
      await link(retiredPath, paths.claimFile);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  await unlink(retiredPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  return !shouldRestore;
}

export async function armEventWakeProbe(
  config,
  { runtimeRoot, now = Date.now, createProbeId = randomUUID } = {},
) {
  const paths = await validateProbeFiles(config, runtimeRoot);
  const armedAt = now();
  const probeId = createProbeId();
  if (!validTimestamp(armedAt) || !validProbeId(probeId)) {
    throw new Error("Invalid event-wake probe identity or timestamp");
  }
  const request = {
    protocol: EVENT_WAKE_PROBE_PROTOCOL,
    probeId,
    armedAt,
    expiresAt: armedAt + EVENT_WAKE_PROBE_TTL_MS,
  };
  await writeProbeJsonAtomic(paths.requestFile, request);
  return { status: "pending", probeId, armedAt, expiresAt: request.expiresAt };
}

export async function readEventWakeProbeResult(config, { runtimeRoot, now = Date.now } = {}) {
  const paths = probePaths(config, runtimeRoot);
  if (paths == null || !validProbeConfig(config, runtimeRoot)) return { status: "missing" };
  let request;
  let result;
  try {
    await validateProbeFiles(config, runtimeRoot);
    [request, result] = await Promise.all([
      readJsonIfExists(paths.requestFile).then(normalizeProbeRequest),
      readJsonIfExists(paths.resultFile).then(normalizeProbeResult),
    ]);
  } catch {
    return { status: "missing" };
  }
  if (request == null) return { status: "missing" };
  const observedAt = now();
  if (observedAt > request.expiresAt) {
    return result?.status === "expired" && sameRequest(result, request)
      ? result
      : { status: "expired", ...request };
  }
  if (result != null && result.status !== "expired" && sameRequest(result, request)) return result;
  return { status: "pending", ...request };
}

export async function claimEventWakeProbe(
  config,
  { runtimeRoot, now = Date.now, createClaimId = randomUUID } = {},
) {
  let paths;
  try {
    paths = await validateProbeFiles(config, runtimeRoot);
  } catch {
    return { status: "none" };
  }
  const observedAt = now();
  const request = normalizeProbeRequest(await readJsonIfExists(paths.requestFile));
  if (request == null) return { status: "none" };
  if (observedAt > request.expiresAt) return { status: "expired", ...request };
  const result = normalizeProbeResult(await readJsonIfExists(paths.resultFile));
  if (result != null && sameRequest(result, request)) return { status: "complete", result };

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const claimId = createClaimId();
    if (!validProbeId(claimId)) throw new Error("Invalid event-wake probe claim identity");
    const claim = {
      protocol: EVENT_WAKE_PROBE_PROTOCOL,
      ...request,
      claimId,
      claimedAt: observedAt,
      claimExpiresAt: Math.min(request.expiresAt, observedAt + EVENT_WAKE_PROBE_CLAIM_TTL_MS),
    };
    try {
      await createClaimFile(paths.claimFile, claim);
      return { status: "claimed", ...normalizeProbeClaim(claim) };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const existingClaim = normalizeProbeClaim(await readJsonIfExists(paths.claimFile));
    const freshCurrentClaim = sameRequest(existingClaim, request)
      && existingClaim.claimExpiresAt >= observedAt;
    if (freshCurrentClaim) return { status: "busy" };
    if (existingClaim == null) {
      if (!await retireInvalidClaim(paths, request, observedAt)) return { status: "busy" };
    } else {
      await retireClaim(paths, existingClaim);
    }
  }
  return { status: "busy" };
}

export async function releaseEventWakeProbeClaim(config, claim, { runtimeRoot } = {}) {
  let paths;
  try {
    paths = await validateProbeFiles(config, runtimeRoot);
  } catch {
    return false;
  }
  const currentClaim = normalizeProbeClaim(await readJsonIfExists(paths.claimFile));
  if (!sameClaim(currentClaim, claim)) return false;
  return retireClaim(paths, currentClaim);
}

export async function writeEventWakeProbeResult(
  config,
  status,
  { runtimeRoot, now = Date.now, claim } = {},
) {
  if (!PROBE_COMPLETION_STATUSES.has(status)) {
    throw new Error("Invalid event-wake probe result");
  }
  const paths = await validateProbeFiles(config, runtimeRoot);
  const observedAt = now();
  const request = normalizeProbeRequest(await readJsonIfExists(paths.requestFile));
  const currentClaim = normalizeProbeClaim(await readJsonIfExists(paths.claimFile));
  if (
    !sameRequest(request, claim)
    || !sameClaim(currentClaim, claim)
    || observedAt > request.expiresAt
    || observedAt > currentClaim.claimExpiresAt
  ) return false;
  const result = {
    protocol: EVENT_WAKE_PROBE_PROTOCOL,
    status,
    probeId: request.probeId,
    armedAt: request.armedAt,
    claimedAt: claim.claimedAt,
    observedAt,
    expiresAt: request.expiresAt,
  };
  await writeProbeJsonAtomic(paths.resultFile, result);
  const latestRequest = normalizeProbeRequest(await readJsonIfExists(paths.requestFile));
  if (!sameRequest(latestRequest, request) || observedAt > latestRequest.expiresAt) {
    const latestResult = normalizeProbeResult(await readJsonIfExists(paths.resultFile));
    if (latestResult?.probeId === result.probeId) {
      await unlink(paths.resultFile).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    return false;
  }
  return true;
}

export async function writeExpiredEventWakeProbeResult(
  config,
  request,
  { runtimeRoot, now = Date.now } = {},
) {
  const paths = await validateProbeFiles(config, runtimeRoot);
  const observedAt = now();
  const currentRequest = normalizeProbeRequest(await readJsonIfExists(paths.requestFile));
  if (!sameRequest(currentRequest, request) || observedAt <= currentRequest.expiresAt) return false;
  await writeProbeJsonAtomic(paths.resultFile, {
    protocol: EVENT_WAKE_PROBE_PROTOCOL,
    status: "expired",
    probeId: currentRequest.probeId,
    armedAt: currentRequest.armedAt,
    claimedAt: null,
    observedAt,
    expiresAt: currentRequest.expiresAt,
  });
  return true;
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
  runtimeRoot,
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
    && validProbeConfig(config, runtimeRoot)
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

export async function inspectPluginBundle(pluginRoot, { enabledContext = false } = {}) {
  const entries = {
    manifest: ".codex-plugin/plugin.json",
    hooks: "hooks/hooks.json",
    launcher: "scripts/plugin-hook.sh",
    sidebarHook: "scripts/sidebar-hook.mjs",
    sidebarRealtime: "scripts/sidebar-realtime.mjs",
    eventWake: "scripts/event-wake.mjs",
  };
  const result = { enabledContext };
  await Promise.all(Object.entries(entries).map(async ([name, relativePath]) => {
    if (!isBoundedAbsolutePath(pluginRoot)) {
      result[name] = false;
      return;
    }
    const filePath = path.join(pluginRoot, relativePath);
    try {
      const metadata = await lstat(filePath);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        result[name] = false;
        return;
      }
      await access(filePath, constants.R_OK);
      result[name] = true;
    } catch {
      result[name] = false;
    }
  }));
  return result;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseDoctorArgs(argv);
  const mode = options.mode;
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const pluginRoot = options.pluginRoot ?? process.env.CLAUDE_PLUGIN_ROOT;
  const runtimeRoot = path.join(codexHome, "sidebar-flow");
  const [hooks, config] = await Promise.all([
    readJson(path.join(codexHome, "hooks.json")).catch(() => ({})),
    readJson(path.join(codexHome, "sidebar-flow", "config.json")).catch(() => ({})),
  ]);
  if (options.armEventWakeProbe || options.eventWakeProbeResult) {
    const eventWakeProbe = options.armEventWakeProbe
      ? await armEventWakeProbe(config, { runtimeRoot })
      : await readEventWakeProbeResult(config, { runtimeRoot });
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
  const eventWakeProbe = await readEventWakeProbeResult(config, { runtimeRoot });
  const pluginBundle = mode === "plugin"
    ? await inspectPluginBundle(pluginRoot, {
        enabledContext: pluginRoot != null && process.env.CLAUDE_PLUGIN_ROOT === pluginRoot,
      })
    : null;
  const checks = inspectInstallation({
    hooks,
    config,
    mode,
    pipePath: process.env.CODEX_APP_TOOLS_PIPE_PATH,
    runtimeProbe,
    eventWakeProbe,
    runtimeRoot,
    legacyHookConflicts: findUnmarkedSidebarHookPaths(hooks),
    pluginBundle,
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
