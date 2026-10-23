# Fingerprint recovery and runtime-safe transfer — 2026-10-20

## Merge scope

The private `main` baseline is `2bcd9fe2d6a1f3a2c57627c1910d32647fcc0abb`. The tested release branch contains 30 existing commits beyond that ancestor, plus the fingerprint/transfer work summarized below. This is a cumulative source rollup, not a claim that only the latest working-tree delta will be merged.

The earlier commits include native LocalStorage commit-before-close ordering, browser stop ownership, cross-machine credential/portability boundaries, truthful navigation/load outcomes, atomic fresh proxy diagnostics, selected-page network observation, sync/health consistency, Firefox Auto/form handling and UI remediation. Their individual retained evidence and open findings remain applicable; this document does not turn all historical findings into passes.

## Current changes

1. **Explain and reopen fingerprint differences.** A local comparison report provides grouped identity risk, review, information and unavailable evidence, with field names, complete escaped old/new values, reasons, original observation time/source, and separate reference-acceptance time. A stopped browser can reopen saved details without starting a process, probing again or refreshing the old observation time.
2. **Do not treat normal geometry as an identity failure.** Comparison uses semantic leaves for structured samples and ignores irrelevant JSON key/brand-list order. Ordinary viewport/window position/work-area and theme changes are informational. Screen dimensions, DPR, hardware, architecture, persona conflicts and seeded signals remain strict. Browser-version review requires actual owned-binary evidence and coherent sampled identity; missing evidence or an opaque hash cannot be explained away as geometry.
3. **Keep launch failures truthful.** Both engines retain typed drift-block/unavailable errors and pre-stop evidence. Required unavailable sampling is not a drift claim or a successful comparison. Deliberately skipped comparisons do not claim verification. A stop request does not certify process exit.
4. **Provide an explicit reference-recovery flow.** Review the current-session snapshot, confirm the intended change, update only the reference, then explicitly start and recheck through the normal launch gates. Trusted candidates are process-local and expire after 30 minutes; confirmation tokens expire after five minutes, are sender/context bound and single-use. Saved disk reports are read-only evidence, not authorization to change a baseline. No automatic seed reset, browser start/stop or login-data removal is introduced.
5. **Invalidate stale observations across restore and identity changes.** Config/proxy identity, runtime generation, baseline and local data revision fence observations and confirmations. The data revision advances before any possibly effective restore/write/live dispatch, including later failure or unchanged portable config bytes. Credential-sensitive witnesses stay main-process-only; no raw credentials or reusable credential hashes are exported to reports.
6. **Treat unknown runtime state conservatively.** Strict process discovery preserves matching no-port processes and reports discovery/permission/unknown failures as unknown, not stopped. Only positive exit evidence, including the precise ESRCH case, releases tracked process ownership. An inert Firefox crash-lock exception is narrow, rechecked and non-deleting; it is not a clean-exit or native-crash fix.
7. **Protect transfer targets as whole environments by default.** Pull skips running, stopping or exit-unconfirmed profiles as a whole, including metadata, without automatically stopping them. The legacy live/partial path requires explicit opt-in. ZIP export requires confirmed stopped state; restore locking extends through metadata adoption and generation invalidation.
8. **Report backup/application boundaries accurately.** Configuration publication with incomplete browser backup is partial, not a complete backup success. Retained artifacts keep their original capture time. Queued Cookies, confirmed live application, unconfirmed dispatch, restart requirements and skipped-stop-required outcomes are distinct. These receipts do not certify runtime fingerprint or account/site safety.

The Linux/Windows CI jobs also create a canonical, job-owned temporary directory before the isolated fixture tests. This satisfies the existing fixture capability boundary without permitting arbitrary filesystem/network access or modifying application storage/security policy.

## Verified scope

