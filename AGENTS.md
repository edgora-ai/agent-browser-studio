# Workspace instructions

## Android build and test artifact retention

- Keep at most two full APK versions generated for this workspace: the active signed candidate and one independently verified, working rollback build. Do not treat an unverified device pull or an unsigned intermediate as a rollback. Do not keep duplicate APKs per run.
- Do not keep a separate full emulator disk or snapshot per run/version. Use one task-owned scratch AVD, check free space on its actual volume before building or running, and remove its generated disk after recording the result when no longer needed. Do not delete user-owned AVDs or shared SDKs/caches.
- Preserve small result manifests, APK/signing hashes, and the first failure evidence required to diagnose or substantiate results. Remove superseded task-generated bulky binaries and emulator images once they are no longer referenced by a live run or pinned evidence. Do not silently replace failed evidence or delete source, keys, releases, or user data.

## Studio macOS build and deployment artifact retention

- Per host, keep one checksum-verified installer for the current accepted build and one independently verified, usable application bundle for rollback. Verify the rollback's code signature, package dependencies, and original activation issuer; a failed or merely unpacked build is not a rollback.
- Check free space on the actual build and deployment volumes. After acceptance, remove superseded task-generated ZIPs, DMGs, unpacked bundles, and transfer copies by exact, resolved path once no live operation or pinned evidence needs them. Do not keep another full bundle for each build attempt. Keep small manifests, hashes, install receipts, and failure evidence.
- This applies only to task-generated app binaries. Do not delete source, keys, explicitly preserved or published releases, unverified user downloads, licenses, browser data or local copies of that data, or cloud sync backups. Do not restart Studio just to prune artifacts.
