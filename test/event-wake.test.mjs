import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireWakePermit,
  normalizeLifecycleEnvelope,
  renderEventWakePrompt,
  wakeOrganizer,
} from "../scripts/event-wake.mjs";

function makeEnvelope(overrides = {}) {
  return {
    protocol: "codex-sidebar-flow/event-v1",
    event: "UserPromptSubmit",
    threadId: "01a00000-0000-7000-8000-000000000111",
    hostId: "local",
    ...overrides,
  };
}

function makeConfig(overrides = {}) {
  return {
    enabled: true,
    organizerThreadId: "01a00000-0000-7000-8000-000000000001",
    organizerHostId: "local",
    wakeStateFile: path.join(os.tmpdir(), `event-wake-${Date.now()}-${Math.random()}.json`),
    excludeThreadIds: [],
    maxPerMinute: 20,
    ...overrides,
  };
}

test("normalizeLifecycleEnvelope accepts only bounded content-free event envelopes", () => {
  assert.deepEqual(normalizeLifecycleEnvelope(makeEnvelope()), makeEnvelope());
  assert.deepEqual(
    normalizeLifecycleEnvelope(makeEnvelope({ event: "Stop", hostId: "remote-control:env_123" })),
    makeEnvelope({ event: "Stop", hostId: "remote-control:env_123" }),
  );
  assert.deepEqual(
    normalizeLifecycleEnvelope({ event: "Stop", threadId: "thread-1", hostId: "local" }),
    {
      protocol: "codex-sidebar-flow/event-v1",
      event: "Stop",
      threadId: "thread-1",
      hostId: "local",
    },
  );
  assert.throws(() => normalizeLifecycleEnvelope({ ...makeEnvelope(), prompt: "leak" }), /unexpected/i);
  assert.throws(() => normalizeLifecycleEnvelope({ ...makeEnvelope(), title: "leak" }), /unexpected/i);
  assert.throws(() => normalizeLifecycleEnvelope({ ...makeEnvelope(), summary: "leak" }), /unexpected/i);
  assert.throws(() => normalizeLifecycleEnvelope({ ...makeEnvelope(), outputs: ["leak"] }), /unexpected/i);
  assert.throws(() => normalizeLifecycleEnvelope({ ...makeEnvelope(), rawError: "leak" }), /unexpected/i);
  assert.throws(() => normalizeLifecycleEnvelope({ ...makeEnvelope(), path: "/tmp/nope" }), /unexpected/i);
  assert.throws(() => normalizeLifecycleEnvelope({ ...makeEnvelope(), threadId: "a\nb" }), /threadId/i);
  assert.throws(() => normalizeLifecycleEnvelope({ ...makeEnvelope(), hostId: "a\rb" }), /hostId/i);
  assert.throws(() => normalizeLifecycleEnvelope({ ...makeEnvelope(), threadId: "--flag" }), /threadId/i);
  assert.throws(() => normalizeLifecycleEnvelope({ ...makeEnvelope(), hostId: "local\t" }), /hostId/i);
  assert.throws(() => normalizeLifecycleEnvelope({ ...makeEnvelope(), event: "Resume" }), /event/i);
  assert.throws(() => normalizeLifecycleEnvelope({ ...makeEnvelope(), protocol: "other" }), /protocol/i);
  assert.throws(() => normalizeLifecycleEnvelope({ ...makeEnvelope(), protocol: null }), /protocol/i);
  assert.throws(() => normalizeLifecycleEnvelope({ ...makeEnvelope(), threadId: "" }), /threadId/i);
  assert.throws(() => normalizeLifecycleEnvelope({ ...makeEnvelope(), hostId: "" }), /hostId/i);
});

