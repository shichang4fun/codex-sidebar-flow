# Local App Server protocol research

Historical research as of 2026-09-07. For the installable v0.4 beta, use the
[Desktop proxy guide](local-desktop-proxy.md). The standalone WebSocket lab and
the installed Desktop proxy are different paths; passing one does not validate
the other's Desktop integration.

## Findings carried into the proxy

- The original Desktop App Server stream carries structured lifecycle events.
  The relay preserves Desktop initialization and request/response traffic,
  while namespacing observer requests to avoid ID collisions.
- The tested Desktop build omits the optional follow-up `initialized`
  notification. A successful `initialize` response enables observation; a
  failed handshake does not.
- ASCII LF framing with UTF-8 decoding preserves U+2028/U+2029 inside JSON
  strings. A prior readline-based splitter broke these frames; subprocess and
  bidirectional Unicode regressions cover the corrected transport.
- `mcpServer/tool/call` can reach native Desktop `codex_app` list/read/move tools
  on the tested build. The installed adapter checks structured identity,
  membership and current status; task text is never classification authority.
- Standalone App Server section APIs alone do not prove Desktop sidebar
  refresh. The beta uses native Desktop MCP tools instead of assuming that
  isolated section storage is the Desktop sidebar.
- These capabilities are version-specific. This research does not establish a
  stable third-party plugin contract, remote support or atomic read/move.

## Reproducible isolated integration tests

Use Node 22+ for the WebSocket test; the installed stdio path requires Node 20+.

```sh
SIDEBAR_TEST_CODEX_BINARY=/absolute/path/to/codex node --test test/app-server-live.test.mjs
```

The tests create a temporary `CODEX_HOME`, a loopback fake Responses API and a
fixture MCP server. They do not copy credentials, read real conversations or
call a paid model. Three transports exercise a second WebSocket connection,
message-level stdio relay and full proxy process. Each test cleans up only its
own temporary files and processes. Loopback networking may need sandbox approval.

The full-proxy integration uses an unmatched observer allowlist: it proves
transport transparency and direct fixture MCP calls, **not real Desktop sidebar
movement**. Adapter unit tests and the separate real Desktop runs provide
different evidence. Do not substitute one for the other.

## Standalone WebSocket lab

`experimental/app-server-observer.mjs` is also a dry-run CLI for an explicitly
supplied numeric loopback WebSocket endpoint:

```sh
node experimental/app-server-observer.mjs \
  --url ws://127.0.0.1:PORT \
  --thread TEST_THREAD_ID --exclude ORGANIZER_THREAD_ID --seconds 30
```

Only use `--apply-test-only` on disposable explicitly allowlisted tasks in a
deliberately configured test server. Endpoint validation does not authenticate
another local process. Do not expose this server to the network or use forwarded
remote endpoints. The CLI does not discover sockets, install a daemon, reconnect
automatically or replay history. It cannot attest ownership of Desktop tasks.

## Evidence boundary

| Check | What it establishes |
|---|---|
| Rule/adapter/manager unit tests | Deterministic policy, protection, config and queue behavior for fixtures |
| Three isolated real App Server tests | Real protocol/transport and fixture MCP compatibility |
| Two real local Desktop task runs | Native start/completion movement on the tested installation |
| `proxy-attached` launcher diagnostic | The configured proxy is attached, not successful task movement |

The installed all-local path was tested on bundled Codex CLI 0.153.4. Remote,
Project, third-task discovery, repeat normal launch and real approval/cancellation
acceptance are not claimed by this prerelease. See the current guide for measured
latency, concurrency limits, recovery behavior and rollback instructions.
