#!/bin/sh
# Run the reasoning-effort writer with a Node that actually works.
#
# Resolution order — the Node of the build you are in, then the safest fallback:
#   1. $DSH_SKILL_NODE                 an explicit override
#   2. in a desktop session: the desktop build's bundled Node (real Node, same runtime as the app)
#   3. node on PATH                    verified by running it, not merely found
#   4. the desktop build's bundled Node (a machine whose PATH has no usable node)
#   5. $DSH_DESKTOP_NODE_EXECUTABLE    the app's own executable, run as Node
# Arguments are handed to the writer unchanged.
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SCRIPT="$HERE/apply-reasoning-efforts.mjs"

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

# A binary inside the app bundle is measurably slower to launch (the OS scans it on every spawn), so
# it is only preferred where it is the build being configured; elsewhere PATH wins when it works.
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
