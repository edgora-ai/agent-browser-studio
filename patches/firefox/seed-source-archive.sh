#!/bin/bash
# Extract and provenance-bind the official Firefox 154 source archive.
set -euo pipefail

FIREFOX_VERSION="154.0"
FIREFOX_STAMP="9ce1ee6baeb9a3c326dbd180bdece65d8fc2eadc"
EXPECTED_BUILD_ID="20260812182057"
EXPECTED_SOURCE_URL="https://hg.mozilla.org/releases/mozilla-release/rev/$FIREFOX_STAMP"
EXPECTED_SHA512="a77cd664982add628681167ef5939bd6bf0c894aa380cca66f9b5fb265947874d1e819d42264f1dd07c843f8a6dc020da268cca9ff1e064fca019de91af9b996"
FIREFOX_ROOT="${1:-$HOME/workspace/firefox-build-154}"
ARCHIVE="${2:-$FIREFOX_ROOT/downloads/firefox-154.0.source.tar.xz}"
FIREFOX_SRC="$FIREFOX_ROOT/src"

for command_name in git tar shasum; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "error: required command is not on PATH: $command_name" >&2
    exit 2
  fi
done
if [[ ! -f "$ARCHIVE" ]]; then
  echo "error: Firefox source archive not found: $ARCHIVE" >&2
  exit 2
fi
actual_sha512="$(shasum -a 512 < "$ARCHIVE" | cut -d ' ' -f 1)"
if [[ "$actual_sha512" != "$EXPECTED_SHA512" ]]; then
  echo "error: Firefox archive SHA-512 mismatch: $actual_sha512 != $EXPECTED_SHA512" >&2
  exit 1
fi
if ! tar -tf "$ARCHIVE" >/dev/null; then
  echo "error: Firefox source archive is corrupt: $ARCHIVE" >&2
  exit 1
fi
if tar -tf "$ARCHIVE" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo "error: Firefox source archive contains an absolute or traversal path" >&2
  exit 1
fi
if [[ -e "$FIREFOX_SRC" ]] && [[ -n "$(find "$FIREFOX_SRC" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
  echo "error: refusing to overwrite a non-empty Firefox source tree: $FIREFOX_SRC" >&2
  exit 2
fi
mkdir -p "$FIREFOX_SRC"
echo "archive sha512: $actual_sha512"
echo "extracting Firefox $FIREFOX_VERSION into $FIREFOX_SRC"
tar -xf "$ARCHIVE" --strip-components=1 -C "$FIREFOX_SRC"

for required in mach browser/config/version.txt config/milestone.txt sourcestamp.txt; do
  if [[ ! -f "$FIREFOX_SRC/$required" ]]; then
    echo "error: Firefox archive is missing required source metadata: $required" >&2
    exit 1
  fi
done
source_build_id="$(awk 'NR == 1 { print; exit }' "$FIREFOX_SRC/sourcestamp.txt")"
source_url="$(awk 'NR == 2 { print; exit }' "$FIREFOX_SRC/sourcestamp.txt")"
archive_stamp="${source_url##*/}"
if [[ "$source_build_id" != "$EXPECTED_BUILD_ID" || "$source_url" != "$EXPECTED_SOURCE_URL" || "$archive_stamp" != "$FIREFOX_STAMP" ]]; then
  echo "error: Firefox sourcestamp metadata is not the pinned release: build=$source_build_id url=$source_url" >&2
  exit 1
fi

# Keep the multi-gigabyte archive tree untracked. Git supplies safe patch state
# and immutable markers; archive SHA-512 + signed sourcestamp metadata are the
# upstream trust anchor.
git -C "$FIREFOX_SRC" init -q
git -C "$FIREFOX_SRC" config user.name "Agent Browser Source Seeder"
git -C "$FIREFOX_SRC" config user.email "source-seed@example.invalid"
empty_tree="$(git -C "$FIREFOX_SRC" mktree </dev/null)"
synthetic_commit="$(printf 'Firefox %s archive seed\n\nUpstream-Commit: %s\nArchive-SHA512: %s\n' \
  "$FIREFOX_VERSION" "$FIREFOX_STAMP" "$actual_sha512" | \
  git -C "$FIREFOX_SRC" commit-tree "$empty_tree")"
git -C "$FIREFOX_SRC" update-ref refs/heads/firefox-154-archive "$synthetic_commit"
git -C "$FIREFOX_SRC" symbolic-ref HEAD refs/heads/firefox-154-archive
printf '%s\n' "$FIREFOX_VERSION" > "$FIREFOX_SRC/.firefox-source-version"
printf '%s\n' "$FIREFOX_STAMP" > "$FIREFOX_SRC/.firefox-source-commit"
printf '%s\n' "$actual_sha512" > "$FIREFOX_SRC/.firefox-source-archive.sha512"

"$(cd "$(dirname "$0")" && pwd)/verify-source-provenance.sh" "$FIREFOX_SRC" "$FIREFOX_STAMP"
echo "Firefox archive source ready: $FIREFOX_SRC"
