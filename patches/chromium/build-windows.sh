#!/bin/bash
# Build the independent Chromium 152 engine for Windows (x64/arm64).
#
# Usage (run inside Git Bash on a Windows build host):
#   bash ./patches/chromium/build-windows.sh [/path/to/chromium/src] [x64|arm64]
#
# First argument: Chromium source checkout (default: ./chromium-src-152 under
# the current directory). If missing, the script clones the pinned upstream
# commit and runs gclient sync (requires depot_tools on PATH; on Windows run
# update_depot_tools.bat once). Second argument selects target_cpu
# (default: x64).
set -euo pipefail

# Official Windows Chromium builds outside Google use the locally installed
# Visual Studio (2022, C++ workload) instead of the Chrome-blessed toolchain
# download. gclient sync / gn gen fail with a login prompt otherwise.
export DEPOT_TOOLS_WIN_TOOLCHAIN="${DEPOT_TOOLS_WIN_TOOLCHAIN:-0}"

PATCH_ROOT="$(cd "$(dirname "$0")" && pwd)"
TARGET_CPU="${2:-x64}"
CHROMIUM_SRC="${1:-$PWD/chromium-src-152}"
CHROMIUM_COMMIT="026bb13a93d60e7adfefa2bbf58d6f57c2d335cc"

if [ ! -d "$CHROMIUM_SRC/.git" ]; then
  mkdir -p "$CHROMIUM_SRC"
  git clone https://chromium.googlesource.com/chromium/src.git "$CHROMIUM_SRC"
  git -C "$CHROMIUM_SRC" checkout "$CHROMIUM_COMMIT"
  if ! command -v gclient >/dev/null 2>&1; then
    echo "error: depot_tools (gclient/gn/ninja) is required on PATH for a fresh clone" >&2
    echo "  git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git" >&2
    echo "  run update_depot_tools.bat once, then add depot_tools to PATH" >&2
    exit 2
  fi
  gclient sync -D
fi

# Git Bash on Windows may not carry the exec bit; invoke apply.sh via bash.
bash "$PATCH_ROOT/apply.sh" "$CHROMIUM_SRC"

OUT_DIR="$CHROMIUM_SRC/out/AgentBrowserRelease"
mkdir -p "$OUT_DIR"
cp "$PATCH_ROOT/args.gn.win" "$OUT_DIR/args.gn"
printf 'target_cpu = "%s"
' "$TARGET_CPU" >> "$OUT_DIR/args.gn"

gn gen "$OUT_DIR"
autoninja -C "$OUT_DIR" chrome

BINARY="$OUT_DIR/chrome.exe"
echo ""
echo "Windows engine built: $BINARY"
echo "Wiring into Agent Browser Studio:"
echo "  export AGENT_BROWSER_CHROMIUM_BINARY_PATH=$BINARY"
