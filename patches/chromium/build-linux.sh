#!/bin/bash
# Build the independent Chromium 151 engine for Linux (x64/arm64).
#
# Usage:
#   ./patches/chromium/build-linux.sh [/path/to/chromium/src] [x64|arm64]
#
# First argument: Chromium source checkout (default: ./chromium-src-151 under
# the current directory). If missing, the script clones the pinned upstream
# commit and runs gclient sync (requires depot_tools on PATH; on Debian/Ubuntu
# also run install-build-deps.sh once). Second argument selects target_cpu
# (default: x64).
set -euo pipefail

PATCH_ROOT="$(cd "$(dirname "$0")" && pwd)"
TARGET_CPU="${2:-x64}"
CHROMIUM_SRC="${1:-$PWD/chromium-src-151}"
CHROMIUM_COMMIT="ef35003457e93c278f911a334b06e4a5f8967e06"

if [ ! -d "$CHROMIUM_SRC/.git" ]; then
  mkdir -p "$CHROMIUM_SRC"
  git clone https://chromium.googlesource.com/chromium/src.git "$CHROMIUM_SRC"
  git -C "$CHROMIUM_SRC" checkout "$CHROMIUM_COMMIT"
  if ! command -v gclient >/dev/null 2>&1; then
    echo "error: depot_tools (gclient/gn/ninja) is required on PATH for a fresh clone" >&2
    echo "  git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git" >&2
    echo "  export PATH=$PWD/depot_tools:$PATH" >&2
    exit 2
  fi
  gclient sync -D
fi

"$PATCH_ROOT/apply.sh" "$CHROMIUM_SRC"

OUT_DIR="$CHROMIUM_SRC/out/AgentBrowserRelease"
mkdir -p "$OUT_DIR"
cp "$PATCH_ROOT/args.gn.linux" "$OUT_DIR/args.gn"
printf 'target_cpu = "%s"\n' "$TARGET_CPU" >> "$OUT_DIR/args.gn"

gn gen "$OUT_DIR"
autoninja -C "$OUT_DIR" chrome

BINARY="$OUT_DIR/chrome"
echo ""
echo "Linux engine built: $BINARY"
echo "Wiring into Agent Browser Studio:"
echo "  export AGENT_BROWSER_CHROMIUM_BINARY_PATH=$BINARY"
echo "or for the headless Docker image:"
echo "  mkdir -p ./chromium && cp $BINARY ./chromium/chrome"
echo "  docker compose up --build -d"
