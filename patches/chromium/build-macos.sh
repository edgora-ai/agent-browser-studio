#!/bin/bash
# Build the independent Chromium 152 engine for macOS (arm64/x64).
#
# Usage:
#   ./patches/chromium/build-macos.sh [/path/to/chromium/src] [arm64|x64]
#
# Prepare a complete checkout first with prepare-source.sh. This script never
# starts an implicit full clone: source sync and compilation are separate,
# resumable checkpoints so a transient failure does not discard hours of work.
set -euo pipefail

PATCH_ROOT="$(cd "$(dirname "$0")" && pwd)"
TARGET_CPU="${2:-arm64}"
CHROMIUM_SRC="${1:-$HOME/workspace/chromium-build-152/src}"
CHROMIUM_COMMIT="026bb13a93d60e7adfefa2bbf58d6f57c2d335cc"
BUILD_JOBS="${CHROMIUM_BUILD_JOBS:-4}"
MIN_INITIAL_FREE_GIB="${CHROMIUM_BUILD_MIN_FREE_GIB:-90}"
MIN_RESUME_FREE_GIB="${CHROMIUM_BUILD_RESUME_MIN_FREE_GIB:-20}"

require_positive_integer() {
  local name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "error: $name must be a positive integer, got: $value" >&2
    exit 2
  fi
}

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "error: required command is not on PATH: $command_name" >&2
    exit 2
  fi
}

free_gib() {
  local target="$1"
  local free_kib
  free_kib="$(df -Pk "$target" | tail -1 | tr -s ' ' | cut -d ' ' -f 4)"
  if [[ ! "$free_kib" =~ ^[0-9]+$ ]]; then
    echo "error: unable to determine free disk space for: $target" >&2
    exit 2
  fi
  printf '%s\n' "$((free_kib / 1024 / 1024))"
}

require_nonempty_directory() {
  local directory="$1"
  if [[ ! -d "$directory" ]] || [[ -z "$(find "$directory" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
    echo "error: required Chromium dependency is missing or empty: $directory" >&2
    echo "rerun: $PATCH_ROOT/prepare-source.sh $(dirname "$CHROMIUM_SRC")" >&2
    exit 2
  fi
}

require_positive_integer "CHROMIUM_BUILD_JOBS" "$BUILD_JOBS"
require_positive_integer "CHROMIUM_BUILD_MIN_FREE_GIB" "$MIN_INITIAL_FREE_GIB"
require_positive_integer "CHROMIUM_BUILD_RESUME_MIN_FREE_GIB" "$MIN_RESUME_FREE_GIB"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: build-macos.sh must run on macOS" >&2
  exit 2
fi
if [[ "$TARGET_CPU" != "arm64" && "$TARGET_CPU" != "x64" ]]; then
  echo "error: target_cpu must be arm64 or x64, got: $TARGET_CPU" >&2
  exit 2
fi
if [[ ! -d "$CHROMIUM_SRC/.git" ]]; then
  echo "error: complete Chromium checkout not found: $CHROMIUM_SRC" >&2
  echo "prepare it first: $PATCH_ROOT/prepare-source.sh $(dirname "$CHROMIUM_SRC")" >&2
  exit 2
fi

require_command git
require_command xcode-select
require_command xcodebuild
require_command gn
require_command autoninja

ACTIVE_DEVELOPER_DIR="${DEVELOPER_DIR:-$(xcode-select -p 2>/dev/null || true)}"
if [[ "$ACTIVE_DEVELOPER_DIR" != */Xcode*.app/Contents/Developer ]]; then
  echo "error: full Xcode is not selected (current: ${ACTIVE_DEVELOPER_DIR:-none})" >&2
  echo "set DEVELOPER_DIR to a full Xcode Developer directory or switch it with xcode-select" >&2
  exit 2
fi
export DEVELOPER_DIR="$ACTIVE_DEVELOPER_DIR"
if ! xcodebuild -version >/dev/null 2>&1; then
  echo "error: xcodebuild is not ready; run xcodebuild -runFirstLaunch first" >&2
  exit 2
fi

actual_commit="$("$PATCH_ROOT/verify-source-provenance.sh" "$CHROMIUM_SRC" "$CHROMIUM_COMMIT")"
if [[ ! -f "$CHROMIUM_SRC/chrome/renderer/chrome_content_renderer_client.cc" ]]; then
  echo "error: incomplete Chromium src checkout: $CHROMIUM_SRC" >&2
  exit 2
fi
for dependency in \
  third_party/icu \
  third_party/swiftshader \
  third_party/devtools-frontend/src \
  third_party/tflite/src \
  third_party/webrtc; do
  require_nonempty_directory "$CHROMIUM_SRC/$dependency"
done

OUT_DIR="$CHROMIUM_SRC/out/AgentBrowserRelease"
available_gib="$(free_gib "$CHROMIUM_SRC")"
if [[ -f "$OUT_DIR/.ninja_log" ]]; then
  minimum_gib="$MIN_RESUME_FREE_GIB"
  disk_stage="resume"
else
  minimum_gib="$MIN_INITIAL_FREE_GIB"
  disk_stage="initial build"
fi
echo "$disk_stage disk: ${available_gib} GiB free (minimum ${minimum_gib} GiB)"
if (( available_gib < minimum_gib )); then
  echo "error: insufficient disk for $disk_stage; refusing to start autoninja" >&2
  exit 2
fi

"$PATCH_ROOT/apply.sh" "$CHROMIUM_SRC"

mkdir -p "$OUT_DIR"
cp "$PATCH_ROOT/args.gn" "$OUT_DIR/args.gn"
printf 'target_cpu = "%s"\n' "$TARGET_CPU" >> "$OUT_DIR/args.gn"

(
  cd "$CHROMIUM_SRC"
  gn gen "$OUT_DIR"
  autoninja -C "$OUT_DIR" -j "$BUILD_JOBS" chrome
)

BINARY="$OUT_DIR/Chromium.app/Contents/MacOS/Chromium"
if [[ ! -x "$BINARY" ]]; then
  echo "error: expected macOS app bundle binary not found: $BINARY" >&2
  exit 1
fi
version_output="$("$BINARY" --version)"
if [[ "$version_output" != *"152.0.7977.72"* ]]; then
  echo "error: built binary reported an unexpected version: $version_output" >&2
  exit 1
fi

echo ""
echo "macOS engine built: $BINARY"
echo "version: $version_output"
echo "Wiring into Agent Browser Studio:"
echo "  export AGENT_BROWSER_CHROMIUM_BINARY_PATH=$BINARY"
