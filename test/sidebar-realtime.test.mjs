import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  confirmPlannedMove,
  parseDeclaredSocketPaths,
  planMoves,
  statusFromThreadRead,
  managedIdentity,
} from "../scripts/sidebar-realtime.mjs";

const sidebarRealtime = await import("../scripts/sidebar-realtime.mjs");

const config = {
  actorThreadId: "automation",
  sections: { inProgress: "In Progress", forReview: "For Review", forLater: "For Later" },
  excludeThreadIds: ["automation", "automation-copy"],
  maxMovesPerRun: 10,
};

function thread(id, status, section, overrides = {}) {
  return {
    id,
    kind: "codex",
    hostId: "local",
    status,
    title: id,
    summary: null,
    section,
    ...overrides,
  };
}

function snapshot(threads) {
  const sections = [
    { sectionId: "pinned", name: "Pinned", itemKeys: [] },
    { sectionId: "review", name: "For Review", itemKeys: [] },
    { sectionId: "progress", name: "In Progress", itemKeys: [] },
    { sectionId: "later", name: "For Later", itemKeys: [] },
    { sectionId: "chats", name: "Tasks", itemKeys: [] },
  ];
  for (const item of threads) {
    const target = sections.find((section) => section.sectionId === item.section);
    if (item.projectContainer === true) {
      const projects = sections.find((section) => section.sectionId === "threads");
      if (projects == null) sections.splice(4, 0, { sectionId: "threads", name: "Projects", itemKeys: [] });
      const projectSection = sections.find((section) => section.sectionId === "threads");
      if (!projectSection.itemKeys.includes(`codex:project:${item.projectId}`)) {
        projectSection.itemKeys.push(`codex:project:${item.projectId}`);
      }
    } else {
      target.itemKeys.push(item.sidebarItemKey ?? `codex:thread:${item.hostId}:${item.id}`);
    }
  }
  if (!sections.some((section) => section.sectionId === "threads")) {
    sections.splice(4, 0, { sectionId: "threads", name: "Projects", itemKeys: [] });
  }
  return { threads, sections };
}

const threads = [
  thread("new-active", "active", "chats"),
  thread("review-resumed", "active", "review"),
  thread("finished", "idle", "progress"),
  thread("manual-later", "active", "later"),
  thread("unknown", "notLoaded", "chats"),
  thread("automation", "idle", "progress"),
  thread("automation-copy", "idle", "progress", { summary: "Automation ID: codex" }),
  thread("chatgpt", "active", "chats", { kind: "chatgpt" }),
];

const moves = planMoves(snapshot(threads), config);
assert.deepEqual(
  moves.map(({ threadId, sectionName }) => [threadId, sectionName]),
  [
    ["new-active", "In Progress"],
    ["review-resumed", "In Progress"],
    ["finished", "For Review"],
  ],
);

for (const status of [
  "needs-attention",
  "needs_attention",
  "failed",
  "interrupted",
  "cancelled",
  "canceled",
]) {
  const terminal = thread(`terminal-${status}`, status, "progress");
  assert.deepEqual(
    planMoves(snapshot([terminal]), config).map(({ threadId, sectionName }) => [threadId, sectionName]),
    [[terminal.id, "For Review"]],
  );
}

const completedBeforeObservation = thread("completed-before-observation", "completed", "chats");
assert.deepEqual(
  planMoves(snapshot([completedBeforeObservation]), config, new Set([completedBeforeObservation.id])).map(
    ({ threadId, sectionName }) => [threadId, sectionName],
  ),
  [["completed-before-observation", "For Review"]],
);
assert.deepEqual(planMoves(snapshot([completedBeforeObservation]), config), []);

assert.equal(typeof sidebarRealtime.assertToolSuccess, "function");
assert.throws(
  () =>
    sidebarRealtime.assertToolSuccess(
      { success: false, contentItems: [{ type: "inputText", text: "move rejected" }] },
      "move_thread_to_sidebar_section",
    ),
  /move_thread_to_sidebar_section returned an error/,
);
try {
  sidebarRealtime.assertToolSuccess(
    { success: false, contentItems: [{ type: "inputText", text: "secret task body" }] },
    "move_thread_to_sidebar_section",
  );
} catch (error) {
  assert.equal(error.message.includes("secret task body"), false);
}
assert.equal(typeof sidebarRealtime.hydrateCustomThreads, "function");

const hydrationSnapshot = snapshot([
  thread("unreadable", "notLoaded", "progress"),
  thread("readable", "notLoaded", "progress"),
]);
const hydratedSnapshot = await sidebarRealtime.hydrateCustomThreads(hydrationSnapshot, config, {
  readThread: async (threadId) => {
    if (threadId === "unreadable") throw new Error("remote host unavailable");
    return {
      thread: { id: threadId, hostId: "local", kind: "codex", status: { type: "notLoaded" } },
      turns: [{ status: "completed" }],
    };
  },
});
assert.equal(
  hydratedSnapshot.threads.find((item) => item.id === "readable")?.status,
  "completed",
);
assert.equal(
  hydratedSnapshot.threads.find((item) => item.id === "unreadable")?.status,
  "notLoaded",
);

assert.equal(typeof sidebarRealtime.sessionIdFromMetaLine, "function");
assert.equal(
  sidebarRealtime.sessionIdFromMetaLine(
    JSON.stringify({
      type: "session_meta",
      payload: {
        session_id: "root-task",
        id: "guardian-session",
        parent_thread_id: "root-task",
        thread_source: "guardian_review",
      },
    }),
  ),
  "root-task",
);
assert.equal(sidebarRealtime.sessionIdFromMetaLine("{}"), null);

