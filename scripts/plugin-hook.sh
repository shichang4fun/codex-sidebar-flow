#!/bin/sh

codex_home=${CODEX_HOME:-"$HOME/.codex"}
config_path="$codex_home/sidebar-flow/config.json"

for candidate in \
  /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node \
  /Applications/Codex.app/Contents/Resources/cua_node/bin/node
do
  if [ -x "$candidate" ]; then
    exec /usr/bin/env -u FORCE_COLOR CODEX_SIDEBAR_FLOW_INSTALL_MODE=plugin \
      CODEX_SIDEBAR_FLOW_CONFIG="$config_path" \
      "$candidate" "${CLAUDE_PLUGIN_ROOT}/scripts/sidebar-hook.mjs"
  fi
done

printf '%s\n' 'sidebar-flow: bundled Desktop Node unavailable' >&2
printf '{}\n'
exit 1
