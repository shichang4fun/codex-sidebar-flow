#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants, createReadStream, existsSync, realpathSync, watch } from "node:fs";
import { lstat, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

export const RECONCILER_TOOLS = [
  "list_threads",
  "read_thread",
  "move_thread_to_sidebar_section",
];
const DEFAULT_SOCKET_DIR = "/tmp/codex-browser-use";
const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");
const MAX_MANAGED_LOCK_OWNER_BYTES = 4_096;
const execFileAsync = promisify(execFile);

function now() {
  return new Date().toISOString();
}

function cancellationError() {
  const error = new Error("Wake deadline exceeded");
  error.code = "WAKE_DEADLINE";
  return error;
}

function isDispatchCancelled({ signal, canDispatch } = {}) {
  if (signal?.aborted === true) return true;
  if (typeof canDispatch === "function") {
    try {
      return canDispatch() === false;
    } catch {
      return true;
    }
  }
  return false;
}

function throwIfDispatchCancelled(options) {
  if (isDispatchCancelled(options)) throw cancellationError();
}

function sessionDayDirectory(sessionsDir, date) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return path.join(sessionsDir, year, month, day);
}

export function sessionDayDirectories(sessionsDir, currentDate = new Date()) {
  const previousDate = new Date(currentDate);
  previousDate.setDate(previousDate.getDate() - 1);
  return [
    sessionDayDirectory(sessionsDir, currentDate),
    sessionDayDirectory(sessionsDir, previousDate),
  ];
}

function log(level, message, details = null) {
  const suffix = details == null ? "" : ` ${JSON.stringify(details)}`;
  process.stdout.write(`${now()} ${level.toUpperCase()} ${message}${suffix}\n`);
}

