#!/bin/bash
# Download, verify and extract the pinned Firefox 154 source archive.
set -euo pipefail

PATCH_ROOT="$(cd "$(dirname "$0")" && pwd)"
FIREFOX_ROOT="${1:-$HOME/workspace/firefox-build-154}"
FIREFOX_SRC="$FIREFOX_ROOT/src"
ARCHIVE="$FIREFOX_ROOT/downloads/firefox-154.0.source.tar.xz"
SOURCE_URL="https://archive.mozilla.org/pub/firefox/releases/154.0/source/firefox-154.0.source.tar.xz"
CHECKSUMS="$FIREFOX_ROOT/downloads/SHA512SUMS"
SIGNATURE="$FIREFOX_ROOT/downloads/SHA512SUMS.asc"
RELEASE_KEY="$FIREFOX_ROOT/downloads/KEY"
RELEASE_ROOT="https://archive.mozilla.org/pub/firefox/releases/154.0"
FIREFOX_STAMP="9ce1ee6baeb9a3c326dbd180bdece65d8fc2eadc"
MIN_FREE_GIB="${FIREFOX_PREPARE_MIN_FREE_GIB:-100}"
MIN_POST_FREE_GIB="${FIREFOX_POST_SYNC_MIN_FREE_GIB:-70}"

require_positive_integer() {
  local name="$1" value="$2"
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "error: $name must be a positive integer, got: $value" >&2
    exit 2
  fi
}
free_gib() {
  local free_kib
  free_kib="$(df -Pk "$1" | tail -1 | tr -s ' ' | cut -d ' ' -f 4)"
  if [[ ! "$free_kib" =~ ^[0-9]+$ ]]; then
    echo "error: unable to determine free disk space for: $1" >&2
    exit 2
  fi
  printf '%s\n' "$((free_kib / 1024 / 1024))"
}
require_free_space() {
  local available
  available="$(free_gib "$1")"
  echo "$3 disk: ${available} GiB free (minimum $2 GiB)"
  if (( available < $2 )); then
    echo "error: insufficient disk for $3; refusing to start an hours-long Firefox operation" >&2
    exit 2
  fi
}

require_positive_integer FIREFOX_PREPARE_MIN_FREE_GIB "$MIN_FREE_GIB"
require_positive_integer FIREFOX_POST_SYNC_MIN_FREE_GIB "$MIN_POST_FREE_GIB"
for command_name in curl git gpg tar shasum; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "error: required command is not on PATH: $command_name" >&2
    exit 2
  fi
done
mkdir -p "$FIREFOX_ROOT/downloads"

if [[ -d "$FIREFOX_SRC/.git" ]]; then
  "$PATCH_ROOT/verify-source-provenance.sh" "$FIREFOX_SRC" "$FIREFOX_STAMP"
  require_free_space "$FIREFOX_ROOT" "$MIN_POST_FREE_GIB" "existing source"
  echo "Firefox source already ready: $FIREFOX_SRC"
  exit 0
fi
require_free_space "$FIREFOX_ROOT" "$MIN_FREE_GIB" "pre-download"

download_file() {
  local url="$1" output="$2"
  if ! curl --http1.1 --fail --location --continue-at - --retry 3 --retry-delay 2 \
    --connect-timeout 30 --speed-time 120 --speed-limit 1024 \
    --output "$output" "$url"; then
    if [[ ! -f "$output" ]]; then
      echo "error: download failed without a resumable file: $url" >&2
      return 1
    fi
    echo "download did not advance; verifying the existing resumable file: $output" >&2
  fi
}

echo "Downloading and verifying Mozilla Firefox 154 release provenance."
download_file "$RELEASE_ROOT/SHA512SUMS" "$CHECKSUMS"
download_file "$RELEASE_ROOT/SHA512SUMS.asc" "$SIGNATURE"
download_file "$RELEASE_ROOT/KEY" "$RELEASE_KEY"
"$PATCH_ROOT/verify-release-signature.sh" "$CHECKSUMS" "$SIGNATURE" "$RELEASE_KEY"

echo "Downloading Firefox 154 source with resume support."
download_file "$SOURCE_URL" "$ARCHIVE"
"$PATCH_ROOT/seed-source-archive.sh" "$FIREFOX_ROOT" "$ARCHIVE"
require_free_space "$FIREFOX_ROOT" "$MIN_POST_FREE_GIB" "post-extract"
echo "Firefox source ready: $FIREFOX_SRC"