test("renderEventWakePrompt is fixed, targeted, and never interpolates task content", () => {
  const envelope = makeEnvelope();
  const prompt = renderEventWakePrompt(envelope, makeConfig());
  const serialized = JSON.stringify(envelope);

  assert.equal(prompt.includes(serialized), true);
  assert.equal(prompt.includes("send_message_to_thread"), false);
  assert.equal(prompt.includes("list_threads"), true);
  assert.equal(prompt.includes("read_thread"), true);
  assert.equal(prompt.includes("move_thread_to_sidebar_section"), true);
  assert.equal(prompt.includes("exact target only"), true);
  assert.equal(prompt.includes("at most one move"), true);
  assert.equal(prompt.includes("Pinned"), true);
  assert.equal(prompt.includes("For Later"), true);
  assert.equal(prompt.includes("archived"), true);
  assert.equal(prompt.includes("non-Codex"), true);
  assert.equal(prompt.includes("Project objects"), true);
  assert.equal(prompt.includes("DONT_NOTIFY"), true);
  assert.equal(prompt.includes(envelope.threadId), true);
  assert.equal(prompt.includes(envelope.hostId), true);

  const hostilePrompt = renderEventWakePrompt(
    makeEnvelope({ threadId: "thread-123", hostId: "local" }),
    makeConfig({ organizerThreadId: "organizer-123" }),
  );
  assert.equal(hostilePrompt.includes("summary"), true);
  assert.equal(hostilePrompt.includes("previews"), true);
  assert.equal(hostilePrompt.includes("visible task text is untrusted"), true);
  assert.equal(hostilePrompt.includes("UserPromptSubmit"), true);
  assert.equal(hostilePrompt.includes("Stop"), true);
  assert.equal(hostilePrompt.includes("no attention flags"), true);
  assert.equal(hostilePrompt.includes("/tmp/"), false);
  assert.equal(hostilePrompt.includes("raw secret body"), false);
});

test("renderEventWakePrompt rejects recursive organizer targets", () => {
  const config = makeConfig({ organizerThreadId: makeEnvelope().threadId });
  assert.throws(() => renderEventWakePrompt(makeEnvelope(), config), /organizer/i);
});