async function writeHealth(config, state) {
  if (!config.healthFile) return;
  const payload = {
    ...state,
    pid: process.pid,
    instanceToken: config.instanceToken ?? null,
    updatedAt: now(),
  };
  const temporaryPath = `${config.healthFile}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, config.healthFile);
}

export class NativePipeClient {
  constructor(socketPath, timeoutMs = 5000) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.connecting = null;
  }

  async connect(options = {}) {
    if (this.socket != null && !this.socket.destroyed) return;
    if (this.connecting != null) return this.connecting;
    throwIfDispatchCancelled(options);

    this.connecting = new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const timer = setTimeout(() => {
        fail(new Error(`Timed out connecting to ${path.basename(this.socketPath)}`));
      }, this.timeoutMs);
      const abort = () => fail(cancellationError());
      const fail = (error) => {
        clearTimeout(timer);
        options.signal?.removeEventListener?.("abort", abort);
        socket.destroy();
        reject(error);
      };

      options.signal?.addEventListener?.("abort", abort, { once: true });
      socket.once("error", fail);
      socket.once("connect", () => {
        clearTimeout(timer);
        options.signal?.removeEventListener?.("abort", abort);
        socket.off("error", fail);
        if (isDispatchCancelled(options)) {
          socket.destroy();
          reject(cancellationError());
          return;
        }
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        socket.on("data", (chunk) => this.onData(chunk));
        socket.on("error", (error) => this.close(error));
        socket.on("close", () => this.close(new Error("Codex app tools pipe closed")));
        resolve();
      });
    }).finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  async request(method, params, timeoutMs = this.timeoutMs, options = {}) {
    throwIfDispatchCancelled(options);
    await this.connect(options);
    throwIfDispatchCancelled(options);
    const id = this.nextId++;
    const payload = Buffer.from(JSON.stringify({ id, jsonrpc: "2.0", method, params }), "utf8");
    const frame = Buffer.alloc(4 + payload.length);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        options.signal?.removeEventListener?.("abort", abort);
        reject(new Error(`Timed out calling ${method}`));
      }, timeoutMs);
      const abort = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        options.signal?.removeEventListener?.("abort", abort);
        reject(cancellationError());
      };

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          options.signal?.removeEventListener?.("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          options.signal?.removeEventListener?.("abort", abort);
          reject(error);
        },
      });
      options.signal?.addEventListener?.("abort", abort, { once: true });

      try {
        throwIfDispatchCancelled(options);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        options.signal?.removeEventListener?.("abort", abort);
        reject(error);
        return;
      }
      this.socket.write(frame, (error) => {
        if (error == null) return;
        const pending = this.pending.get(id);
        this.pending.delete(id);
        options.signal?.removeEventListener?.("abort", abort);
        pending?.reject(error);
      });
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > 8 * 1024 * 1024) {
        this.close(new Error("Codex app tools response exceeded 8 MiB"));
        return;
      }
      if (this.buffer.length < length + 4) return;

      const payload = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      let response;
      try {
        response = JSON.parse(payload.toString("utf8"));
      } catch (error) {
        this.close(error);
        return;
      }

      const pending = this.pending.get(Number(response.id));
      if (pending == null) continue;
      this.pending.delete(Number(response.id));
      if (response.error != null) {
        const error = new Error("Codex app tools RPC failed");
        error.code = "APP_TOOLS_RPC_ERROR";
        pending.reject(error);
      } else {
        pending.resolve(response.result);
      }
    }
  }

  close(error = new Error("Codex app tools pipe closed")) {
    const socket = this.socket;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    if (socket != null && !socket.destroyed) socket.destroy();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export function parseDeclaredSocketPaths(processList) {
  const matches = processList.matchAll(
    /CODEX_APP_TOOLS_PIPE_PATH"?="?([^",}\s]+\.sock)/g,
  );
  return [...new Set([...matches].map((match) => match[1]))];
}

export function selectSocketCandidates(preferred, discovered, maximum) {
  return [...new Set([...preferred, ...discovered])].slice(0, maximum);
}

export function isTrustedSocketMetadata(metadata, userId = process.getuid?.()) {
  return metadata?.isSocket?.() === true && metadata.uid === userId;
}

export function promoteClientTimeout(client, requestTimeoutMs) {
  client.timeoutMs = requestTimeoutMs;
  return client;
}

export function hostHasRequiredTools(host, requiredTools = RECONCILER_TOOLS) {
  const toolMap = host?.toolMap;
  return requiredTools.every((name) => toolMap instanceof Map && toolMap.has(name));
}

export async function keepHostAlive(host, timeoutMs = 5000, requiredTools = RECONCILER_TOOLS) {
  const result = await host.client.request(
    "tools/list",
    { threadStartKind: "all" },
    timeoutMs,
  );
  const toolMap = new Map((result?.tools ?? []).map((tool) => [tool.name, tool]));
  if (!hostHasRequiredTools({ ...host, toolMap }, requiredTools)) {
    throw new Error("Codex app tools keepalive lost required sidebar tools");
  }
}

export function nextBackoffMs(failureCount, baseMs = 1000, maximumMs = 30000) {
  return Math.min(maximumMs, baseMs * 2 ** Math.max(0, failureCount - 1));
}

export function sessionIdFromMetaLine(line) {
  try {
    const record = JSON.parse(line);
    if (record?.type !== "session_meta") return null;
    const sessionId = record?.payload?.session_id;
    return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
  } catch {
    return null;
  }
}

export function normalizeManagedState(raw, currentTime = Date.now(), graceMs = 300000) {
  const defaultStart = currentTime - graceMs;
  const manageSince = Number.isFinite(raw?.manageSince) ? raw.manageSince : defaultStart;
  const lastSessionScanAt = Number.isFinite(raw?.lastSessionScanAt)
    ? raw.lastSessionScanAt
    : defaultStart;
  const managedThreadIds = [
    ...new Set(
      (raw?.managedThreadIds ?? [])
        .filter((value) => typeof value === "string")
        .map((value) => (value.includes(":") ? value : managedIdentity("local", value))),
    ),
  ];
  const knownThreadIdentities = [
    ...new Set(
      (raw?.knownThreadIdentities ?? []).filter(
        (value) => typeof value === "string" && value.includes(":"),
      ),
    ),
  ];
  const sessionFiles = Object.fromEntries(
    Object.entries(raw?.sessionFiles ?? {}).filter(
      ([filePath, mtimeMs]) => typeof filePath === "string" && Number.isFinite(mtimeMs),
    ),
  );
  return { version: 4, manageSince, lastSessionScanAt, managedThreadIds, knownThreadIdentities, sessionFiles };
}

export function managedIdentity(hostId, threadId) {
  if (typeof hostId !== "string" || hostId.length === 0) return null;
  if (typeof threadId !== "string" || threadId.length === 0) return null;
  return `${hostId}:${threadId}`;
}

export async function readSessionIdFromFile(filePath) {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) return sessionIdFromMetaLine(line);
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
}

export async function loadManagedState(filePath, currentTime = Date.now(), graceMs = 300000) {
  if (!filePath) return normalizeManagedState(null, currentTime, graceMs);
  try {
    return normalizeManagedState(JSON.parse(await readFile(filePath, "utf8")), currentTime, graceMs);
  } catch {
    return normalizeManagedState(null, currentTime, graceMs);
  }
}

async function writeManagedStateFile(filePath, state) {
  const normalized = normalizeManagedState(state);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(normalized)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, filePath);
  return normalized;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function sameFileIdentity(left, right) {
  return left != null && right != null && left.dev === right.dev && left.ino === right.ino;
}

async function unlinkOwnedLock(lockPath, handle) {
  if (handle == null) return false;
  const [ownedStat, currentStat] = await Promise.all([
    handle.stat().catch(() => null),
    lstat(lockPath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }),
  ]);
  if (!sameFileIdentity(ownedStat, currentStat)) return false;
  await unlink(lockPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  return true;
}

async function readLockOwner(handle, metadata) {
  if (!metadata.isFile() || metadata.size > MAX_MANAGED_LOCK_OWNER_BYTES) return null;
  const buffer = Buffer.alloc(MAX_MANAGED_LOCK_OWNER_BYTES + 1);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  if (bytesRead > MAX_MANAGED_LOCK_OWNER_BYTES) return null;
  let owner = null;
  try {
    owner = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } catch {}
  return owner;
}

async function clearStaleLock(
  lockPath,
  staleAfterMs = 30000,
  { now = Date.now, isProcessAlive = processIsAlive, onBeforeReclaim = null } = {},
) {
  let handle;
  try {
    handle = await open(lockPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === "ENOENT") return true;
    return false;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) return false;
    const owner = await readLockOwner(handle, metadata);
    const createdAt = Number.isFinite(owner?.createdAt) ? owner.createdAt : metadata.mtimeMs;
    const staleByAge = now() - createdAt > staleAfterMs;
    let ownerGone = false;
    if (Number.isInteger(owner?.pid)) {
      try {
        ownerGone = isProcessAlive(owner.pid) === false;
      } catch {
        ownerGone = false;
      }
    }
    if (!staleByAge && !ownerGone) return false;
    if (typeof onBeforeReclaim === "function") {
      await onBeforeReclaim({ lockPath, owner });
    }
    return await unlinkOwnedLock(lockPath, handle);
  } catch {
    return false;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function withFileLock(
  lockPath,
  task,
  {
    attempts = 80,
    delayMs = 25,
    staleAfterMs = 30000,
    now = Date.now,
    isProcessAlive = processIsAlive,
    onBeforeReclaim = null,
    onBeforeRelease = null,
  } = {},
) {
  let handle = null;
  let blockedAttempts = 0;
  let recoveryAttempts = 0;
  while (handle == null) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: now() })}\n`);
      } catch (error) {
        await unlinkOwnedLock(lockPath, handle);
        await handle.close().catch(() => {});
        handle = null;
        throw error;
      }
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (recoveryAttempts < attempts) {
        recoveryAttempts += 1;
        const reclaimed = await clearStaleLock(lockPath, staleAfterMs, {
          now,
          isProcessAlive,
          onBeforeReclaim,
        });
        if (reclaimed) continue;
      }
      blockedAttempts += 1;
      if (blockedAttempts >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  try {
    return await task();
  } finally {
    try {
      if (typeof onBeforeRelease === "function") {
        await onBeforeRelease({ lockPath });
      }
    } finally {
      await unlinkOwnedLock(lockPath, handle);
      await handle?.close().catch(() => {});
    }
  }
}

