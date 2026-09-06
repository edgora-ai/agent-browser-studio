#!/bin/bash
# Verify Mozilla's signed Firefox 154 SHA-512 manifest and pinned source entry.
set -euo pipefail

CHECKSUMS="${1:?usage: verify-release-signature.sh SHA512SUMS SHA512SUMS.asc KEY}"
SIGNATURE="${2:?usage: verify-release-signature.sh SHA512SUMS SHA512SUMS.asc KEY}"
KEY_FILE="${3:?usage: verify-release-signature.sh SHA512SUMS SHA512SUMS.asc KEY}"
EXPECTED_SOURCE_SHA512="a77cd664982add628681167ef5939bd6bf0c894aa380cca66f9b5fb265947874d1e819d42264f1dd07c843f8a6dc020da268cca9ff1e064fca019de91af9b996"
EXPECTED_SIGNING_FINGERPRINT="827E658608679618CD349F93678E455D76767AA3"
EXPECTED_CHECKSUMS_SHA256="5265e013a818830ae2128d655954845cb8660741f0400f84dca6df6f802ea68a"
EXPECTED_SIGNATURE_SHA256="208d231dade9908fa2cd799c0dc9b7f95b8caeed12b5baaaf7c8909b2d79e41d"
EXPECTED_KEY_SHA256="b0c538f0f145fa902ac55455d92d4e9a627c2c6865d79c81b280bcb55d75b798"

for command_name in gpg shasum; do
  command -v "$command_name" >/dev/null 2>&1 || { echo "error: required command is missing: $command_name" >&2; exit 2; }
done
for spec in \
  "$CHECKSUMS:$EXPECTED_CHECKSUMS_SHA256" \
  "$SIGNATURE:$EXPECTED_SIGNATURE_SHA256" \
  "$KEY_FILE:$EXPECTED_KEY_SHA256"; do
  file="${spec%%:*}" expected="${spec##*:}"
  [[ -f "$file" ]] || { echo "error: Firefox provenance file is missing: $file" >&2; exit 2; }
  actual="$(shasum -a 256 < "$file" | cut -d ' ' -f 1)"
  [[ "$actual" == "$expected" ]] || { echo "error: Firefox provenance file hash mismatch: $file" >&2; exit 1; }
done

if ! grep -Fqx "$EXPECTED_SOURCE_SHA512  source/firefox-154.0.source.tar.xz" "$CHECKSUMS"; then
  echo "error: signed Firefox checksum manifest does not contain the pinned source archive" >&2
  exit 1
fi

gpg_home="$(mktemp -d)"
trap 'rm -rf "$gpg_home"' EXIT
chmod 700 "$gpg_home"
GNUPGHOME="$gpg_home" gpg --batch --import "$KEY_FILE" >/dev/null 2>&1
status="$(GNUPGHOME="$gpg_home" gpg --batch --status-fd 1 --verify "$SIGNATURE" "$CHECKSUMS" 2>/dev/null)"
if ! grep -Fq "[GNUPG:] VALIDSIG $EXPECTED_SIGNING_FINGERPRINT " <<<"$status"; then
  echo "error: Firefox checksum manifest is not signed by the pinned Mozilla release key" >&2
  exit 1
fi
printf 'Mozilla Firefox release signature: %s\n' "$EXPECTED_SIGNING_FINGERPRINT"
