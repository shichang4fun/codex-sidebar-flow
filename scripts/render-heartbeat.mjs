#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TEMPLATE_PATH = fileURLToPath(new URL("../docs/heartbeat-prompt.md", import.meta.url));
const PLACEHOLDER = "{{EXCLUDED_TASK_IDS}}";

export function renderHeartbeatPrompt(template, excludedTaskIds) {
  const ids = [...new Set(excludedTaskIds)];
  if (ids.length === 0 || ids.some((id) => typeof id !== "string" || id.trim().length === 0)) {
    throw new Error("At least one exact excluded task ID is required");
  }
  const promptLine = template.split("\n").find((line) => line.startsWith("> ") && line.includes(PLACEHOLDER));
  if (promptLine == null) throw new Error("Heartbeat template placeholder is missing");
  const rendered = promptLine.slice(2).replace(PLACEHOLDER, JSON.stringify(ids));
  if (rendered.includes(PLACEHOLDER)) throw new Error("Heartbeat template placeholder was not fully rendered");
  return rendered;
}

function parseArgs(argv) {
  const excludedTaskIds = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--exclude") excludedTaskIds.push(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return excludedTaskIds;
}

if (process.argv[1] != null && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const template = await readFile(TEMPLATE_PATH, "utf8");
  process.stdout.write(`${renderHeartbeatPrompt(template, parseArgs(process.argv.slice(2)))}\n`);
}