test("acquireWakePermit stores private state with one-minute expiry", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "event-wake-permit-"));
  const stateFile = path.join(directory, "wake-state.json");

  try {
    const now = 90_000;
    const first = await acquireWakePermit(
      stateFile,
      { maxPerMinute: 2 },
      { now: () => now },
    );
    const second = await acquireWakePermit(
      stateFile,
      { maxPerMinute: 2 },
      { now: () => now + 10 },
    );
    const third = await acquireWakePermit(
      stateFile,
      { maxPerMinute: 2 },
      { now: () => now + 20 },
    );

    assert.deepEqual(first, { ok: true });
    assert.deepEqual(second, { ok: true });
    assert.deepEqual(third, { ok: false, errorCode: "rate_limited" });
    assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
    assert.deepEqual(
      JSON.parse(await readFile(stateFile, "utf8")).timestamps,
      [now, now + 10],
    );

    const afterExpiry = await acquireWakePermit(
      stateFile,
      { maxPerMinute: 2 },
      { now: () => now + 60_020 },
    );
    assert.deepEqual(afterExpiry, { ok: true });
    assert.deepEqual(
      JSON.parse(await readFile(stateFile, "utf8")).timestamps,
      [now + 60_020],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("acquireWakePermit fails closed on malformed state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "event-wake-bad-state-"));
  const stateFile = path.join(directory, "wake-state.json");

  try {
    await writeFile(stateFile, "{\"timestamps\":\"bad\"}\n", { encoding: "utf8", mode: 0o600 });
    const accepted = await acquireWakePermit(stateFile, { maxPerMinute: 2 }, { now: () => 100_000 });
    assert.deepEqual(accepted, { ok: false, errorCode: "invalid_state" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("acquireWakePermit fails closed on json null state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "event-wake-null-state-"));
  const stateFile = path.join(directory, "wake-state.json");

  try {
    await writeFile(stateFile, "null\n", { encoding: "utf8", mode: 0o600 });
    const accepted = await acquireWakePermit(stateFile, { maxPerMinute: 2 }, { now: () => 100_000 });
    assert.deepEqual(accepted, { ok: false, errorCode: "invalid_state" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("acquireWakePermit fails closed on malformed timestamp entries", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "event-wake-bad-timestamp-"));
  const stateFile = path.join(directory, "wake-state.json");

  try {
    await writeFile(stateFile, "{\"timestamps\":[\"bad\"]}\n", { encoding: "utf8", mode: 0o600 });
    const accepted = await acquireWakePermit(stateFile, { maxPerMinute: 2 }, { now: () => 100_000 });
    assert.deepEqual(accepted, { ok: false, errorCode: "invalid_state" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("acquireWakePermit never removes a replacement lock during release", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "event-wake-lock-replacement-"));
  const stateFile = path.join(directory, "wake-state.json");
  const lockFile = `${stateFile}.lock`;

  try {
    const result = await acquireWakePermit(
      stateFile,
      { maxPerMinute: 1 },
      {
        now: () => 100_000,
        onBeforeRelease: async () => {
          await rm(lockFile, { force: true });
          await writeFile(
            lockFile,
            `${JSON.stringify({ pid: 4242, createdAt: 100_000, token: "replacement" })}\n`,
            { encoding: "utf8", mode: 0o600 },
          );
        },
      },
    );
    assert.deepEqual(result, { ok: true });
    assert.match(await readFile(lockFile, "utf8"), /replacement/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("acquireWakePermit cleans up lock and handle when token creation fails", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "event-wake-init-fail-"));
  const stateFile = path.join(directory, "wake-state.json");
  const lockFile = `${stateFile}.lock`;
  let releaseCalled = false;

  try {
    const failed = await acquireWakePermit(
      stateFile,
      { maxPerMinute: 1 },
      {
        now: () => 100_000,
        createToken: () => {
          throw new Error("token boom");
        },
        onBeforeRelease: async () => {
          releaseCalled = true;
        },
      },
    );
    assert.deepEqual(failed, { ok: false, errorCode: "io_failure" });
    assert.equal(releaseCalled, false);
    await assert.rejects(access(lockFile), { code: "ENOENT" });

    const recovered = await acquireWakePermit(stateFile, { maxPerMinute: 1 }, { now: () => 100_001 });
    assert.deepEqual(recovered, { ok: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("acquireWakePermit cleans up lock and handle when lock write fails", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "event-wake-lock-write-fail-"));
  const stateFile = path.join(directory, "wake-state.json");
  const lockFile = `${stateFile}.lock`;
  let releaseCalled = false;

  try {
    const failed = await acquireWakePermit(
      stateFile,
      { maxPerMinute: 1 },
      {
        now: () => 100_000,
        writeOwnerRecord: async () => {
          throw new Error("owner write boom");
        },
        onBeforeRelease: async () => {
          releaseCalled = true;
        },
      },
    );
    assert.deepEqual(failed, { ok: false, errorCode: "io_failure" });
    assert.equal(releaseCalled, false);
    await assert.rejects(access(lockFile), { code: "ENOENT" });

    const recovered = await acquireWakePermit(stateFile, { maxPerMinute: 1 }, { now: () => 100_001 });
    assert.deepEqual(recovered, { ok: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("acquireWakePermit removes its lock after partial owner write failure", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "event-wake-partial-owner-write-"));
  const stateFile = path.join(directory, "wake-state.json");
  const lockFile = `${stateFile}.lock`;

  try {
    const failed = await acquireWakePermit(
      stateFile,
      { maxPerMinute: 1 },
      {
        now: () => 100_000,
        writeOwnerRecord: async ({ handle }) => {
          await handle.writeFile("{");
          throw new Error("partial owner write");
        },
      },
    );
    assert.deepEqual(failed, { ok: false, errorCode: "io_failure" });
    await assert.rejects(access(lockFile), { code: "ENOENT" });

    const recovered = await acquireWakePermit(stateFile, { maxPerMinute: 1 }, { now: () => 100_001 });
    assert.deepEqual(recovered, { ok: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("acquireWakePermit does not delete an empty replacement lock", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "event-wake-empty-replacement-"));
  const stateFile = path.join(directory, "wake-state.json");
  const lockFile = `${stateFile}.lock`;

  try {
    const result = await acquireWakePermit(
      stateFile,
      { maxPerMinute: 1 },
      {
        now: () => 100_000,
        onBeforeRelease: async () => {
          await rm(lockFile, { force: true });
          await writeFile(lockFile, "", { encoding: "utf8", mode: 0o600 });
        },
      },
    );
    assert.deepEqual(result, { ok: true });
    assert.equal(await readFile(lockFile, "utf8"), "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("acquireWakePermit unlinks orphan temp file when rename fails", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "event-wake-rename-fail-"));
  const stateFile = path.join(directory, "wake-state.json");

  try {
    const failed = await acquireWakePermit(
      stateFile,
      { maxPerMinute: 1 },
      {
        now: () => 100_000,
        renameFile: async () => {
          const error = new Error("rename boom");
          error.code = "EXDEV";
          throw error;
        },
      },
    );
    assert.deepEqual(failed, { ok: false, errorCode: "io_failure" });
    const entriesAfterFailure = await readdir(directory);
    assert.deepEqual(entriesAfterFailure, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("acquireWakePermit enforces the cap under concurrent callers", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "event-wake-concurrency-"));
  const stateFile = path.join(directory, "wake-state.json");
  const worker = `
    import { acquireWakePermit } from ${JSON.stringify(new URL("../scripts/event-wake.mjs", import.meta.url).href)};
    const accepted = await acquireWakePermit(process.argv[1], { maxPerMinute: 1 }, { now: () => 123456 });
    console.log(JSON.stringify({ accepted }));
  `;

  try {
    const runWorker = () =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", worker, stateFile], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("exit", (code) => {
          if (code !== 0) {
            reject(new Error(stderr || `worker exited ${code}`));
            return;
          }
          resolve(JSON.parse(stdout.trim()).accepted);
        });
      });

    const results = await Promise.all([runWorker(), runWorker()]);
    assert.deepEqual(
      results.sort((left, right) => String(left.ok).localeCompare(String(right.ok))),
      [{ ok: false, errorCode: "rate_limited" }, { ok: true }],
    );
    assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")).timestamps, [123456]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("wakeOrganizer is disabled by default and excludes recursive sends", async () => {
  const sendCalls = [];
  const appTools = {
    sendMessageToThread: async (args) => {
      sendCalls.push(args);
    },
  };

  assert.deepEqual(
    await wakeOrganizer(makeEnvelope(), makeConfig({ enabled: false }), appTools),
    { status: "disabled" },
  );
  assert.deepEqual(await wakeOrganizer(makeEnvelope(), {}, appTools), { status: "disabled" });
  assert.deepEqual(await wakeOrganizer(makeEnvelope(), undefined, appTools), { status: "disabled" });
  assert.deepEqual(sendCalls, []);

  assert.deepEqual(
    await wakeOrganizer(
      makeEnvelope({ threadId: "organizer-123" }),
      makeConfig({ organizerThreadId: "organizer-123" }),
      appTools,
    ),
    { status: "excluded" },
  );
  assert.deepEqual(sendCalls, []);
});

test("wakeOrganizer returns invalid_config for enabled incomplete or invalid config", async () => {
  const appTools = {
    sendMessageToThread: async () => {
      throw new Error("should not send");
    },
  };

  assert.deepEqual(
    await wakeOrganizer(makeEnvelope(), { enabled: true }, appTools),
    { status: "failed", errorCode: "invalid_config" },
  );
  assert.deepEqual(
    await wakeOrganizer(
      makeEnvelope(),
      { enabled: true, organizerThreadId: "organizer-1", organizerHostId: "local" },
      appTools,
    ),
    { status: "failed", errorCode: "invalid_config" },
  );
  assert.deepEqual(
    await wakeOrganizer(
      makeEnvelope(),
      { enabled: true, organizerThreadId: "", organizerHostId: "local", wakeStateFile: "/tmp/a" },
      appTools,
    ),
    { status: "failed", errorCode: "invalid_config" },
  );
  assert.deepEqual(
    await wakeOrganizer(
      makeEnvelope(),
      {
        enabled: true,
        organizerThreadId: "organizer-1",
        organizerHostId: "local",
        wakeStateFile: "",
      },
      appTools,
    ),
    { status: "failed", errorCode: "invalid_config" },
  );
  assert.deepEqual(
    await wakeOrganizer(
      makeEnvelope(),
      {
        enabled: true,
        organizerThreadId: "organizer-1",
        organizerHostId: "local",
        wakeStateFile: "/tmp/a",
        maxPerMinute: 0,
      },
      appTools,
    ),
    { status: "failed", errorCode: "invalid_config" },
  );
  assert.deepEqual(
    await wakeOrganizer(
      makeEnvelope(),
      {
        enabled: true,
        organizerThreadId: "organizer-1",
        organizerHostId: "bad\nhost",
        wakeStateFile: "/tmp/a",
      },
      appTools,
    ),
    { status: "failed", errorCode: "invalid_config" },
  );
});

test("wakeOrganizer routes local and remote organizers with exactly one send", async () => {
  const sendCalls = [];
  const appTools = {
    sendMessageToThread: async (args) => {
      sendCalls.push(args);
      return { ok: true };
    },
  };
  const directory = await mkdtemp(path.join(os.tmpdir(), "event-wake-send-"));

  try {
    const localResult = await wakeOrganizer(
      makeEnvelope(),
      makeConfig({ wakeStateFile: path.join(directory, "local.json") }),
      appTools,
      { now: () => 100_000 },
    );
    const remoteResult = await wakeOrganizer(
      makeEnvelope({ event: "Stop", hostId: "remote-control:env_remote", threadId: "thread-2" }),
      makeConfig({
        organizerThreadId: "organizer-remote",
        organizerHostId: "remote-control:env_remote",
        wakeStateFile: path.join(directory, "remote.json"),
      }),
      appTools,
      { now: () => 200_000 },
    );

    assert.deepEqual(localResult, { status: "sent" });
    assert.deepEqual(remoteResult, { status: "sent" });
    assert.equal(sendCalls.length, 2);
    assert.deepEqual(sendCalls[0], {
      threadId: "01a00000-0000-7000-8000-000000000001",
      hostId: "local",
      prompt: renderEventWakePrompt(makeEnvelope(), makeConfig({ wakeStateFile: path.join(directory, "local.json") })),
    });
    assert.deepEqual(sendCalls[1], {
      threadId: "organizer-remote",
      hostId: "remote-control:env_remote",
      prompt: renderEventWakePrompt(
        makeEnvelope({ event: "Stop", hostId: "remote-control:env_remote", threadId: "thread-2" }),
        makeConfig({
          organizerThreadId: "organizer-remote",
          organizerHostId: "remote-control:env_remote",
          wakeStateFile: path.join(directory, "remote.json"),
        }),
      ),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("wakeOrganizer counts failed and timed out sends against the permit without leaking raw errors", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "event-wake-errors-"));

  try {
    const stateFile = path.join(directory, "failed.json");
    const timeoutFile = path.join(directory, "timeout.json");

    const failed = await wakeOrganizer(
      makeEnvelope(),
      makeConfig({ wakeStateFile: stateFile, maxPerMinute: 1 }),
      {
        sendMessageToThread: async () => {
          throw new Error("raw secret body");
        },
      },
      { now: () => 100_000 },
    );
    assert.equal(failed.status, "failed");
    assert.ok(failed.errorCode);
    assert.equal(JSON.stringify(failed).includes("raw secret body"), false);
    assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")).timestamps, [100000]);
    assert.deepEqual(
      await wakeOrganizer(
        makeEnvelope(),
        makeConfig({ wakeStateFile: stateFile, maxPerMinute: 1 }),
        { sendMessageToThread: async () => assert.fail("should not retry after failed count") },
        { now: () => 100_001 },
      ),
      { status: "rate_limited" },
    );

    const timedOut = await wakeOrganizer(
      makeEnvelope({ threadId: "thread-timeout" }),
      makeConfig({ wakeStateFile: timeoutFile, maxPerMinute: 1 }),
      {
        sendMessageToThread: async () => {
          const error = new Error("Timed out calling send_message_to_thread");
          throw error;
        },
      },
      { now: () => 200_000 },
    );
    assert.deepEqual(timedOut, { status: "failed", errorCode: "send_timeout" });
    assert.deepEqual(JSON.parse(await readFile(timeoutFile, "utf8")).timestamps, [200000]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("wakeOrganizer checks deadline signal immediately before send and never dispatches after abort", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "event-wake-abort-before-send-"));
  const stateFile = path.join(directory, "abort.json");
  const controller = new AbortController();
  let sends = 0;

  try {
    const result = await wakeOrganizer(
      makeEnvelope(),
      makeConfig({ wakeStateFile: stateFile, maxPerMinute: 1 }),
      {
        sendMessageToThread: async () => {
          sends += 1;
        },
      },
      {
        signal: controller.signal,
        renameFile: async (...args) => {
          controller.abort();
          return rename(...args);
        },
      },
    );

    assert.deepEqual(result, { status: "failed", errorCode: "wake_deadline" });
    assert.equal(sends, 0);
    assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")).timestamps.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("wakeOrganizer distinguishes quota exhaustion from operational permit failures", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "event-wake-permit-errors-"));

  try {
    const rateLimitedFile = path.join(directory, "rate-limited.json");
    const malformedFile = path.join(directory, "malformed.json");

    await writeFile(rateLimitedFile, `${JSON.stringify({ timestamps: [100_000] })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await writeFile(malformedFile, "{\"timestamps\":[\"bad\"]}\n", { encoding: "utf8", mode: 0o600 });

    assert.deepEqual(
      await wakeOrganizer(
        makeEnvelope(),
        makeConfig({ wakeStateFile: rateLimitedFile, maxPerMinute: 1 }),
        { sendMessageToThread: async () => assert.fail("should not send when rate limited") },
        { now: () => 100_001 },
      ),
      { status: "rate_limited" },
    );
    assert.deepEqual(
      await wakeOrganizer(
        makeEnvelope(),
        makeConfig({ wakeStateFile: malformedFile, maxPerMinute: 1 }),
        { sendMessageToThread: async () => assert.fail("should not send on bad permit state") },
        { now: () => 100_001 },
      ),
      { status: "failed", errorCode: "invalid_state" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
