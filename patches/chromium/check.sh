#!/bin/bash
# Validate that the patch remains applicable to an unmodified Chromium tree.

set -euo pipefail

PATCH_ROOT="$(cd "$(dirname "$0")" && pwd)"
CHROMIUM_SRC="${1:?usage: check.sh /path/to/chromium/src}"

if [[ ! -f "$CHROMIUM_SRC/chrome/renderer/chrome_content_renderer_client.cc" ]]; then
  echo "error: expected a Chromium src checkout: $CHROMIUM_SRC" >&2
  exit 2
fi

TEMP_INDEX="$(mktemp)"
rm -f "$TEMP_INDEX"
trap 'rm -f "$TEMP_INDEX"' EXIT
GIT_INDEX_FILE="$TEMP_INDEX" git -C "$CHROMIUM_SRC" read-tree HEAD

for patch in "$PATCH_ROOT"/patches/*.patch; do
  GIT_INDEX_FILE="$TEMP_INDEX" git -C "$CHROMIUM_SRC" apply --cached --check "$patch"
  GIT_INDEX_FILE="$TEMP_INDEX" git -C "$CHROMIUM_SRC" apply --cached "$patch"
  echo "ok: $(basename "$patch")"
done

test -s "$PATCH_ROOT/files/third_party/blink/public/common/roxy_fingerprint_config.h"
test -s "$PATCH_ROOT/files/third_party/blink/public/common/roxy_webrtc_rewriter.h"
echo "source payload: ok"
