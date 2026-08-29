import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
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
    return { thread: { id: threadId, status: { type: "notLoaded" } }, turns: [{ status: "completed" }] };
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

const remoteHydrationCalls = [];
const remoteNotLoaded = thread("remote-not-loaded", "notLoaded", "progress", {
  hostId: remoteHostId,
  sidebarItemKey: "codex:thread:local:remote-not-loaded",
});
const remoteHydrated = await sidebarRealtime.hydrateCustomThreads(snapshot([remoteNotLoaded]), config, {
  readThread: async (threadId, hostId) => {
    remoteHydrationCalls.push({ threadId, hostId });
    return { thread: { id: threadId, hostId, status: { type: "notLoaded" } }, turns: [{ status: "completed" }] };
  },
});
assert.deepEqual(remoteHydrationCalls, [{ threadId: remoteNotLoaded.id, hostId: remoteHostId }]);
assert.equal(remoteHydrated.threads[0].status, "completed");
assert.equal(planMoves(remoteHydrated, config)[0].hostId, remoteHostId);

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
assert.equal(
  statusFromThreadRead({ thread: { status: { type: "notLoaded" } }, turns: [{ status: "failed" }] }),
  "needsattention",
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
await assert.rejects(
  sidebarRealtime.keepHostAlive(
    { client: { request: async () => ({ tools: [{ name: "list_threads" }] }) } },
    2_000,
  ),
  /required sidebar tools/,
);

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