assert.equal(typeof sidebarRealtime.normalizeManagedState, "function");
assert.deepEqual(sidebarRealtime.normalizeManagedState(null, 10_000, 2_000), {
  version: 4,
  manageSince: 8_000,
  lastSessionScanAt: 8_000,
  managedThreadIds: [],
  knownThreadIdentities: [],
  sessionFiles: {},
});
assert.deepEqual(
  sidebarRealtime.normalizeManagedState(
    {
      version: 2,
      manageSince: 6_000,
      lastSessionScanAt: 7_000,
      managedThreadIds: ["a", "a", 42, "b"],
      sessionFiles: { "/tmp/a.jsonl": 6_500, invalid: "bad" },
    },
    10_000,
    2_000,
  ),
  {
    version: 4,
    manageSince: 6_000,
    lastSessionScanAt: 7_000,
    managedThreadIds: ["local:a", "local:b"],
    knownThreadIdentities: [],
    sessionFiles: { "/tmp/a.jsonl": 6_500 },
  },
);

assert.equal(typeof sidebarRealtime.readSessionIdFromFile, "function");
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "sidebar-realtime-test-"));
const sessionFile = path.join(temporaryDirectory, "session.jsonl");
await writeFile(
  sessionFile,
  `${JSON.stringify({ type: "session_meta", payload: { session_id: "managed-task" } })}\n` +
    `${JSON.stringify({ type: "event_msg", payload: { message: "ignored" } })}\n`,
  "utf8",
);
assert.equal(await sidebarRealtime.readSessionIdFromFile(sessionFile), "managed-task");
await rm(temporaryDirectory, { recursive: true, force: true });

assert.equal(typeof sidebarRealtime.saveManagedState, "function");
assert.equal(typeof sidebarRealtime.loadManagedState, "function");
const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "sidebar-realtime-state-test-"));
const statePath = path.join(stateDirectory, "state.json");
const managedState = {
  version: 4,
  manageSince: 10_000,
  lastSessionScanAt: 12_345,
  managedThreadIds: ["local:task-a"],
  knownThreadIdentities: [],
  sessionFiles: { "/tmp/task-a.jsonl": 12_000 },
};
await sidebarRealtime.saveManagedState(statePath, managedState);
assert.deepEqual(await sidebarRealtime.loadManagedState(statePath, 99_999, 2_000), managedState);
assert.equal((await stat(statePath)).mode & 0o777, 0o600);
await Promise.all([
  sidebarRealtime.updateManagedState(statePath, { add: ["local:task-b"] }),
  sidebarRealtime.updateManagedState(statePath, { add: ["local:task-c"] }),
]);
assert.deepEqual(
  new Set((await sidebarRealtime.loadManagedState(statePath)).managedThreadIds),
  new Set(["local:task-a", "local:task-b", "local:task-c"]),
);

const malformedOwnerStatePath = path.join(stateDirectory, "malformed-owner-state.json");
const malformedOwnerLockPath = `${malformedOwnerStatePath}.lock`;
const malformedOwnerNow = Date.now();
await writeFile(
  malformedOwnerLockPath,
  `${JSON.stringify({ pid: "not-a-pid", createdAt: malformedOwnerNow + 60_000 })}\n`,
  { mode: 0o600 },
);
const malformedOwnerOldTime = new Date(malformedOwnerNow - 30_001);
await utimes(malformedOwnerLockPath, malformedOwnerOldTime, malformedOwnerOldTime);
await sidebarRealtime.updateManagedState(
  malformedOwnerStatePath,
  { add: ["local:recovered-malformed-owner"] },
  { now: () => malformedOwnerNow, attempts: 1, delayMs: 0, staleAfterMs: 30_000 },
);
assert.deepEqual(
  (await sidebarRealtime.loadManagedState(malformedOwnerStatePath)).managedThreadIds,
  ["local:recovered-malformed-owner"],
);

const slowStatePath = path.join(stateDirectory, "slow-state.json");
await sidebarRealtime.saveManagedState(slowStatePath, managedState);
let releaseSlowOwner;
let slowOwnerReleased = false;
let signalSlowOwnerReady;
const slowOwnerReady = new Promise((resolve) => {
  signalSlowOwnerReady = resolve;
});
const slowOwnerRelease = new Promise((resolve) => {
  releaseSlowOwner = () => {
    if (slowOwnerReleased) return;
    slowOwnerReleased = true;
    resolve();
  };
});
let firstSlowUpdate = null;
try {
  firstSlowUpdate = sidebarRealtime.updateManagedState(
    slowStatePath,
    { add: ["local:slow-first"] },
    {
      now: () => 100_000,
      onBeforeRelease: async () => {
        const firstSnapshot = await readFile(slowStatePath, "utf8");
        signalSlowOwnerReady();
        await slowOwnerRelease;
        await writeFile(slowStatePath, firstSnapshot, { mode: 0o600 });
      },
    },
  );
  await slowOwnerReady;

  let secondError = null;
  try {
    await sidebarRealtime.updateManagedState(
      slowStatePath,
      { add: ["local:slow-second"] },
      { now: () => 130_001, attempts: 1, delayMs: 0, isProcessAlive: () => true },
    );
  } catch (error) {
    secondError = error;
  }

  releaseSlowOwner();
  await firstSlowUpdate;
  assert.equal(secondError?.code, "EEXIST");
  assert.deepEqual(
    new Set((await sidebarRealtime.loadManagedState(slowStatePath)).managedThreadIds),
    new Set(["local:task-a", "local:slow-first"]),
  );
} finally {
  releaseSlowOwner?.();
  await firstSlowUpdate?.catch(() => {});
}

const staleForegroundSnapshot = { ...managedState, managedThreadIds: ["local:task-a"] };
await sidebarRealtime.updateManagedState(statePath, { add: ["local:hook-task"] });
await sidebarRealtime.saveManagedState(statePath, staleForegroundSnapshot);
assert.equal(
  (await sidebarRealtime.loadManagedState(statePath)).managedThreadIds.includes("local:hook-task"),
  true,
);
await writeFile(
  `${statePath}.lock`,
  `${JSON.stringify({ pid: 999_999_999, createdAt: Date.now() - 60_000 })}\n`,
  { mode: 0o600 },
);
await sidebarRealtime.updateManagedState(statePath, { add: ["local:after-stale-lock"] });
assert.equal(
  JSON.parse(await readFile(statePath, "utf8")).managedThreadIds.includes("local:after-stale-lock"),
  true,
);

