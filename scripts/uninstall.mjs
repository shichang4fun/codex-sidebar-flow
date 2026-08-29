#!/usr/bin/env node

import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { removeHooks, writeJsonAtomic } from "./setup.mjs";

export async function uninstall({
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  purge = false,
  mode = "source",
} = {}) {
  if (!new Set(["source", "plugin"]).has(mode)) throw new Error(`Unknown uninstall mode: ${mode}`);
  const hooksPath = path.join(codexHome, "hooks.json");
  if (mode === "source") {
    let hooks = {};
    try {
      hooks = JSON.parse(await readFile(hooksPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await writeJsonAtomic(hooksPath, removeHooks(hooks));
  }
  if (purge) await rm(path.join(codexHome, "sidebar-flow"), { recursive: true, force: true });
  return { mode, hooksPath, purged: purge };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const purge = process.argv.includes("--purge");
  const mode = process.argv.includes("--plugin") ? "plugin" : "source";
  const homeIndex = process.argv.indexOf("--codex-home");
  const codexHome = homeIndex === -1 ? undefined : process.argv[homeIndex + 1];
  uninstall({ codexHome, purge, mode })
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`uninstall failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
