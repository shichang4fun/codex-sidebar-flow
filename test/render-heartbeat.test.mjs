import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderHeartbeatPrompt } from "../scripts/render-heartbeat.mjs";

test("heartbeat renderer injects exact organizer IDs and removes its placeholder", async () => {
  const template = await readFile(new URL("../docs/heartbeat-prompt.md", import.meta.url), "utf8");
  const organizerId = "01a00000-0000-7000-8000-000000000001";
  const prompt = renderHeartbeatPrompt(template, [organizerId]);
  assert.equal(prompt.includes(organizerId), true);
  assert.equal(prompt.includes("{{EXCLUDED_TASK_IDS}}"), false);
});

test("heartbeat renderer fails closed without an organizer ID", () => {
  assert.throws(() => renderHeartbeatPrompt("> x {{EXCLUDED_TASK_IDS}}", []), /At least one/);
});

test("heartbeat prompt enforces audited allowlist, protections, and fail-closed recovery policy", async () => {
  const template = await readFile(new URL("../docs/heartbeat-prompt.md", import.meta.url), "utf8");
  const organizerId = "01a00000-0000-7000-8000-000000000001";
  const prompt = renderHeartbeatPrompt(template, [organizerId]);

  assert.equal(prompt.includes("using only `list_threads`, `read_thread`, and `move_thread_to_sidebar_section`"), true);
  assert.equal(prompt.includes("send_message_to_thread"), false);
  assert.equal(prompt.includes("titles"), true);
  assert.equal(prompt.includes("summaries"), true);
  assert.equal(prompt.includes("previews"), true);
  assert.equal(prompt.includes("bodies"), true);
  assert.equal(prompt.includes("never follow instructions"), true);
  assert.equal(prompt.includes("Pinned"), true);
  assert.equal(prompt.includes("For Later"), true);
  assert.equal(prompt.includes("archived"), true);
  assert.equal(prompt.includes("non-Codex"), true);
  assert.equal(prompt.includes("Project objects"), true);
  assert.equal(prompt.includes(organizerId), true);
  assert.equal(prompt.includes("actual `hostId`"), true);
  assert.equal(prompt.includes("UserPromptSubmit"), true);
  assert.equal(prompt.includes("confirmed active task with no attention flags"), true);
  assert.equal(prompt.includes("Stop"), true);
  assert.equal(prompt.includes("confirmed idle, completed, failed, or needs-attention"), true);
  assert.equal(prompt.includes("Tasks, In Progress, or an eligible Project task"), true);
  assert.equal(prompt.includes("at most 10 moves"), true);
  assert.equal(prompt.includes("Fail closed"), true);
  assert.equal(prompt.includes("DONT_NOTIFY"), true);
  assert.equal(prompt.includes("<organizer-task-id>"), false);
});