const staleSymlinkTarget = path.join(stateDirectory, "stale-symlink-target.lock");
await writeFile(
  staleSymlinkTarget,
  `${JSON.stringify({ pid: 999_999_999, createdAt: Date.now() - 60_000 })}\n`,
  { mode: 0o600 },
);
await symlink(staleSymlinkTarget, `${statePath}.lock`);
await assert.rejects(
  sidebarRealtime.updateManagedState(
    statePath,
    { add: ["local:must-not-follow-lock-symlink"] },
    { attempts: 1, delayMs: 0 },
  ),
  (error) => error.code === "EEXIST",
);
assert.equal((await lstat(`${statePath}.lock`)).isSymbolicLink(), true);
assert.match(await readFile(staleSymlinkTarget, "utf8"), /999999999/);
await rm(`${statePath}.lock`, { force: true });

await writeFile(
  `${statePath}.lock`,
  `${JSON.stringify({ pid: 999_999_999, createdAt: Date.now() - 60_000 })}\n`,
  { mode: 0o600 },
);
await assert.rejects(
  sidebarRealtime.updateManagedState(
    statePath,
    { add: ["local:must-not-delete-replacement-lock"] },
    {
      attempts: 1,
      delayMs: 0,
      onBeforeReclaim: async ({ lockPath }) => {
        await rm(lockPath, { force: true });
        await writeFile(lockPath, "replacement\n", { mode: 0o600 });
      },
    },
  ),
  (error) => error.code === "EEXIST",
);
assert.equal(await readFile(`${statePath}.lock`, "utf8"), "replacement\n");
await rm(`${statePath}.lock`, { force: true });

await sidebarRealtime.updateManagedState(
  statePath,
  { add: ["local:release-replacement"] },
  {
    onBeforeRelease: async ({ lockPath }) => {
      await rm(lockPath, { force: true });
      await writeFile(lockPath, "release replacement\n", { mode: 0o600 });
    },
  },
);
assert.equal(await readFile(`${statePath}.lock`, "utf8"), "release replacement\n");
await rm(`${statePath}.lock`, { force: true });

const movedOwnedLock = path.join(stateDirectory, "moved-owned.lock");
await sidebarRealtime.updateManagedState(
  statePath,
  { add: ["local:release-symlink-replacement"] },
  {
    onBeforeRelease: async ({ lockPath }) => {
      await rename(lockPath, movedOwnedLock);
      await symlink(movedOwnedLock, lockPath);
    },
  },
);
assert.equal((await lstat(`${statePath}.lock`)).isSymbolicLink(), true);
assert.match(await readFile(movedOwnedLock, "utf8"), /createdAt/);
await rm(`${statePath}.lock`, { force: true });
await sidebarRealtime.updateManagedState(statePath, { observe: ["remote-control:env_remote_test:blocked-prompt"] });
const observedOnlyState = await sidebarRealtime.loadManagedState(statePath);
assert.equal(observedOnlyState.knownThreadIdentities.includes("remote-control:env_remote_test:blocked-prompt"), true);
assert.equal(observedOnlyState.managedThreadIds.includes("remote-control:env_remote_test:blocked-prompt"), false);
assert.deepEqual(
  planMoves(
    snapshot([thread("blocked-prompt", "idle", "chats", { hostId: "remote-control:env_remote_test" })]),
    config,
    new Set(observedOnlyState.managedThreadIds),
  ),
  [],
);
await rm(stateDirectory, { recursive: true, force: true });

assert.equal(typeof sidebarRealtime.recordSessionActivity, "function");
assert.deepEqual(
  sidebarRealtime.mergePersistedManagedState(
    {
      version: 4,
      manageSince: 10,
      lastSessionScanAt: 20,
      managedThreadIds: [],
      knownThreadIdentities: [],
      sessionFiles: {},
    },
    {
      version: 4,
      manageSince: 10,
      lastSessionScanAt: 20,
      managedThreadIds: ["local:remove-in-flight", "local:keep"],
      knownThreadIdentities: [],
      sessionFiles: {},
    },
    {
      pendingAdds: ["local:add-pending"],
      pendingRemoves: ["local:remove-in-flight"],
    },
  ).managedThreadIds.sort(),
  ["local:add-pending", "local:keep"],
);
assert.deepEqual(
  sidebarRealtime.recordSessionActivity(
    {
      version: 3,
      manageSince: 0,
      lastSessionScanAt: 10,
      managedThreadIds: ["local:task-a"],
      knownThreadIdentities: [],
      sessionFiles: {},
    },
    "task-b",
    20,
  ),
  {
    version: 4,
    manageSince: 0,
    lastSessionScanAt: 20,
    managedThreadIds: ["local:task-a", "local:task-b"],
    knownThreadIdentities: [],
    sessionFiles: {},
  },
);
assert.deepEqual(
  sidebarRealtime.forgetManagedThread(
    {
      version: 3,
      manageSince: 0,
      lastSessionScanAt: 20,
      managedThreadIds: ["local:task-a", "local:task-b"],
      knownThreadIdentities: [],
      sessionFiles: {},
    },
    "task-a",
  ),
  {
    version: 4,
    manageSince: 0,
    lastSessionScanAt: 20,
    managedThreadIds: ["local:task-b"],
    knownThreadIdentities: [],
    sessionFiles: {},
  },
);

assert.equal(typeof sidebarRealtime.recordSessionFile, "function");
const oldFileState = sidebarRealtime.recordSessionFile(
  sidebarRealtime.normalizeManagedState(null, 10_000, 2_000),
  "/tmp/old.jsonl",
  "old-task",
  7_000,
);
assert.deepEqual(oldFileState.managedThreadIds, []);
const newFileState = sidebarRealtime.recordSessionFile(
  oldFileState,
  "/tmp/new.jsonl",
  "new-task",
  9_000,
);
assert.deepEqual(newFileState.managedThreadIds, ["local:new-task"]);
const changedOldFileState = sidebarRealtime.recordSessionFile(
  newFileState,
  "/tmp/old.jsonl",
  "old-task",
  11_000,
);
assert.deepEqual(changedOldFileState.managedThreadIds, ["local:new-task", "local:old-task"]);

