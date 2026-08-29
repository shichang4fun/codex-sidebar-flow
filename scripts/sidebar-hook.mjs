#!/usr/bin/env node

import { appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import {
  AppTools,
  forgetManagedThread,
  hydrateCustomThreads,
  loadConfig,
  loadManagedState,
  planMoves,
  recordSnapshotActivity,
  saveManagedState,
  sidebarMembershipForThread,
} from "./sidebar-realtime.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = process.env.CODEX_SIDEBAR_FLOW_CONFIG ?? path.join(os.homedir(), ".codex", "sidebar-flow", "config.json");
const DEFAULT_LOG_PATH = path.join(os.homedir(), ".codex", "sidebar-flow", "hook.log");
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_ATTEMPTS = 2;

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
  if (pinned == null || tasks == null) throw new Error("Missing built-in Tasks or Pinned section");

  const thread = (snapshot.threads ?? []).find((candidate) => candidate.id === threadId) ?? {
    id: threadId,
    hostId: input.host_id,
    projectId: input.project_id,
  };
  const membership = sidebarMembershipForThread(sections, thread);
  if (membership == null) return null;
  if ([pinned.sectionId, forLater.sectionId].includes(membership.sectionId)) return null;

  let destination = null;
  if (
    event === "UserPromptSubmit" &&
    [tasks.sectionId, forReview.sectionId].includes(membership.sectionId)
  ) {
    destination = inProgress;
  } else if (event === "Stop" && membership.sectionId === inProgress.sectionId) {
    destination = forReview;
  }
  if (destination == null || destination.sectionId === membership.sectionId) return null;

  return {
    threadId,
    hostId: thread.hostId ?? membership.itemHostId,
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
  const record = { at: new Date().toISOString(), ...payload };
  await appendFile(logPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function isRetryableHookError(error) {
  const retryableCodes = new Set([
    "APP_TOOLS_BACKOFF",
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

export async function executeHookMove(
  input,
  config,
  {
    createAppTools = () => new AppTools(config),
    wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    attempts = DEFAULT_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    managedState = null,
  } = {},
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const appTools = createAppTools();
    try {
      const snapshot = await hydrateCustomThreads(await appTools.listThreads(), config, appTools);
      let nextManagedState = recordSnapshotActivity(managedState, snapshot);
      const move = planHookMove(snapshot, input, config);
      const globalMoves = planMoves(
        snapshot,
        config,
        new Set(nextManagedState.managedThreadIds),
      ).filter((candidate) => candidate.threadId !== input.session_id);
      const moves = [...(move == null ? [] : [move]), ...globalMoves];
      for (const candidate of moves) {
        await appTools.moveThread(candidate);
        if (candidate.sectionName === config.sections.forReview) {
          nextManagedState = forgetManagedThread(
            nextManagedState,
            candidate.threadId,
            candidate.hostId,
          );
        }
      }
      return { move, moves, managedState: nextManagedState, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableHookError(error)) {
        error.hookAttempts = attempt;
        throw error;
      }
    } finally {
      appTools.reset();
    }
    await wait(retryDelayMs);
  }
  throw lastError;
}

export async function handleHook(input, configPath = DEFAULT_CONFIG_PATH) {
  if (!["UserPromptSubmit", "Stop"].includes(input?.hook_event_name)) return null;
  const config = await loadConfig(configPath);
  config.actorThreadId = input.session_id;
  config.quiet = true;
  config.discoveryTimeoutMs = Math.min(config.discoveryTimeoutMs, 1500);
  config.socketProbeTimeoutMs = Math.min(config.socketProbeTimeoutMs, 500);
  config.maxSocketCandidates = Math.min(config.maxSocketCandidates, 4);
  config.requestTimeoutMs = Math.min(config.requestTimeoutMs, 5000);

  const startedAt = Date.now();
  const managedState = await loadManagedState(config.stateFile);
  const result = await executeHookMove(input, config, { managedState });
  await saveManagedState(config.stateFile, result.managedState);
  await writeHookLog(config.hookLogFile ?? DEFAULT_LOG_PATH, {
    event: input.hook_event_name,
    threadId: input.session_id,
    destination: result.move?.sectionName ?? null,
    reconciliationMoves: result.moves.length - (result.move == null ? 0 : 1),
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
      error: error.message,
    }).catch(() => {});
  }
  process.stdout.write("{}\n");
}

const isMain = process.argv[1] != null && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) void main();
