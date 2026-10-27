# ABS Android — internal capability candidate

**Development resumed by the user's explicit request on 2026-10-27, including dedicated-emulator verification. Incomplete; not a Ping0-passed release. No production APK publication is implied.**

Server handoff: [`../../docs/review/android-native-kernel-server-task-2026-10-27.md`](../../docs/review/android-native-kernel-server-task-2026-10-27.md). The approved next direction is a controllable native engine; this checked-in prototype still uses System WebView and does not implement that native integration yet.

Historical pause checkpoint: [`../../docs/review/android-development-paused-2026-10-21.md`](../../docs/review/android-development-paused-2026-10-21.md). The last pre-resume build0014 result was 52/100, 166/166, five anomalies, partial68; native per-profile timezone and DNS remain unresolved. Detailed historical evidence: [`../../docs/review/android-ping0-load-recovery-2026-10-21.md`](../../docs/review/android-ping0-load-recovery-2026-10-21.md). Existing artifacts and failure evidence are retained; resumed development does not mark the product complete.

The Android-only project is intentionally independent of the Electron desktop app. It does not change the desktop issuer, commercial licensing, installed app or browser data. Production/release variants are disabled; the APK uses a newly generated, isolated development signing identity, not an official release certificate.

Research: [`../../docs/review/mobile-fingerprint-browser-research-2026-10-21.md`](../../docs/review/mobile-fingerprint-browser-research-2026-10-21.md). Initial emulator/Ping0 observations: [`../../docs/review/android-emulator-ping0-2026-10-21.md`](../../docs/review/android-emulator-ping0-2026-10-21.md). Follow-up full ten-minute wait, timed screenshots and limitations: [`../../docs/review/android-ping0-extended-wait-2026-10-21.md`](../../docs/review/android-ping0-extended-wait-2026-10-21.md).

## Scope and current limits

Implemented source:

- Native environment list/editor and immutable profile revisions.
- Private SQLite configuration, explicit compare-and-swap edits and encrypted proxy credential envelopes using AndroidKeyStore non-exportable AES-GCM handles. No plaintext fallback or automatic cloud/device backup.
- A dedicated `:browser` process, stable profile directory suffix, one-use launch claim before providers, and fresh same-UID controller activation before any WebView is created. The main process disables WebView.
- Session/incarnation-bound control, process-lifetime lock, separate Cookie-flush receipt and actual PID/death checks. Finishing an Activity, a timeout, TTL expiry or a drain reply does not unlock the next profile.
- System WebView proxy configuration without DIRECT fallbacks, safe-origin local message bridge and a six-realm identity sampler. It reads real native values; it does not rewrite Date/Intl/Navigator or install a JS fingerprint shim.
- Explicit HTTP-proxy GeoIP suggestions, with a fresh bounded request, strict response parsing and stale-form rejection. It never substitutes the phone's direct IP or an old cached success. Suggestions are not browser-routing proof.
- A native Android instrumentation suite for fresh synthetic configuration databases and parser checks. Build0013 actually ran 48 checks successfully in the dedicated emulator; this is not a WebView/Ping0 or AndroidKeyStore acceptance result.
- A native-confirmed, session-bound fixed Ping0 observation, limited to 600 seconds for a bounded full wait. It permits the fixed page and reviewed static CDN JS paths, reports blocked dependencies as partial, and never promotes the ordinary browsing gate.
- A separate, explicitly entered local synthetic-storage page. Initial entry only reads; an explicit button writes a fresh sample to Cookie, LocalStorage and IndexedDB and reads it back. Its reserved origin serves only three bundled resources, has a bounded session and never promotes storage or ordinary-browsing admission. Normal A/B/A/B process-switch readback was observed on the dedicated API-35 emulator; complete durability and real login remain unverified.

**Ordinary browsing remains blocked by the full admission gate.** Fixed Ping0 observation is not a generic “ignore checks” bypass. System WebView proxy configuration alone does not prove DNS/WebRTC/UDP confinement, and a Cookie flush is not a full LocalStorage/IndexedDB/Cache/SW shutdown barrier.

Specific incomplete capabilities:

| Capability | Current status |
| --- | --- |
| Real Android process/profile/configuration round trips | Observed in a dedicated Android 15 emulator: native SQL readback, cold-start retrieval and exact PID/lifetime-lock exit checks; website storage durability remains unverified |
| Cross-realm native timezone/locale propagation | Build0014 saved America/New_York correctly, but a fresh browser and Ping0 still exposed Asia/Shanghai; Java defaults do not supply the required per-profile native engine timezone control. Locale/header coverage remains separate |
| Proxy username/password authentication in WebView | Blocked: public HTTP-auth callback cannot safely bind a challenge to a proxy rather than a website |
| Complete device-model emulation | Blocked: declared uncalibrated models are not silently converted to native hardware |
| DNS/IPv6/WebRTC/UDP enforcement and failure closure | Not implemented/verified by this WebView adapter |
| Full web-storage durability across profile switches | Synthetic Cookie/LocalStorage/IndexedDB A/B/A/B readback after normal browser-process exit observed on API 35; full-store, crash/power-loss and real-site durability remain unverified |
| Browser HTTP headers and actual proxy exit | Not covered by the bundled local identity probe; this emulator used a lab proxy over ADB reverse, not different-country proxy acceptance |
| Ping0 | Latest build0014 rendered a real 52/100 high-risk score, 166/166, five anomalies, partial68 after the lab CDN path recovered. Timezone/DNS and emulator findings remain; not a full site or product PASS |
| Production licensing/signing/distribution | Not integrated; no release variant is built |

The supported UI mode is an **internal capability verification candidate**. Do not use real accounts or treat it as production-ready. Independent website storage is not a promise of hardware-fingerprint unlinkability. A self-test's `identityVerified` only denotes its documented native timezone/locale/UA subset, not a full identity or network PASS.

## Project structure

```text
core/                    Pure Java contracts and executable assertion tests
app/src/main/java/       Android UI, configuration, startup/control and WebView adapter
app/src/main/assets/      Identity-probe assets and the original SQLite schema
app/src/androidTest/     Owned Android instrumentation, not a mocked platform backend
probe-tests/             Node/VM realm and protocol tests (not browser tests)
storage-tests/           Actual host SQLite + static Java contract tests (not Android tests)
tools/build.py           Bounded isolated build runner and source/proc-group receipts
```

The first implementation uses Java 17 and Groovy Gradle to reuse a small toolchain and avoid unnecessary Kotlin/Compose dependencies. This is a tooling choice, not a relaxation of the browser requirements.

## Build

Pinned build inputs:

- JDK 17; Gradle 8.9; Android Gradle Plugin 8.7.3.
- Compile/target SDK 35 and Build-tools 35.0.0; minimum Android API 29.
- AndroidX WebKit 1.12.1. Runtime provider features are still checked independently.

Use an explicitly owned external state directory registered under the local storage rules. Do not create caches in an arbitrary internal-disk fallback or reuse another project's SDK state. The runner requires a regular `android-build-state.json` marker with this source root, owner UID, cap and reserve fields, plus the owned directories described in the task README. Its storage-check script is supplied explicitly rather than embedding one person's home path in the project.

```sh
python3 -B mobile/android/tools/build.py \
  --state-root "$ABS_ANDROID_STATE_ROOT" \
  --gradle "$ABS_GRADLE_BIN" \
  --sdk "$ANDROID_SDK_ROOT" \
  --java-home "$JAVA_HOME" \
  --read-only-cache "$ABS_GRADLE_RO_CACHE" \
  --host-volume "$ABS_HOST_VOLUME" \
  --storage-check "$ABS_STORAGE_CHECK" \
  :core:contractTest :app:assembleDebug :app:assembleDebugAndroidTest :app:lintDebug
```

The default native test runner is `OwnedInstrumentation`. Set `ABS_ANDROID_VERIFICATION_SUITE=lifecycle` for the independent `LifecycleInstrumentation` suite; only `owned` and `lifecycle` are accepted. Each requires a fresh canonical UUID in its `ownedScope` argument. The lifecycle suite executes the actual coordinator with Android Messenger and scoped SQLite fault fixtures, not a full WebView/UI scenario. See [the 2026-10-27 verification report](../../docs/review/android-resume-lifecycle-storage-2026-10-27.md) for the separate actual UI/storage results.

