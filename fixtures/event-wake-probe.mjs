import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { handleHook } from "../scripts/sidebar-hook.mjs";
import { INSTALL_MODE_ENV } from "../scripts/setup.mjs";

const [configPath, barrierDirectory] = process.argv.slice(2);
if (configPath != null && barrierDirectory != null) {
  process.env[INSTALL_MODE_ENV] = "source";

  const readyFile = path.join(barrierDirectory, `ready-${process.pid}`);
  const releaseFile = path.join(barrierDirectory, "release");
  await writeFile(readyFile, "\n", { mode: 0o600 });
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await access(releaseFile);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  let probeConnections = 0;
  let wakeCalls = 0;
  await handleHook(
    { session_id: "thread-1", hook_event_name: "UserPromptSubmit" },
    configPath,
    {
      now: () => 2_000,
      async execute() {
        return {
          attempts: 1,
          managedAdds: [],
          managedRemoves: [],
          observedIdentities: [],
          eventEnvelope: {
            protocol: "codex-sidebar-flow/event-v1",
            event: "UserPromptSubmit",
            threadId: "thread-1",
            hostId: "local",
          },
        };
      },
      createAppTools(_config, options) {
        if ((options?.requiredTools ?? []).includes("send_message_to_thread")) {
          return { reset() {} };
        }
        return {
          async connect() {
            probeConnections += 1;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return {
              toolMap: new Map([
                ["send_message_to_thread", { name: "send_message_to_thread" }],
              ]),
            };
          },
          reset() {},
        };
      },
      async updateManaged() {},
      async wake() {
        wakeCalls += 1;
        return { status: "sent" };
      },
    },
  );

  process.stdout.write(`${JSON.stringify({ probeConnections, wakeCalls })}\n`);
}
