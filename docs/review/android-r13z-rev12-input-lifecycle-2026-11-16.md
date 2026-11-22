# Android r13z rev12 — preserve Viz input support across tab reattachment

## Status

**The compiled, signed native rev12 candidate was installed over rev11 on 2026-11-17 at 08:17:02 +08:00, following the explicit user request “覆盖安装”.** Host regressions and artifact verification passed. The upgrade used `adb install -r --no-incremental`, without uninstalling or clearing data. Installed APK bytes match the verified candidate; package UID, data directory and first-install timestamp are unchanged. Three-tab runtime acceptance remains **NOT_RUN**. No commit, push or publication is claimed.

This is Chromium Android Content Shell/WebContents and Viz input, **not System WebView**. A source/control-flow regression or successful native build is not a three-tab physical-phone pass.

## What the phone evidence establishes

At **2026-11-16 23:00:55.795 +08:00**, PID **13369**, thread **13429 / VizCompositorTh**, aborted with SIGABRT:

```
FATAL:components/input/render_input_router.cc:718
DCHECK failed: !is_in_gesture_scroll_[static_cast<int>(
    gesture_event.SourceDevice())] || gsb_filtered_for_paint_holding_.
kGestureScrollBegin should not be sent again when kTouchscreen is in gesture scroll
```

The process-death events and replacement privileged child (PID **19407**, started **23:00:56.572**) agree with the native fatal event. This is stronger evidence than guessing at Java scroll/focus or the website. It is consistent with a broken input sequence and subsequent shared rendering interruption, but **does not independently prove why the recovered rendering remained stale**, or which exact tab/gesture triggered this instance.

Evidence, privately retained with URL/credential redaction, is under `.tmp-apk/proxy-fix-work/v13z-rev12-freeze-20261116.66e4986faecb/`. Relevant files: `native-crash-reporters-redacted.log`, `package-process-events.log`, `crashed-child-13369-redacted.log`, and `input-source/` with SHA-256 provenance manifests. Rolled buffers and unusable SurfaceFlinger timing samples are not treated as frame-progress proof. No screenshots, UI hierarchy dumps, daily-tab gestures, process kills, network changes or data clearing were used for this investigation.

## Source-proven lifecycle defect

The captured native source is from `ahoo@192.168.4.12:/home/ahoo/abs-native-work/chromium-build-152/src`, Chromium HEAD `3f1de50fc81dd33dae9e115c57f6a8b5565d6a21`. Relevant files are existing overlay payloads, some untracked there; **HEAD alone is not their provenance**. Exact captured bytes and the reviewed old-to-new SHA values bind the patch.

1. `RenderWidgetHostViewAndroid::OnDetachedFromWindow()` calls `OnDetachCompositor()`; the delegated frame host removes its child frame sink. Reattachment adds it again. `ui/android/delegated_frame_host_android.cc:405-434` and `content/browser/renderer_host/compositor_impl_android.cc:667-685` connect those operations to frame-sink hierarchy registration/unregistration.
2. `InputManager::OnUnregisteredFrameSinkHierarchy()` leaves support intact when parent count becomes **zero**. `OnRegisteredFrameSinkHierarchy()` recreates support when the first parent is added again.
3. `RecreateRenderInputRouterSupport()` retains the same `RenderInputRouter` (RIR) but destroys/recreates its view support. For top-level Android support this also shuts down the old filtered gesture provider. The RIR's touchscreen scroll latch is **not** reset by `SetView(nullptr)`.
4. Old support destruction also removes pending root-view touch ACK entries/targets in the page input router. Pending gesture completion can therefore be discarded while the surviving RIR is still in scroll. A fresh provider can produce a new scroll begin against that old state.

This is a concrete state-lifetime mismatch that can reach the observed assertion. **The captured incident did not contain the hierarchy/gesture trace needed to establish that this was its unique causal trigger.** The patch addresses the demonstrated lifecycle defect, not every possible cause of the assertion.

## Narrow fix

