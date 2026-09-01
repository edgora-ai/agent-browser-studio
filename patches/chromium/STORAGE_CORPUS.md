# Storage quota capability corpus

This corpus records public browser API results from the independent Chromium
build. It verifies that the configured storage identity is consistent without
changing which APIs stock Chromium exposes in Window and Worker contexts.

## Leak found before patch `0039`

The test Profile declares `120000 MiB`, or `125829120000` bytes. Before the
fix, `navigator.storage.estimate()` and Storage Buckets returned that value,
but Blink's deprecated Window quota APIs exposed host/context defaults:

| Context | Legacy temporary/persistent result before `0039` |
|---|---:|
| Persistent Profile | `10737418240` bytes (10 GiB) |
| Incognito Profile | `4294967296` bytes (4 GiB) |

This was a cross-API fingerprint leak: one page could observe both the managed
quota and the native default in the same browser identity.

## Verified result

Patch `0039` applies the immutable managed quota in the deprecated query and
request callbacks. It retains actual usage and never reports a quota below
usage. A request for `251658240000` bytes is clamped to the configured
`125829120000` bytes.

The strict corpus now passes with exact persistent/incognito parity across:

- Window and Dedicated Worker `navigator.storage.estimate()`;
- Window and Worker Storage Buckets estimates and bucket OPFS access;
- Window and Worker OPFS create/write/read/remove round trips;
- Window `webkitTemporaryStorage` and `webkitPersistentStorage` query and
  request callbacks;
- Window `webkitRequestFileSystem` open behavior.

Workers continue to omit the deprecated Window-only quota and FileSystem
globals, matching stock Chromium exposure rather than fabricating APIs.

## Preserved implementation

- Chromium source commit:
  `3eb1216fd3259fa220ce2612c16020f190c7eda7`.
- Annotated tag: `roxy-chromium-150-patchset-0039`.
- Portable patch: `patches/0039-native-legacy-storage-quota.patch`.
- Patch SHA-256:
  `a111080791715db1fc6886e0b2607cc72ead8949e3343f4873a68d2102107d39`.
- Runtime corpus: `src/tools/storage-corpus.ts`, enforced by
  `src/tools/verify-native-chromium.ts`.

Acceptance used Chromium `150.0.7871.114`: the incremental build succeeded,
the strict verifier passed 52 baseline surfaces plus this Storage corpus and
61 system-theme cases, `424/424` tests passed, and patches `0002–0039` applied
in order to a clean index at upstream commit
`f405107495a07cb1bfcf687d4af8d91117098db6`.

The same modern/legacy/Buckets/OPFS corpus was reverified on installed Chromium
`152.0.7977.72` (commit
`026bb13a93d60e7adfefa2bbf58d6f57c2d335cc`) across Window/Worker,
persistent/incognito and same-Profile restart paths as part of the passing
53-surface native verifier.
