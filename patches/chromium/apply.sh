#!/bin/bash
# Apply the RoxyLite community fingerprint patch to the pinned Chromium 152 checkout.

set -euo pipefail

PATCH_ROOT="$(cd "$(dirname "$0")" && pwd)"
CHROMIUM_SRC="${1:-$(pwd)}"

if [[ ! -f "$CHROMIUM_SRC/chrome/renderer/chrome_content_renderer_client.cc" ]]; then
  echo "error: expected a Chromium src checkout: $CHROMIUM_SRC" >&2
  exit 2
fi

copy_file() {
  local relative="$1"
  local source="$PATCH_ROOT/files/$relative"
  local target="$CHROMIUM_SRC/$relative"
  mkdir -p "$(dirname "$target")"
  cp "$source" "$target"
}

copy_file "third_party/blink/public/common/roxy_fingerprint_config.h"
copy_file "third_party/blink/public/common/roxy_webrtc_rewriter.h"

GIT_DIR="$(git -C "$CHROMIUM_SRC" rev-parse --absolute-git-dir)"
STATE_DIR="$GIT_DIR/roxy-fingerprint-patches"
mkdir -p "$STATE_DIR"

for patch in "$PATCH_ROOT"/patches/*.patch; do
  patch_name="$(basename "$patch")"
  patch_hash="$(git -C "$CHROMIUM_SRC" hash-object "$patch")"
  marker="$STATE_DIR/$patch_name"
  if [[ -f "$marker" && "$(<"$marker")" == "$patch_hash" ]]; then
    echo "already applied: $patch_name"
  elif git -C "$CHROMIUM_SRC" apply --check "$patch" >/dev/null 2>&1; then
    git -C "$CHROMIUM_SRC" apply "$patch"
    printf '%s\n' "$patch_hash" > "$marker"
    echo "applied: $patch_name"
  elif git -C "$CHROMIUM_SRC" apply --reverse --check "$patch" >/dev/null 2>&1; then
    printf '%s\n' "$patch_hash" > "$marker"
    echo "already applied: $(basename "$patch")"
  else
    echo "error: $patch_name neither applies nor cleanly reverses; use a clean Chromium checkout or remove the conflicting edits" >&2
    exit 1
  fi
done

echo "Roxy fingerprint patch is ready in $CHROMIUM_SRC"