assert.equal(typeof sidebarRealtime.scanManagedSessionFiles, "function");
const sessionDirectory = await mkdtemp(path.join(os.tmpdir(), "sidebar-session-scan-"));
const sessionDate = new Date(2026, 7, 29, 12, 0, 0);
const sessionDayPath = path.join(sessionDirectory, "2026", "08", "29");
await mkdir(sessionDayPath, { recursive: true });
const shortTaskPath = path.join(sessionDayPath, "short-task.jsonl");
await writeFile(
  shortTaskPath,
  `${JSON.stringify({ type: "session_meta", payload: { session_id: "short-task" } })}\n`,
);
const scannedSessions = await sidebarRealtime.scanManagedSessionFiles(
  sidebarRealtime.normalizeManagedState(null, Date.now(), 60_000),
  sessionDirectory,
  sessionDate,
);
assert.deepEqual(scannedSessions.state.managedThreadIds, ["local:short-task"]);
assert.deepEqual(scannedSessions.files, [shortTaskPath]);
assert.equal(scannedSessions.sessionIdsByFile[shortTaskPath], "short-task");
await rm(sessionDirectory, { recursive: true, force: true });

const remoteHostId = "remote-control:env_remote_test";
const mismatchedHost = thread("remote-finished", "completed", "progress", {
  hostId: remoteHostId,
  sidebarItemKey: "codex:thread:local:remote-finished",
});
const mismatchedMove = planMoves(snapshot([mismatchedHost]), config)[0];
assert.equal(mismatchedMove.sectionName, "For Review");
assert.equal(mismatchedMove.hostId, remoteHostId);

const remoteProjectActive = thread("remote-project-active", "active", "threads", {
  hostId: remoteHostId,
  projectId: "remote-project",
  projectContainer: true,
});
const remoteProjectMove = planMoves(snapshot([remoteProjectActive]), config)[0];
assert.equal(remoteProjectMove.sectionName, "In Progress");
assert.equal(remoteProjectMove.hostId, remoteHostId);

const projectWithDirectCustom = thread("project-direct-custom", "active", "threads", {
  projectId: "remote-project",
  projectContainer: true,
});
const projectWithDirectCustomSnapshot = snapshot([projectWithDirectCustom]);
projectWithDirectCustomSnapshot.sections.push({
  sectionId: "other-custom",
  name: "Other Custom",
  itemKeys: [`codex:thread:${remoteHostId}:${projectWithDirectCustom.id}`],
});
assert.deepEqual(planMoves(projectWithDirectCustomSnapshot, config), []);

const remoteProjectCompleted = thread("remote-project-completed", "completed", "threads", {
  hostId: remoteHostId,
  projectId: "remote-project",
  projectContainer: true,
});
assert.equal(
  planMoves(
    snapshot([remoteProjectCompleted]),
    config,
    new Set([managedIdentity(remoteHostId, remoteProjectCompleted.id)]),
  )[0].sectionName,
  "For Review",
);

const remoteProjectHydrationTasks = [
  thread("remote-project-hydrate-active", "notLoaded", "threads", {
    hostId: remoteHostId,
    projectId: "remote-hydration-project",
    projectContainer: true,
  }),
  thread("remote-project-hydrate-completed", "notLoaded", "threads", {
    hostId: remoteHostId,
    projectId: "remote-hydration-project",
    projectContainer: true,
  }),
  thread("remote-project-hydrate-attention", "notLoaded", "threads", {
    hostId: remoteHostId,
    projectId: "remote-hydration-project",
    projectContainer: true,
  }),
];
const remoteProjectHydrationCalls = [];
const remoteProjectHydrated = await sidebarRealtime.hydrateCustomThreads(
  snapshot(remoteProjectHydrationTasks),
  config,
  {
    readThread: async (threadId, hostId) => {
      remoteProjectHydrationCalls.push({ threadId, hostId });
      if (threadId.endsWith("active")) {
        return {
          thread: { id: threadId, hostId, kind: "codex", status: { type: "active", activeFlags: [] } },
          turns: [{ status: "inProgress" }],
        };
      }
      if (threadId.endsWith("attention")) {
        return {
          thread: {
            id: threadId,
            hostId,
            kind: "codex",
            status: { type: "active", activeFlags: ["waitingOnUserInput"] },
          },
          turns: [{ status: "inProgress" }],
        };
      }
      return {
        thread: { id: threadId, hostId, kind: "codex", status: { type: "notLoaded" } },
        turns: [{ status: "completed" }],
      };
    },
  },
);
assert.deepEqual(
  remoteProjectHydrationCalls,
  remoteProjectHydrationTasks.map(({ id }) => ({ threadId: id, hostId: remoteHostId })),
);
assert.deepEqual(
  remoteProjectHydrated.threads.map(({ status }) => status),
  ["active", "completed", "needsattention"],
);
assert.deepEqual(
  planMoves(
    remoteProjectHydrated,
    config,
    new Set(remoteProjectHydrationTasks.map(({ id }) => managedIdentity(remoteHostId, id))),
  ).map(({ threadId, sectionName }) => [threadId, sectionName]),
  [
    ["remote-project-hydrate-active", "In Progress"],
    ["remote-project-hydrate-completed", "For Review"],
    ["remote-project-hydrate-attention", "For Review"],
  ],
);

