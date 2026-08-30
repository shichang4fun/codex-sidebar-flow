#!/usr/bin/env node

import { chmod, copyFile, link, lstat, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { constants, existsSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeRuntimeFingerprint,
  ensureRealDirectory,
  isRuntimeFingerprint,
  revalidateRealDirectory,
  RUNTIME_FILES,
} from "./runtime-integrity.mjs";
import { validateSectionNames } from "./sidebar-policy.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const HOOK_MARKER = "CODEX_SIDEBAR_FLOW_OWNER=codex-sidebar-flow-v1";
export const AGENT_TRANSITIONS_START = "<!-- CODEX_SIDEBAR_FLOW_AGENT_TRANSITIONS_START -->";
export const AGENT_TRANSITIONS_END = "<!-- CODEX_SIDEBAR_FLOW_AGENT_TRANSITIONS_END -->";
export const INSTALL_MODE_ENV = "CODEX_SIDEBAR_FLOW_INSTALL_MODE";
export const CURRENT_CONFIG_VERSION = 3;
export const DEFAULT_HOOK_DEADLINE_MS = 14000;
export const DEFAULT_STOP_SETTLE_DELAY_MS = 3000;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9:_-]{1,256}$/;

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

export function hookCommand(
  root = ROOT,
  nodeExecutable = detectNodeExecutable(),
  configPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sidebar-flow", "config.json"),
) {
  return `exec /usr/bin/env -u FORCE_COLOR ${HOOK_MARKER} ${INSTALL_MODE_ENV}=source CODEX_SIDEBAR_FLOW_CONFIG=${quote(configPath)} ${quote(nodeExecutable)} ${quote(path.join(root, "scripts", "sidebar-hook.mjs"))}`;
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

export function findOwnedSidebarHookPaths(existing = {}) {
  const paths = new Set();
  for (const event of ["UserPromptSubmit", "Stop"]) {
    for (const matcher of existing.hooks?.[event] ?? []) {
      for (const hook of matcher?.hooks ?? []) {
        if (typeof hook?.command !== "string" || !hook.command.includes(HOOK_MARKER)) continue;
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
    const handler = {
      type: "command",
      command,
      timeout: event === "Stop" ? 20 : 15,
      ...(event === "Stop" ? { async: true } : {}),
    };
    matchers.push({ hooks: [handler] });
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
  await ensureRealDirectory(directory, { create: true, label: "JSON parent directory" });
  await chmod(directory, 0o700);
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, filePath);
}

export async function readAgentInstructionsFile(filePath) {
  const metadata = await lstat(filePath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (metadata == null) return { exists: false, content: "", mode: 0o600 };
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    const error = new Error(`Global agent instructions must be a regular file: ${filePath}`);
    error.code = "UNSAFE_AGENT_INSTRUCTIONS";
    throw error;
  }
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      const error = new Error(`Global agent instructions changed while being read: ${filePath}`);
      error.code = "AGENT_INSTRUCTIONS_CHANGED";
      throw error;
    }
    return {
      exists: true,
      content: await handle.readFile("utf8"),
      mode: opened.mode & 0o777,
      identity: { dev: opened.dev, ino: opened.ino },
    };
  } finally {
    await handle?.close();
  }
}

async function writeTextAtomic(filePath, value, current) {
  await ensureRealDirectory(path.dirname(filePath), { create: true, label: "Agent instructions directory" });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, value, { encoding: "utf8", mode: current.mode, flag: "wx" });
    const latest = await readAgentInstructionsFile(filePath);
    const unchanged = current.exists === latest.exists
      && current.content === latest.content
      && (
        !current.exists
        || (
          current.identity.dev === latest.identity.dev
          && current.identity.ino === latest.identity.ino
          && current.mode === latest.mode
        )
      );
    if (!unchanged) {
      const error = new Error(`Global agent instructions changed during setup: ${filePath}`);
      error.code = "AGENT_INSTRUCTIONS_CHANGED";
      throw error;
    }
    await rename(temporaryPath, filePath);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

function markerCount(content, marker) {
  return content.split(marker).length - 1;
}

export function removeAgentTransitionInstructions(content = "") {
  const starts = markerCount(content, AGENT_TRANSITIONS_START);
  const ends = markerCount(content, AGENT_TRANSITIONS_END);
  if (starts === 0 && ends === 0) return content;
  if (starts !== 1 || ends !== 1) {
    const error = new Error("Malformed Sidebar Flow block in global agent instructions");
    error.code = "MALFORMED_AGENT_INSTRUCTIONS";
    throw error;
  }
  const start = content.indexOf(AGENT_TRANSITIONS_START);
  const end = content.indexOf(AGENT_TRANSITIONS_END, start) + AGENT_TRANSITIONS_END.length;
  if (end <= start || content.indexOf(AGENT_TRANSITIONS_END) < start) {
    const error = new Error("Malformed Sidebar Flow block in global agent instructions");
    error.code = "MALFORMED_AGENT_INSTRUCTIONS";
    throw error;
  }
  const before = content.slice(0, start).trimEnd();
  const after = content.slice(end).trimStart();
  const joined = [before, after].filter((part) => part.length > 0).join("\n\n");
  return joined.length > 0 ? `${joined}\n` : "";
}

function safeMarkdownCommand(value, label) {
  if (typeof value !== "string" || /[`\r\n]/.test(value)) {
    const error = new Error(`${label} cannot be embedded in managed agent instructions`);
    error.code = "UNSAFE_AGENT_INSTRUCTIONS";
    throw error;
  }
  return quote(value);
}

export function agentTransitionInstructions({ runtimeRoot, configPath, nodeExecutable }) {
  const command = [
    safeMarkdownCommand(nodeExecutable, "Node executable"),
    safeMarkdownCommand(path.join(runtimeRoot, "scripts", "sidebar-agent-context.mjs"), "Runtime path"),
  ].join(" ");
  const configArgument = safeMarkdownCommand(configPath, "Configuration path");
  return `${AGENT_TRANSITIONS_START}
## Codex Sidebar Flow managed lifecycle

Apply this workflow only to the root Codex task. At the first tool opportunity in every user turn, run \`${command} start --config ${configArgument}\`. Immediately before a successful final response, run the same command with \`finish\`. If the command fails or returns \`eligible:false\`, do nothing else for this workflow.

When it returns \`eligible:true\`, use only Codex task-management tools and structured fields. Call \`list_threads\` once with the returned limit and select exactly one Codex task whose ID equals the returned \`threadId\`; never use title, summary, prompt, or output text to identify it. Resolve each returned destination name to exactly one non-built-in custom section, require the three section IDs to be distinct, and fail closed on missing or duplicate names. Resolve membership from the real task or parent Project item key, but use the task's actual \`hostId\` for every \`read_thread\` and move. A task with no direct membership is eligible through its parent Project only when that Project has exactly one membership and it is the built-in Projects section. Fail closed on a missing or duplicate identity, multiple direct or Project memberships, tool error, archived task, non-Codex task, Pinned, For Later, or an excluded/protected parent Project. Never move a Project object.

For \`start\`, require the exact \`read_thread\` to confirm active status with no approval/user-input attention flag; move only the current task from Tasks, For Review, or an eligible Project task to the returned In Progress section, unless already there. For \`finish\`, act only when the current agent is genuinely about to return a successful final response and is not blocked or waiting for input; the exact read may still report active during finalization. Move only the current task from Tasks, In Progress, or an eligible Project task to the returned For Review section, unless already there. Perform at most one move per phase.
${AGENT_TRANSITIONS_END}`;
}

export async function syncAgentTransitionInstructions({
  codexHome,
  enabled,
  runtimeRoot,
  configPath,
  nodeExecutable = detectNodeExecutable(),
  dryRun = false,
}) {
  const agentsPath = path.join(codexHome, "AGENTS.md");
  const overridePath = path.join(codexHome, "AGENTS.override.md");
  const [agents, override] = await Promise.all([
    readAgentInstructionsFile(agentsPath),
    readAgentInstructionsFile(overridePath),
  ]);
  const activePath = override.content.trim().length > 0 ? overridePath : agentsPath;
  const block = enabled
    ? agentTransitionInstructions({ runtimeRoot, configPath, nodeExecutable })
    : null;
  const updates = [];
  for (const [filePath, current] of [[agentsPath, agents], [overridePath, override]]) {
    let content = removeAgentTransitionInstructions(current.content);
    if (enabled && filePath === activePath) {
      content = content.trimEnd();
      content = content.length > 0 ? `${content}\n\n${block}\n` : `${block}\n`;
    }
    if (content !== current.content) updates.push({ filePath, current, content });
  }
  if (!dryRun) {
    for (const update of updates) {
      if (update.current.exists) {
        await writePrivateContentBackup(update.current.content, `${update.filePath}.sidebar-flow.bak`);
      }
      await writeTextAtomic(update.filePath, update.content, update.current);
    }
  }
  return { enabled, activePath, changedPaths: updates.map((update) => update.filePath) };
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

async function writePrivateContentBackup(content, backupPath) {
  if (existsSync(backupPath)) return false;
  const temporaryPath = `${backupPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, { mode: 0o600, flag: "wx" });
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

export function defaultConfig(codexHome, installMode = null, runtimeFingerprint = null) {
  if (installMode != null && !isRuntimeFingerprint(runtimeFingerprint)) {
    throw new Error("A runtime fingerprint is required for an installed configuration");
  }
  const runtime = path.join(codexHome, "sidebar-flow");
  return {
    configVersion: CURRENT_CONFIG_VERSION,
    ...(installMode == null ? {} : { installMode }),
    ...(runtimeFingerprint == null ? {} : { runtimeFingerprint }),
    actorThreadId: "codex-sidebar-flow",
    sections: {
      inProgress: "In Progress",
      forReview: "For Review",
      forLater: "For Later",
    },
    excludeThreadIds: [],
    eventWake: {
      enabled: false,
      organizerThreadId: null,
      organizerHostId: "local",
      maxPerMinute: 20,
    },
    agentTransitions: {
      enabled: false,
    },
    wakeStateFile: path.join(runtime, "wake-state.json"),
    eventWakeProbeRequestFile: path.join(runtime, "event-wake-probe-request.json"),
    eventWakeProbeResultFile: path.join(runtime, "event-wake-probe-result.json"),
    eventWakeProbeTtlMs: 300000,
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
    hookDeadlineMs: DEFAULT_HOOK_DEADLINE_MS,
    stopSettleDelayMs: DEFAULT_STOP_SETTLE_DELAY_MS,
  };
}

async function verifyRelease(releaseRoot, expectedFingerprint) {
  const metadata = await lstat(releaseRoot);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Runtime release must be a real directory");
  }
  const actualFingerprint = await computeRuntimeFingerprint(releaseRoot, "source");
  if (actualFingerprint !== expectedFingerprint) {
    const error = new Error("Runtime release fingerprint mismatch");
    error.code = "RUNTIME_FINGERPRINT_MISMATCH";
    throw error;
  }
}

async function publishSourceRelease(
  runtimeRoot,
  sourceRoot,
  runtimeFingerprint,
  { copyRuntimeFile = copyFile, renameRuntimeRelease = rename } = {},
) {
  const releasesRoot = path.join(runtimeRoot, "releases");
  const releaseRoot = path.join(releasesRoot, runtimeFingerprint);
  await mkdir(releasesRoot, { recursive: true, mode: 0o700 });
  const releasesMetadata = await lstat(releasesRoot);
  if (releasesMetadata.isSymbolicLink() || !releasesMetadata.isDirectory()) {
    throw new Error("Runtime releases root must be a real directory, not a symlink");
  }
  await chmod(releasesRoot, 0o700);
  const existing = await lstat(releaseRoot).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing != null) {
    await verifyRelease(releaseRoot, runtimeFingerprint);
    return releaseRoot;
  }

  const stagingRoot = path.join(releasesRoot, `.staging-${process.pid}-${randomUUID()}`);
  try {
    await mkdir(stagingRoot, { mode: 0o700 });
    for (const relativePath of RUNTIME_FILES) {
      const destination = path.join(stagingRoot, relativePath);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await copyRuntimeFile(path.join(sourceRoot, relativePath), destination);
    }
    const stagedFingerprint = await computeRuntimeFingerprint(stagingRoot, "source");
    if (stagedFingerprint !== runtimeFingerprint) {
      const error = new Error("Staged runtime fingerprint mismatch");
      error.code = "RUNTIME_FINGERPRINT_MISMATCH";
      throw error;
    }
    try {
      await renameRuntimeRelease(stagingRoot, releaseRoot);
    } catch (error) {
      if (!new Set(["EEXIST", "ENOTEMPTY"]).has(error.code)) throw error;
      await verifyRelease(releaseRoot, runtimeFingerprint);
    }
    await verifyRelease(releaseRoot, runtimeFingerprint);
    return releaseRoot;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

export async function setup({
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  dryRun = false,
  mode = "source",
  migrateLegacyHookPaths = [],
  enableEventWake = false,
  organizerThreadId,
  organizerHostId,
  eventWakeMaxPerMinute,
  agentTransitionsEnabled,
} = {}, dependencies = {}) {
  if (!new Set(["source", "plugin"]).has(mode)) throw new Error(`Unknown setup mode: ${mode}`);
  if (!isSingleLine(codexHome, 4096) || !path.isAbsolute(codexHome)) {
    const error = new Error(`CODEX_HOME must be an absolute path: ${codexHome}`);
    error.code = "INVALID_CODEX_HOME";
    throw error;
  }
  const runtimeCodexHome = dependencies.runtimeCodexHome
    ?? process.env.CODEX_HOME
    ?? path.join(os.homedir(), ".codex");
  if (mode === "plugin" && path.resolve(codexHome) !== path.resolve(runtimeCodexHome)) {
    const error = new Error(
      "Plugin setup must use the CODEX_HOME inherited by the plugin runtime; set CODEX_HOME before setup instead of passing a different path",
    );
    error.code = "PLUGIN_CODEX_HOME_MISMATCH";
    throw error;
  }
  if (enableEventWake && organizerThreadId == null) {
    throw invalidArgument("--enable-event-wake requires --organizer-thread-id");
  }
  if (organizerThreadId != null && !isSafeIdentifier(organizerThreadId)) {
    throw invalidArgument("Invalid organizerThreadId");
  }
  if (organizerHostId != null && !isSafeIdentifier(organizerHostId)) {
    throw invalidArgument("Invalid organizerHostId");
  }
  if (
    eventWakeMaxPerMinute != null
    && (!Number.isInteger(eventWakeMaxPerMinute) || eventWakeMaxPerMinute <= 0)
  ) {
    throw invalidArgument("event-wake max per minute must be a positive integer");
  }
  const runtimeRoot = path.join(codexHome, "sidebar-flow");
  const runtimeScripts = path.join(runtimeRoot, "scripts");
  const hooksPath = path.join(codexHome, "hooks.json");
  const backupPath = `${hooksPath}.sidebar-flow.bak`;
  const configPath = path.join(runtimeRoot, "config.json");
  const sourceRoot = dependencies.sourceRoot ?? ROOT;
  const runtimeRootIdentity = await ensureRealDirectory(runtimeRoot, {
    create: !dryRun,
    label: "Sidebar Flow runtime root",
  }).catch((error) => {
    if (dryRun && error.code === "ENOENT") return null;
    throw error;
  });
  const runtimeFingerprint = await computeRuntimeFingerprint(sourceRoot, mode);
  const releaseRoot = mode === "source"
    ? path.join(runtimeRoot, "releases", runtimeFingerprint)
    : sourceRoot;
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
  const defaults = defaultConfig(codexHome, mode, runtimeFingerprint);
  const bindingChanged = existingConfig?.installMode !== mode
    || existingConfig?.runtimeFingerprint !== runtimeFingerprint;
  const config = {
    ...defaults,
    ...(existingConfig ?? {}),
    sections: {
      ...defaults.sections,
      ...(existingConfig?.sections ?? {}),
    },
    eventWake: {
      ...defaults.eventWake,
      ...(existingConfig?.eventWake ?? {}),
      ...(bindingChanged ? { enabled: false } : {}),
    },
    agentTransitions: {
      ...defaults.agentTransitions,
      ...(existingConfig?.agentTransitions ?? {}),
      ...(agentTransitionsEnabled == null ? {} : { enabled: agentTransitionsEnabled }),
    },
    installMode: mode,
    runtimeFingerprint,
  };
  const existingConfigVersion = Number.isInteger(existingConfig?.configVersion)
    ? existingConfig.configVersion
    : 0;
  if (existingConfig != null && existingConfigVersion < CURRENT_CONFIG_VERSION) {
    if (existingConfig.hookDeadlineMs == null || existingConfig.hookDeadlineMs === 9000) {
      config.hookDeadlineMs = DEFAULT_HOOK_DEADLINE_MS;
    }
    if (existingConfig.stopSettleDelayMs == null || existingConfig.stopSettleDelayMs === 500) {
      config.stopSettleDelayMs = DEFAULT_STOP_SETTLE_DELAY_MS;
    }
    config.configVersion = CURRENT_CONFIG_VERSION;
  }
  config.sections = validateSectionNames(config.sections);
  if (config.eventWake?.organizerThreadId != null) {
    config.excludeThreadIds = [...new Set([
      ...(Array.isArray(config.excludeThreadIds) ? config.excludeThreadIds : []),
      config.eventWake.organizerThreadId,
    ])];
  }
  if (enableEventWake) {
    const { readEventWakeProbeResult } = await import("./doctor.mjs");
    const capability = await readEventWakeProbeResult(config, { runtimeRoot });
    if (capability.status !== "present") {
      const error = new Error("A present capability probe for this install mode and runtime is required");
      error.code = "CAPABILITY_PROBE_REQUIRED";
      throw error;
    }
    config.eventWake = {
      ...config.eventWake,
      enabled: true,
      organizerThreadId,
      organizerHostId: organizerHostId ?? config.eventWake.organizerHostId ?? "local",
      maxPerMinute: eventWakeMaxPerMinute ?? config.eventWake.maxPerMinute ?? 20,
    };
    config.excludeThreadIds = [...new Set([
      ...(Array.isArray(config.excludeThreadIds) ? config.excludeThreadIds : []),
      organizerThreadId,
    ])];
  }
  const hooks = mode === "source"
    ? installHooks(existingHooks, hookCommand(releaseRoot, detectNodeExecutable(), configPath), ownedLegacyHookPaths)
    : null;
  const agentInstructionOptions = {
    codexHome,
    enabled: config.agentTransitions.enabled === true,
    runtimeRoot: releaseRoot,
    configPath,
  };
  const shouldSyncAgentInstructions = config.agentTransitions.enabled === true
    || existingConfig?.agentTransitions?.enabled === true
    || agentTransitionsEnabled === false;
  const agentInstructionPreview = shouldSyncAgentInstructions
    ? await syncAgentTransitionInstructions({
        ...agentInstructionOptions,
        dryRun: true,
      })
    : { enabled: false, activePath: null, changedPaths: [], skipped: true };
  if (!dryRun) {
    await revalidateRealDirectory(runtimeRoot, runtimeRootIdentity, "Sidebar Flow runtime root");
    if (mode === "source") {
      await publishSourceRelease(runtimeRoot, sourceRoot, runtimeFingerprint, dependencies);
      await revalidateRealDirectory(runtimeRoot, runtimeRootIdentity, "Sidebar Flow runtime root");
      if (existsSync(hooksPath)) await writePrivateBackup(hooksPath, backupPath);
    }
    await writeJsonAtomic(configPath, config);
    if (mode === "source") await writeJsonAtomic(hooksPath, hooks);
    if (mode === "plugin") {
      await revalidateRealDirectory(runtimeRoot, runtimeRootIdentity, "Sidebar Flow runtime root");
      await rm(runtimeScripts, { recursive: true, force: true });
    }
  }
  const agentInstructions = !shouldSyncAgentInstructions || dryRun
    ? agentInstructionPreview
    : await syncAgentTransitionInstructions(agentInstructionOptions);
  return {
    mode,
    hooksPath,
    backupPath,
    configPath,
    runtimeRoot,
    releaseRoot,
    runtimeFingerprint,
    dryRun,
    migratedLegacyHookPaths: authorizedLegacyHookPaths,
    nodeExecutable: detectNodeExecutable(),
    agentInstructions,
  };
}

function invalidArgument(message) {
  const error = new Error(message);
  error.code = "INVALID_ARGUMENT";
  return error;
}

function isSingleLine(value, maxLength) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !/[\r\n]/.test(value);
}

export function isSafeIdentifier(value) {
  return isSingleLine(value, 256)
    && value.trim() === value
    && !value.startsWith("-")
    && SAFE_IDENTIFIER_PATTERN.test(value);
}

function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!isSingleLine(value, 4096) || value.startsWith("-")) {
    throw invalidArgument(`${option} requires a value on one line`);
  }
  return value;
}

function identifierOptionValue(argv, index, option) {
  const value = optionValue(argv, index, option);
  if (!isSafeIdentifier(value)) throw invalidArgument(`Invalid value for ${option}`);
  return value;
}

export function parseSetupArgs(argv) {
  const result = { dryRun: false, migrateLegacyHookPaths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--dry-run") result.dryRun = true;
    else if (argv[index] === "--plugin") result.mode = "plugin";
    else if (argv[index] === "--enable-event-wake") result.enableEventWake = true;
    else if (argv[index] === "--enable-agent-transitions") {
      if (result.agentTransitionsEnabled != null) {
        throw invalidArgument("Choose only one agent-transitions mode");
      }
      result.agentTransitionsEnabled = true;
    }
    else if (argv[index] === "--disable-agent-transitions") {
      if (result.agentTransitionsEnabled != null) {
        throw invalidArgument("Choose only one agent-transitions mode");
      }
      result.agentTransitionsEnabled = false;
    }
    else if (argv[index] === "--codex-home") {
      result.codexHome = optionValue(argv, index, "--codex-home");
      index += 1;
    } else if (argv[index] === "--migrate-legacy-hook") {
      result.migrateLegacyHookPaths.push(optionValue(argv, index, "--migrate-legacy-hook"));
      index += 1;
    } else if (argv[index] === "--organizer-thread-id") {
      result.organizerThreadId = identifierOptionValue(argv, index, "--organizer-thread-id");
      index += 1;
    } else if (argv[index] === "--organizer-host-id") {
      result.organizerHostId = identifierOptionValue(argv, index, "--organizer-host-id");
      index += 1;
    } else if (argv[index] === "--event-wake-max-per-minute") {
      const value = optionValue(argv, index, "--event-wake-max-per-minute");
      if (!/^\d+$/.test(value) || Number(value) <= 0 || !Number.isSafeInteger(Number(value))) {
        throw invalidArgument("--event-wake-max-per-minute requires a positive integer");
      }
      result.eventWakeMaxPerMinute = Number(value);
      index += 1;
    }
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (result.enableEventWake && result.organizerThreadId == null) {
    throw invalidArgument("--enable-event-wake requires --organizer-thread-id");
  }
  if (result.mode === "plugin" && result.codexHome != null) {
    throw invalidArgument("Plugin setup cannot use --codex-home; set CODEX_HOME for the plugin runtime instead");
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
