#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { constants, existsSync, realpathSync } from "node:fs";
import { access, lstat, open, opendir, readFile, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppTools } from "./sidebar-realtime.mjs";
import { isRuntimeFingerprint } from "./runtime-integrity.mjs";
import {
  detectNodeExecutable,
  findUnmarkedSidebarHookPaths,
  HOOK_MARKER,
  isSafeIdentifier,
} from "./setup.mjs";

export const EVENT_WAKE_PROBE_PROTOCOL = "codex-sidebar-flow/event-wake-probe-v1";
export const EVENT_WAKE_PROBE_TTL_MS = 300000;
const PROBE_RESULT_STATUSES = new Set(["present", "missing"]);
const PROBE_REQUEST_NAME = "event-wake-probe-request.json";
const PROBE_RESULT_NAME = "event-wake-probe-result.json";
const MAX_PROBE_FILE_BYTES = 4096;
const MAX_PROBE_SNAPSHOT_ATTEMPTS = 4;
const MAX_PROBE_ID_ATTEMPTS = 8;
const MAX_PROBE_CLEANUP_ENTRIES = 256;
const MAX_PROBE_CLEANUP_DELETIONS = 32;

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

function hasExactKeys(value, expected) {
  return value != null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function validProbeBinding(value) {
  return new Set(["source", "plugin"]).has(value?.installMode)
    && isRuntimeFingerprint(value?.runtimeFingerprint);
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
    resultBaseFile: resultFile,
    installMode: config?.installMode,
    runtimeFingerprint: config?.runtimeFingerprint,
  };
}

function generationProbePaths(paths, probeId) {
  if (!validProbeId(probeId)) throw new Error("Invalid event-wake probe identity");
  return {
    claimFile: `${paths.requestFile}.claim.${probeId}`,
    resultFile: `${paths.resultBaseFile}.result.${probeId}`,
  };
}

function probeIdFromGenerationFilename(filename) {
  const prefixes = [
    `${PROBE_REQUEST_NAME}.claim.`,
    `${PROBE_RESULT_NAME}.result.`,
  ];
  for (const prefix of prefixes) {
    if (!filename.startsWith(prefix)) continue;
    const probeId = filename.slice(prefix.length);
    return validProbeId(probeId) && filename === `${prefix}${probeId}` ? probeId : null;
  }
  return null;
}

function validProbeConfig(config, runtimeRoot) {
  return probePaths(config, runtimeRoot) != null
    && config?.eventWakeProbeTtlMs === EVENT_WAKE_PROBE_TTL_MS
    && validProbeBinding(config);
}

