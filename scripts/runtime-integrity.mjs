import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

export const RUNTIME_FILES = Object.freeze([
  "scripts/doctor.mjs",
  "scripts/event-wake.mjs",
  "scripts/runtime-integrity.mjs",
  "scripts/setup.mjs",
  "scripts/sidebar-hook.mjs",
  "scripts/sidebar-realtime.mjs",
  "scripts/uninstall.mjs",
]);

export const RUNTIME_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

export function isRuntimeFingerprint(value) {
  return typeof value === "string" && RUNTIME_FINGERPRINT_PATTERN.test(value);
}

export async function computeRuntimeFingerprint(root) {
  if (typeof root !== "string" || !path.isAbsolute(root) || path.normalize(root) !== root) {
    throw new Error("Runtime root must be an absolute normalized path");
  }
  const hash = createHash("sha256");
  for (const relativePath of RUNTIME_FILES) {
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