Canonical patch: `mobile/android/native-kernel/chromium/product-input-lifecycle.patch`. It is explicitly selected as the **78th product input**, destination `chromium/product-input-lifecycle.patch`; it is not an unselected numbered patch or a Java-only repack.

`InputManager::RecreateRenderInputRouterSupport()` returns without replacement **only** when an existing non-child Android support is still being attached directly under a root sink. It preserves the same support, filtered gesture provider, ACK ownership and transfer weak pointers together with the same RIR.

- Root/parent lookup, hit-test query, coordinates, device scale and viewport are dynamically derived. FrameSinkId registration maps the same stable ID to the same support; no refresh is required for this case. Mobile-optimization updates have an independent existing notification path.
- **Root-to-child, child-to-root and child-to-child retain the existing reconstruction path.** Child helpers cache bubbling state; blindly reusing every same-kind support would be a broader, unreviewed change.
- Root recreation/promotion logic is unchanged. The native assertion is retained. Patch 0064, Java tab rendering, DNS/network policy, GN arguments and feature flags are not changed.
- A proposed hide-time cancel/reset-only fix was rejected: delayed transfer or touch ACKs can outlive reset, and pending fling-start ACKs can reopen scroll. It was not shipped as this fix.

The top-level Chromium patchset inventory already lags patches 0059–0064. This work does not silently repair that unrelated inventory or replay the global patch chain; it uses the exact selected product overlay and guarded effective rev11 baseline. Patch 0051 is unchanged.

## Verification and acceptance boundaries

- Independent source review approved the **Android-root-only** reuse branch and rejected a general child-to-child reuse expansion.
- Fresh bounded source-stage suite: **18/18 passed**, including exact selected-patch metadata, DNS→0063 no-fuzz forward/reverse restoration, security/packaging selection, filesystem identity/readback and path rejection. The first wrapper attempt lacked the required `tests/` parent and exited before any test; the retained successful run created that parent explicitly. This is host/synthetic staging proof, not native or phone execution.
- Exact production-method host regressions were **compiled and executed** with Clang C++17, warnings-as-errors, AddressSanitizer and UndefinedBehaviorSanitizer: baseline **6 PASS / 5 expected FAIL**, patched **11 PASS**, no sanitizer diagnostics. The method is extracted from the canonical patch; the direct-oldest-parent stub was checked against the captured real API. This remains **CONTROL_FLOW_ONLY**, not real gesture/ACK execution. Receipt: `.tmp-apk/proxy-fix-work/v13z-rev12-host-test/run-3jmg_i5p/result.json`. Reproduction: `python3 -B mobile/android/native-kernel/tests/native-input/run_control_flow.py --run --cxx clang++ --sanitize`.
- Complete canonical **two-target** patch was actually forward/reverse applied with `patch -p1 -F0`; both full source snapshots matched the approved new hashes and reverse restored both exact old byte sequences. Receipt: `.tmp-apk/proxy-fix-work/v13z-rev12-lead/patch-roundtrip-receipt-rev12.json`.
- Five real Android `AndroidFrameSinkManagerTest` lifecycle regressions were added: three independent tabs over 30 reattach rounds, old-root destruction/new-root creation, dual-root oldest-parent removal, actual root/child type transitions, and child-to-child reconstruction. They use actual support weak pointers, RIR/provider identities and, for repeated reattachment, an unacknowledged real provider DOWN. They **compiled successfully as the Android ARM64 test object**, but the test executable/suite was **not built or run**. Disabled/unsupported InputOnViz cases explicitly skip, not pass.
- Actual native build log proves production CXX, service archive creation, main SOLINK, native-test CXX and APK creation. The production object, test object and main stripped/unstripped ELF were hashed; the production object's link chain reaches the packaged main ELF. Unit-object compilation is **not C++ test-suite execution**.
- Final 78-input selected manifest has SHA-256 `4a1836db8fe8c3023be516eafb41078767f56e0192666b6f8a95a80eda97e812`; all **77 previous rows are unchanged**. Canonical patch SHA-256: `19f2a79158a852d6b6f66f8446b00ddc22693b992af5e81c14f55bb2872c0881`.
- Runtime acceptance remains **NOT_RUN** until the new candidate is installed without data loss and a causally owned three-tab drag/fling/switch sequence demonstrates continued scrolling and frame progress. Existing unknown tabs must not be adopted or manipulated as test fixtures.

