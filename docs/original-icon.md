# Optional original Codex icon startup

Included in `v0.4.0`. It changes how the already-installed
local Desktop proxy is selected, not its classification rules or runtime files.

## Enable

First install the [Desktop proxy](local-desktop-proxy.md#setup) from this checkout,
with the actual app/Node/CLI paths. Then, as the logged-in macOS GUI user (no sudo):

```sh
node scripts/original-icon.mjs --root /absolute/private/sidebar-flow-desktop
```

Finish running work, quit Codex normally, and open the **original Codex icon**.
No second app entry is required. An already-running app keeps its existing
environment; installation never stops it or claims live activation.

Paths are read from the Desktop installation manifest and current user's home,
not a developer username or a fixed Codex/ChatGPT app name. Spaces, apostrophes
and XML characters are escaped. Node 20+, macOS and a GUI login session are
required. No GitHub login, administrator privilege or additional dependency is
needed. The optional `--home` argument is for isolated/test homes; it does not
switch the user or GUI session.

## Behavior and boundaries

- Installs a one-shot `RunAtLoad` LaunchAgent named
  `io.github.codex-sidebar-flow.original-icon`. It restores `CODEX_CLI_PATH`
  at GUI login; it does not start Codex or leave another observer running.
- Sets the current user's **GUI-session-wide** `CODEX_CLI_PATH` to a small shim.
  Other newly launched clients that honor this variable can inherit it too.
  This is not an app-specific preference or a supported public plugin API.
- The shim delegates to the existing proxy. If its executable or config is
  removed by proxy uninstall, it delegates to the manifest's original CLI.
  The fallback assumes that original CLI path still exists. Moving/removing
  Codex, or a breaking Desktop update, requires rechecking this integration.
- Support files live under `~/Library/Application Support/Codex Sidebar Flow Original Icon`;
  the agent lives under `~/Library/LaunchAgents`. A standalone helper copy makes
  login refresh and disable independent of the source checkout and proxy release.
  They still depend on the Node executable recorded in the Desktop manifest.
- Refuses a different nonempty GUI override, unowned support directory, foreign
  or modified agent, unsafe file types, or changed target installation paths.
  Repeating setup for the same owned installation is safe and preserves proxy
  configuration. Do not overwrite another tool's setting to make setup pass.
- Does not edit the signed app, Dock icon, hooks, credentials, task instructions,
  remote machines or model schedules. It creates no network listener or telemetry.

The original icon is **not a proxy bypass while this is enabled**. The default
dedicated launcher remains available. It uses a per-launch override instead;
both entries select the same installed proxy, not two sorting mechanisms.

## Disable / uninstall

Use the installed `Disable Original Icon Integration.command` in the support
directory, or run from this checkout:

```sh
node scripts/original-icon.mjs --disable
```

This renames the exact owned agent to `.plist.disabled`, unloads its job, and
unsets the GUI variable **only if it still points to this shim**. Repeated disable
is safe. Other overrides, proxy runtime/configuration, and support files remain
intact. No files are permanently deleted. Quit/reopen Codex normally to stop
using the proxy in the app already running. Re-run setup to enable it again.

For complete removal, disable this integration **before** using the Desktop
proxy uninstaller. Keep the shim until the GUI override is cleared. If Node is
unavailable, inspect the exact job and `launchctl getenv CODEX_CLI_PATH` before
manually unloading the owned job and clearing only the matching override.

Older experimental local scripts without the ownership marker are deliberately
not auto-migrated. Disable them with their own rollback command, preserve their
support directory/agent as backups, and ensure the standard destinations and
GUI override are free before using this installer. Existing managed installs
with changed app/Node paths likewise require disable and preservation of the
old support directory/agent before reinstalling. Never delete an active shim.

## Verification

The current maintainer acceptance confirms original-icon observer startup and
local start/completion placement. See the exact
[tested build and accepted baseline](local-desktop-proxy.md#verification-status).
The historical implementation-specific record below is retained to distinguish
earlier evidence from validation of a newly installed helper on another Mac.

Automated tests use temporary homes and a launchctl boundary substitute; they
never change the developer's GUI environment. The generated shim is executed
for real with difficult arguments and after removal of the proxy config. Tests
cover repeated enable/disable, conflicting overrides, ownership/type guards,
bootstrap failure/retry, and plist syntax on macOS. The helper is standalone;
these tests do not prove that launchd attached a proxy on a new user's Mac.

Deployment evidence on 2026-09-13 (the earlier local-script version of the same
startup approach, not a live install of this newly packaged helper):

- A normal original-icon restart created a Codex main process with the installed
  stdio observer as a direct child, using bundled CLI `0.154.0-alpha.6.2`.
- The native snapshot showed the running local task in In Progress; the new
  process log contained a successful native sidebar move, without a manual
  move during inspection.
- The user then confirmed that the completed task appeared in For Review.
  This completion observation is user-reported, not a separate agent-side read.
- Compensation was configured to 600 seconds, but successful timer execution
  was not established by that restart inspection. This guide does not upgrade
  configuration evidence into a timer acceptance claim.

Retest the actual process attachment and start/finish movements after installing
on another Mac or after Desktop updates. This optional entry adds no real-time
guarantee and does not broaden the proxy's local-only scope.
