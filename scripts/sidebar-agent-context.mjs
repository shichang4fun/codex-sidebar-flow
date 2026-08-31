#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeRuntimeFingerprint,
  isRuntimeFingerprint,
} from "./runtime-integrity.mjs";
import { validateSectionNames } from "./sidebar-policy.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9:_-]{1,256}$/;
const PHASES = new Set(["start", "finish"]);

function safeIdentifier(value) {
  return typeof value === "string"
    && value.trim() === value
    && SAFE_IDENTIFIER_PATTERN.test(value);
}

export function rootTaskId(env = process.env) {
  const threadId = env.CODEX_THREAD_ID;
  const sessionId = env.CODEX_SESSION_ID;
  if (!safeIdentifier(threadId) || !safeIdentifier(sessionId) || threadId !== sessionId) return null;
  return threadId;
}

export function validAgentTransitionConfig(config) {
  return config?.agentTransitions?.enabled === true
    && safeIdentifier(config.actorThreadId)
    && Array.isArray(config.excludeThreadIds)
    && config.excludeThreadIds.length <= 1000
    && config.excludeThreadIds.every(safeIdentifier)
    && Number.isInteger(config.listLimit)
    && config.listLimit >= 1
    && config.listLimit <= 50;
}

export async function resolveAgentTransitionContext({
  phase,
  env = process.env,
  configPath = env.CODEX_SIDEBAR_FLOW_CONFIG
    ?? path.join(env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sidebar-flow", "config.json"),
  runtimeRoot = ROOT,
} = {}, dependencies = {}) {
  if (!PHASES.has(phase)) {
    const error = new Error("phase must be start or finish");
    error.code = "INVALID_ARGUMENT";
    throw error;
  }
  const threadId = rootTaskId(env);
  if (threadId == null) return { eligible: false, reason: "not_root_task" };

  let config;
  try {
    config = JSON.parse(await (dependencies.readFile ?? readFile)(configPath, "utf8"));
  } catch {
    return { eligible: false, reason: "config_unavailable" };
  }
  if (config.agentTransitions?.enabled !== true) {
    return { eligible: false, reason: "disabled" };
  }
  if (!validAgentTransitionConfig(config)) return { eligible: false, reason: "invalid_config" };
  if (
    threadId === config.actorThreadId
    || (Array.isArray(config.excludeThreadIds) && config.excludeThreadIds.includes(threadId))
  ) return { eligible: false, reason: "excluded" };

  if (
    !new Set(["source", "plugin"]).has(config.installMode)
    || !isRuntimeFingerprint(config.runtimeFingerprint)
  ) return { eligible: false, reason: "runtime_binding" };
  try {
    const actual = await (dependencies.computeRuntimeFingerprint ?? computeRuntimeFingerprint)(
      runtimeRoot,
      config.installMode,
    );
    if (actual !== config.runtimeFingerprint) {
      return { eligible: false, reason: "runtime_binding" };
    }
  } catch {
    return { eligible: false, reason: "runtime_binding" };
  }

  let sections;
  try {
    sections = validateSectionNames(config.sections);
  } catch {
    return { eligible: false, reason: "invalid_sections" };
  }
  return {
    eligible: true,
    phase,
    threadId,
    sections,
    listLimit: config.listLimit,
  };
}

function parseArgs(argv) {
  const phase = argv[0];
  const result = { phase };
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === "--config") {
      const value = argv[index + 1];
      if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\r\n]/.test(value)) {
        throw new Error("--config requires a single-line value");
      }
      result.configPath = value;
      index += 1;
    } else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return result;
}

const isMain = process.argv[1] != null
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  resolveAgentTransitionContext(parseArgs(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`sidebar agent context failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
