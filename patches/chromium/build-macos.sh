#!/bin/bash
# Build the independent Chromium 152 engine for macOS (arm64/x64).
#
# Usage:
#   ./patches/chromium/build-macos.sh [/path/to/chromium/src] [arm64|x64]
#
# First argument: Chromium source checkout (default: ./chromium-src-152 under
# the current directory). If missing, the script clones the pinned upstream
# commit and runs gclient sync (requires depot_tools on PATH). Second argument
# selects target_cpu (default: arm64 — Apple Silicon; use x64 for Intel).
#
# The macOS build is arch-native: no need for a blessed toolchain download;
# gn gen selects the Xcode toolchain automatically. Cross-compiling between
# arm64 and x64 is supported by passing the other target_cpu (the SDK is
# universal), but only the host arch is exercised in CI.
set -euo pipefail

PATCH_ROOT="$(cd "$(dirname "$0")" && pwd)"
TARGET_CPU="${2:-arm64}"
CHROMIUM_SRC="${1:-$PWD/chromium-src-152}"
CHROMIUM_COMMIT="026bb13a93d60e7adfefa2bbf58d6f57c2d335cc"

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
cp "$PATCH_ROOT/args.gn" "$OUT_DIR/args.gn"
printf 'target_cpu = "%s"\n' "$TARGET_CPU" >> "$OUT_DIR/args.gn"

gn gen "$OUT_DIR"
autoninja -C "$OUT_DIR" chrome

BINARY="$OUT_DIR/Chromium.app/Contents/MacOS/Chromium"
if [ ! -x "$BINARY" ]; then
  echo "error: expected macOS app bundle binary not found: $BINARY" >&2
  exit 1
fi
echo ""
echo "macOS engine built: $BINARY"
echo "Wiring into Agent Browser Studio:"
echo "  export AGENT_BROWSER_CHROMIUM_BINARY_PATH=$BINARY"
