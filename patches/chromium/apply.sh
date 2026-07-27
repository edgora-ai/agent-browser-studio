#!/bin/bash
# Apply the RoxyLite community fingerprint patch to a Chromium 149+ checkout.

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

copy_file "chrome/renderer/roxy_fingerprint/roxy_fingerprint_agent.cc"
copy_file "chrome/renderer/roxy_fingerprint/roxy_fingerprint_agent.h"
copy_file "third_party/blink/public/common/roxy_fingerprint_config.h"
copy_file "third_party/blink/public/common/roxy_webrtc_rewriter.h"

for patch in "$PATCH_ROOT"/patches/*.patch; do
  if git -C "$CHROMIUM_SRC" apply --reverse --check "$patch" >/dev/null 2>&1; then
    echo "already applied: $(basename "$patch")"
  else
    git -C "$CHROMIUM_SRC" apply --check "$patch"
    git -C "$CHROMIUM_SRC" apply "$patch"
    echo "applied: $(basename "$patch")"
  fi
done

echo "Roxy fingerprint patch is ready in $CHROMIUM_SRC"
