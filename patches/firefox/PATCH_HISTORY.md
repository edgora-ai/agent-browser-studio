# Firefox 154 patch history

## Immutable upstream anchor

- Product version: `154.0`
- Mozilla repository: `https://hg.mozilla.org/releases/mozilla-release`
- Release tag: `FIREFOX_154_0_RELEASE`
- SourceStamp: `9ce1ee6baeb9a3c326dbd180bdece65d8fc2eadc`
- Parent changeset: `23c7b9841903ac50041691eef82540bef0760311`
- Official source archive: `firefox-154.0.source.tar.xz`
- Official SHA-512: `a77cd664982add628681167ef5939bd6bf0c894aa380cca66f9b5fb265947874d1e819d42264f1dd07c843f8a6dc020da268cca9ff1e064fca019de91af9b996`

The SHA-512 value was read from Mozilla's signed `154.0/SHA512SUMS`.
`verify-release-signature.sh` pins the downloaded checksum, signature and KEY
file hashes and requires signing fingerprint
`827E658608679618CD349F93678E455D76767AA3` before any source is extracted.
Source preparation additionally requires `sourcestamp.txt` to contain build ID
`20260812182057` and the exact `mozilla-release/rev/9ce1ee6…` URL; archive metadata to bind the extracted tree
to the exact SourceStamp; version text alone is insufficient.

## Append-only policy

Numbered patches are never rewritten after review. A compatibility or build fix
is added as the next patch. `PATCHSET.sha256` pins every patch and immutable
payload; `PATCHED_SOURCE.sha256` pins the full final contents of every modified
Gecko source file.

## Current state

No Gecko source patch has been accepted yet. The first checkpoint is a clean,
unofficial-branding stock build from the exact source anchor. Patch `0001` will
introduce the immutable config service and binary-attested capability response.
