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
