#!/bin/sh
# Run the read-only checker with a Node that actually works. Same resolution order as run-apply.sh:
# $DSH_SKILL_NODE, the desktop build's bundled Node (in a desktop session), node on PATH (run to
# verify), the bundled Node again, then the app's own executable as Node.
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SCRIPT="$HERE/check-reasoning-route.mjs"

if [ -n "$DSH_SKILL_NODE" ] && "$DSH_SKILL_NODE" --version >/dev/null 2>&1; then
  exec "$DSH_SKILL_NODE" "$SCRIPT" "$@"
fi

BUNDLED=""
for candidate in \
  "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node" \
  "$HOME/.local/share/deepseek-harness/resources/runtime/primary-runtime/dependencies/node/bin/node" \
  "/opt/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node" \
  "/usr/lib/deepseek-harness/resources/runtime/primary-runtime/dependencies/node/bin/node"
do
  if [ -x "$candidate" ]; then
    BUNDLED="$candidate"
    break
  fi
done

if [ "$DSH_PROFILE" = "desktop" ] && [ -n "$BUNDLED" ]; then
  exec "$BUNDLED" "$SCRIPT" "$@"
fi

if command -v node >/dev/null 2>&1 && node --version >/dev/null 2>&1; then
  exec node "$SCRIPT" "$@"
fi

if [ -n "$BUNDLED" ]; then
  exec "$BUNDLED" "$SCRIPT" "$@"
fi

if [ -n "$DSH_DESKTOP_NODE_EXECUTABLE" ]; then
  ELECTRON_RUN_AS_NODE=1
  export ELECTRON_RUN_AS_NODE
  exec "$DSH_DESKTOP_NODE_EXECUTABLE" --expose-internals "$SCRIPT" "$@"
fi

cat >&2 <<'EOF'
No usable Node found. Tried, in order:
  1. $DSH_SKILL_NODE (not set, or not runnable)
  2. the desktop build's bundled Node
  3. node on PATH
  4. $DSH_DESKTOP_NODE_EXECUTABLE (not set)
Set DSH_SKILL_NODE to a working node executable, then run this again.
EOF
exit 2
