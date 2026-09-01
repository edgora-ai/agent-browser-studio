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
      printf '%s\n' args.gn PATCHED_SOURCE.sha256
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

verify_source_manifest() {
  if command -v shasum >/dev/null 2>&1; then
    (cd "$CHROMIUM_SRC" && shasum -a 256 -c "$PATCH_ROOT/PATCHED_SOURCE.sha256")
  elif command -v sha256sum >/dev/null 2>&1; then
    (cd "$CHROMIUM_SRC" && sha256sum -c "$PATCH_ROOT/PATCHED_SOURCE.sha256")
  else
    echo "error: shasum or sha256sum is required for source integrity verification" >&2
    exit 2
  fi
}

sha256_stream() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    echo "error: shasum or sha256sum is required for source integrity verification" >&2
    exit 2
  fi
}

if [[ ! -f "$CHROMIUM_SRC/chrome/renderer/chrome_content_renderer_client.cc" ]]; then
  echo "error: expected a Chromium src checkout: $CHROMIUM_SRC" >&2
  exit 2
fi

provenance="$($PATCH_ROOT/verify-source-provenance.sh "$CHROMIUM_SRC" "$UPSTREAM_BASELINE")"

# Archive-seeded source intentionally has a tiny synthetic Git history: the
# trusted archive SHA and exact per-file delta establish source provenance,
# while apply.sh records every successfully applied patch by its immutable
# hash. Do not make git cat-file lazily fetch a multi-GiB upstream pack merely
# to validate this already-patched build tree.
if [[ -f "$CHROMIUM_SRC/.chromium-source-base-commit" ]]; then
  GIT_DIR="$(git -C "$CHROMIUM_SRC" rev-parse --absolute-git-dir)"
  STATE_DIR="$GIT_DIR/roxy-fingerprint-patches"
  for patch in "$PATCH_ROOT"/patches/*.patch; do
    patch_name="$(basename "$patch")"
    marker="$STATE_DIR/$patch_name"
    patch_hash="$(git -C "$CHROMIUM_SRC" hash-object "$patch")"
    if [[ ! -f "$marker" || "$(<"$marker")" != "$patch_hash" ]]; then
      echo "error: archive source patch is not recorded as applied: $patch_name" >&2
      exit 2
    fi
    echo "ok: $patch_name"
  done
  verify_source_manifest
  echo "upstream baseline: $provenance"
  echo "patched source: immutable final-file manifest verified"
  exit 0
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
  if GIT_INDEX_FILE="$TEMP_INDEX" git -C "$CHROMIUM_SRC" apply --cached --check "$patch" >/dev/null 2>&1; then
    GIT_INDEX_FILE="$TEMP_INDEX" git -C "$CHROMIUM_SRC" apply --cached "$patch"
    echo "ok: $(basename "$patch")"
  elif GIT_INDEX_FILE="$TEMP_INDEX" git -C "$CHROMIUM_SRC" apply --cached --reverse --check "$patch" >/dev/null 2>&1; then
    echo "ok (already represented): $(basename "$patch")"
  else
    echo "error: $(basename "$patch") neither applies nor is already represented in the simulated patch chain" >&2
    exit 2
  fi
done

while read -r expected_sha relative; do
  if ! actual_sha="$(
    GIT_INDEX_FILE="$TEMP_INDEX" git -C "$CHROMIUM_SRC" show ":$relative" | sha256_stream
  )"; then
    echo "error: patched source manifest path is missing from simulated index: $relative" >&2
    exit 2
  fi
  if [[ "$actual_sha" != "$expected_sha" ]]; then
    echo "error: patched source manifest mismatch for $relative: $actual_sha != $expected_sha" >&2
    exit 2
  fi
done < "$PATCH_ROOT/PATCHED_SOURCE.sha256"
echo "patched source: immutable final-file manifest verified"