- Frozen macOS non-GUI unit/smoke run: **258 files; 7,530 collected; 7,529 passed; one Windows-only skip; zero failing assertions, suites or runtime errors**. The suite-level failure count is checked separately from assertion failures.
- V8 coverage of `src/main/services/**` and `src/main/ipc/**`: **lines 83.38%, statements 78.96%, branches 74.39%, functions 84.63%**. This is not renderer/native/site coverage.
- Storage regressions include synthetic writes, direct JSON/file inspection, module reload/readback and profile/name lookup, plus stale-observation/token and restore/runtime races. Synthetic fixture results are not actual cloud/cross-machine account acceptance.
- TypeScript compile/type-check, strict renderer/main localization parity, mirrored dictionaries, whitespace and the accepted file-size baseline passed. The CI temp setup is separately executed and checked for canonical ownership; remote platform CI remains its own result.
- The exact source identity used by the passing run and installed candidate is **`16e8505e75a900bb2910fe5cbef3c76d52dbccefce8e4434af6d37bd93e5e193`**. It hashes actual `src` bytes plus `package.json`, `tsconfig.json` and root `i18n.js`; docs/CI-only changes do not change the application build identity.

## Signed local candidate

- macOS arm64, App bundle version 1.0.1; **352** intended packaged controller/resource entries read back against the fresh compilation.
- Official Developer ID team `Y62N77529N`; same formal public issuer as the existing installation. No replacement issuer, trial reset, private-key export, security-permission/backend change or real credential read was used.
- **554** application content/metadata entries verified across staged copy and actual installation. The old App was retained using exclusive renames; the installer did not inspect, copy or migrate userData.
- Normal installed-App startup, actual on-screen main-window metadata and both public service health endpoints passed. The real protected collection rejected missing/invalid authentication with HTTP401. Startup remained stable for 30.77 seconds; this is not authenticated business-flow or browser-profile execution evidence.
- Signed DMG **487,614,795 bytes**, SHA-256 **`3dc12feaa6563817b9a2cc2a55f389874983409a24c4b58a7bb8ae68a48fda4c`**. Mounted read-only App, source App and installed App share CDHash **`b4c0bbc77c6dd35a692eaa8d1da3f3fdc2571b7a`**. Image verification/readback and clean detach passed.
- Installed ASAR SHA-256: **`482763a66a406b7687e1d61179866f151dfbaab1ba8e77c63562da41db5ffd3e`**.
- The initial task-local archive mapping omitted the three corpus modules; actual archive inspection caught it before installation. The corrected directory mapping was verified before signing/installing. An external DMG tool download timed out; native offline `hdiutil` created the final container instead. Failure evidence was retained rather than counted as acceptance.

## Explicitly not closed

- One bounded isolated Firefox native probe exited **SIGSEGV before BiDi session creation**. Its cause/fix is unconfirmed; neither this merge nor this package certifies Firefox/native acceptance.
- The old mocked-API Electron fixture remains suspended after repeated user-reported system prompts; their precise cause was not confirmed. It was not resumed for the local install or shipped as an application requirement.
- Native UI screen/Accessibility permissions were denied. No alternate capture/automation/debug workaround or permission change was used. The installed fingerprint review/update/start/recheck buttons and actual license-status UI were **not automatically verified**. Window/process health is not an interactive GUI pass.
- No real API credential, device ID, license/vault/Cookie/token or business-site data was inspected for the install smoke. The matching issuer and installer's non-access to license files are not an independently revalidated lifetime-license status.
- No complete website/account-safety guarantee, detection-evasion claim, cross-machine login acceptance, Windows package, or Apple notarization is implied. Public distribution should be a known-issues **prerelease**, not Latest/stable.

## Repository/publication boundary

Source changes and their cumulative MR belong only to the private source repository. The public distribution repository receives the verified signed installer, checksum and sanitized release notes only. A public release tag must target an already-public commit, never the private source branch or merge commit. Local receipts containing host paths/runtime details are not public release assets.
