# Android native product adapter — development input, not an accepted APK

This directory is the product-side migration from System WebView to the controlled Chromium engine. It is **not** the separate fixed-asset timezone verification shell in patch 0057, and it is not built by the existing Gradle `app` target.

The overall Android product and dedicated-emulator goal remains incomplete. The native verification build has reached GN/Ninja, but no new native APK has passed packaging, install, Window/Worker and Ping0 acceptance. Do not install an older WebView APK or the standalone shell and report that as acceptance of this adapter.

## Implemented source boundaries

- `NativeBrowserApplication` explicitly distinguishes the manager, `:browser`, and declared sandboxed/privileged child roles. It does not inherit ContentShellApplication's incorrect-for-this-product “no colon means browser” rule.
- The browser holds the existing process-lifetime lock and atomically consumes the existing SQLite bootstrap claim before rendering initialization. The same-UID session/nonce/incarnation controller and real process-death checks are reused, not replaced with a process-alive boolean.
- `NativeTimezoneLaunchConfig` translates the claimed `LaunchSpec` into patch 0057's exact five-field canonical native input, with a fresh process incarnation, deadline checks and decoded-payload SHA-256. No fixture profile, writable command-line file, incoming Intent arguments, proxy credential or JS flags supply the frozen identity.
- The command line is frozen before any LibraryLoader access. The native adapter does **not** set Java's default timezone or the device timezone. Java UI locale configuration and the native `--lang` request are not evidence of complete browser/header locale propagation.
- Native data and thumbnail directories are under a UUID-derived private no-backup profile directory; cache gets a distinct profile subdirectory. This is source-level directory binding, not verified full-store durability. No old WebView profile directory is imported or deleted.
- The rendering Activity is non-exported and accepts only its current coordinator-issued session/nonce. It does not inherit shell Intent navigation or restore a saved arbitrary URL. Its initial document is `about:blank`; the shell's address controls are hidden before the container becomes visible.
- A bundled diagnostic reads real Date/Intl values in the Window and two sequential Dedicated Workers. It requests Worker termination before recreation, cleans Blob URLs/timers and rejects late/superseded results. It does not replace Date, Intl or Navigator, manufacture matching values, access website storage or make network requests. A `terminate()` call is not a separately observed worker-thread exit.
- The separate native overlay validates preflight startup, skips the shell's DevTools HTTP handler, and restricts **browser-initiated navigation and Worker-script requests** to local preflight URLs. This is defense in depth, **not** renderer-subresource/WebSocket/WebRTC/UDP/DNS confinement proof.

The ordinary browsing admission gate remains unverified. Proxy authentication is unsupported in this adapter, fixed proxy flags are not routing proof, and complete identity/storage checks have not passed. Native drain does not call Android WebView's unrelated CookieManager: it reports Cookie flush `NOT_ATTEMPTED` and keeps full web-storage durability unverified. A drain reply never substitutes for actual process exit.

## Build input and overlay

The intended internal target is `//content/shell/android:agent_browser_product_apk`, producing `AgentBrowserProduct.apk` with package `com.ahoo.abs.android.native_product.preview` and `libagent_browser_product.so`. This is a test-only/debug source target, not a production signing or licensing integration.

`chromium/product-bootstrap.patch` is a separately staged overlay **after the exact reviewed patch 0057**. It is deliberately not applied to an active build's Chromium source/COW/output tree. Its four selected-file application and reverse checks passed on isolated copies; that is not C++ compilation. Stage and review a new complete selected-source/graph/artifact contract before using it in a native build. Do not silently change the running verification build's manifest or relax its source counts.

`tools/stage_product.py` selects the shared product/core classes, native adapter, resources, schema, diagnostic and overlay into an already registered bounded Android build state root. It:

- excludes the WebView Application/Activity/Runtime/asset adapters;
- rejects source/parent symlinks, hardlinks, oversized inputs and duplicate destinations;
- limits selection to 128 files, 2 MiB/file and 8 MiB total, with bounded relative metadata;
- writes new private files exclusively, fsyncs, reopens and fully verifies every byte and exact filename;
- records a deterministic source manifest and checks the source set again before success;
- preserves failed/partial outputs and never borrows another task's quota;
- does not apply a patch, run GN/Ninja, launch a VM/emulator, install an APK or read a signing key.

Example, using only existing admitted inputs:

```sh
python3 -B mobile/android/native-kernel/tools/stage_product.py \
  --execute \
  --state-root "$ABS_ANDROID_STATE_ROOT" \
  --stage-id native-product-01 \
  --host-volume "$ABS_HOST_VOLUME" \
  --storage-check "$ABS_STORAGE_CHECK"
```

A stage ID is single-use. A missing volume, changed identity, insufficient space or an existing destination is a rejection, not permission to delete, expand, overwrite or use an internal-disk fallback. The manifest explicitly retains `fullUpstreamIdentity=NOT_ESTABLISHED`, `completeDependencyClosure=false` and `nativeExecution=NOT_RUN`.

The staged directory is intended to be materialized as `content/shell/android/agent_browser_product` in a **new reviewed build input**. Native target generation, Java/C++ compilation, JNI registration and final manifest/resource/ABI/certificate validation are still required. The successful Gradle prototype build does not compile this directory.

## Verification performed and still missing

Observed component checks at this checkpoint:

| Check | Actual result | Scope |
| --- | --- | --- |
| Java core contracts | 228 passed, 0 failed | Real host javac/Java, not Android |
| Node probe contracts | 97 passed, 0 failed/skipped | VM/Worker API fixtures, not Chromium workers |
| Python build-harness contracts | 13 passed | Actual small owned files/process groups; no Gradle/device |
| Source-staging contracts | 12 passed | Actual small owned files and real source selection |
| Selected-source staging | 52 files / 248,197 source bytes; every selected byte read back | Not a compiled artifact |
| Product overlay | Five actual selected-file check/apply/reverse-check commands exited 0 | Four source copies only |
| GN template formatting/syntax | Actual formatter and subsequent dry-run exited 0 | Not GN graph generation |

Deliberate defects in retained test copies were detected with real failing CLI exits: hashing base64 text instead of decoded native input, omitting Worker termination, and omitting staged-source byte readback. The production sources were not mutated by those negative tests.

Still **NOT_RUN / NOT_ESTABLISHED** for this adapter: its real GN graph, native Java/C++ build, final APK/ABI/JNI/manifest/signature checks, install/pull byte equality, dedicated-emulator execution, Java/native freeze association, native Window/Worker values, full network/storage acceptance and a real Ping0 page/screenshot. Native C++ tests and normal/crash/power-loss store durability cannot be replaced by the component results above. No release, real account, production device or official license change is authorized by source staging.

Run the staging tests only inside the existing registered Android build root:

```sh
ABS_ANDROID_STATE_ROOT="$ABS_ANDROID_STATE_ROOT" \
  python3 -B mobile/android/native-kernel/tests/test_stage_product.py -v
```

These tests use their own small retained fixtures in the original build quota; they neither reset nor use the separate, exhausted host-SQLite test sub-budget.