## Artifact and build receipt

Candidate: `.tmp-apk/proxy-fix-work/v13z-rev12-native/ABS-Browser-v1.0.0-r13z-rev12-arm64-release-candidate.apk`

| Property | Verified value |
|---|---|
| Package | `com.ahoo.abs.browser` |
| Size | 372,355,843 bytes |
| APK SHA-256 | `e41060ad99b1c70fd3c060182c06c18963f44efacc0bd289447d1fa132757386` |
| Original release certificate SHA-256 | `0f186dd70f80892e04443b7105842eef2ac9e641e9ecefa15015158317f1402f` |
| Packaged main ELF SHA-256 | `6687cb2820650e5a9c22b312914a0bab1fc55c94780fe73ddff15bf8dd357c0a` |
| Debuggable | false; release manifest checked |
| Runtime acceptance | **NOT_RUN** |

Actual build steps (not a Ninja dry run):

```text
[1/5] CXX obj/components/viz/service/service/input_manager.o
[2/5] AR obj/components/viz/service/libservice.a
[3/5] SOLINK ./libagent_browser_product.so
[4/5] CXX obj/components/viz/service/unit_tests/frame_sink_manager_unittest.o
[5/5] ACTION //content/shell/android:agent_browser_product_apk__create(//build/toolchain/android:android_clang_arm64)
```

The signed and unsigned APKs have identical non-signature ZIP payload bytes. Relative to the approved signed rev11 APK, **only `lib/arm64-v8a/libagent_browser_product.so` changes** outside signature metadata. All non-native payloads, including the Android manifest and Java bytecode, are byte-identical; the other two native libraries are unchanged. All three libraries remain uncompressed and 16 KiB aligned. The signed APK was verified against the original release certificate; signing was local and did not alter the unsigned input. No key material was transferred.

Build execution staged exactly four remote files: production source, native test source, selected product patch, selected-source manifest. Guards verified the effective rev11 DNS policy and left the already-stopped legacy worker tree untouched; no Java, GN, feature or RIR-assertion change was staged.

Private receipts under `.tmp-apk/proxy-fix-work/v13z-rev12-native/`: `approved-freeze-rev12.json`, `preparation-receipt-rev12.json`, `prebuild-guard-rev12.json`, `stage-rev12.json`, `build-rev12.log`, `postbuild-guard-rev12.json`, `native-execution-receipt-rev12.json`, `unsigned-build-receipt-rev12.json`, `signature-receipt-rev12.json` and `candidate-build-receipt-rev12.json`.

**Safe validation boundary:** installation is now authorized and completed; the earlier in-memory failure state is no longer claimed to be untouched by package replacement. No explicit force-stop, data clearing, uninstallation, app launch, tab switching or daily-tab gestures were issued. Successful installation and exact-byte verification are not a three-tab runtime pass or proof that this patch is the uniquely proven cause of the captured incident. No runtime QA is assigned to the user by this report.


## Authorized overwrite-install receipt — 2026-11-17

- Device: PKG110, hardware serial `69a2181d`; user 0.
- Package: `com.ahoo.abs.browser`; package UID remains 10629.
- Installer returned **Success**; phone APK SHA-256 is `e41060ad99b1c70fd3c060182c06c18963f44efacc0bd289447d1fa132757386`, exactly matching the certificate-verified rev12 candidate.
- Package data directory and original first-install time (`2026-11-05 21:35:16`) are unchanged. No uninstall/clear-data command was used.
- VersionName/versionCode remain `1.0.0`/`10000`; revision identity is proven by the changed installed APK hash, not those unchanged version labels.
- Private install/preflight/verification receipts: `.tmp-apk/proxy-fix-work/v13z-rev12-native/install-rev12-20261117-1rcyor3r/`.
- App launch and three-tab behavioral acceptance: **NOT_RUN**.