async function validateProbeFiles(config, runtimeRoot) {
  const paths = probePaths(config, runtimeRoot);
  if (
    paths == null
    || config?.eventWakeProbeTtlMs !== EVENT_WAKE_PROBE_TTL_MS
    || !validProbeBinding(config)
  ) {
    throw new Error("Invalid event-wake probe path or runtime configuration");
  }
  const runtimeMetadata = await lstat(runtimeRoot).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (runtimeMetadata == null || !runtimeMetadata.isDirectory() || runtimeMetadata.isSymbolicLink()) {
    throw new Error("Event-wake probe runtime must be a real directory");
  }
  for (const filePath of [paths.requestFile, paths.resultBaseFile]) {
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

async function validateGenerationFile(filePath) {
  const metadata = await lstat(filePath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (metadata == null) return null;
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("Event-wake probe generation path must be a regular file, not a symlink");
  }
  await access(filePath, constants.R_OK | constants.W_OK);
  return metadata;
}

async function readCompletedProbeResult(paths, request) {
  const generation = generationProbePaths(paths, request?.probeId);
  try {
    await validateGenerationFile(generation.resultFile);
    const result = normalizeProbeResult(await readJsonIfExists(generation.resultFile));
    return result != null && sameRequest(result, request) ? result : null;
  } catch {
    return null;
  }
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
    !hasExactKeys(value, [
      "protocol", "probeId", "armedAt", "expiresAt", "installMode", "runtimeFingerprint",
    ])
    || value.protocol !== EVENT_WAKE_PROBE_PROTOCOL
    || !validProbeId(value?.probeId)
    || !validTimestamp(value?.armedAt)
    || !validTimestamp(value?.expiresAt)
    || !validProbeBinding(value)
    || value.expiresAt - value.armedAt !== EVENT_WAKE_PROBE_TTL_MS
  ) return null;
  return {
    probeId: value.probeId,
    armedAt: value.armedAt,
    expiresAt: value.expiresAt,
    installMode: value.installMode,
    runtimeFingerprint: value.runtimeFingerprint,
  };
}

function normalizeProbeResult(value) {
  if (
    !hasExactKeys(value, [
      "protocol", "status", "probeId", "armedAt", "claimedAt", "observedAt", "expiresAt",
      "installMode", "runtimeFingerprint",
    ])
    || value.protocol !== EVENT_WAKE_PROBE_PROTOCOL
    || !PROBE_RESULT_STATUSES.has(value?.status)
    || !validProbeId(value?.probeId)
    || !validTimestamp(value?.armedAt)
    || !validTimestamp(value?.observedAt)
    || !validTimestamp(value?.expiresAt)
    || !validProbeBinding(value)
    || value.expiresAt - value.armedAt !== EVENT_WAKE_PROBE_TTL_MS
  ) return null;
  if (
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
    installMode: value.installMode,
    runtimeFingerprint: value.runtimeFingerprint,
  };
}

function normalizeProbeClaim(value) {
  if (
    !hasExactKeys(value, [
      "protocol", "probeId", "armedAt", "expiresAt", "installMode", "runtimeFingerprint",
      "claimId", "claimedAt",
    ])
    || value.protocol !== EVENT_WAKE_PROBE_PROTOCOL
    || !validProbeId(value?.probeId)
    || !validProbeId(value?.claimId)
    || !validTimestamp(value?.armedAt)
    || !validTimestamp(value?.claimedAt)
    || !validTimestamp(value?.expiresAt)
    || !validProbeBinding(value)
    || value.expiresAt - value.armedAt !== EVENT_WAKE_PROBE_TTL_MS
    || value.claimedAt < value.armedAt
    || value.claimedAt > value.expiresAt
  ) return null;
  return {
    probeId: value.probeId,
    claimId: value.claimId,
    armedAt: value.armedAt,
    claimedAt: value.claimedAt,
    expiresAt: value.expiresAt,
    installMode: value.installMode,
    runtimeFingerprint: value.runtimeFingerprint,
  };
}

function publicProbeRequest(value) {
  return {
    probeId: value.probeId,
    armedAt: value.armedAt,
    expiresAt: value.expiresAt,
  };
}

function publicProbeResult(value) {
  return {
    status: value.status,
    probeId: value.probeId,
    armedAt: value.armedAt,
    claimedAt: value.claimedAt,
    observedAt: value.observedAt,
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

function sameRequest(left, right) {
  return left != null
    && right != null
    && left.probeId === right.probeId
    && left.armedAt === right.armedAt
    && left.expiresAt === right.expiresAt
    && left.installMode === right.installMode
    && left.runtimeFingerprint === right.runtimeFingerprint;
}

function attachClaimOwnership(claim, fileHandle, metadata, claimFile) {
  Object.defineProperties(claim, {
    _fileHandle: { value: fileHandle, writable: true },
    _device: { value: metadata.dev },
    _inode: { value: metadata.ino },
    _claimFile: { value: claimFile },
  });
  return claim;
}

async function releaseOwnedClaimPath(claim) {
  const handle = claim?._fileHandle;
  if (handle == null || typeof claim?._claimFile !== "string") return false;
  claim._fileHandle = null;
  try {
    const ownerMetadata = await handle.stat();
    if (ownerMetadata.dev !== claim._device || ownerMetadata.ino !== claim._inode) return false;
    const pathMetadata = await lstat(claim._claimFile).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (pathMetadata?.dev !== claim._device || pathMetadata?.ino !== claim._inode) return false;
    await unlink(claim._claimFile);
    return true;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function generationExists(paths, probeId) {
  const generation = generationProbePaths(paths, probeId);
  const metadata = await Promise.all([
    lstat(generation.claimFile).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }),
    lstat(generation.resultFile).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }),
  ]);
  return metadata.some((entry) => entry != null);
}

async function readCurrentProbeRequest(paths) {
  const request = normalizeProbeRequest(await readJsonIfExists(paths.requestFile));
  if (
    request?.installMode !== paths.installMode
    || request?.runtimeFingerprint !== paths.runtimeFingerprint
  ) return null;
  return request;
}

async function cleanupOrphanedProbeGenerations(paths, currentRequest, observedAt) {
  if (currentRequest == null || !validTimestamp(observedAt)) return;
  const directory = await opendir(paths.runtimeRoot);
  let inspected = 0;
  let deleted = 0;
  for await (const entry of directory) {
    inspected += 1;
    if (inspected > MAX_PROBE_CLEANUP_ENTRIES) break;
    const probeId = probeIdFromGenerationFilename(entry.name);
    if (probeId == null || probeId === currentRequest.probeId) continue;
    const filePath = path.join(paths.runtimeRoot, entry.name);
    const metadata = await lstat(filePath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (
      metadata == null
      || metadata.isSymbolicLink()
      || !metadata.isFile()
      || !Number.isFinite(metadata.mtimeMs)
      || observedAt - metadata.mtimeMs <= EVENT_WAKE_PROBE_TTL_MS
    ) continue;
    const latestRequest = await readCurrentProbeRequest(paths);
    if (latestRequest == null || latestRequest.probeId === probeId) continue;
    await unlink(filePath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    deleted += 1;
    if (deleted >= MAX_PROBE_CLEANUP_DELETIONS) break;
  }
}

export async function armEventWakeProbe(
  config,
  { runtimeRoot, now = Date.now, createProbeId = randomUUID } = {},
) {
  const paths = await validateProbeFiles(config, runtimeRoot);
  const armedAt = now();
  if (!validTimestamp(armedAt)) throw new Error("Invalid event-wake probe timestamp");
  const previousRequest = await readCurrentProbeRequest(paths);
  let probeId = null;
  for (let attempt = 0; attempt < MAX_PROBE_ID_ATTEMPTS; attempt += 1) {
    const candidate = createProbeId();
    if (!validProbeId(candidate)) throw new Error("Invalid event-wake probe identity");
    if (candidate === previousRequest?.probeId || await generationExists(paths, candidate)) continue;
    probeId = candidate;
    break;
  }
  if (probeId == null) throw new Error("Unable to create a unique event-wake probe identity");
  const request = {
    protocol: EVENT_WAKE_PROBE_PROTOCOL,
    probeId,
    armedAt,
    expiresAt: armedAt + EVENT_WAKE_PROBE_TTL_MS,
    installMode: config.installMode,
    runtimeFingerprint: config.runtimeFingerprint,
  };
  await writeProbeJsonAtomic(paths.requestFile, request);
  await cleanupOrphanedProbeGenerations(paths, request, armedAt).catch(() => {});
  return { status: "pending", probeId, armedAt, expiresAt: request.expiresAt };
}

export async function readEventWakeProbeResult(
  config,
  { runtimeRoot, now = Date.now, afterResultRead = async () => {} } = {},
) {
  let paths;
  try {
    paths = await validateProbeFiles(config, runtimeRoot);
  } catch (error) {
    return { status: "missing" };
  }
  const observedAt = now();
  for (let attempt = 0; attempt < MAX_PROBE_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const firstRequest = await readCurrentProbeRequest(paths);
    if (firstRequest == null) return { status: "missing" };
    await cleanupOrphanedProbeGenerations(paths, firstRequest, observedAt).catch(() => {});
    const result = await readCompletedProbeResult(paths, firstRequest);
    await afterResultRead({ attempt, probeId: firstRequest.probeId });
    const secondRequest = await readCurrentProbeRequest(paths);
    if (!sameRequest(firstRequest, secondRequest)) continue;
    if (result != null) return publicProbeResult(result);
    if (observedAt > firstRequest.expiresAt) {
      return { status: "expired", ...publicProbeRequest(firstRequest) };
    }
    return { status: "pending", ...publicProbeRequest(firstRequest) };
  }
  return { status: "pending" };
}

export async function claimEventWakeProbe(
  config,
  {
    runtimeRoot,
    now = Date.now,
    createClaimId = randomUUID,
    afterInitialResultRead = async () => {},
  } = {},
) {
  let paths;
  try {
    paths = await validateProbeFiles(config, runtimeRoot);
  } catch {
    return { status: "none" };
  }
  const observedAt = now();
  const request = await readCurrentProbeRequest(paths);
  if (request == null) return { status: "none" };
  await cleanupOrphanedProbeGenerations(paths, request, observedAt).catch(() => {});
  const result = await readCompletedProbeResult(paths, request);
  if (result != null) return { status: "complete", result: publicProbeResult(result) };
  if (observedAt > request.expiresAt) return { status: "expired", ...publicProbeRequest(request) };
  const generation = generationProbePaths(paths, request.probeId);
  await afterInitialResultRead({ probeId: request.probeId });
  const claimId = createClaimId();
  if (!validProbeId(claimId)) throw new Error("Invalid event-wake probe claim identity");
  await validateGenerationFile(generation.claimFile);
  let handle;
  try {
    handle = await open(
      generation.claimFile,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const completedResult = await readCompletedProbeResult(paths, request);
    if (completedResult != null) return { status: "complete", result: publicProbeResult(completedResult) };
    return observedAt > request.expiresAt
      ? { status: "expired", ...publicProbeRequest(request) }
      : { status: "busy" };
  }
  const claimRecord = {
    protocol: EVENT_WAKE_PROBE_PROTOCOL,
    ...request,
    claimId,
    claimedAt: observedAt,
  };
  const metadata = await handle.stat();
  const claim = attachClaimOwnership(
    { status: "claimed", ...normalizeProbeClaim(claimRecord) },
    handle,
    metadata,
    generation.claimFile,
  );
  try {
    await handle.writeFile(`${JSON.stringify(claimRecord)}\n`, "utf8");
    const latestRequest = await readCurrentProbeRequest(paths);
    if (!sameRequest(latestRequest, request)) {
      await releaseOwnedClaimPath(claim);
      return { status: "none" };
    }
    const completedResult = await readCompletedProbeResult(paths, request);
    const requestAfterResult = await readCurrentProbeRequest(paths);
    if (!sameRequest(requestAfterResult, request)) {
      await releaseOwnedClaimPath(claim);
      return { status: "none" };
    }
    if (completedResult != null) {
      await releaseOwnedClaimPath(claim);
      return { status: "complete", result: publicProbeResult(completedResult) };
    }
    return claim;
  } catch (error) {
    await releaseOwnedClaimPath(claim).catch(() => false);
    throw error;
  }
}

export async function releaseEventWakeProbeClaim(config, claim, { runtimeRoot } = {}) {
  try {
    const paths = await validateProbeFiles(config, runtimeRoot);
    const generation = generationProbePaths(paths, claim?.probeId);
    if (claim?._claimFile !== generation.claimFile) return false;
    return releaseOwnedClaimPath(claim);
  } catch {
    return false;
  }
}

export async function writeEventWakeProbeResult(
  config,
  status,
  {
    runtimeRoot,
    now = Date.now,
    claim,
    afterRequestValidation = async () => {},
  } = {},
) {
  if (!PROBE_RESULT_STATUSES.has(status)) throw new Error("Invalid event-wake probe result");
  const paths = await validateProbeFiles(config, runtimeRoot);
  const observedAt = now();
  const request = await readCurrentProbeRequest(paths);
  if (
    !sameRequest(request, claim)
    || observedAt > request.expiresAt
  ) return false;
  const ownerMetadata = await claim?._fileHandle?.stat().catch(() => null);
  if (ownerMetadata?.dev !== claim?._device || ownerMetadata?.ino !== claim?._inode) return false;
  const generation = generationProbePaths(paths, claim.probeId);
  await validateGenerationFile(generation.resultFile);
  await afterRequestValidation({ probeId: claim.probeId });
  const requestBeforePublish = await readCurrentProbeRequest(paths);
  if (!sameRequest(requestBeforePublish, request) || observedAt > requestBeforePublish.expiresAt) return false;
  const result = {
    protocol: EVENT_WAKE_PROBE_PROTOCOL,
    status,
    probeId: request.probeId,
    armedAt: request.armedAt,
    claimedAt: claim.claimedAt,
    observedAt,
    expiresAt: request.expiresAt,
    installMode: request.installMode,
    runtimeFingerprint: request.runtimeFingerprint,
  };
  await writeProbeJsonAtomic(generation.resultFile, result);
  const requestAfterPublish = await readCurrentProbeRequest(paths);
  return sameRequest(requestAfterPublish, request);
}

export async function writeExpiredEventWakeProbeResult(
  config,
  request,
  { runtimeRoot, now = Date.now } = {},
) {
  const paths = await validateProbeFiles(config, runtimeRoot);
  const observedAt = now();
  const currentRequest = await readCurrentProbeRequest(paths);
  if (!sameRequest(currentRequest, request) || observedAt <= currentRequest.expiresAt) return false;
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
  checks.push({
    level: config?.installMode === mode && isRuntimeFingerprint(config?.runtimeFingerprint) ? "ok" : "error",
    name: "runtime-binding",
    message: config?.installMode === mode && isRuntimeFingerprint(config?.runtimeFingerprint)
      ? "Configuration is bound to a runtime fingerprint"
      : "Configuration is missing an exact install mode and runtime fingerprint binding",
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
      "setup",
      "uninstall",
      "doctor",
      "runtimeIntegrity",
    ].every(
      (name) => pluginBundle[name] === true,
    );
    checks.push({
      level: !bundleComplete ? "error" : (pluginBundle.enabledContext ? "ok" : "warning"),
      name: "plugin-bundle",
      message: !bundleComplete
        ? "Plugin manifest, Hook declaration, launcher, runtime, or administration script is missing"
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
    capabilityLevel = "error";
    capabilityMessage = "Capability probe is armed and pending the next lifecycle Hook";
  } else if (eventWakeProbe?.status === "expired") {
    capabilityLevel = "error";
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
    setup: "scripts/setup.mjs",
    uninstall: "scripts/uninstall.mjs",
    doctor: "scripts/doctor.mjs",
    runtimeIntegrity: "scripts/runtime-integrity.mjs",
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