const projectTerminalTransition = snapshot([
  thread("remote-project-transition-completed", "active", "threads", {
    hostId: remoteHostId,
    projectId: "remote-transition-project",
    projectContainer: true,
  }),
  thread("remote-project-transition-attention", "active", "threads", {
    hostId: remoteHostId,
    projectId: "remote-transition-project",
    projectContainer: true,
  }),
]);
const projectTerminalOutcome = await sidebarRealtime.hydrateSnapshotWithActivity(
  projectTerminalTransition,
  sidebarRealtime.normalizeManagedState(null, 10_000, 0),
  config,
  {
    readThread: async (threadId, hostId) => threadId.endsWith("attention")
      ? {
          thread: {
            id: threadId,
            hostId,
            kind: "codex",
            status: { type: "active", activeFlags: ["waitingOnApproval"] },
          },
          turns: [{ status: "inProgress" }],
        }
      : {
          thread: { id: threadId, hostId, kind: "codex", status: { type: "notLoaded" } },
          turns: [{ status: "completed" }],
        },
  },
);
assert.deepEqual(
  new Set(projectTerminalOutcome.managedState.managedThreadIds),
  new Set(projectTerminalTransition.threads.map(({ id }) => managedIdentity(remoteHostId, id))),
);
assert.deepEqual(
  planMoves(
    projectTerminalOutcome.snapshot,
    config,
    new Set(projectTerminalOutcome.managedState.managedThreadIds),
  ).map(({ threadId, sectionName }) => [threadId, sectionName]),
  [
    ["remote-project-transition-completed", "For Review"],
    ["remote-project-transition-attention", "For Review"],
  ],
);

const protectedProjectHydration = snapshot([
  thread("remote-project-protected", "notLoaded", "threads", {
    hostId: remoteHostId,
    projectId: "remote-protected-project",
    projectContainer: true,
  }),
]);
protectedProjectHydration.sections.find((section) => section.sectionId === "pinned").itemKeys.push(
  "codex:project:remote-protected-project",
);
let protectedProjectReads = 0;
await sidebarRealtime.hydrateCustomThreads(protectedProjectHydration, config, {
  readThread: async () => {
    protectedProjectReads += 1;
    throw new Error("protected Project must not be hydrated");
  },
});
assert.equal(protectedProjectReads, 0);

const remoteHydrationCalls = [];
const remoteNotLoaded = thread("remote-not-loaded", "notLoaded", "progress", {
  hostId: remoteHostId,
  sidebarItemKey: "codex:thread:local:remote-not-loaded",
});
const remoteHydrated = await sidebarRealtime.hydrateCustomThreads(snapshot([remoteNotLoaded]), config, {
  readThread: async (threadId, hostId) => {
    remoteHydrationCalls.push({ threadId, hostId });
    return {
      thread: { id: threadId, hostId, kind: "codex", status: { type: "notLoaded" } },
      turns: [{ status: "completed" }],
    };
  },
});
assert.deepEqual(remoteHydrationCalls, [{ threadId: remoteNotLoaded.id, hostId: remoteHostId }]);
assert.equal(remoteHydrated.threads[0].status, "completed");
assert.equal(planMoves(remoteHydrated, config)[0].hostId, remoteHostId);

const wrongHostHydration = snapshot([thread("wrong-host-hydration", "notLoaded", "progress", {
  hostId: remoteHostId,
  sidebarItemKey: "codex:thread:local:wrong-host-hydration",
})]);
await sidebarRealtime.hydrateCustomThreads(wrongHostHydration, config, {
  readThread: async (threadId) => ({
    thread: { id: threadId, hostId: "local", kind: "codex", status: { type: "completed" } },
    turns: [{ status: "completed" }],
  }),
});
assert.equal(wrongHostHydration.threads[0].status, "notLoaded");
assert.match(wrongHostHydration.hydrationErrors[0].error, /identity did not match/);

const reviewNotLoaded = thread("review-not-loaded", "notLoaded", "review", { hostId: remoteHostId });
const reviewHydrated = await sidebarRealtime.hydrateCustomThreads(snapshot([reviewNotLoaded]), config, {
  readThread: async (threadId, hostId) => ({
    thread: { id: threadId, hostId, kind: "codex", status: { type: "active", activeFlags: [] } },
    turns: [{ status: "inProgress" }],
  }),
});
assert.equal(reviewHydrated.threads[0].status, "active");
assert.equal(planMoves(reviewHydrated, config)[0].sectionName, "In Progress");

const remoteMissingFromList = snapshot([]);
remoteMissingFromList.sections.find((section) => section.sectionId === "progress").itemKeys.push(
  "codex:thread:local:remote-stale",
);
const remoteMissingCalls = [];
const remoteMissingHydrated = await sidebarRealtime.hydrateCustomThreads(
  remoteMissingFromList,
  config,
  {
    readThread: async (threadId, hostId) => {
      remoteMissingCalls.push({ threadId, hostId });
      return {
        thread: { id: threadId, kind: "codex", hostId: remoteHostId, status: { type: "idle" } },
        turns: [{ status: "completed" }],
      };
    },
  },
  new Map([["remote-stale", remoteHostId]]),
);
assert.deepEqual(remoteMissingCalls, [{ threadId: "remote-stale", hostId: remoteHostId }]);
assert.equal(planMoves(remoteMissingHydrated, config)[0].hostId, remoteHostId);

const hostlessMissing = snapshot([]);
hostlessMissing.sections.find((section) => section.sectionId === "progress").itemKeys.push(
  "codex:thread:local:hostless-remote",
);
const hostlessCalls = [];
const hostlessHydrated = await sidebarRealtime.hydrateCustomThreads(hostlessMissing, config, {
  readThread: async (threadId, hostId) => {
    hostlessCalls.push({ threadId, hostId });
    return { thread: { id: threadId, kind: "codex", hostId: remoteHostId, status: { type: "idle" } }, turns: [] };
  },
});
assert.deepEqual(hostlessCalls, []);
assert.match(hostlessHydrated.hydrationErrors[0].error, /no authoritative hostId/);

for (const protectedSection of ["pinned", "later"]) {
  const child = thread(`protected-parent-${protectedSection}`, "idle", "progress", {
    projectId: `project-${protectedSection}`,
  });
  const protectedSnapshot = snapshot([child]);
  protectedSnapshot.sections.find((section) => section.sectionId === protectedSection).itemKeys.push(
    `codex:project:${child.projectId}`,
  );
  assert.deepEqual(planMoves(protectedSnapshot, config), []);
}

