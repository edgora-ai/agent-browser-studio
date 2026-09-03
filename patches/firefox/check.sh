#!/bin/bash
# Validate Firefox patch artifacts, provenance, markers and final source files.
set -euo pipefail

PATCH_ROOT="$(cd "$(dirname "$0")" && pwd)"
FIREFOX_SRC="${1:?usage: check.sh /path/to/firefox/src}"
FIREFOX_STAMP="9ce1ee6baeb9a3c326dbd180bdece65d8fc2eadc"

if ! diff -u \
  <(awk '{print $2}' "$PATCH_ROOT/PATCHSET.sha256" | LC_ALL=C sort) \
  <(
    cd "$PATCH_ROOT"
    {
      printf '%s\n' SOURCE.sha512 mozconfig.macos-arm64 PATCHED_SOURCE.sha256
      for directory in files patches; do
        [[ -d "$directory" ]] && find "$directory" -type f
      done | LC_ALL=C sort
    } | LC_ALL=C sort
  ); then
  echo "error: PATCHSET.sha256 must list every Firefox patch and immutable payload exactly once" >&2
  exit 2
fi
if command -v shasum >/dev/null 2>&1; then
  (cd "$PATCH_ROOT" && shasum -a 256 -c PATCHSET.sha256)
else
  (cd "$PATCH_ROOT" && sha256sum -c PATCHSET.sha256)
fi
provenance="$("$PATCH_ROOT/verify-source-provenance.sh" "$FIREFOX_SRC" "$FIREFOX_STAMP")"

GIT_DIR="$(git -C "$FIREFOX_SRC" rev-parse --absolute-git-dir)"
STATE_DIR="$GIT_DIR/agent-browser-firefox-patches"
shopt -s nullglob
patch_count=0
for patch in "$PATCH_ROOT"/patches/*.patch; do
  patch_count=$((patch_count + 1))
  name="$(basename "$patch")"
  marker="$STATE_DIR/$name"
  expected="$(git -C "$FIREFOX_SRC" hash-object "$patch")"
  if [[ ! -f "$marker" || "$(<"$marker")" != "$expected" ]]; then
    echo "error: Firefox source patch is not recorded as applied: $name" >&2
    exit 2
  fi
  echo "ok: $name"
done
if [[ -s "$PATCH_ROOT/PATCHED_SOURCE.sha256" ]]; then
  (cd "$FIREFOX_SRC" && shasum -a 256 -c "$PATCH_ROOT/PATCHED_SOURCE.sha256")
fi
echo "upstream baseline: $provenance"
echo "Firefox patch chain: $patch_count patches verified"