export async function saveManagedState(filePath, state, lockOptions = {}) {
  if (!filePath) return normalizeManagedState(state);
  return withFileLock(`${filePath}.lock`, async () => {
    let current = null;
    try {
      current = normalizeManagedState(JSON.parse(await readFile(filePath, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    const proposed = normalizeManagedState(state);
    const next = current == null
      ? proposed
      : {
          ...proposed,
          manageSince: Math.min(current.manageSince, proposed.manageSince),
          lastSessionScanAt: Math.max(current.lastSessionScanAt, proposed.lastSessionScanAt),
          managedThreadIds: [...new Set([...current.managedThreadIds, ...proposed.managedThreadIds])],
          knownThreadIdentities: [
            ...new Set([...current.knownThreadIdentities, ...proposed.knownThreadIdentities]),
          ],
          sessionFiles: { ...current.sessionFiles, ...proposed.sessionFiles },
        };
    return writeManagedStateFile(filePath, next);
  }, lockOptions);
}

export async function updateManagedState(
  filePath,
  { add = [], remove = [], observe = [], lastSessionScanAt = null, sessionFiles = null } = {},
  lockOptions = {},
) {
  if (!filePath) return normalizeManagedState(null);
  return withFileLock(`${filePath}.lock`, async () => {
    const current = await loadManagedState(filePath);
    const managedThreadIds = new Set(current.managedThreadIds);
    for (const identity of add) if (typeof identity === "string") managedThreadIds.add(identity);
    for (const identity of remove) if (typeof identity === "string") managedThreadIds.delete(identity);
    const knownThreadIdentities = new Set(current.knownThreadIdentities);
    for (const identity of observe) if (typeof identity === "string") knownThreadIdentities.add(identity);
    const next = {
      ...current,
      lastSessionScanAt: Number.isFinite(lastSessionScanAt)
        ? Math.max(current.lastSessionScanAt, lastSessionScanAt)
        : current.lastSessionScanAt,
      managedThreadIds: [...managedThreadIds],
      knownThreadIdentities: [...knownThreadIdentities],
      sessionFiles: sessionFiles == null ? current.sessionFiles : { ...current.sessionFiles, ...sessionFiles },
    };
    return writeManagedStateFile(filePath, next);
  }, lockOptions);
}

export function managedHostsByThreadId(managedThreadIds = []) {
  const candidates = new Map();
  for (const identity of managedThreadIds) {
    if (typeof identity !== "string") continue;
    const separator = identity.lastIndexOf(":");
    if (separator <= 0 || separator === identity.length - 1) continue;
    const hostId = identity.slice(0, separator);
    const threadId = identity.slice(separator + 1);
    const hosts = candidates.get(threadId) ?? new Set();
    hosts.add(hostId);
    candidates.set(threadId, hosts);
  }
  return new Map(
    [...candidates].flatMap(([threadId, hosts]) =>
      hosts.size === 1 ? [[threadId, [...hosts][0]]] : [],
    ),
  );
}

export function mergePersistedManagedState(
  localState,
  persistedState,
  { pendingAdds = [], pendingRemoves = [] } = {},
) {
  const local = normalizeManagedState(localState);
  const persisted = normalizeManagedState(persistedState);
  const removed = new Set(pendingRemoves);
  const managedThreadIds = new Set(
    persisted.managedThreadIds.filter((identity) => !removed.has(identity)),
  );
  for (const identity of pendingAdds) managedThreadIds.add(identity);
  return {
    ...local,
    manageSince: Math.min(local.manageSince, persisted.manageSince),
    lastSessionScanAt: Math.max(local.lastSessionScanAt, persisted.lastSessionScanAt),
    managedThreadIds: [...managedThreadIds],
    knownThreadIdentities: [...new Set([
      ...local.knownThreadIdentities,
      ...persisted.knownThreadIdentities,
    ])],
    sessionFiles: { ...persisted.sessionFiles, ...local.sessionFiles },
  };
}

export function recordSessionActivity(state, sessionId, observedAt = Date.now(), hostId = "local") {
  const normalized = normalizeManagedState(state, observedAt, 0);
  const managedThreadIds = new Set(normalized.managedThreadIds);
  const identity = managedIdentity(hostId, sessionId);
  if (identity != null) managedThreadIds.add(identity);
  return {
    ...normalized,
    lastSessionScanAt: Math.max(normalized.lastSessionScanAt, observedAt),
    managedThreadIds: [...managedThreadIds],
  };
}

export function forgetManagedThread(state, threadId, hostId = "local") {
  const normalized = normalizeManagedState(state);
  const identity = managedIdentity(hostId, threadId);
  return {
    ...normalized,
    managedThreadIds: normalized.managedThreadIds.filter((id) => id !== identity && id !== threadId),
  };
}

export function recordSnapshotActivity(state, snapshot) {
  const normalized = normalizeManagedState(state);
  const managedThreadIds = new Set(normalized.managedThreadIds);
  for (const thread of snapshot?.threads ?? []) {
    if (thread.kind !== "codex") continue;
    const status = normalizedThreadStatus(thread);
    if (!["active", "running", "inprogress"].includes(status)) continue;
    const identity = managedIdentity(thread.hostId, thread.id);
    if (identity != null) managedThreadIds.add(identity);
  }
  return { ...normalized, managedThreadIds: [...managedThreadIds] };
}

export function recordSessionFile(state, filePath, sessionId, mtimeMs) {
  const normalized = normalizeManagedState(state);
  const previousMtime = normalized.sessionFiles[filePath];
  const changed =
    Number.isFinite(mtimeMs) &&
    (previousMtime == null ? mtimeMs > normalized.manageSince : mtimeMs > previousMtime);
  const next = recordSessionActivity(normalized, changed ? sessionId : null, mtimeMs);
  next.sessionFiles = { ...next.sessionFiles, [filePath]: mtimeMs };
  return next;
}

export async function scanManagedSessionFiles(state, sessionsDir, currentDate = new Date()) {
  let nextState = normalizeManagedState(state);
  const files = [];
  const sessionIdsByFile = {};

  for (const targetPath of sessionDayDirectories(sessionsDir, currentDate)) {
    const entries = await readdir(targetPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const filePath = path.join(targetPath, entry.name);
      const [sessionId, metadata] = await Promise.all([
        readSessionIdFromFile(filePath).catch(() => null),
        stat(filePath).catch(() => null),
      ]);
      if (metadata == null) continue;
      files.push(filePath);
      if (sessionId != null) sessionIdsByFile[filePath] = sessionId;
      nextState = recordSessionFile(nextState, filePath, sessionId, metadata.mtimeMs);
    }
  }

  const retainedFiles = new Set(files);
  nextState.sessionFiles = Object.fromEntries(
    Object.entries(nextState.sessionFiles).filter(([filePath]) => retainedFiles.has(filePath)),
  );
  return { state: nextState, files, sessionIdsByFile };
}

export function createEventScheduler({ reconcile, eventDebounceMs, settleDelayMs }) {
  let leadingTimer = null;
  let settleTimer = null;
  return {
    schedule(reason) {
      if (leadingTimer == null) {
        leadingTimer = setTimeout(() => {
          leadingTimer = null;
          void reconcile(reason);
        }, eventDebounceMs);
      }
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        void reconcile(`${reason}:settled`);
      }, settleDelayMs);
    },
    close() {
      clearTimeout(leadingTimer);
      clearTimeout(settleTimer);
      leadingTimer = null;
      settleTimer = null;
    },
  };
}

export function createSingleFlight(task) {
  let current = null;
  return (...args) => {
    if (current != null) return current;
    current = Promise.resolve()
      .then(() => task(...args))
      .finally(() => {
        current = null;
      });
    return current;
  };
}

export async function runWithRetries(task, { attempts = 2, delayMs = 2000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

async function declaredSocketPaths() {
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-ww", "-axo", "command="], {
      maxBuffer: 4 * 1024 * 1024,
    });
    return parseDeclaredSocketPaths(stdout);
  } catch {
    return [];
  }
}

export async function filterTrustedSocketPaths(
  paths,
  { statPath = stat, userId = process.getuid?.() } = {},
) {
  const trusted = [];
  for (const socketPath of paths) {
    try {
      const metadata = await statPath(socketPath);
      if (isTrustedSocketMetadata(metadata, userId)) trusted.push(socketPath);
    } catch {
      // Fail closed when a candidate disappears or is not inspectable.
    }
  }
  return trusted;
}

async function socketCandidates(socketDir, explicitPath, maximum, allowSocketDiscovery) {
  const preferred = [explicitPath].filter(Boolean);
  const discovered = [];
  if (allowSocketDiscovery) {
    preferred.push(...(await declaredSocketPaths()));
    const entries = await readdir(socketDir, { withFileTypes: true }).catch(() => []);
    const candidates = [];
    for (const entry of entries) {
      if (!entry.name.endsWith(".sock")) continue;
      const socketPath = path.join(socketDir, entry.name);
      try {
        const metadata = await stat(socketPath);
        if (isTrustedSocketMetadata(metadata)) {
          candidates.push({ socketPath, mtimeMs: metadata.mtimeMs });
        }
      } catch {
        // Socket disappeared during discovery.
      }
    }
    discovered.push(
      ...candidates.sort((a, b) => b.mtimeMs - a.mtimeMs).map((entry) => entry.socketPath),
    );
  }
  return filterTrustedSocketPaths(selectSocketCandidates(preferred, discovered, maximum));
}

async function discoverHost(config, requiredTools = RECONCILER_TOOLS, options = {}) {
  throwIfDispatchCancelled(options);
  const candidates = await socketCandidates(
    config.socketDir ?? DEFAULT_SOCKET_DIR,
    process.env.CODEX_APP_TOOLS_PIPE_PATH,
    config.maxSocketCandidates ?? 8,
    config.allowSocketDiscovery ?? false,
  );
  const failures = [];
  const deadline = Date.now() + (config.discoveryTimeoutMs ?? 6000);

  for (const socketPath of candidates) {
    throwIfDispatchCancelled(options);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const probeTimeoutMs = Math.max(
      100,
      Math.min(config.socketProbeTimeoutMs ?? 1500, remainingMs),
    );
    const client = new NativePipeClient(socketPath, probeTimeoutMs);
    try {
      const result = await client.request(
        "tools/list",
        { threadStartKind: "all" },
        probeTimeoutMs,
        options,
      );
      throwIfDispatchCancelled(options);
      const tools = Array.isArray(result?.tools) ? result.tools : [];
      const host = { client, socketPath, toolMap: new Map(tools.map((tool) => [tool.name, tool])) };
      if (hostHasRequiredTools(host, requiredTools)) {
        promoteClientTimeout(client, config.requestTimeoutMs ?? 15000);
        return host;
      }
    } catch (error) {
      if (failures.length < 8) {
        failures.push(`${path.basename(socketPath)}:${error.code ?? error.message}`);
      }
      // Try the next live Codex/ChatGPT app socket.
    }
    client.close();
  }

  throw new Error(
    `No live Codex app-tools socket exposes the required sidebar tools; checked ${candidates.length}; ${failures.join(", ")}`,
  );
}

export function assertToolSuccess(result, toolName) {
  if (result?.success === true) return result;
  const error = new Error(`${toolName} returned an error`);
  error.code = "APP_TOOL_ERROR";
  error.toolName = toolName;
  throw error;
}

function parseToolText(result, toolName) {
  assertToolSuccess(result, toolName);
  const textItem = result.contentItems?.find((item) => item.type === "inputText");
  if (typeof textItem?.text !== "string") {
    throw new Error(`${toolName} returned no JSON text`);
  }
  try {
    return JSON.parse(textItem.text);
  } catch {
    throw new Error(`${toolName} returned invalid JSON`);
  }
}

export class AppTools {
  constructor(config, { requiredTools = RECONCILER_TOOLS, discoverHost: discoverHostImpl = discoverHost } = {}) {
    this.config = config;
    this.requiredTools = [...requiredTools];
    this.discoverHost = discoverHostImpl;
    this.host = null;
    this.failureCount = 0;
    this.nextConnectAt = 0;
    this.connectionGeneration = 0;
    this.connecting = null;
  }

  async connect(options = {}) {
    throwIfDispatchCancelled(options);
    if (this.host != null) return this.host;
    if (Date.now() < this.nextConnectAt) {
      const error = new Error("Codex app tools reconnect is backing off");
      error.code = "APP_TOOLS_BACKOFF";
      error.retryAfterMs = this.nextConnectAt - Date.now();
      throw error;
    }
    const generation = this.connectionGeneration;
    if (this.connecting == null) {
      this.connecting = this.discoverHost(this.config, this.requiredTools, options)
        .finally(() => {
          if (this.connectionGeneration === generation) this.connecting = null;
        });
    }
    let discoveredHost;
    try {
      discoveredHost = await this.connecting;
      if (generation !== this.connectionGeneration || isDispatchCancelled(options)) {
        discoveredHost?.client.close();
        throw cancellationError();
      }
      this.host = discoveredHost;
      this.failureCount = 0;
      this.nextConnectAt = 0;
    } catch (error) {
      this.noteFailure();
      error.backoffRecorded = true;
      throw error;
    }
    if (!this.config.quiet) {
      log("info", "connected to Codex app tools", { socket: path.basename(this.host.socketPath) });
    }
    return this.host;
  }

  noteFailure() {
    this.failureCount += 1;
    this.nextConnectAt =
      Date.now() +
      nextBackoffMs(
        this.failureCount,
        this.config.reconnectBackoffBaseMs ?? 1000,
        this.config.reconnectBackoffMaxMs ?? 30000,
      );
  }

  reset() {
    this.connectionGeneration += 1;
    this.connecting = null;
    this.host?.client.close();
    this.host = null;
  }

  acceptsHost(host) {
    return hostHasRequiredTools(host, this.requiredTools);
  }

  async keepAlive() {
    if (this.host == null) return false;
    try {
      await keepHostAlive(
        this.host,
        this.config.socketKeepAliveTimeoutMs ?? 5000,
        this.requiredTools,
      );
      return true;
    } catch (error) {
      this.noteFailure();
      error.backoffRecorded = true;
      this.reset();
      throw error;
    }
  }

  async call(name, args, options = {}) {
    throwIfDispatchCancelled(options);
    const host = await this.connect(options);
    throwIfDispatchCancelled(options);
    const tool = host.toolMap.get(name);
    if (tool == null) throw new Error(`Missing Codex app tool: ${name}`);
    try {
      return await host.client.request("tools/call", {
        arguments: args,
        callId: `sidebar-realtime-${randomUUID()}`,
        namespace: tool.namespace,
        threadId: this.config.actorThreadId,
        tool: tool.name,
        turnId: `sidebar-realtime-${randomUUID()}`,
      }, host.client.timeoutMs, options);
    } catch (error) {
      this.noteFailure();
      error.backoffRecorded = true;
      this.reset();
      throw error;
    }
  }

  async listThreads(options = {}) {
    return parseToolText(
      await this.call("list_threads", { limit: this.config.listLimit }, options),
      "list_threads",
    );
  }

  async moveThread(move, options = {}) {
    const args = { threadId: move.threadId, sectionId: move.sectionId };
    if (move.hostId) args.hostId = move.hostId;
    return assertToolSuccess(
      await this.call("move_thread_to_sidebar_section", args, options),
      "move_thread_to_sidebar_section",
    );
  }

  async readThread(threadId, hostId, options = {}) {
    const args = {
      threadId,
      turnLimit: 1,
      includeOutputs: false,
      maxOutputCharsPerItem: 1,
    };
    if (hostId) args.hostId = hostId;
    return parseToolText(
      await this.call("read_thread", args, options),
      "read_thread",
    );
  }

  async sendMessageToThread({ threadId, hostId, prompt }, options = {}) {
    const args = { threadId, prompt };
    if (hostId) args.hostId = hostId;
    return assertToolSuccess(
      await this.call("send_message_to_thread", args, options),
      "send_message_to_thread",
    );
  }
}

function exactSection(sections, name) {
  const matches = sections.filter((section) => section.name === name);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one sidebar section named ${name}; found ${matches.length}`);
  }
  return matches[0];
}

function normalizedStatus(status) {
  return String(status ?? "").toLowerCase().replaceAll(" ", "");
}

export function normalizedThreadStatus(thread) {
  const status = thread?.status;
  const type = normalizedStatus(status?.type ?? status);
  const flags = new Set((status?.activeFlags ?? []).map(normalizedStatus));
  if (
    type === "active" &&
    (flags.has("waitingonapproval") || flags.has("waitingonuserinput"))
  ) {
    return "needsattention";
  }
  return type;
}

function parseThreadItemKey(key) {
  const prefix = "codex:thread:";
  if (!key.startsWith(prefix)) return null;
  const separator = key.lastIndexOf(":");
  if (separator <= prefix.length) return null;
  return { hostId: key.slice(prefix.length, separator), threadId: key.slice(separator + 1) };
}

export function sidebarMembershipForThread(sections, thread) {
  let directMembership = null;
  let projectMembership = null;
  for (const section of sections ?? []) {
    for (const key of section.itemKeys ?? []) {
      const parsed = parseThreadItemKey(key);
      if (parsed?.threadId === thread.id) {
        directMembership = {
          sectionId: section.sectionId,
          itemKey: key,
        };
      }
      if (thread.projectId && key === `codex:project:${thread.projectId}`) {
        projectMembership = {
          sectionId: section.sectionId,
          itemKey: key,
        };
      }
    }
  }
  if (directMembership == null && projectMembership == null) return null;
  const current = directMembership ?? projectMembership;
  return {
    ...current,
    viaProject: directMembership == null,
    direct: directMembership,
    project: projectMembership,
  };
}

export function membershipIsProtected(membership, protectedSectionIds) {
  if (membership == null) return false;
  return [membership.direct?.sectionId, membership.project?.sectionId].some((sectionId) =>
    protectedSectionIds.has(sectionId),
  );
}

export function statusFromThreadRead(result) {
  const threadStatus = normalizedThreadStatus(result?.thread);
  if (threadStatus !== "notloaded" && threadStatus !== "") return threadStatus;
  const turnStatus = normalizedStatus(result?.turns?.[0]?.status);
  if (["running", "inprogress", "active"].includes(turnStatus)) return "active";
  if (turnStatus === "completed") return "completed";
  if (["failed", "interrupted", "cancelled", "canceled"].includes(turnStatus)) {
    return "needsattention";
  }
  return threadStatus;
}

export async function hydrateCustomThreads(snapshot, config, appTools, knownHosts = new Map()) {
  const threads = Array.isArray(snapshot.threads) ? snapshot.threads : [];
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  snapshot.hydrationErrors = [];
  const customSections = (snapshot.sections ?? []).filter((section) =>
    [config.sections.inProgress, config.sections.forReview].includes(section.name),
  );

  for (const section of customSections) {
    for (const key of section.itemKeys ?? []) {
      const parsed = parseThreadItemKey(key);
      if (parsed == null) continue;
      const thread = threadById.get(parsed.threadId);
      if (thread != null) thread.sidebarItemKey = key;
    }
  }

  const inProgress = exactSection(snapshot.sections ?? [], config.sections.inProgress);
  const reads = [];
  for (const key of inProgress.itemKeys ?? []) {
    const parsed = parseThreadItemKey(key);
    if (parsed == null) continue;
    const existing = threadById.get(parsed.threadId);
    const existingStatus = normalizedThreadStatus(existing);
    if (existing != null && !["notloaded", "active"].includes(existingStatus)) continue;
    const executionHostId = existing?.hostId ?? knownHosts.get(parsed.threadId);
    if (typeof executionHostId !== "string" || executionHostId.length === 0) {
      snapshot.hydrationErrors.push({
        threadId: parsed.threadId,
        error: "read_thread skipped because no authoritative hostId is available",
      });
      continue;
    }
    reads.push({
      key,
      parsed,
      existing,
      executionHostId,
      promise: appTools.readThread(parsed.threadId, executionHostId),
    });
  }

  const outcomes = await Promise.allSettled(reads.map(({ promise }) => promise));
  for (let index = 0; index < outcomes.length; index += 1) {
    const outcome = outcomes[index];
    const { key, parsed, existing, executionHostId } = reads[index];
    if (outcome.status === "rejected") {
      snapshot.hydrationErrors.push({
        threadId: parsed.threadId,
        error: outcome.reason?.message ?? String(outcome.reason),
      });
      continue;
    }
    const result = outcome.value;
    const resolvedHostId = result.thread?.hostId ?? existing?.hostId ?? executionHostId;
    if (typeof resolvedHostId !== "string" || resolvedHostId.length === 0) {
      snapshot.hydrationErrors.push({
        threadId: parsed.threadId,
        error: "read_thread did not return an authoritative hostId",
      });
      continue;
    }
    const hydrated = existing ?? {
      id: result.thread?.id ?? parsed.threadId,
      kind: result.thread?.kind ?? "codex",
      hostId: resolvedHostId,
      title: result.thread?.title ?? parsed.threadId,
      summary: null,
    };
    hydrated.hostId = resolvedHostId;
    hydrated.sidebarItemKey = key;
    hydrated.status = statusFromThreadRead(result);
    if (existing == null) {
      threads.push(hydrated);
      threadById.set(hydrated.id, hydrated);
    }
  }
  snapshot.threads = threads;
  return snapshot;
}

export function planMoves(snapshot, config, managedThreadIds = new Set()) {
  const sections = Array.isArray(snapshot?.sections) ? snapshot.sections : [];
  const inProgress = exactSection(sections, config.sections.inProgress);
  const forReview = exactSection(sections, config.sections.forReview);
  const forLater = exactSection(sections, config.sections.forLater);
  const tasks = sections.find((section) => section.sectionId === "chats");
  const projects = sections.find((section) => section.sectionId === "threads");
  const pinned = sections.find((section) => section.sectionId === "pinned");
  if (tasks == null || projects == null || pinned == null) {
    throw new Error("Missing built-in Projects, Tasks, or Pinned section");
  }
  const excludedIds = new Set(config.excludeThreadIds ?? []);
  const reviewStatuses = new Set(["idle", "completed", "needsattention", "waiting", "approval"]);
  const moves = [];

  for (const thread of snapshot.threads ?? []) {
    if (thread.kind !== "codex" || !thread.hostId || excludedIds.has(thread.id)) continue;

    const membership = sidebarMembershipForThread(sections, thread);
    const currentSectionId = membership?.sectionId;
    if (currentSectionId == null) continue;
    if (membershipIsProtected(membership, new Set([pinned.sectionId, forLater.sectionId]))) continue;

    const status = normalizedThreadStatus(thread);
    let destination = null;
    if (status === "active") {
      if (
        currentSectionId === tasks.sectionId ||
        currentSectionId === forReview.sectionId ||
        (membership.viaProject && currentSectionId === projects.sectionId)
      ) {
        destination = inProgress;
      }
    } else if (reviewStatuses.has(status)) {
      const identity = managedIdentity(thread.hostId, thread.id);
      const managed = managedThreadIds.has(identity) || managedThreadIds.has(thread.id);
      if (
        currentSectionId === inProgress.sectionId ||
        ([tasks.sectionId, projects.sectionId].includes(currentSectionId) && managed)
      ) {
        destination = forReview;
      }
    }

    if (destination == null || destination.sectionId === currentSectionId) continue;
    moves.push({
      threadId: thread.id,
      hostId: thread.hostId,
      sectionId: destination.sectionId,
      sectionName: destination.name,
    });
    if (moves.length >= config.maxMovesPerRun) break;
  }

  return moves;
}

export async function loadConfig(configPath) {
  const parsed = JSON.parse(await readFile(configPath, "utf8"));
  return {
    socketDir: DEFAULT_SOCKET_DIR,
    sessionsDir: DEFAULT_SESSIONS_DIR,
    requestTimeoutMs: 15000,
    eventDebounceMs: 300,
    settleDelayMs: 1500,
    fallbackIntervalMs: 60000,
    socketProbeTimeoutMs: 1500,
    discoveryTimeoutMs: 6000,
    maxSocketCandidates: 8,
    allowSocketDiscovery: false,
    listLimit: 50,
    maxMovesPerRun: 10,
    ...parsed,
  };
}

function parseArgs(argv) {
  const options = { configPath: process.env.CODEX_SIDEBAR_FLOW_CONFIG ?? path.join(os.homedir(), ".codex", "sidebar-flow", "config.json") };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--once") options.once = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--config") options.configPath = argv[++index];
    else if (arg === "--instance-token") options.instanceToken = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = await loadConfig(options.configPath);
  config.instanceToken = options.instanceToken ?? null;
  if (options.once) config.healthFile = null;
  const appTools = new AppTools(config);
  let managedState = await loadManagedState(config.stateFile);
  let running = false;
  let pending = false;
  let retryTimer = null;
  let backlogTimer = null;
  let stateSaveTimer = null;
  let stateSavePromise = Promise.resolve();
  const pendingStateAdds = new Set();
  const pendingStateRemoves = new Set();
  let watcherDayPath = null;
  const sessionWatchers = new Map();
  const sessionIdsByFile = new Map();

  const flushManagedStateUpdates = () => {
    stateSavePromise = stateSavePromise
      .catch(() => {})
      .then(async () => {
        const add = [...pendingStateAdds];
        const remove = [...pendingStateRemoves];
        pendingStateAdds.clear();
        pendingStateRemoves.clear();
        try {
          return await updateManagedState(config.stateFile, {
            add,
            remove,
            lastSessionScanAt: managedState.lastSessionScanAt,
            sessionFiles: managedState.sessionFiles,
          });
        } catch (error) {
          for (const identity of add) {
            if (!pendingStateRemoves.has(identity)) pendingStateAdds.add(identity);
          }
          for (const identity of remove) {
            pendingStateAdds.delete(identity);
            pendingStateRemoves.add(identity);
          }
          throw error;
        }
      });
    return stateSavePromise;
  };

  const scheduleManagedStateSave = ({ add = [], remove = [] } = {}) => {
    for (const identity of add) {
      pendingStateRemoves.delete(identity);
      pendingStateAdds.add(identity);
    }
    for (const identity of remove) {
      pendingStateAdds.delete(identity);
      pendingStateRemoves.add(identity);
    }
    clearTimeout(stateSaveTimer);
    stateSaveTimer = setTimeout(() => {
      stateSaveTimer = null;
      void flushManagedStateUpdates().catch((error) =>
        log("warn", "managed state save failed", { error: error.message }),
      );
    }, 250);
  };

  const reconcile = async (reason) => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    let retryAfterFailure = false;
    try {
      do {
        pending = false;
        await stateSavePromise.catch(() => {});
        const persistedState = await loadManagedState(config.stateFile);
        managedState = mergePersistedManagedState(managedState, persistedState, {
          pendingAdds: pendingStateAdds,
          pendingRemoves: pendingStateRemoves,
        });
        const snapshot = await hydrateCustomThreads(
          await appTools.listThreads(),
          config,
          appTools,
          managedHostsByThreadId([
            ...managedState.managedThreadIds,
            ...managedState.knownThreadIdentities,
          ]),
        );
        if (snapshot.hydrationErrors?.length > 0) {
          log("warn", "some custom-section tasks could not be refreshed", {
            count: snapshot.hydrationErrors.length,
            tasks: snapshot.hydrationErrors.slice(0, 5).map(({ threadId, error }) => ({
              threadId: threadId.slice(-8),
              error: error.slice(0, 300),
            })),
          });
        }
        if (options.verbose) {
          log("debug", "custom-section task snapshot", {
            threadCount: snapshot.threads?.length ?? 0,
            sections: (snapshot.sections ?? []).map((section) => ({
              id: section.sectionId,
              name: section.name,
              itemCount: section.itemKeys?.length ?? 0,
            })),
            tasks: (snapshot.threads ?? [])
              .filter((thread) => {
                const membership = sidebarMembershipForThread(snapshot.sections, thread);
                return membership != null && !["pinned", "threads", "chats"].includes(membership.sectionId);
              })
              .map((thread) => ({ id: thread.id, hostId: thread.hostId, status: thread.status })),
          });
        }
        const previousManagedIds = new Set(managedState.managedThreadIds);
        const nextManagedState = recordSnapshotActivity(managedState, snapshot);
        if (nextManagedState.managedThreadIds.length !== managedState.managedThreadIds.length) {
          managedState = nextManagedState;
          scheduleManagedStateSave({
            add: managedState.managedThreadIds.filter((identity) => !previousManagedIds.has(identity)),
          });
        }
        const moves = planMoves(snapshot, config, new Set(managedState.managedThreadIds));
        if (options.verbose || moves.length > 0) log("info", "sidebar reconciliation", { reason, moves: moves.length });
        for (const move of moves) {
          if (!options.dryRun) await appTools.moveThread(move);
          log(options.dryRun ? "dry-run" : "info", "task moved", {
            threadId: move.threadId.slice(-8),
            destination: move.sectionName,
          });
          if (!options.dryRun && move.sectionName === config.sections.forReview) {
            const nextState = forgetManagedThread(managedState, move.threadId, move.hostId);
            if (nextState.managedThreadIds.length !== managedState.managedThreadIds.length) {
              managedState = nextState;
              scheduleManagedStateSave({ remove: [managedIdentity(move.hostId, move.threadId)] });
            }
          }
        }
        await writeHealth(config, {
          state: "ok",
          reason,
          moves: moves.length,
          socket: path.basename(appTools.host.socketPath),
        });
        if (moves.length >= config.maxMovesPerRun && backlogTimer == null) {
          backlogTimer = setTimeout(() => {
            backlogTimer = null;
            void reconcile("backlog");
          }, 1000);
        }
      } while (pending);
    } catch (error) {
      retryAfterFailure = pending;
      pending = false;
      if (error.code === "APP_TOOLS_BACKOFF") {
        if (options.once) throw error;
        return;
      }
      if (!error.backoffRecorded) appTools.noteFailure();
      appTools.reset();
      log("warn", "reconciliation failed", { reason, error: error.message });
      await writeHealth(config, { state: "degraded", reason, error: error.message });
      if (options.once) throw error;
    } finally {
      running = false;
      if (retryAfterFailure && retryTimer == null) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void reconcile("event-retry");
        }, config.failureRetryMs ?? 2000);
      }
    }
  };

  if (options.once) {
    if (existsSync(config.sessionsDir)) {
      const previousManagedIds = new Set(managedState.managedThreadIds);
      const scannedSessions = await scanManagedSessionFiles(managedState, config.sessionsDir);
      managedState = scannedSessions.state;
      managedState = await updateManagedState(config.stateFile, {
        add: managedState.managedThreadIds.filter((identity) => !previousManagedIds.has(identity)),
        lastSessionScanAt: managedState.lastSessionScanAt,
        sessionFiles: managedState.sessionFiles,
      });
    }
    await runWithRetries(
      (attempt) => reconcile(attempt === 0 ? "startup" : `startup-retry-${attempt}`),
      { attempts: 2, delayMs: config.failureRetryMs ?? 2000 },
    );
    appTools.reset();
    return;
  }

  const eventScheduler = createEventScheduler({
    reconcile,
    eventDebounceMs: config.eventDebounceMs,
    settleDelayMs: config.settleDelayMs,
  });
  const schedule = (reason) => eventScheduler.schedule(reason);

  let keepAliveRunning = false;
  const keepAliveTimer = setInterval(() => {
    if (keepAliveRunning || appTools.host == null) return;
    keepAliveRunning = true;
    void appTools.keepAlive()
      .catch((error) => {
        log("warn", "Codex app tools keepalive failed", { error: error.message });
        void reconcile("keepalive-recovery");
      })
      .finally(() => {
        keepAliveRunning = false;
      });
  }, config.socketKeepAliveIntervalMs ?? 10000);

  const refreshSessionWatchers = async () => {
    const previousManagedIds = new Set(managedState.managedThreadIds);
    const targetPaths = sessionDayDirectories(config.sessionsDir);
    watcherDayPath = targetPaths[0];
    const currentFiles = new Set();
    for (const targetPath of targetPaths) {
      if (!existsSync(targetPath)) continue;
      const entries = await readdir(targetPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          currentFiles.add(path.join(targetPath, entry.name));
        }
      }
    }
    for (const [filePath, targetWatcher] of sessionWatchers) {
      if (currentFiles.has(filePath)) continue;
      targetWatcher.close();
      sessionWatchers.delete(filePath);
      sessionIdsByFile.delete(filePath);
    }
    let stateChanged = false;
    for (const filePath of currentFiles) {
      let sessionId = sessionIdsByFile.get(filePath);
      if (sessionId == null) {
        sessionId = await readSessionIdFromFile(filePath).catch(() => null);
        if (sessionId != null) sessionIdsByFile.set(filePath, sessionId);
      }
      const metadata = await stat(filePath).catch(() => null);
      if (metadata != null) {
        const nextState = recordSessionFile(managedState, filePath, sessionId, metadata.mtimeMs);
        if (
          nextState.lastSessionScanAt !== managedState.lastSessionScanAt ||
          nextState.managedThreadIds.length !== managedState.managedThreadIds.length ||
          nextState.sessionFiles[filePath] !== managedState.sessionFiles[filePath]
        ) {
          managedState = nextState;
          stateChanged = true;
        }
      }
      if (sessionWatchers.has(filePath)) continue;
      const targetWatcher = watch(filePath, () => {
        const observedSessionId = sessionIdsByFile.get(filePath);
        if (observedSessionId != null) {
          managedState = recordSessionActivity(managedState, observedSessionId);
          const identity = managedIdentity("local", observedSessionId);
          scheduleManagedStateSave({ add: identity == null ? [] : [identity] });
        }
        schedule("session-event");
      });
      targetWatcher.on("error", (error) => {
        targetWatcher.close();
        sessionWatchers.delete(filePath);
        log("warn", "session watcher failed", { path: filePath, error: error.message });
      });
      sessionWatchers.set(filePath, targetWatcher);
    }
    const retainedSessionFiles = Object.fromEntries(
      Object.entries(managedState.sessionFiles).filter(([filePath]) => currentFiles.has(filePath)),
    );
    if (Object.keys(retainedSessionFiles).length !== Object.keys(managedState.sessionFiles).length) {
      managedState.sessionFiles = retainedSessionFiles;
      stateChanged = true;
    }
    if (stateChanged) {
      scheduleManagedStateSave({
        add: managedState.managedThreadIds.filter((identity) => !previousManagedIds.has(identity)),
      });
    }
  };

  const safelyRefreshSessionWatchers = createSingleFlight(() =>
    refreshSessionWatchers().catch((error) =>
      log("warn", "session watcher refresh failed", { error: error.message }),
    ),
  );

  await reconcile("startup");

  if (existsSync(config.sessionsDir)) {
    await refreshSessionWatchers();
    log("info", "watching current Codex session files", {
      path: watcherDayPath,
      files: sessionWatchers.size,
    });
    await reconcile("session-scan");
  } else {
    log("warn", "sessions directory is unavailable; using fallback reconciliation only", {
      sessionsDir: config.sessionsDir,
    });
  }

  const fallbackTimer = setInterval(() => void reconcile("fallback"), config.fallbackIntervalMs);
  const watcherRefreshTimer = setInterval(safelyRefreshSessionWatchers, 2000);
  const shutdown = async () => {
    for (const targetWatcher of sessionWatchers.values()) targetWatcher.close();
    sessionWatchers.clear();
    clearInterval(fallbackTimer);
    clearInterval(watcherRefreshTimer);
    clearInterval(keepAliveTimer);
    eventScheduler.close();
    clearTimeout(retryTimer);
    clearTimeout(backlogTimer);
    clearTimeout(stateSaveTimer);
    appTools.reset();
    await flushManagedStateUpdates();
    await writeHealth(config, { state: "stopped" });
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

const isMain = process.argv[1] != null && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    log("error", "fatal", { error: error.message });
    process.exitCode = 1;
  });
}
