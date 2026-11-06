# Android native product adapter — installed development APK

## Current checkpoint — 2026-11-05, v5 browser UX and tab overview

V5 adds separate profile/proxy management, grouped profile editing, isolated persistent history tiles, and a Chrome-inspired vertically scrolling two-column tab overview. The toolbar count opens the overview; cards select retained pages, × closes a page, and the header creates one. One profile is active at a time; manual creation is capped at 10 retained Shell/WebContents tabs. Cold tab restoration is not implemented.

Exact development APK: 382838242 bytes, SHA-256 `3dce931073398b9002e6d670f8c8acd58cce5e1a4426697cb3b7ce9ffde5b44a`; staged product source digest `181ae3e88268c84f7ecaf76c18c3a1b824ad606ceccef8cd3cdfc72bd2d1fb2b`. All 65 staged inputs and canonical `product_sources.gni` were verified against the build host; installed base.apk matches. The Chromium base, target and development signer are unchanged.

The real phone reached 10 retained tabs and all nine named web pages through vertical scrolling. Closing a script popup restores the retained page and omnibox URL after giving the root a neutral focus target. Periodic refresh does not reset the overview scroll. Previews are optional and never fabricated: this phone showed an actual NTP preview but local-avatar fallbacks for all nine web cards, so web PixelCopy thumbnails are NOT_ACCEPTED on this device.

This remains a development build, not a commercially accepted fingerprint browser. Persistent cookies across cold restart are a known failure. Native graceful shutdown has an unresolved historical MessagePumpAndroid abort: ESRCH plus a free lifecycle lock proves exit, not crash-free shutdown. Proxy authentication, concurrent profiles, cold tab restoration, full Chromium dependency/source closure, production signing and a full native unit-suite run are not delivered. See `deployment-artifacts/android-native-v5-20261105/TEST-RESULTS.md` from the repository root for exact-APK results; historical checkpoints below must not override it.

## Historical checkpoint — 2026-11-04, v4 native profile languages

This is the native Chromium/content-shell product adapter, not Android System WebView and not the standalone fixed-asset timezone shell. The overall fingerprint-browser goal is **not fully accepted**. Earlier staging/preflight notes below are historical and must not override this checkpoint.

### Built and observed

- Chromium `152.0.7977.72`, pinned upstream `026bb13a93d60e7adfefa2bbf58d6f57c2d335cc`, with the Roxy patch series (through 0057) and product overlays. Audited patched base HEAD: `3f1de50fc81dd33dae9e115c57f6a8b5565d6a21`.
- Target `//content/shell/android:agent_browser_product_apk`; package `com.ahoo.abs.android.native_product.preview`; real Android 16 arm64 PKG110 phone. APK is 382730951 bytes, SHA-256 `d93930c39df3958da5833245fdab62fe57426fa420958b50160ec61b9aeb55b1`. Installed `base.apk` SHA-256 independently matched.
- APK v2 signature verification passed; signer certificate SHA-256 `32a2fc74d731105859e5a85df16d95f102d85b22099b8064c5d8915c61dad1e0`. This remains development/test signing, not production signing/licensing integration.
- Fullscreen browser chrome with up to 10 retained Shell/WebContents tabs, one active profile. Switching back to the original HK tab retained its document nonce; controlled origin saw only one initial GET. Cold tab restoration is not claimed.
- Product-fixed proxy configuration is installed in NetworkContext, with strict HTTP/HTTPS/SOCKS5 host+port syntax and exactly `<-loopback>` bypass. No DIRECT fallback, PAC, system proxy, or authenticated proxy support. On this final APK an unbound Mac port 18999 returned `ERR_PROXY_CONNECTION_FAILED`; the fresh controlled-origin URL received zero requests. This is a controlled fail-closed regression, not a proof about all DNS/UDP/WebRTC traffic.
- HK Window, Dedicated, nested Dedicated, Shared and Service Worker probes reported `Asia/Hong_Kong`, `zh-HK`, `["zh-HK","en-US"]`; request Accept-Language was `zh-HK,en-US`. US Window/worker probes used `America/Los_Angeles` and `["en-US"]`. Native Android/mobile Chrome identity is used, not injected JS or Chrome/999. Secure JS UAData reported Android/mobile/full Chrome 152; HTTP UA-CH headers were not observed and are not claimed.
- Real process death was checked by ESRCH plus an obtainable lifecycle lock. Original HK localStorage survived cold exit and profile switching; a new US profile initially saw neither HK localStorage nor HK cookie and wrote its own synthetic marker. On returning to HK its own localStorage remained, not the US marker.

### Proxy comparison on the same installed APK

Original HK entrance `HTTP 192.168.4.100:7890`: Ping0 completed 166/166, score 62, four anomalies (DNS country mismatch, IDC, RAF, cross-country exits).

