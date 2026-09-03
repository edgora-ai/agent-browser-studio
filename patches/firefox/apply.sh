#!/bin/bash
# Apply the append-only Agent Browser Firefox patch chain.
set -euo pipefail

PATCH_ROOT="$(cd "$(dirname "$0")" && pwd)"
FIREFOX_SRC="${1:-$(pwd)}"
FIREFOX_STAMP="9ce1ee6baeb9a3c326dbd180bdece65d8fc2eadc"

[[ -x "$FIREFOX_SRC/mach" ]] || { echo "error: expected Firefox source: $FIREFOX_SRC" >&2; exit 2; }
"$PATCH_ROOT/verify-source-provenance.sh" "$FIREFOX_SRC" "$FIREFOX_STAMP" >/dev/null

if command -v shasum >/dev/null 2>&1; then
  (cd "$PATCH_ROOT" && shasum -a 256 -c PATCHSET.sha256)
else
  (cd "$PATCH_ROOT" && sha256sum -c PATCHSET.sha256)
fi

GIT_DIR="$(git -C "$FIREFOX_SRC" rev-parse --absolute-git-dir)"
STATE_DIR="$GIT_DIR/agent-browser-firefox-patches"
mkdir -p "$STATE_DIR"

while IFS= read -r payload; do
  relative="${payload#files/}"
  source="$PATCH_ROOT/$payload"
  target="$FIREFOX_SRC/$relative"
  mkdir -p "$(dirname "$target")"
  if [[ -e "$target" || -L "$target" ]]; then
    cmp -s "$source" "$target" || { echo "error: refusing to overwrite Firefox source payload: $target" >&2; exit 1; }
  else
    cp "$source" "$target"
  fi
done < <(
  cd "$PATCH_ROOT"
  [[ -d files ]] && find files -type f | LC_ALL=C sort
)

shopt -s nullglob
patch_count=0
for patch in "$PATCH_ROOT"/patches/*.patch; do
  patch_count=$((patch_count + 1))
  name="$(basename "$patch")"
  hash="$(git -C "$FIREFOX_SRC" hash-object "$patch")"
  marker="$STATE_DIR/$name"
  if [[ -f "$marker" && "$(<"$marker")" == "$hash" ]]; then
    echo "already applied: $name"
  elif git -C "$FIREFOX_SRC" apply --check "$patch" >/dev/null 2>&1; then
    git -C "$FIREFOX_SRC" apply "$patch"
    printf '%s\n' "$hash" > "$marker"
    echo "applied: $name"
  elif git -C "$FIREFOX_SRC" apply --reverse --check "$patch" >/dev/null 2>&1; then
    printf '%s\n' "$hash" > "$marker"
    echo "already represented: $name"
  else
    echo "error: $name neither applies nor cleanly reverses" >&2
    exit 1
  fi
done

if [[ -s "$PATCH_ROOT/PATCHED_SOURCE.sha256" ]]; then
  (cd "$FIREFOX_SRC" && shasum -a 256 -c "$PATCH_ROOT/PATCHED_SOURCE.sha256")
fi
echo "Agent Browser Firefox patch chain ready ($patch_count patches)"
