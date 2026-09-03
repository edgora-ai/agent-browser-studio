#!/bin/bash
# Incrementally build the pinned Firefox 154 engine for macOS arm64.
set -euo pipefail

PATCH_ROOT="$(cd "$(dirname "$0")" && pwd)"
FIREFOX_SRC="${1:-$HOME/workspace/firefox-build-154/src}"
FIREFOX_STAMP="9ce1ee6baeb9a3c326dbd180bdece65d8fc2eadc"
OBJ_DIR="$FIREFOX_SRC/obj-agent-browser-arm64"
MIN_INITIAL_FREE_GIB="${FIREFOX_BUILD_MIN_FREE_GIB:-70}"
MIN_RESUME_FREE_GIB="${FIREFOX_BUILD_RESUME_MIN_FREE_GIB:-30}"
BUILD_PACKAGE="${FIREFOX_BUILD_PACKAGE:-1}"

free_gib() {
  local free_kib
  free_kib="$(df -Pk "$1" | tail -1 | tr -s ' ' | cut -d ' ' -f 4)"
  [[ "$free_kib" =~ ^[0-9]+$ ]] || { echo "error: unable to determine free disk space" >&2; exit 2; }
  printf '%s\n' "$((free_kib / 1024 / 1024))"
}
if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "error: build-macos.sh requires macOS arm64" >&2
  exit 2
fi
if [[ "$BUILD_PACKAGE" != "0" && "$BUILD_PACKAGE" != "1" ]]; then
  echo "error: FIREFOX_BUILD_PACKAGE must be 0 or 1" >&2
  exit 2
fi
if [[ ! -x "$FIREFOX_SRC/mach" ]]; then
  echo "error: prepared Firefox source is missing: $FIREFOX_SRC/mach" >&2
  echo "run $PATCH_ROOT/prepare-source.sh first" >&2
  exit 2
fi
ACTIVE_DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
if [[ "$ACTIVE_DEVELOPER_DIR" != */Xcode*.app/Contents/Developer ]]; then
  echo "error: DEVELOPER_DIR must point to a full Xcode installation" >&2
  exit 2
fi
export DEVELOPER_DIR="$ACTIVE_DEVELOPER_DIR"
xcodebuild -version >/dev/null
"$PATCH_ROOT/verify-source-provenance.sh" "$FIREFOX_SRC" "$FIREFOX_STAMP"
"$PATCH_ROOT/check.sh" "$FIREFOX_SRC"

if [[ -d "$OBJ_DIR" ]]; then
  minimum="$MIN_RESUME_FREE_GIB"; stage="resume build"
else
  minimum="$MIN_INITIAL_FREE_GIB"; stage="initial build"
fi
available="$(free_gib "$FIREFOX_SRC")"
echo "$stage disk: ${available} GiB free (minimum ${minimum} GiB)"
if (( available < minimum )); then
  echo "error: insufficient disk for $stage" >&2
  exit 2
fi

(
  cd "$FIREFOX_SRC"
  MOZCONFIG="$PATCH_ROOT/mozconfig.macos-arm64" ./mach build
)

app=""
while IFS= read -r candidate; do
  if [[ -x "$candidate/Contents/MacOS/firefox" ]]; then
    if [[ -n "$app" ]]; then
      echo "error: multiple Firefox app bundles found in $OBJ_DIR/dist" >&2
      exit 1
    fi
    app="$candidate"
  fi
done < <(find "$OBJ_DIR/dist" -maxdepth 1 -type d -name '*.app' | LC_ALL=C sort)
if [[ -z "$app" ]]; then
  echo "error: built Firefox app bundle not found in $OBJ_DIR/dist" >&2
  exit 1
fi
binary="$app/Contents/MacOS/firefox"
version_output="$("$binary" --version)"
if [[ "$version_output" != *"154.0"* ]]; then
  echo "error: built Firefox reported an unexpected version: $version_output" >&2
  exit 1
fi
codesign --force --deep --sign - --timestamp=none "$app"
codesign --verify --deep --strict "$app"

if [[ "$BUILD_PACKAGE" == "1" ]]; then
  (cd "$FIREFOX_SRC" && MOZCONFIG="$PATCH_ROOT/mozconfig.macos-arm64" ./mach package)
fi

echo "Firefox engine built: $app"
echo "version: $version_output"
echo "source: $FIREFOX_STAMP"