const duplicateDirect = snapshot([thread("duplicate-direct", "active", "chats")]);
duplicateDirect.sections.find((section) => section.sectionId === "pinned").itemKeys.push(
  "codex:thread:local:duplicate-direct",
);
assert.deepEqual(planMoves(duplicateDirect, config), []);

const duplicateProject = snapshot([thread("duplicate-project", "active", "threads", {
  projectId: "duplicate-project-parent",
  projectContainer: true,
})]);
duplicateProject.sections.find((section) => section.sectionId === "later").itemKeys.push(
  "codex:project:duplicate-project-parent",
);
assert.deepEqual(planMoves(duplicateProject, config), []);

const duplicateHostId = snapshot([
  thread("same-id-two-hosts", "active", "chats", { hostId: "local" }),
  thread("same-id-two-hosts", "active", "chats", { hostId: remoteHostId }),
]);
assert.deepEqual(planMoves(duplicateHostId, config), []);

const duplicateSameHostId = snapshot([
  thread("same-id-same-host", "active", "chats", { hostId: "local" }),
  thread("same-id-same-host", "active", "chats", { hostId: "local" }),
]);
assert.deepEqual(planMoves(duplicateSameHostId, config), []);

assert.throws(
  () => planMoves(snapshot([]), {
    ...config,
    sections: { inProgress: "Pinned", forReview: "For Review", forLater: "For Later" },
  }),
  (error) => error.code === "INVALID_SECTION_CONFIG",
);

const confirmSource = snapshot([thread("confirm-final-read", "active", "chats")]);
const plannedConfirmation = planMoves(confirmSource, config)[0];
let finalReads = 0;
const rejectedConfirmation = await confirmPlannedMove({
  listThreads: async () => structuredClone(confirmSource),
  readThread: async (threadId, hostId) => {
    finalReads += 1;
    return {
      thread: { id: threadId, hostId, kind: "codex", status: { type: "idle" } },
      turns: [{ status: "completed" }],
    };
  },
}, plannedConfirmation, config);
assert.equal(rejectedConfirmation, null);
assert.equal(finalReads, 1);

const acceptedConfirmation = await confirmPlannedMove({
  listThreads: async () => structuredClone(confirmSource),
  readThread: async (threadId, hostId) => ({
    thread: { id: threadId, hostId, kind: "codex", status: { type: "active", activeFlags: [] } },
    turns: [{ status: "inProgress" }],
  }),
}, plannedConfirmation, config);
assert.deepEqual(acceptedConfirmation, plannedConfirmation);

assert.deepEqual(planMoves(snapshot([thread("remote-active-idempotent", "active", "progress", {
  hostId: remoteHostId,
  sidebarItemKey: "codex:thread:local:remote-active-idempotent",
})]), config), []);
assert.deepEqual(planMoves(snapshot([thread("remote-complete-idempotent", "completed", "review", {
  hostId: remoteHostId,
  sidebarItemKey: "codex:thread:local:remote-complete-idempotent",
})]), config), []);

const readThreadArgs = [];
const readThreadAppTools = new sidebarRealtime.AppTools(config);
readThreadAppTools.call = async (name, args) => {
  readThreadArgs.push({ name, args });
  return {
    success: true,
    contentItems: [{ type: "inputText", text: JSON.stringify({ thread: {}, turns: [] }) }],
  };
};
await readThreadAppTools.readThread("remote-read", remoteHostId);
assert.equal(readThreadArgs[0].args.hostId, remoteHostId);

const recordedRemote = sidebarRealtime.recordSnapshotActivity(
  sidebarRealtime.normalizeManagedState(null, 10_000, 0),
  snapshot([remoteProjectActive]),
);
assert.deepEqual(recordedRemote.managedThreadIds, [managedIdentity(remoteHostId, remoteProjectActive.id)]);

assert.equal(
  statusFromThreadRead({ thread: { status: { type: "notLoaded" } }, turns: [{ status: "completed" }] }),
  "completed",
);
for (const turnStatus of [
  "needs-attention",
  "needs_attention",
  "failed",
  "interrupted",
  "cancelled",
  "canceled",
]) {
  assert.equal(
    statusFromThreadRead({
      thread: { status: { type: "notLoaded" } },
      turns: [{ status: turnStatus }],
    }),
    "needsattention",
  );
}
assert.equal(
  statusFromThreadRead({ thread: { status: { type: "idle" } }, turns: [{ status: "inProgress" }] }),
  "active",
);
for (const activeFlag of ["waitingOnApproval", "waitingOnUserInput"]) {
  assert.equal(
    statusFromThreadRead({
      thread: { status: { type: "active", activeFlags: [activeFlag] } },
      turns: [{ status: "inProgress" }],
    }),
    "needsattention",
  );
}

const attentionTask = thread("attention-task", { type: "active", activeFlags: [] }, "progress");
const attentionHydrated = await sidebarRealtime.hydrateCustomThreads(snapshot([attentionTask]), config, {
  readThread: async () => ({
    thread: {
      id: attentionTask.id,
      hostId: "local",
      kind: "codex",
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    },
    turns: [{ status: "inProgress" }],
  }),
});
assert.equal(attentionHydrated.threads[0].status, "needsattention");
assert.equal(planMoves(attentionHydrated, config)[0].sectionName, "For Review");

assert.deepEqual(
  sidebarRealtime.managedHostsByThreadId([
    "local:task-a",
    `${remoteHostId}:remote-a`,
  ]),
  new Map([["task-a", "local"], ["remote-a", remoteHostId]]),
);

assert.throws(
  () => planMoves({ ...snapshot([]), sections: snapshot([]).sections.filter((section) => section.name !== "For Review") }, config),
  /exactly one sidebar section named For Review/,
);

assert.deepEqual(
  parseDeclaredSocketPaths(
    'codex app-server env={"CODEX_APP_TOOLS_PIPE_PATH"="/tmp/codex-browser-use/live.sock"}\n' +
      'duplicate CODEX_APP_TOOLS_PIPE_PATH=/tmp/codex-browser-use/live.sock',
  ),
  ["/tmp/codex-browser-use/live.sock"],
);

