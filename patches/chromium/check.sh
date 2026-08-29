#!/bin/bash
# Validate that the patch remains applicable to an unmodified Chromium tree.

set -euo pipefail

PATCH_ROOT="$(cd "$(dirname "$0")" && pwd)"
CHROMIUM_SRC="${1:?usage: check.sh /path/to/chromium/src}"
UPSTREAM_BASELINE="026bb13a93d60e7adfefa2bbf58d6f57c2d335cc"

if ! diff -u \
  <(awk '{print $2}' "$PATCH_ROOT/PATCHSET.sha256" | LC_ALL=C sort) \
  <(
    cd "$PATCH_ROOT"
    {
      printf '%s\n' args.gn
      find files patches -type f | LC_ALL=C sort
    } | LC_ALL=C sort
  ); then
  echo "error: PATCHSET.sha256 must list every patch and source payload exactly once" >&2
  exit 2
fi

if command -v shasum >/dev/null 2>&1; then
  (cd "$PATCH_ROOT" && shasum -a 256 -c PATCHSET.sha256)
elif command -v sha256sum >/dev/null 2>&1; then
  (cd "$PATCH_ROOT" && sha256sum -c PATCHSET.sha256)
else
  echo "error: shasum or sha256sum is required to verify PATCHSET.sha256" >&2
  exit 2
fi
echo "patch history: immutable payload verified"

if [[ ! -f "$CHROMIUM_SRC/chrome/renderer/chrome_content_renderer_client.cc" ]]; then
  echo "error: expected a Chromium src checkout: $CHROMIUM_SRC" >&2
  exit 2
fi

if ! git -C "$CHROMIUM_SRC" cat-file -e "${UPSTREAM_BASELINE}^{commit}"; then
  echo "error: pinned Chromium baseline is missing: $UPSTREAM_BASELINE" >&2
  exit 2
fi

TEMP_INDEX="$(mktemp)"
rm -f "$TEMP_INDEX"
trap 'rm -f "$TEMP_INDEX"' EXIT
GIT_INDEX_FILE="$TEMP_INDEX" git -C "$CHROMIUM_SRC" read-tree "$UPSTREAM_BASELINE"
echo "upstream baseline: $UPSTREAM_BASELINE"

# apply.sh copies immutable source payloads before applying the numbered patch
# chain. Mirror that order in the temporary index so a later append-only patch
# can evolve a payload without rewriting its original bytes.
while IFS= read -r payload; do
  relative="${payload#files/}"
  blob="$(git -C "$CHROMIUM_SRC" hash-object -w "$PATCH_ROOT/$payload")"
  GIT_INDEX_FILE="$TEMP_INDEX" git -C "$CHROMIUM_SRC" update-index \
    --add --cacheinfo "100644,$blob,$relative"
done < <(cd "$PATCH_ROOT" && find files -type f | LC_ALL=C sort)

for patch in "$PATCH_ROOT"/patches/*.patch; do
  GIT_INDEX_FILE="$TEMP_INDEX" git -C "$CHROMIUM_SRC" apply --cached --check "$patch"
  GIT_INDEX_FILE="$TEMP_INDEX" git -C "$CHROMIUM_SRC" apply --cached "$patch"
  echo "ok: $(basename "$patch")"
done

test -s "$PATCH_ROOT/files/third_party/blink/public/common/roxy_fingerprint_config.h"
test -s "$PATCH_ROOT/files/third_party/blink/public/common/roxy_webrtc_rewriter.h"
echo "source payload: ok"