Existing sibling `../v2ray` gateway `ai` entrance `HTTP 192.168.4.100:20080`: both Mac HTTPS targets and the Android browser returned US `204.0.23.126` (Los Angeles, AS2914 NTT America). In independent profile `env-us-gateway`, timezone `America/Los_Angeles`, language `en-US`, Ping0 completed twice at **90/100, 166/166, two anomalies**, site label “安全”. Multi-target exits were the same US IP and the prior IDC/cross-country anomalies were absent. DNS still reported CN; RAF was 228.74 ms initially and 176.48 ms on the final foreground rerun. The site's residential classification is not an independent certification of residential service.

The gateway process/policy/subscriptions were not changed or restarted. `auto`/`video` entrances independently showed heterogeneous country exits; `ai-p4` had a TLS failure on one target. Original HK and verify-a profiles were preserved. Final phone browser is on the US 20080 profile; Android global proxy remains `:0`, ADB reverse tcp:7891 remains intact. This LAN gateway requires the phone to be able to reach the Mac; the APK does not embed proxy credentials/configuration.

### Failed / incomplete acceptance — do not hide these

1. **Persistent Cookie cold-start test FAILED.** Live served fixture HTML was checked and included `Max-Age=604800`; HK cookie was present before exit and empty after cold reload, despite its localStorage surviving. Source review confirms that shell NetworkContext parameters never configure a persistent cookie database (`NetworkContextFilePaths.data_directory` / `cookie_database_name`). Merely having a BrowserContext profile directory is insufficient. This has NOT been fixed in v4. Do not claim account/login persistence or complete durable web storage.
2. DNS-country mismatch remains on the alternate proxy; browser-vs-gateway/resolver attribution is not established. No complete DNS/UDP/WebRTC leak-free claim.
3. Foreground RAF interval remains nonstandard; cause unresolved. Do not dismiss it only as background throttling.
4. Reviewed MEDIUM tab bug: native/scripted closure of the active tab can clear the active Shell without selecting a retained replacement. Explicit UI close selects a replacement, but native popup closure is not repaired in this APK. Manual tab selection can recover retained tabs.
5. Native proxy unit-test object compiled, but the full test binary was not linked/run. Final staging tests passed 14/14. Build completed with overall exit 0, but ErrorProne emitted warnings/asynchronous failed analysis stamps; this is not an analyzer-clean build.
6. Authentication, full storage/database durability, independent device fingerprints, Canvas/WebGL/Audio spoofing, production signing, and complete clean-room dependency closure remain unsupported or unverified.

### Reproduction / evidence scope

The delivery contains the exact staged input archive/manifest (56 files; source SHA-256 `fcedb05f3e7a7a67ea90fc0bec34c5d2aa8cac04be788c7a8fb08f3269f8b221`), current product source and overlays, edited native snapshots, actual GN args, successful build/object logs, test results, runtime JSON/XML and target-app screenshots. Start with the pinned Chromium+DEPS checkout and Roxy 57-patch base, stage the product inputs using `tools/stage_product.py`, then apply the exact product bootstrap, retained-tab, language, and policy-test overlays. The included complete edited snapshots are authoritative checks for the overlay chain; do not silently tolerate patch fuzz or skipped paths. Generate with the included args and run `autoninja -C out/abs-timezone-newyork -j4 agent_browser_product_apk` from the Chromium src directory.

The manifest is input identity, not an execution certificate: it intentionally retains `completeDependencyClosure=false`, `fullUpstreamIdentity=NOT_ESTABLISHED`, `nativeExecution=NOT_RUN`. Separate build/runtime evidence records what was actually executed. This bundle is NOT a full Chromium checkout/SDK/DEPS archive and does not establish byte-reproducible APK output. No gateway subscription, node passwords, controller secrets, personal browser data, or device profile databases are included.

---

## Historical staging and preflight notes (superseded where contradicted above)

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


## 2026-11-04 runtime checkpoint (product adapter)

The product adapter target `//content/shell/android:agent_browser_product_apk` has now been **built and executed on a real Android 16 arm64 phone** (PKG110): `AgentBrowserProduct.apk` SHA256 `6c0fe15b…`, package `com.ahoo.abs.android.native_product.preview`. Launch handshake, native library load, renderer sandbox, and timezone preflight all passed: Java `frozen=1` and renderer `applied=1` share digest `ecc308f9…` with `canonical_timezone=America/New_York`, and Window/Worker 1/Worker 2 all report `America/New_York · offset=300` while the device timezone is `Asia/Shanghai`. Ordinary browsing remains closed by design in this preview candidate; release signing, Ping0/network/storage acceptance are still NOT_RUN. Four Android-16 compatibility adaptations were required and are recorded in `build-recovery/evidence/device-verify-product/product-apk-acceptance.json`.
