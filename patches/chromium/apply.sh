#!/bin/bash
# Apply the RoxyLite community fingerprint patch to the pinned Chromium 152 checkout.

set -euo pipefail

PATCH_ROOT="$(cd "$(dirname "$0")" && pwd)"
CHROMIUM_SRC="${1:-$(pwd)}"

if [[ ! -f "$CHROMIUM_SRC/chrome/renderer/chrome_content_renderer_client.cc" ]]; then
  echo "error: expected a Chromium src checkout: $CHROMIUM_SRC" >&2
  exit 2
fi

if ! diff -u \
  <(awk '{print $2}' "$PATCH_ROOT/PATCHSET.sha256" | LC_ALL=C sort) \
  <(
    cd "$PATCH_ROOT"
    {
      printf '%s\n' args.gn PATCHED_SOURCE.sha256
      find files patches -type f | LC_ALL=C sort
    } | LC_ALL=C sort
  ); then
  echo "error: PATCHSET.sha256 must list every patch and source payload exactly once" >&2
  exit 2
fi

verify_sha256_manifest() {
  local root="$1"
  local manifest="$2"
  if command -v shasum >/dev/null 2>&1; then
    (cd "$root" && shasum -a 256 -c "$manifest")
  elif command -v sha256sum >/dev/null 2>&1; then
    (cd "$root" && sha256sum -c "$manifest")
  else
    echo "error: shasum or sha256sum is required for source integrity verification" >&2
    exit 2
  fi
}

verify_sha256_manifest "$PATCH_ROOT" "$PATCH_ROOT/PATCHSET.sha256"
echo "patch history: immutable payload verified"

GIT_DIR="$(git -C "$CHROMIUM_SRC" rev-parse --absolute-git-dir)"
STATE_DIR="$GIT_DIR/roxy-fingerprint-patches"
mkdir -p "$STATE_DIR"

copy_file() {
  local relative="$1"
  local source="$PATCH_ROOT/files/$relative"
  local target="$CHROMIUM_SRC/$relative"
  mkdir -p "$(dirname "$target")"
  if [[ -e "$target" || -L "$target" ]]; then
    if cmp -s "$source" "$target"; then
      return
    fi
    if [[ -n "$(find "$STATE_DIR" -maxdepth 1 -type f -name '*.patch' -print -quit)" ]]; then
      echo "preserving evolved payload: $relative"
      return
    fi
    echo "error: refusing to overwrite an unexpected source payload: $target" >&2
    exit 1
  fi
  cp "$source" "$target"
}

copy_file "third_party/blink/public/common/roxy_fingerprint_config.h"
copy_file "third_party/blink/public/common/roxy_webrtc_rewriter.h"

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

verify_sha256_manifest "$CHROMIUM_SRC" "$PATCH_ROOT/PATCHED_SOURCE.sha256"
echo "patched source: immutable final-file manifest verified"
echo "Roxy fingerprint patch is ready in $CHROMIUM_SRC"
