#!/bin/bash
# Verify either an exact Git checkout or the trusted archive+delta provenance
# chain used on networks that cannot transfer Chromium Git packs.
set -euo pipefail

CHROMIUM_SRC="${1:?usage: verify-source-provenance.sh /path/to/chromium/src expected-commit}"
EXPECTED_COMMIT="${2:?usage: verify-source-provenance.sh /path/to/chromium/src expected-commit}"

if [[ ! "$EXPECTED_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "error: expected Chromium commit is malformed: $EXPECTED_COMMIT" >&2
  exit 2
fi
actual_head="$(git -C "$CHROMIUM_SRC" rev-parse HEAD)"
if [[ "$actual_head" == "$EXPECTED_COMMIT" ]]; then
  printf '%s\n' "$actual_head"
  exit 0
fi

base_file="$CHROMIUM_SRC/.chromium-source-base-commit"
target_file="$CHROMIUM_SRC/.chromium-source-commit"
archive_sha_file="$CHROMIUM_SRC/.chromium-source-archive.sha256"
for provenance_file in "$base_file" "$target_file" "$archive_sha_file"; do
  if [[ ! -f "$provenance_file" ]]; then
    echo "error: archive source provenance is incomplete: $provenance_file" >&2
    exit 2
  fi
done
base_commit="$(<"$base_file")"
target_commit="$(<"$target_file")"
archive_sha256="$(<"$archive_sha_file")"
if [[ "$target_commit" != "$EXPECTED_COMMIT" ]]; then
  echo "error: archive source target is $target_commit, expected $EXPECTED_COMMIT" >&2
  exit 2
fi

trusted_archive_sha256=""
case "$base_commit" in
  fc4d67f1788019a27e32511137ceccbd2fafdaaa)
    trusted_archive_sha256="1a544857555a0c391753e7f9f3016cc07b0288d9da02260c451aa9082b305066"
    ;;
  *)
    echo "error: untrusted Chromium archive base commit: $base_commit" >&2
    exit 2
    ;;
esac
if [[ "$archive_sha256" != "$trusted_archive_sha256" ]]; then
  echo "error: archive provenance SHA-256 is $archive_sha256, expected $trusted_archive_sha256" >&2
  exit 2
fi
commit_message="$(git -C "$CHROMIUM_SRC" log -1 --format=%B HEAD)"
if ! grep -Fqx "Upstream-Commit: $base_commit" <<<"$commit_message"; then
  echo "error: synthetic HEAD does not bind the trusted archive base commit" >&2
  exit 2
fi
if ! grep -Fqx "Archive-SHA256: $archive_sha256" <<<"$commit_message"; then
  echo "error: synthetic HEAD does not bind the trusted archive SHA-256" >&2
  exit 2
fi
printf '%s (trusted archive base %s)\n' "$target_commit" "$base_commit"
