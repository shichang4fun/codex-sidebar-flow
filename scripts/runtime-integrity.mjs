import { createHash } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export const SOURCE_RUNTIME_FILES = Object.freeze([
  "scripts/doctor.mjs",
  "scripts/event-wake.mjs",
  "scripts/runtime-integrity.mjs",
  "scripts/setup.mjs",
  "scripts/sidebar-hook.mjs",
  "scripts/sidebar-policy.mjs",
  "scripts/sidebar-realtime.mjs",
  "scripts/uninstall.mjs",
]);

export const PLUGIN_RUNTIME_FILES = Object.freeze([
  ...SOURCE_RUNTIME_FILES,
  ".codex-plugin/plugin.json",
  "docs/heartbeat-prompt.md",
  "hooks/hooks.json",
  "scripts/plugin-hook.sh",
  "scripts/render-heartbeat.mjs",
  "skills/sidebar-flow/SKILL.md",
].sort());

export const RUNTIME_FILES = SOURCE_RUNTIME_FILES;

export const RUNTIME_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

export function isRuntimeFingerprint(value) {
  return typeof value === "string" && RUNTIME_FINGERPRINT_PATTERN.test(value);
}

export function runtimeFilesForMode(mode) {
  if (mode === "source") return SOURCE_RUNTIME_FILES;
  if (mode === "plugin") return PLUGIN_RUNTIME_FILES;
  throw new Error(`Unknown runtime fingerprint mode: ${mode}`);
}

export async function computeRuntimeFingerprint(root, mode) {
  if (typeof root !== "string" || !path.isAbsolute(root) || path.normalize(root) !== root) {
    throw new Error("Runtime root must be an absolute normalized path");
  }
  const hash = createHash("sha256");
  for (const relativePath of runtimeFilesForMode(mode)) {
    const filePath = path.join(root, relativePath);
    const metadata = await lstat(filePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Runtime entry must be a regular file: ${relativePath}`);
    }
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await readFile(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function unsafeDirectory(label) {
  const error = new Error(`${label} must be a real directory, not a symlink`);
  error.code = "UNSAFE_RUNTIME_DIRECTORY";
  return error;
}

export async function ensureRealDirectory(directory, { create = false, label = "Directory" } = {}) {
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if (error.code !== "ENOENT" || !create) throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    metadata = await lstat(directory);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw unsafeDirectory(label);
  return { dev: metadata.dev, ino: metadata.ino };
}

export async function revalidateRealDirectory(directory, identity, label = "Directory") {
  const metadata = await lstat(directory).catch(() => null);
  if (
    metadata == null
    || metadata.isSymbolicLink()
    || !metadata.isDirectory()
    || metadata.dev !== identity?.dev
    || metadata.ino !== identity?.ino
  ) throw unsafeDirectory(label);
  return identity;
}
