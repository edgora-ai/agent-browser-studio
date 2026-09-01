#!/bin/bash
# Seed a Chromium 152 gclient solution from a verified release archive.
#
# Usage:
#   ./patches/chromium/seed-source-archive.sh \
#     [/path/to/chromium-build-152] [/path/to/chromium-152.tar.gz]
#
# This is the fail-fast fallback for networks that can download a resumable
# codeload archive but truncate Git pack streams. It creates a tiny synthetic Git
# HEAD so gclient can treat the solution as unmanaged, records the real upstream
# commit as provenance, and leaves all source files in the worktree for patching.
set -euo pipefail

CHROMIUM_VERSION="${CHROMIUM_ARCHIVE_VERSION:-152.0.7977.72}"
CHROMIUM_COMMIT="${CHROMIUM_ARCHIVE_COMMIT:-026bb13a93d60e7adfefa2bbf58d6f57c2d335cc}"
GCLIENT_ROOT="${1:-$HOME/workspace/chromium-build-152}"
ARCHIVE="${2:-$GCLIENT_ROOT/chromium-$CHROMIUM_VERSION.tar.gz}"
CHROMIUM_SRC="$GCLIENT_ROOT/src"
EXPECTED_ARCHIVE_SHA256="${CHROMIUM_ARCHIVE_SHA256:-}"
if [[ "$CHROMIUM_VERSION" == "152.0.7977.65" && "$CHROMIUM_COMMIT" == "fc4d67f1788019a27e32511137ceccbd2fafdaaa" ]]; then
  trusted_sha256="1a544857555a0c391753e7f9f3016cc07b0288d9da02260c451aa9082b305066"
  if [[ -n "$EXPECTED_ARCHIVE_SHA256" && "$EXPECTED_ARCHIVE_SHA256" != "$trusted_sha256" ]]; then
    echo "error: configured SHA-256 does not match the trusted Chromium 152.0.7977.65 archive" >&2
    exit 2
  fi
  EXPECTED_ARCHIVE_SHA256="$trusted_sha256"
fi

for command_name in git tar; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "error: required command is not on PATH: $command_name" >&2
    exit 2
  fi
done
if command -v shasum >/dev/null 2>&1; then
  SHA256_COMMAND=(shasum -a 256)
elif command -v sha256sum >/dev/null 2>&1; then
  SHA256_COMMAND=(sha256sum)
else
  echo "error: shasum or sha256sum is required" >&2
  exit 2
fi
if [[ ! -f "$GCLIENT_ROOT/.gclient" ]]; then
  echo "error: gclient root is not configured: $GCLIENT_ROOT/.gclient" >&2
  exit 2
fi
if [[ ! -f "$ARCHIVE" ]]; then
  echo "error: Chromium source archive not found: $ARCHIVE" >&2
  exit 2
fi
if [[ ! "$EXPECTED_ARCHIVE_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "error: no trusted SHA-256 is configured for Chromium $CHROMIUM_VERSION ($CHROMIUM_COMMIT)" >&2
  exit 2
fi
archive_sha256="$("${SHA256_COMMAND[@]}" "$ARCHIVE" | cut -d ' ' -f 1)"
if [[ "$archive_sha256" != "$EXPECTED_ARCHIVE_SHA256" ]]; then
  echo "error: Chromium archive SHA-256 mismatch: $archive_sha256 != $EXPECTED_ARCHIVE_SHA256" >&2
  exit 1
fi
if ! tar -tf "$ARCHIVE" >/dev/null; then
  echo "error: Chromium source archive is corrupt or incomplete: $ARCHIVE" >&2
  exit 1
fi
if tar -tf "$ARCHIVE" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo "error: Chromium source archive contains an absolute or traversal path" >&2
  exit 1
fi
if [[ ! -d "$CHROMIUM_SRC/.git" ]]; then
  echo "error: expected the configured src Git directory: $CHROMIUM_SRC/.git" >&2
  exit 2
fi
if [[ -n "$(find "$CHROMIUM_SRC" -mindepth 1 -maxdepth 1 ! -name .git -print -quit)" ]]; then
  echo "error: refusing to overwrite a non-empty Chromium worktree: $CHROMIUM_SRC" >&2
  exit 2
fi

echo "archive sha256: $archive_sha256"
echo "extracting Chromium $CHROMIUM_VERSION into $CHROMIUM_SRC"
tar -xf "$ARCHIVE" --strip-components=1 -C "$CHROMIUM_SRC"

for required_file in DEPS chrome/VERSION chrome/renderer/chrome_content_renderer_client.cc; do
  if [[ ! -f "$CHROMIUM_SRC/$required_file" ]]; then
    echo "error: archive is missing required Chromium source: $required_file" >&2
    exit 1
  fi
done

read_version_component() {
  local component="$1"
  grep -E "^${component}=" "$CHROMIUM_SRC/chrome/VERSION" | cut -d= -f2
}
archive_version="$(read_version_component MAJOR).$(read_version_component MINOR).$(read_version_component BUILD).$(read_version_component PATCH)"
if [[ "$archive_version" != "$CHROMIUM_VERSION" ]]; then
  echo "error: archive reports Chromium $archive_version, expected $CHROMIUM_VERSION" >&2
  exit 1
fi

# gclient only needs a valid HEAD in unmanaged mode. Do not add the multi-GiB
# archive to Git: the immutable tag, version and archive SHA are recorded as
# provenance, while apply.sh validates every patch directly against the files.
git -C "$CHROMIUM_SRC" config user.name "Agent Browser Source Seeder"
git -C "$CHROMIUM_SRC" config user.email "source-seed@example.invalid"
empty_tree="$(git -C "$CHROMIUM_SRC" mktree </dev/null)"
synthetic_commit="$(printf 'Chromium %s archive seed\n\nUpstream-Commit: %s\nArchive-SHA256: %s\n' \
  "$CHROMIUM_VERSION" "$CHROMIUM_COMMIT" "$archive_sha256" | \
  git -C "$CHROMIUM_SRC" commit-tree "$empty_tree")"
git -C "$CHROMIUM_SRC" update-ref refs/heads/chromium-152-archive "$synthetic_commit"
git -C "$CHROMIUM_SRC" symbolic-ref HEAD refs/heads/chromium-152-archive
printf '%s\n' "$CHROMIUM_COMMIT" > "$CHROMIUM_SRC/.chromium-source-base-commit"
printf '%s\n' "$CHROMIUM_COMMIT" > "$CHROMIUM_SRC/.chromium-source-commit"
printf '%s\n' "$archive_sha256" > "$CHROMIUM_SRC/.chromium-source-archive.sha256"

echo "archive source ready: $CHROMIUM_SRC"
echo "upstream commit: $CHROMIUM_COMMIT"
echo "synthetic HEAD: $synthetic_commit"