assert.equal(typeof sidebarRealtime.selectSocketCandidates, "function");
assert.deepEqual(
  sidebarRealtime.selectSocketCandidates(
    ["/tmp/explicit.sock", "/tmp/declared.sock"],
    ["/tmp/declared.sock", "/tmp/newest.sock", "/tmp/older.sock"],
    3,
  ),
  ["/tmp/explicit.sock", "/tmp/declared.sock", "/tmp/newest.sock"],
);
assert.equal(typeof sidebarRealtime.isTrustedSocketMetadata, "function");
assert.equal(sidebarRealtime.isTrustedSocketMetadata({ isSocket: () => true, uid: 501 }, 501), true);
assert.equal(sidebarRealtime.isTrustedSocketMetadata({ isSocket: () => true, uid: 502 }, 501), false);
assert.deepEqual(
  await sidebarRealtime.filterTrustedSocketPaths(
    ["/tmp/owned.sock", "/tmp/not-a-socket", "/tmp/foreign.sock"],
    {
      userId: 501,
      statPath: async (socketPath) => ({
        uid: socketPath === "/tmp/foreign.sock" ? 502 : 501,
        isSocket: () => socketPath !== "/tmp/not-a-socket",
      }),
    },
  ),
  ["/tmp/owned.sock"],
);
assert.equal(typeof sidebarRealtime.promoteClientTimeout, "function");
const promotedClient = new sidebarRealtime.NativePipeClient("/tmp/not-used.sock", 100);
sidebarRealtime.promoteClientTimeout(promotedClient, 15_000);
assert.equal(promotedClient.timeoutMs, 15_000);
assert.equal(typeof sidebarRealtime.nextBackoffMs, "function");
assert.equal(sidebarRealtime.nextBackoffMs(1, 1_000, 30_000), 1_000);
assert.equal(sidebarRealtime.nextBackoffMs(4, 1_000, 30_000), 8_000);
assert.equal(sidebarRealtime.nextBackoffMs(10, 1_000, 30_000), 30_000);

assert.equal(typeof sidebarRealtime.keepHostAlive, "function");
const keepAliveRequests = [];
await sidebarRealtime.keepHostAlive(
  {
    client: {
      request: async (...args) => {
        keepAliveRequests.push(args);
        return {
          tools: [
            { name: "list_threads" },
            { name: "move_thread_to_sidebar_section" },
            { name: "read_thread" },
          ],
        };
      },
    },
  },
  2_000,
);
assert.deepEqual(keepAliveRequests, [["tools/list", { threadStartKind: "all" }, 2_000]]);
await sidebarRealtime.keepHostAlive(
  {
    client: {
      request: async () => ({
        tools: [
          { name: "list_threads" },
          { name: "read_thread" },
        ],
      }),
    },
  },
  2_000,
  ["list_threads", "read_thread"],
);
await assert.rejects(
  sidebarRealtime.keepHostAlive(
    { client: { request: async () => ({ tools: [{ name: "list_threads" }] }) } },
    2_000,
  ),
  /required sidebar tools/,
);

assert.deepEqual(sidebarRealtime.RECONCILER_TOOLS, [
  "list_threads",
  "read_thread",
  "move_thread_to_sidebar_section",
]);

const reconcilerTools = new sidebarRealtime.AppTools(config);
assert.deepEqual(reconcilerTools.requiredTools, [
  "list_threads",
  "read_thread",
  "move_thread_to_sidebar_section",
]);

const observationTools = new sidebarRealtime.AppTools(config, {
  requiredTools: ["list_threads", "read_thread"],
});
assert.deepEqual(observationTools.requiredTools, ["list_threads", "read_thread"]);
assert.equal(observationTools.requiredTools.includes("move_thread_to_sidebar_section"), false);

const eventHookTools = new sidebarRealtime.AppTools(config, {
  requiredTools: ["list_threads", "read_thread", "send_message_to_thread"],
});
assert.deepEqual(eventHookTools.requiredTools, [
  "list_threads",
  "read_thread",
  "send_message_to_thread",
]);

const sendMessageCalls = [];
eventHookTools.call = async (name, args) => {
  sendMessageCalls.push({ name, args });
  return { success: true, contentItems: [] };
};
await eventHookTools.sendMessageToThread({
  threadId: "hook-target",
  hostId: remoteHostId,
  prompt: "hook prompt",
});
assert.deepEqual(sendMessageCalls, [{
  name: "send_message_to_thread",
  args: {
    threadId: "hook-target",
    hostId: remoteHostId,
    prompt: "hook prompt",
  },
}]);

const moveCalls = [];
const moveTools = new sidebarRealtime.AppTools(config);
moveTools.call = async (name, args) => {
  moveCalls.push({ name, args });
  return { success: true, contentItems: [] };
};
await moveTools.moveThread(mismatchedMove);
assert.deepEqual(moveCalls, [{
  name: "move_thread_to_sidebar_section",
  args: {
    threadId: mismatchedMove.threadId,
    hostId: remoteHostId,
    sectionId: mismatchedMove.sectionId,
  },
}]);

{
  const client = new sidebarRealtime.NativePipeClient("/tmp/not-used.sock", 200);
  let writes = 0;
  let logicalNow = 0;
  client.connect = async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    logicalNow = 50;
    client.socket = {
      destroyed: false,
      write(_frame, callback) {
        writes += 1;
        callback?.(null);
      },
    };
  };
  await assert.rejects(
    client.request("tools/call", { ping: true }, 200, {
      canDispatch: () => logicalNow < 20,
    }),
    (error) => error?.code === "WAKE_DEADLINE",
  );
  assert.equal(writes, 0);
}