Offline is the default. Add `--online` only when missing small public Maven dependencies have been admitted. No Chromium, emulator or SDK download is performed by the runner; automatic SDK download is disabled. A read-only shared dependency cache is an input, not a writable Gradle home. `local.properties` is deliberately rejected by this isolated runner so it cannot silently override the admitted SDK path.

All build outputs, per-attempt logs, source inventories, command-specific temporary files, development signing material and process-group receipts stay under the one state root. Failed attempts are retained. Never add a keystore, credentials or runtime database to Git or app resources. The development keystore's conventional Android test password does not make it a release-signing identity.

The build runner checks the source inventory before and after a task; source changes or an unconfirmed owned process group prevent a passing result. A dependency-report task's exit code is not proof that every dependency resolved; real compilation is still required.

## Host checks

```sh
NODE_DISABLE_COMPILE_CACHE=1 NODE_OPTIONS= node --test mobile/android/probe-tests/*.test.cjs
ABS_STORAGE_TEST_ROOT="$ABS_ANDROID_STATE_ROOT/tests/storage" \
  python3 -B mobile/android/storage-tests/run_contract_tests.py
ABS_ANDROID_STATE_ROOT="$ABS_ANDROID_STATE_ROOT" \
  python3 -B mobile/android/tool-tests/test_build.py
```

`ABS_STORAGE_TEST_ROOT` must be the existing owned mode-0700 `tests/storage` directory under the admitted task root. The harness checks ownership, mode, path shape, symlinks and its 64-MiB sub-limit; mount identity and registration are the caller's responsibility. It refuses a missing root rather than falling back to the system temporary directory. Read that harness before provisioning a new scope; do not run old evidence or reset an existing scope's budget.

The Java contract tests can also be run through `:core:contractTest`. Their deliberate assertion-failure mode must exit nonzero. The host SQLite suite executes the original packaged SQL, directly queries rows/WAL, closes/reopens and searches again. It does **not** execute Android SQLiteOpenHelper or AndroidKeyStore.

## Android acceptance

Only use a newly owned isolated emulator or an explicitly authorized dedicated test device, with a fresh synthetic scope and an explicit device serial/server. Do not enumerate, install into, force-stop or read data from an unknown existing device/AVD. Do not use real accounts, existing browser data or system credentials.

The native instrumentation requires a new UUID `ownedScope`, uses only a new `verification_<UUID>.sqlite` database and refuses to overwrite an existing scope. It directly checks the actual Android SQLite rows before closing/reopening and testing retrieval. It reports WebView/Ping0 as NOT_RUN; this suite is not a substitute for the browser acceptance matrix in the research report.

The initial build0006 milestone had no admitted runtime capacity. The user subsequently approved a separate 32-GiB virtual APFS target with a cumulative 12-GiB runtime budget and 10-GiB reserves on that volume and its host. A new no-account Android 15 / Pixel Tablet emulator was actually run there, using the existing WebView 124 provider. Build0011 was installed and pulled back byte-for-byte, native checks and actual UI interactions were executed, and Ping0 was observed but did not produce a valid score. The owned browser, emulator, private ADB and test proxy were then stopped and checked. The original 1-GiB build cap and 6-GiB development-volume reserve remain unchanged. This does not authorize existing AVD/device use, another target, budget expansion, migration or internal-disk fallback. See the observation report above for evidence and remaining acceptance gaps.

## GeoIP provider

The development suggestion client uses the documented `success`, `ip`, `country_code` and `timezone.id` fields from [ipwhois.io documentation](https://ipwhois.io/documentation). A country may have multiple languages/timezones; provider geolocation is only a suggestion. The client currently supports unauthenticated HTTP proxy transport, rejects other transports explicitly, follows no redirects and changes no TLS trust policy. Proxy endpoint DNS resolution is distinct from destination DNS; neither this lookup nor its result certifies the WebView's routing. Provider availability, production usage terms and real proxy compatibility remain unverified.
