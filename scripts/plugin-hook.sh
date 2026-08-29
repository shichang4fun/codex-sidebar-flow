#!/bin/sh

for candidate in \
  /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node \
  /Applications/Codex.app/Contents/Resources/cua_node/bin/node
do
  if [ -x "$candidate" ]; then
    exec /usr/bin/env -u FORCE_COLOR "$candidate" "${CLAUDE_PLUGIN_ROOT}/scripts/sidebar-hook.mjs"
  fi
done

printf '{}\n'
exit 0
