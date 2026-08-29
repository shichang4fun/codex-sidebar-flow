#!/usr/bin/env node

import { appendFile, chmod, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import {
  AppTools,
  loadConfig,
  loadManagedState,
  managedIdentity,
  membershipIsProtected,
  normalizedThreadStatus,
  recordSessionActivity,
  sidebarMembershipForThread,
  statusFromThreadRead,
  updateManagedState,
} from "./sidebar-realtime.mjs";
import { defaultConfig, writeJsonAtomic } from "./setup.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = process.env.CODEX_SIDEBAR_FLOW_CONFIG ?? path.join(os.homedir(), ".codex", "sidebar-flow", "config.json");
const DEFAULT_LOG_PATH = path.join(os.homedir(), ".codex", "sidebar-flow", "hook.log");
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_ATTEMPTS = 2;
const DEFAULT_HOOK_DEADLINE_MS = 9000;
const MAX_LOG_BYTES = 1024 * 1024;

function exactSection(sections, name) {
  const matches = sections.filter((section) => section.name === name);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one sidebar section named ${name}; found ${matches.length}`);
  }
  return matches[0];
}

export function planHookMove(snapshot, input, config) {
  const threadId = input?.session_id;
  const event = input?.hook_event_name;
  if (typeof threadId !== "string" || threadId.length === 0) return null;
  if (!new Set(["UserPromptSubmit", "Stop"]).has(event)) return null;
  if ((config.excludeThreadIds ?? []).includes(threadId)) return null;

  const sections = Array.isArray(snapshot?.sections) ? snapshot.sections : [];
  const inProgress = exactSection(sections, config.sections.inProgress);
  const forReview = exactSection(sections, config.sections.forReview);
  const forLater = exactSection(sections, config.sections.forLater);
  const pinned = sections.find((section) => section.sectionId === "pinned");
  const tasks = sections.find((section) => section.sectionId === "chats");
  const projects = sections.find((section) => section.sectionId === "threads");
  if (pinned == null || tasks == null || projects == null) {
    throw new Error("Missing built-in Projects, Tasks, or Pinned section");
  }

  const thread = (snapshot.threads ?? []).find((candidate) => candidate.id === threadId);
  if (thread == null || thread.kind !== "codex" || !thread.hostId) return null;
  const membership = sidebarMembershipForThread(sections, thread);
  if (membership == null) return null;
  if (membershipIsProtected(membership, new Set([pinned.sectionId, forLater.sectionId]))) return null;

  let destination = null;
  if (
    event === "UserPromptSubmit" &&
    (
      [tasks.sectionId, forReview.sectionId].includes(membership.sectionId) ||
      (membership.viaProject && membership.sectionId === projects.sectionId)
    )
  ) {
    destination = inProgress;
  } else if (
    event === "Stop" &&
    new Set(["idle", "completed", "needsattention"]).has(normalizedThreadStatus(thread)) &&
    (
      membership.sectionId === inProgress.sectionId ||
      (membership.viaProject && membership.sectionId === projects.sectionId)
    )
  ) {
    destination = forReview;
  }
  if (destination == null || destination.sectionId === membership.sectionId) return null;

  return {
    threadId,
    hostId: thread.hostId,
    sectionId: destination.sectionId,
    sectionName: destination.name,
  };
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

async function runBeforeDeadline(task, deadlineAt) {
  const remainingMs = deadlineAt - Date.now();
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

async function hydrateHookThread(snapshot, input, appTools, deadlineAt) {
  const threadId = input.session_id;
  const threads = Array.isArray(snapshot.threads) ? snapshot.threads : [];
  const existing = threads.find((thread) => thread.id === threadId);
  const mustRead = existing == null || input.hook_event_name === "Stop" || !existing.hostId;
  if (!mustRead) return snapshot;
  const result = await runBeforeDeadline(
    () => appTools.readThread(threadId, existing?.hostId ?? input.host_id),
    deadlineAt,
  );
  const hostId = result.thread?.hostId ?? existing?.hostId ?? input.host_id;
  if (typeof hostId !== "string" || hostId.length === 0) return snapshot;
  const hydrated = {
    ...existing,
    id: result.thread?.id ?? threadId,
    kind: result.thread?.kind ?? existing?.kind ?? "codex",
    hostId,
    projectId: result.thread?.projectId ?? existing?.projectId ?? input.project_id,
    status: statusFromThreadRead(result),
    summary: null,
  };
  if (existing == null) threads.push(hydrated);
  else Object.assign(existing, hydrated);
  snapshot.threads = threads;
  return snapshot;
}

export async function executeHookMove(
  input,
  config,
  {
    createAppTools = () => new AppTools(config),
    wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    attempts = DEFAULT_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    managedState = null,
    deadlineMs = config.hookDeadlineMs ?? DEFAULT_HOOK_DEADLINE_MS,
  } = {},
) {
  const deadlineAt = Date.now() + deadlineMs;
  if (input.hook_event_name === "Stop") {
    await runBeforeDeadline(
      () => wait(Math.min(config.stopSettleDelayMs ?? 500, Math.max(0, deadlineAt - Date.now()))),
      deadlineAt,
    );
  }
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const appTools = createAppTools();
    try {
      let snapshot = await runBeforeDeadline(() => appTools.listThreads(), deadlineAt);
      snapshot = await hydrateHookThread(snapshot, input, appTools, deadlineAt);
      let nextManagedState = managedState;
      const move = planHookMove(snapshot, input, config);
      const managedAdds = [];
      const managedRemoves = [];
      if (move != null) {
        await runBeforeDeadline(() => appTools.moveThread(move), deadlineAt);
        const identity = managedIdentity(move.hostId, move.threadId);
        if (move.sectionName === config.sections.inProgress && identity != null) {
          managedAdds.push(identity);
          nextManagedState = recordSessionActivity(nextManagedState, move.threadId, Date.now(), move.hostId);
        } else if (move.sectionName === config.sections.forReview && identity != null) {
          managedRemoves.push(identity);
          nextManagedState = {
            ...nextManagedState,
            managedThreadIds: (nextManagedState?.managedThreadIds ?? []).filter((value) => value !== identity),
          };
        }
      }
      return { move, moves: move == null ? [] : [move], managedState: nextManagedState, managedAdds, managedRemoves, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableHookError(error)) {
        error.hookAttempts = attempt;
        throw error;
      }
    } finally {
      appTools.reset();
    }
    await runBeforeDeadline(() => wait(retryDelayMs), deadlineAt);
  }
  throw lastError;
}

export async function handleHook(input, configPath = DEFAULT_CONFIG_PATH) {
  if (!["UserPromptSubmit", "Stop"].includes(input?.hook_event_name)) return null;
  let config;
  try {
    config = await loadConfig(configPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const codexHome = path.dirname(path.dirname(configPath));
    await writeJsonAtomic(configPath, defaultConfig(codexHome));
    config = await loadConfig(configPath);
  }
  config.actorThreadId = input.session_id;
  config.quiet = true;
  config.discoveryTimeoutMs = Math.min(config.discoveryTimeoutMs, 1500);
  config.socketProbeTimeoutMs = Math.min(config.socketProbeTimeoutMs, 500);
  config.maxSocketCandidates = Math.min(config.maxSocketCandidates, 4);
  config.requestTimeoutMs = Math.min(config.requestTimeoutMs, 2000);

  const startedAt = Date.now();
  const managedState = await loadManagedState(config.stateFile);
  const result = await executeHookMove(input, config, { managedState });
  await updateManagedState(config.stateFile, {
    add: result.managedAdds,
    remove: result.managedRemoves,
  });
  await writeHookLog(config.hookLogFile ?? DEFAULT_LOG_PATH, {
    event: input.hook_event_name,
    threadId: input.session_id,
    destination: result.move?.sectionName ?? null,
    attempts: result.attempts,
    pid: process.pid,
    ppid: process.ppid,
    execPath: process.execPath,
    hasPipe: Boolean(process.env.CODEX_APP_TOOLS_PIPE_PATH),
    pipeBasename: path.basename(process.env.CODEX_APP_TOOLS_PIPE_PATH ?? ""),
    toolsListSucceeded: true,
    durationMs: Date.now() - startedAt,
  });
  return result.move;
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

const isMain = process.argv[1] != null && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) void main();
