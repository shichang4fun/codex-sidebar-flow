#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateSectionNames } from "./sidebar-policy.mjs";

const TEMPLATE_PATH = fileURLToPath(new URL("../docs/heartbeat-prompt.md", import.meta.url));
const PLACEHOLDER = "{{EXCLUDED_TASK_IDS}}";
const SECTION_PLACEHOLDERS = {
  inProgress: "{{IN_PROGRESS_SECTION}}",
  forReview: "{{FOR_REVIEW_SECTION}}",
  forLater: "{{FOR_LATER_SECTION}}",
};
const DEFAULT_SECTIONS = {
  inProgress: "In Progress",
  forReview: "For Review",
  forLater: "For Later",
};

export function renderHeartbeatPrompt(template, excludedTaskIds, configuredSections = DEFAULT_SECTIONS) {
  const ids = [...new Set(excludedTaskIds)];
  if (ids.length === 0 || ids.some((id) => typeof id !== "string" || id.trim().length === 0)) {
    throw new Error("At least one exact excluded task ID is required");
  }
  const promptLine = template.split("\n").find((line) => line.startsWith("> ") && line.includes(PLACEHOLDER));
  if (promptLine == null) throw new Error("Heartbeat template placeholder is missing");
  const sections = validateSectionNames(configuredSections);
  let rendered = promptLine.slice(2).replace(PLACEHOLDER, JSON.stringify(ids));
  for (const [key, placeholder] of Object.entries(SECTION_PLACEHOLDERS)) {
    if (!rendered.includes(placeholder)) throw new Error(`Heartbeat template placeholder is missing: ${key}`);
    rendered = rendered.replaceAll(placeholder, JSON.stringify(sections[key]));
  }
  if (rendered.includes("{{")) throw new Error("Heartbeat template placeholder was not fully rendered");
  return rendered;
}

function parseArgs(argv) {
  const excludedTaskIds = [];
  const sections = { ...DEFAULT_SECTIONS };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--exclude") excludedTaskIds.push(argv[++index]);
    else if (argv[index] === "--in-progress") sections.inProgress = argv[++index];
    else if (argv[index] === "--for-review") sections.forReview = argv[++index];
    else if (argv[index] === "--for-later") sections.forLater = argv[++index];
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return { excludedTaskIds, sections };
}

if (process.argv[1] != null && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const template = await readFile(TEMPLATE_PATH, "utf8");
  const { excludedTaskIds, sections } = parseArgs(process.argv.slice(2));
  process.stdout.write(`${renderHeartbeatPrompt(template, excludedTaskIds, sections)}\n`);
}
