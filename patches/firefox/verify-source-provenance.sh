#!/bin/bash
# Verify the exact Firefox 154 official archive provenance.
set -euo pipefail

FIREFOX_SRC="${1:?usage: verify-source-provenance.sh /path/to/firefox/src [expected-sourcestamp]}"
EXPECTED_STAMP="${2:-9ce1ee6baeb9a3c326dbd180bdece65d8fc2eadc}"
EXPECTED_VERSION="154.0"
EXPECTED_BUILD_ID="20260812182057"
EXPECTED_SOURCE_URL="https://hg.mozilla.org/releases/mozilla-release/rev/$EXPECTED_STAMP"
EXPECTED_ARCHIVE_SHA512="a77cd664982add628681167ef5939bd6bf0c894aa380cca66f9b5fb265947874d1e819d42264f1dd07c843f8a6dc020da268cca9ff1e064fca019de91af9b996"

if [[ ! "$EXPECTED_STAMP" =~ ^[0-9a-f]{40}$ ]]; then
  echo "error: malformed Firefox SourceStamp: $EXPECTED_STAMP" >&2
  exit 2
fi
for required in mach browser/config/version.txt config/milestone.txt sourcestamp.txt; do
  if [[ ! -f "$FIREFOX_SRC/$required" ]]; then
    echo "error: Firefox source provenance is missing: $FIREFOX_SRC/$required" >&2
    exit 2
  fi
done
for marker in .firefox-source-version .firefox-source-commit .firefox-source-archive.sha512; do
  if [[ ! -f "$FIREFOX_SRC/$marker" ]]; then
    echo "error: Firefox source provenance marker is missing: $FIREFOX_SRC/$marker" >&2
    exit 2
  fi
done

version="$(tr -d '[:space:]' < "$FIREFOX_SRC/browser/config/version.txt")"
milestone="$(awk '!/^[[:space:]]*(#|$)/ { gsub(/[[:space:]]/, ""); print; exit }' "$FIREFOX_SRC/config/milestone.txt")"
source_build_id="$(awk 'NR == 1 { print; exit }' "$FIREFOX_SRC/sourcestamp.txt")"
source_url="$(awk 'NR == 2 { print; exit }' "$FIREFOX_SRC/sourcestamp.txt")"
archive_stamp="${source_url##*/}"
if [[ "$version" != "$EXPECTED_VERSION" || "$milestone" != "$EXPECTED_VERSION" ]]; then
  echo "error: Firefox source reports version=$version milestone=$milestone, expected $EXPECTED_VERSION" >&2
  exit 2
fi
if [[ "$source_build_id" != "$EXPECTED_BUILD_ID" || "$source_url" != "$EXPECTED_SOURCE_URL" || "$archive_stamp" != "$EXPECTED_STAMP" ]]; then
  echo "error: Firefox sourcestamp metadata is not the pinned release: build=$source_build_id url=$source_url" >&2
  exit 2
fi
if [[ "$(<"$FIREFOX_SRC/.firefox-source-version")" != "$EXPECTED_VERSION" ]]; then
  echo "error: Firefox source version marker is not $EXPECTED_VERSION" >&2
  exit 2
fi
if [[ "$(<"$FIREFOX_SRC/.firefox-source-commit")" != "$EXPECTED_STAMP" ]]; then
  echo "error: Firefox source commit marker does not match $EXPECTED_STAMP" >&2
  exit 2
fi
if [[ "$(<"$FIREFOX_SRC/.firefox-source-archive.sha512")" != "$EXPECTED_ARCHIVE_SHA512" ]]; then
  echo "error: Firefox archive SHA-512 marker is not trusted" >&2
  exit 2
fi

if [[ ! -d "$FIREFOX_SRC/.git" ]]; then
  echo "error: Firefox archive source is missing its synthetic Git state" >&2
  exit 2
fi
commit_message="$(git -C "$FIREFOX_SRC" log -1 --format=%B HEAD)"
if ! grep -Fqx "Upstream-Commit: $EXPECTED_STAMP" <<<"$commit_message"; then
  echo "error: synthetic HEAD does not bind the Firefox SourceStamp" >&2
  exit 2
fi
if ! grep -Fqx "Archive-SHA512: $EXPECTED_ARCHIVE_SHA512" <<<"$commit_message"; then
  echo "error: synthetic HEAD does not bind the Firefox archive SHA-512" >&2
  exit 2
fi

printf '%s (Firefox %s trusted archive)\n' "$EXPECTED_STAMP" "$EXPECTED_VERSION"
