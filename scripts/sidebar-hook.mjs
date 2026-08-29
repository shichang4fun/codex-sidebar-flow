#!/usr/bin/env node

import { appendFile, chmod, mkdir, rename, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import {
  AppTools,
  loadConfig,
  loadManagedState,
  managedIdentity,
  updateManagedState,
} from "./sidebar-realtime.mjs";
import { normalizeLifecycleEnvelope, wakeOrganizer } from "./event-wake.mjs";
import {
  claimEventWakeProbe,
  releaseEventWakeProbeClaim,
  writeExpiredEventWakeProbeResult,
  writeEventWakeProbeResult,
} from "./doctor.mjs";
import { defaultConfig, INSTALL_MODE_ENV, writeJsonAtomic } from "./setup.mjs";
import { computeRuntimeFingerprint } from "./runtime-integrity.mjs";

const RUNTIME_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_CONFIG_PATH = process.env.CODEX_SIDEBAR_FLOW_CONFIG ?? path.join(os.homedir(), ".codex", "sidebar-flow", "config.json");
const DEFAULT_LOG_PATH = path.join(os.homedir(), ".codex", "sidebar-flow", "hook.log");
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_ATTEMPTS = 2;
const DEFAULT_HOOK_DEADLINE_MS = 9000;
const OBSERVATION_REQUIRED_TOOLS = ["list_threads", "read_thread"];
const EVENT_WAKE_REQUIRED_TOOLS = ["list_threads", "read_thread", "send_message_to_thread"];
const MAX_LOG_BYTES = 1024 * 1024;
const LIFECYCLE_ID_PATTERN = /^[A-Za-z0-9:_-]{1,256}$/;

export function selectLifecycleThread(snapshot, input) {
  const threadId = input?.session_id;
  if (typeof threadId !== "string" || !LIFECYCLE_ID_PATTERN.test(threadId) || threadId.startsWith("-")) {
    return { status: "invalid", thread: null, hostId: null };
  }
  const hasHostHint = Object.hasOwn(input ?? {}, "host_id");
  const hostId = hasHostHint ? input.host_id : null;
  if (
    hasHostHint
    && (typeof hostId !== "string" || !LIFECYCLE_ID_PATTERN.test(hostId) || hostId.startsWith("-"))
  ) {
    return { status: "invalid", thread: null, hostId: null };
  }
  const idMatches = (snapshot?.threads ?? []).filter((candidate) => candidate?.id === threadId);
  const candidates = hasHostHint
    ? idMatches.filter((candidate) => candidate?.hostId === hostId)
    : idMatches;
  if (candidates.length !== 1) {
    return {
      status: candidates.length > 1 ? "ambiguous" : "missing",
      thread: null,
      hostId: hasHostHint ? hostId : null,
    };
  }
  return {
    status: "selected",
    thread: candidates[0],
    hostId: candidates[0]?.hostId ?? (hasHostHint ? hostId : null),
  };
}

export function managedMutationFromLifecycle(snapshot, input, config) {
  const threadId = input?.session_id;
  const event = input?.hook_event_name;
  if (typeof threadId !== "string" || threadId.length === 0) return null;
  if (event !== "UserPromptSubmit") return null;
  if ((config.excludeThreadIds ?? []).includes(threadId)) return null;

  const thread = selectLifecycleThread(snapshot, input).thread;
  if (thread == null || thread.kind !== "codex" || !thread.hostId) return null;
  const identity = managedIdentity(thread.hostId, thread.id);
  if (identity == null) return null;
  return {
    action: "observe",
    identity,
    threadId: thread.id,
    hostId: thread.hostId,
  };
}

function authoritativeEventEnvelope(snapshot, input, config) {
  const threadId = input?.session_id;
  const event = input?.hook_event_name;
  if (typeof threadId !== "string" || threadId.length === 0) return null;
  if (!["UserPromptSubmit", "Stop"].includes(event)) return null;
  if (config?.eventWake?.enabled !== true) return null;
  if ((config.excludeThreadIds ?? []).includes(threadId)) return null;
  if (threadId === config?.eventWake?.organizerThreadId) return null;

  const thread = selectLifecycleThread(snapshot, input).thread;
  if (thread == null || thread.kind !== "codex" || typeof thread.hostId !== "string" || thread.hostId.length === 0) {
    return null;
  }
  return normalizeLifecycleEnvelope({
    event,
    threadId: thread.id,
    hostId: thread.hostId,
  });
}

async function readHookInput() {
  let source = "";
  for await (const chunk of process.stdin) source += chunk;
  return JSON.parse(source || "{}");
}

async function writeHookLog(logPath, payload) {
  const directory = path.dirname(logPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const metadata = await stat(logPath).catch(() => null);
  if (metadata?.size > MAX_LOG_BYTES) {
    await rename(logPath, `${logPath}.1`).catch(() => {});
  }
  const record = { at: new Date().toISOString(), ...payload };
  await appendFile(logPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(logPath, 0o600);
}

function safeError(error) {
  const code = typeof error?.code === "string" ? error.code : "HOOK_ERROR";
  const safeMessages = [
    /app tools pipe closed/i,
    /no live codex app-tools socket/i,
    /timed out (?:connecting to|calling)/i,
    /expected exactly one sidebar section/i,
    /missing built-in/i,
    /hook deadline exceeded/i,
  ];
  const message = String(error?.message ?? "");
  return {
    errorCode: code,
    error: safeMessages.some((pattern) => pattern.test(message)) ? message.slice(0, 240) : code,
  };
}

export function isRetryableHookError(error) {
  const retryableCodes = new Set([
    "APP_TOOLS_BACKOFF",
    "APP_TOOLS_RPC_ERROR",
    "ECONNREFUSED",
    "ECONNRESET",
    "EPIPE",
    "ETIMEDOUT",
  ]);
  if (retryableCodes.has(error?.code)) return true;
  return /app tools pipe closed|no live codex app-tools socket|timed out (?:connecting to|calling)|socket hang up/i.test(
    String(error?.message ?? ""),
  );
}

async function runBeforeDeadline(task, deadlineAt, now = Date.now) {
  const remainingMs = deadlineAt - now();
  if (remainingMs <= 0) {
    const error = new Error("Hook deadline exceeded");
    error.code = "HOOK_DEADLINE";
    throw error;
  }
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("Hook deadline exceeded");
          error.code = "HOOK_DEADLINE";
          reject(error);
        }, remainingMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function remainingDeadlineMs(deadlineAt, now = Date.now) {
  return Math.max(0, deadlineAt - now());
}

async function hydrateHookThread(snapshot, input, appTools, deadlineAt, now = Date.now) {
  const threadId = input.session_id;
  const threads = Array.isArray(snapshot.threads) ? snapshot.threads : [];
  const selection = selectLifecycleThread(snapshot, input);
  const existing = selection.thread;
  const mustRead = existing == null || !existing.hostId || !existing.kind;
  if (!mustRead) return snapshot;
  if (selection.status === "ambiguous" || selection.status === "invalid") return snapshot;
  const executionHostId = selection.hostId;
  if (typeof executionHostId !== "string" || executionHostId.length === 0) return snapshot;
  const result = await runBeforeDeadline(
    () => appTools.readThread(threadId, executionHostId),
    deadlineAt,
    now,
  );
  if (
    result?.thread == null
    || typeof result.thread !== "object"
    || result.thread.id !== threadId
    || result.thread.hostId !== executionHostId
  ) return snapshot;
  const hostId = result.thread.hostId;
  const kind = typeof result.thread.kind === "string" && result.thread.kind.length > 0
    ? result.thread.kind
    : existing?.kind;
  if (typeof hostId !== "string" || hostId.length === 0) return snapshot;
  if (typeof kind !== "string" || kind.length === 0) return snapshot;
  const hydrated = {
    ...existing,
    id: threadId,
    kind,
    hostId,
    projectId: result.thread?.projectId ?? existing?.projectId ?? input.project_id,
    status: result.thread?.status ?? existing?.status ?? "notLoaded",
    summary: null,
  };
  if (existing == null) threads.push(hydrated);
  else Object.assign(existing, hydrated);
  snapshot.threads = threads;
  return snapshot;
}

export async function executeHookEvent(
  input,
  config,
  {
    createAppTools = (runtimeConfig, options) => new AppTools(runtimeConfig, options),
    wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    attempts = DEFAULT_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    managedState = null,
    now = Date.now,
    deadlineMs = config.hookDeadlineMs ?? DEFAULT_HOOK_DEADLINE_MS,
    deadlineAt = now() + deadlineMs,
  } = {},
) {
  let lastError;
  if (input?.hook_event_name === "Stop") {
    const settleDelayMs = config.stopSettleDelayMs ?? 500;
    const availableMs = remainingDeadlineMs(deadlineAt, now);
    const boundedDelayMs = Math.min(settleDelayMs, availableMs);
    if (boundedDelayMs > 0) await wait(boundedDelayMs);
    if (boundedDelayMs < settleDelayMs || remainingDeadlineMs(deadlineAt, now) <= 0) {
      return {
        move: null,
        moves: [],
        managedState,
        managedAdds: [],
        managedRemoves: [],
        observedIdentities: [],
        eventEnvelope: null,
        attempts: 0,
      };
    }
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const appTools = createAppTools(config, { requiredTools: OBSERVATION_REQUIRED_TOOLS });
    try {
      let snapshot = await runBeforeDeadline(() => appTools.listThreads(), deadlineAt, now);
      snapshot = await hydrateHookThread(snapshot, input, appTools, deadlineAt, now);
      let nextManagedState = managedState;
      const managedAdds = [];
      const managedRemoves = [];
      const observedIdentities = [];
      const mutation = managedMutationFromLifecycle(snapshot, input, config);
      if (mutation?.action === "observe") observedIdentities.push(mutation.identity);
      const eventEnvelope = authoritativeEventEnvelope(snapshot, input, config);
      return {
        move: null,
        moves: [],
        managedState: nextManagedState,
        managedAdds,
        managedRemoves,
        observedIdentities,
        eventEnvelope,
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableHookError(error)) {
        error.hookAttempts = attempt;
        throw error;
      }
    } finally {
      appTools.reset();
    }
    await runBeforeDeadline(() => wait(retryDelayMs), deadlineAt, now);
  }
  throw lastError;
}

function boundedWakeResult(result) {
  if (result == null || typeof result !== "object") return null;
  const wakeStatus = sanitizeWakeStatus(result.status);
  const wakeErrorCode = sanitizeWakeErrorCode(result.errorCode);
  return wakeErrorCode == null ? { wakeStatus } : { wakeStatus, wakeErrorCode };
}

const STABLE_WAKE_ERROR_CODES = new Set([
  "invalid_config",
  "invalid_envelope",
  "invalid_state",
  "io_failure",
  "lock_unavailable",
  "rate_limited",
  "send_failed",
  "send_timeout",
  "wake_deadline",
  "wake_failed",
]);

function sanitizeWakeStatus(status) {
  return new Set(["disabled", "excluded", "failed", "rate_limited", "sent"]).has(status)
    ? status
    : "failed";
}

function sanitizeWakeErrorCode(errorCode) {
  if (typeof errorCode !== "string") return undefined;
  return STABLE_WAKE_ERROR_CODES.has(errorCode) ? errorCode : "wake_failed";
}

function boundedWakeThrown(error) {
  const wakeErrorCode = sanitizeWakeErrorCode(error?.code) ?? "wake_failed";
  return { wakeStatus: "failed", wakeErrorCode };
}

async function wakeBeforeDeadline(task, deadlineAt, now = Date.now) {
  const remainingMs = remainingDeadlineMs(deadlineAt, now);
  if (remainingMs <= 0) return { status: "failed", errorCode: "wake_deadline" };
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => task(controller.signal)),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({ status: "failed", errorCode: "wake_deadline" });
        }, remainingMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function inspectEventWakeCapability(appTools, deadlineAt, now = Date.now) {
  const host = await runBeforeDeadline(() => appTools.connect(), deadlineAt, now);
  return host?.toolMap instanceof Map && host.toolMap.has("send_message_to_thread");
}

function runtimeEventWakeConfig(config) {
  return {
    ...(config.eventWake ?? {}),
    wakeStateFile: config.wakeStateFile ?? config.eventWake?.wakeStateFile,
    excludeThreadIds: config.excludeThreadIds ?? [],
  };
}

export async function handleHook(
  input,
  configPath = DEFAULT_CONFIG_PATH,
  dependencies = {},
 ) {
  const {
    execute = executeHookEvent,
    createAppTools = (runtimeConfig, options) => new AppTools(runtimeConfig, options),
    load = dependencies.loadConfig ?? loadConfig,
    loadState = loadManagedState,
    updateManaged = updateManagedState,
    wake = wakeOrganizer,
    claimProbe = claimEventWakeProbe,
    releaseProbeClaim = releaseEventWakeProbeClaim,
    writeExpiredProbeResult = writeExpiredEventWakeProbeResult,
    writeProbeResult = writeEventWakeProbeResult,
    inspectCapability = inspectEventWakeCapability,
    computeRuntimeFingerprint: computeFingerprint = computeRuntimeFingerprint,
    now = Date.now,
  } = dependencies;
  if (!["UserPromptSubmit", "Stop"].includes(input?.hook_event_name)) return null;
  const installMode = process.env[INSTALL_MODE_ENV];
  if (!new Set(["source", "plugin"]).has(installMode)) {
    const error = new Error(`Missing or invalid ${INSTALL_MODE_ENV}`);
    error.code = "INSTALL_MODE_MISSING";
    throw error;
  }
  const actualRuntimeFingerprint = await computeFingerprint(RUNTIME_ROOT);
  let config;
  try {
    config = await load(configPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const codexHome = path.dirname(path.dirname(configPath));
    await writeJsonAtomic(
      configPath,
      defaultConfig(codexHome, installMode, actualRuntimeFingerprint),
    );
    config = await load(configPath);
  }
  if (config.installMode !== installMode) {
    const error = new Error(
      `Hook mode ${installMode} does not match configured mode ${config.installMode ?? "unrecorded"}`,
    );
    error.code = "INSTALL_MODE_MISMATCH";
    throw error;
  }
  if (config.runtimeFingerprint !== actualRuntimeFingerprint) {
    const error = new Error("Hook runtime does not match the configured runtime fingerprint");
    error.code = "RUNTIME_FINGERPRINT_MISMATCH";
    throw error;
  }
  config.actorThreadId = input.session_id;
  config.quiet = true;
  config.discoveryTimeoutMs = Math.min(config.discoveryTimeoutMs, 1500);
  config.socketProbeTimeoutMs = Math.min(config.socketProbeTimeoutMs, 500);
  config.maxSocketCandidates = Math.min(config.maxSocketCandidates, 4);
  config.requestTimeoutMs = Math.min(config.requestTimeoutMs, 2000);

  const startedAt = now();
  const deadlineAt = startedAt + (config.hookDeadlineMs ?? DEFAULT_HOOK_DEADLINE_MS);
  const probeRuntimeRoot = path.dirname(configPath);
  const probeClaim = await claimProbe(config, { runtimeRoot: probeRuntimeRoot, now });
  let eventWakeProbeStatus = null;
  if (probeClaim.status === "expired") {
    eventWakeProbeStatus = "expired";
    await writeExpiredProbeResult(config, probeClaim, {
      runtimeRoot: probeRuntimeRoot,
      now,
    }).catch(() => false);
  } else if (probeClaim.status === "claimed") {
    const probeTools = createAppTools(config, { requiredTools: OBSERVATION_REQUIRED_TOOLS });
    try {
      const present = await inspectCapability(probeTools, deadlineAt, now);
      const status = present ? "present" : "missing";
      const committed = await writeProbeResult(config, status, {
        runtimeRoot: probeRuntimeRoot,
        now,
        claim: probeClaim,
      });
      eventWakeProbeStatus = committed ? status : "pending";
    } catch {
      eventWakeProbeStatus = "pending";
    } finally {
      probeTools.reset?.();
      await releaseProbeClaim(config, probeClaim, { runtimeRoot: probeRuntimeRoot }).catch(() => false);
    }
  }
  const managedState = await loadState(config.stateFile);
  const result = await execute(input, config, {
    managedState,
    deadlineAt,
    now,
    createAppTools,
  });
  await updateManaged(config.stateFile, {
    add: result.managedAdds,
    remove: result.managedRemoves,
    observe: result.observedIdentities,
  });
  let wakeOutcome = null;
  if (result.eventEnvelope != null && probeClaim.status !== "claimed" && now() < deadlineAt) {
    const wakeTools = createAppTools(config, { requiredTools: EVENT_WAKE_REQUIRED_TOOLS });
    try {
      wakeOutcome = boundedWakeResult(
        await wakeBeforeDeadline(
          (signal) => wake(result.eventEnvelope, runtimeEventWakeConfig(config), wakeTools, {
            signal,
            canDispatch: () => now() < deadlineAt,
          }),
          deadlineAt,
          now,
        ),
      );
    } catch (error) {
      wakeOutcome = boundedWakeThrown(error);
    } finally {
      wakeTools.reset?.();
    }
  } else if (result.eventEnvelope != null && probeClaim.status !== "claimed") {
    wakeOutcome = { wakeStatus: "failed", wakeErrorCode: "wake_deadline" };
  }
  await writeHookLog(config.hookLogFile ?? DEFAULT_LOG_PATH, {
    event: input.hook_event_name,
    destination: null,
    observationOnly: true,
    attempts: result.attempts,
    pid: process.pid,
    ppid: process.ppid,
    execPath: process.execPath,
    hasPipe: Boolean(process.env.CODEX_APP_TOOLS_PIPE_PATH),
    pipeBasename: path.basename(process.env.CODEX_APP_TOOLS_PIPE_PATH ?? ""),
    toolsListSucceeded: true,
    durationMs: now() - startedAt,
    ...(eventWakeProbeStatus == null ? {} : { eventWakeProbeStatus }),
    ...wakeOutcome,
  });
  return null;
}

async function main() {
  let input = {};
  try {
    input = await readHookInput();
    await handleHook(input);
  } catch (error) {
    const safe = safeError(error);
    await writeHookLog(DEFAULT_LOG_PATH, {
      event: input?.hook_event_name ?? "unknown",
      threadId: input?.session_id ?? null,
      attempts: error?.hookAttempts ?? 1,
      pid: process.pid,
      ppid: process.ppid,
      execPath: process.execPath,
      hasPipe: Boolean(process.env.CODEX_APP_TOOLS_PIPE_PATH),
      pipeBasename: path.basename(process.env.CODEX_APP_TOOLS_PIPE_PATH ?? ""),
      toolsListSucceeded: false,
      ...safe,
    }).catch(() => {});
  }
  process.stdout.write("{}\n");
}

const isMain = process.argv[1] != null && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) void main();
