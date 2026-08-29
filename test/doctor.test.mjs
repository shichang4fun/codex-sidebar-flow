import assert from "node:assert/strict";
import test from "node:test";
import { inspectInstallation } from "../scripts/doctor.mjs";

const config = {
  installMode: "plugin",
  sections: { inProgress: "In Progress", forReview: "For Review", forLater: "For Later" },
};

test("plugin doctor rejects a missing bundle", () => {
  const checks = inspectInstallation({
    config,
    mode: "plugin",
    platform: "darwin",
    nodeExecutable: "/Applications/Codex.app/Contents/Resources/cua_node/bin/node",
    pluginBundle: { manifest: false, hooks: false, launcher: false, enabledContext: false },
  });
  assert.equal(checks.find((check) => check.name === "plugin-bundle").level, "error");
});

test("plugin doctor distinguishes a complete bundle from verified enablement", () => {
  const staticChecks = inspectInstallation({
    config,
    mode: "plugin",
    platform: "darwin",
    nodeExecutable: "/Applications/Codex.app/Contents/Resources/cua_node/bin/node",
    pluginBundle: { manifest: true, hooks: true, launcher: true, enabledContext: false },
  });
  assert.equal(staticChecks.find((check) => check.name === "plugin-bundle").level, "warning");

  const activeChecks = inspectInstallation({
    config,
    mode: "plugin",
    platform: "darwin",
    nodeExecutable: "/Applications/Codex.app/Contents/Resources/cua_node/bin/node",
    pluginBundle: { manifest: true, hooks: true, launcher: true, enabledContext: true },
  });
  assert.equal(activeChecks.find((check) => check.name === "plugin-bundle").level, "ok");
});