{
  let closedHosts = 0;
  let sendCalls = 0;
  const cancellingTools = new sidebarRealtime.AppTools(
    {
      ...config,
      quiet: true,
      actorThreadId: "hook-actor",
      socketProbeTimeoutMs: 200,
      requestTimeoutMs: 200,
      discoveryTimeoutMs: 200,
    },
    {
      requiredTools: ["list_threads", "read_thread", "send_message_to_thread"],
      discoverHost: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return {
          socketPath: "/tmp/fake.sock",
          toolMap: new Map([
            ["send_message_to_thread", { name: "send_message_to_thread", namespace: "codex" }],
          ]),
          client: {
            timeoutMs: 200,
            close() {
              closedHosts += 1;
            },
            async request(method) {
              if (method === "tools/call") sendCalls += 1;
              return { success: true, contentItems: [] };
            },
          },
        };
      },
    },
  );
  const controller = new AbortController();

  try {
    const pendingSend = cancellingTools.sendMessageToThread(
      { threadId: "hook-target", hostId: remoteHostId, prompt: "hook prompt" },
      { signal: controller.signal, canDispatch: () => !controller.signal.aborted },
    );
    setTimeout(() => {
      controller.abort();
      cancellingTools.reset();
    }, 10);
    await assert.rejects(pendingSend, (error) => error?.code === "WAKE_DEADLINE");
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(sendCalls, 0);
    assert.equal(cancellingTools.host, null);
    assert.equal(closedHosts, 1);
  } finally {
    controller.abort();
  }
}

const reducedCapabilityHost = {
  client: { close() {} },
  toolMap: new Map([
    ["list_threads", { name: "list_threads", namespace: "codex" }],
    ["read_thread", { name: "read_thread", namespace: "codex" }],
  ]),
};
assert.equal(typeof observationTools.acceptsHost, "function");
assert.equal(observationTools.acceptsHost(reducedCapabilityHost), true);
assert.equal(reconcilerTools.acceptsHost(reducedCapabilityHost), false);

const keepAliveObserver = new sidebarRealtime.AppTools(
  { ...config, socketKeepAliveTimeoutMs: 250, quiet: true },
  { requiredTools: ["list_threads", "read_thread"] },
);
let keepAliveClosed = 0;
keepAliveObserver.host = {
  socketPath: "/tmp/reduced.sock",
  toolMap: reducedCapabilityHost.toolMap,
  client: {
    close() {
      keepAliveClosed += 1;
    },
    request: async () => ({
      tools: [{ name: "list_threads" }],
    }),
  },
};
await assert.rejects(keepAliveObserver.keepAlive(), /required sidebar tools/);
assert.equal(keepAliveClosed, 1);
assert.equal(keepAliveObserver.host, null);

assert.equal(typeof sidebarRealtime.createEventScheduler, "function");
const scheduledReasons = [];
const schedulerStartedAt = Date.now();
const eventScheduler = sidebarRealtime.createEventScheduler({
  eventDebounceMs: 60,
  settleDelayMs: 120,
  reconcile: async (reason) => scheduledReasons.push({ reason, elapsedMs: Date.now() - schedulerStartedAt }),
});
for (let index = 0; index < 6; index += 1) {
  eventScheduler.schedule("continuous-event");
  await new Promise((resolve) => setTimeout(resolve, 30));
}
await new Promise((resolve) => setTimeout(resolve, 160));
eventScheduler.close();
assert.equal(scheduledReasons[0].elapsedMs < 150, true);
assert.equal(scheduledReasons.some(({ reason }) => reason === "continuous-event:settled"), true);

assert.equal(typeof sidebarRealtime.sessionDayDirectories, "function");
assert.deepEqual(
  sidebarRealtime.sessionDayDirectories(
    "/sessions",
    new Date(2026, 7, 30, 0, 1, 0),
  ),
  ["/sessions/2026/08/30", "/sessions/2026/08/29"],
);

assert.equal(typeof sidebarRealtime.createSingleFlight, "function");
let activeRefreshes = 0;
let maximumActiveRefreshes = 0;
let refreshRuns = 0;
const refreshOnce = sidebarRealtime.createSingleFlight(async () => {
  refreshRuns += 1;
  activeRefreshes += 1;
  maximumActiveRefreshes = Math.max(maximumActiveRefreshes, activeRefreshes);
  await new Promise((resolve) => setTimeout(resolve, 25));
  activeRefreshes -= 1;
  return refreshRuns;
});
const refreshResults = await Promise.all([refreshOnce(), refreshOnce(), refreshOnce()]);
assert.deepEqual(refreshResults, [1, 1, 1]);
assert.equal(maximumActiveRefreshes, 1);

assert.equal(typeof sidebarRealtime.runWithRetries, "function");
let retryAttempts = 0;
assert.equal(
  await sidebarRealtime.runWithRetries(
    async () => {
      retryAttempts += 1;
      if (retryAttempts === 1) throw new Error("transient");
      return "ok";
    },
    { attempts: 2, delayMs: 0 },
  ),
  "ok",
);
assert.equal(retryAttempts, 2);

const onceExitDirectory = await mkdtemp(path.join(os.tmpdir(), "sidebar-once-exit-test-"));
const onceExitConfigPath = path.join(onceExitDirectory, "config.json");
await writeFile(
  onceExitConfigPath,
  `${JSON.stringify({
    actorThreadId: "test-actor",
    socketDir: path.join(onceExitDirectory, "missing-sockets"),
    sessionsDir: path.join(onceExitDirectory, "missing-sessions"),
    stateFile: path.join(onceExitDirectory, "state.json"),
    healthFile: null,
    sections: {
      inProgress: "In Progress",
      forReview: "For Review",
      forLater: "For Later",
    },
    failureRetryMs: 0,
    discoveryTimeoutMs: 25,
    maxSocketCandidates: 0,
  })}\n`,
);
const onceExitResult = await new Promise((resolve) => {
  const child = spawn(
    process.execPath,
    [path.join(import.meta.dirname, "..", "scripts", "sidebar-realtime.mjs"), "--once", "--config", onceExitConfigPath],
    { stdio: "ignore" },
  );
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    resolve({ timedOut: true });
  }, 750);
  child.once("exit", (code, signal) => {
    clearTimeout(timer);
    resolve({ code, signal, timedOut: false });
  });
});
assert.deepEqual(onceExitResult, { code: 1, signal: null, timedOut: false });
await rm(onceExitDirectory, { recursive: true, force: true });

process.stdout.write("sidebar-realtime tests passed\n");
