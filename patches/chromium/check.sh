#!/bin/bash
# Validate that the patch remains applicable to an unmodified Chromium tree.

set -euo pipefail

PATCH_ROOT="$(cd "$(dirname "$0")" && pwd)"
CHROMIUM_SRC="${1:?usage: check.sh /path/to/chromium/src}"

for patch in "$PATCH_ROOT"/patches/*.patch; do
  git -C "$CHROMIUM_SRC" apply --check "$patch"
  echo "ok: $(basename "$patch")"
done

test -s "$PATCH_ROOT/files/chrome/renderer/roxy_fingerprint/roxy_fingerprint_agent.cc"
test -s "$PATCH_ROOT/files/chrome/renderer/roxy_fingerprint/roxy_fingerprint_agent.h"
test -s "$PATCH_ROOT/files/third_party/blink/public/common/roxy_fingerprint_config.h"
echo "source payload: ok"
