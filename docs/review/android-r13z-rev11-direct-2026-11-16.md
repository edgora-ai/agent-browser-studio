# Android r13z rev11 — explicit optional proxy / direct connection

## Current status

**Native candidate built, original-signature verified and update-installed without clearing data; targeted direct-mode phone checks passed, including live HTTP interaction and public HTTPS rendering.** This is native Chromium/Shell/WebContents, not a System WebView routing change. No release or push is authorized or performed.

## Behavior contract

- Creating an environment no longer requires a proxy catalog entry. New environments visibly default to **不使用代理（直连）**. Existing proxied environments retain their selected endpoint; they are never automatically converted.
- Direct means the device's current network, including a system VPN if present, and exposes that network's public IP. It provides no proxy isolation or anonymity guarantee. It does not bypass a VPN or replace system network settings.
- Unchecking direct without choosing a proxy is an inline validation failure, not implicit direct. Choosing a managed proxy unchecks direct; reverting restores the original route. Dirty/cancel/error/retry semantics are retained.
- Direct save is explicit and transactional: clear only this profile's credential envelope, unlink its managed proxy, serialize an explicit JSON `"proxy": null`, and preserve existing CAS/inactive checks. Missing/malformed proxy JSON or a missing/mismatched catalog link does not imply direct.
- `ProxySpec` remains a strict real HTTP/HTTPS/SOCKS5 endpoint. Direct is not a fake proxy endpoint, proxy fallback, PAC, auto-detect or inherited system-proxy configuration.
- Native startup uses an explicit `agent-browser-product-network-mode=direct` switch, the product marker, immutable direct NetworkContext configuration and the normal resolver path. Missing mode still requires the original strict proxy configuration. Invalid mode, competing proxy controls or stale direct DNS controls fail closed.
- Proxy mode retains its exact parser, one-proxy/no-DIRECT-fallback policy and proxy-local-DNS-deny overlay. Existing debugging, sandbox, certificate, permission, QUIC and WebRTC restrictions are not relaxed.
- Existing proxied fingerprint streams remain unchanged. Direct uses a separate `abs.profile.direct.v1` domain and remains honestly UNVERIFIED (`DIRECT_CONNECTION_UNPROTECTED`), not a verified anonymity profile.
- Database version 3 makes the 2→3 transition a no-rewrite semantic fence; 1→3 retains the existing catalog import. The historical WebView verification adapter rejects direct instead of creating an alternate networking implementation.

## Frozen production inputs

- Baseline HEAD: `e41057db4dd84cf85b931291de9d963c462dc806`, plus reviewed dirty production inputs.
- Exact selected-source manifest: `.tmp-apk/proxy-fix-work/v13z-rev11-tests/approved-selected-source-freeze-rev11.json`.
- Manifest-file SHA-256: `dd0f21cbb6f44083f9daa7c8a2fba12cd0846459dd063d298aaa7f8e92dadd3d`.
- Source selection: **77 files / 738107 bytes**, source SHA-256 `c70eb0d2b1c7d249e8005dbbfdd13859f340697c34194e3b37d6a91c076ddc65`; 17 explicitly approved changed selected paths, no new selected paths.
- Effective C++ policy after product DNS overlay then patch 0063: `1b0dfa19da0f5f6feaea8df7d3cf6f0df500fa2c4837010335ffaa9d3c91c835`.
- Effective C++ unit source: `03e80d96322e9c87356eeec00674995d6e7ec1e9024d20bb77328d18dfb2d129`.
- Rev10 persistent-renderer fix retained unchanged: product Java patch SHA-256 `dd777f002392b7ad89dee96a3d4f3b3bde80329546f938312ef028adaf21867b`.

## Verification before Android build

- Six focused UI source contracts passed; independent read-only UI/lifecycle review found no specific blocking defect. These are not Android layout or interaction proof.
- Executed with JDK 17: CoreContractTest **228**, DirectProfileContractTest **31**, MonitorContractTest **517** checks passed, including six exact legacy fingerprint vectors.
- DirectStorageContractTest **94** executable checks passed against actual production ProfileCodec/repository/core, explicit host Android/JSON doubles and real SQLite via a stdio-only Python adapter. Covered strict direct JSON, CAS, direct↔proxy/reopen/copy, credential KEEP/CLEAR and rollback, multi-profile endpoint updates, missing-link rejection, unchanged full v2 tables, v1 import, and direct publish→claim. This is not AndroidKeyStore, Android SQLite concurrency or device proof.
- Fresh registered bounded source-stage suite **18/18** passed, including strict `-F0` forward/reverse DNS→0063 composition and byte-for-byte restoration. An earlier insufficient-headroom attempt and overlay-context failure are superseded by the fresh-root successful run, not hidden or counted as acceptance.

- Existing storage cleanup **126** checks and original SQL/static **62** checks passed. The complete native-history host suite passed, including **685** UI source contracts and **760** added checks executing real Java network freeze/verify method bodies with real core types plus explicit host CommandLine/Context doubles. These do not execute Chromium networking.

## Candidate and device evidence

- Candidate: `.tmp-apk/proxy-fix-work/v13z-rev11/ABS-Browser-v1.0.0-r13z-rev11-arm64-release-candidate.apk`, **372355843 bytes**, SHA-256 `3e071863ee44fc85fd180970b7950a175f02aa29d26688dd7d49f18ab0e90997`.
- Package `com.ahoo.abs.browser`, ARM64, non-debuggable; original certificate SHA-256 `0f186dd70f80892e04443b7105842eef2ac9e641e9ecefa15015158317f1402f`. Lead independently ran `apksigner verify --verbose --print-certs` successfully.
- Actual same-run Ninja evidence: policy CXX `[9/24]`, product native SOLINK `[16/23]`, standalone policy-unit CXX `[23/23]`; exit 0. The unit object was **compiled, not linked as a test suite or executed**.
- Packaged native library SHA-256 `0cab3e92d4c385c31dbb13b6c27c3d664365a4e139783c306cdd6776c56382de`, byte-equal to the new native build output and different from rev10. Lead independently verified all three packaged native libraries against the build receipt.
- Exact pre/post guard **96/96**, ErrorProne/dependency analysis finished without failures. Builder evidence: `candidate-build-receipt-rev11.json`, `native-execution-receipt-rev11.json`, `postbuild-guard-rev11.log`, `analysis-receipt-rev11.json`, `build-rev11.log` in the ignored candidate directory. No engine-source/Java or GN-argument changes.
- Phone **69a2181d / PKG110 / Android 16 (SDK 36)**: authorized `adb install -r` returned `Success` at 20:09 on 2026-11-16. Installed base APK SHA-256 independently matches the candidate. No data clear, force-stop or process-termination command was used. The user explicitly authorized closing the currently unsaved 本地 form before this update.
- Device receipts and bounded UI action/screenshot evidence are in ignored `.tmp-apk/proxy-fix-work/v13z-rev11-device-20261116/`. The first new-editor attempt was interrupted by a foreign foreground app before any save. The Lead stopped, reviewed, then resumed once through the normal launcher. This next resume visibly reported no active environment; no exit/switch action was dispatched. Targeted editor/persistence/startup, owned HTTP interaction and public HTTPS observations are recorded below.

Phone checks may use only newly created, causally owned environments/tabs. The previously active UI-Demo and unknown tabs must not be stopped, switched away from, inspected or closed for this test. An authorized no-data-clear update may naturally end the old process; only normal reconciliation proving old-PID ESRCH plus a free lifecycle lock may clear its active record. If it remains active, native direct launch stays untested rather than forcing a switch.

The initial bounded plan allowed up to two fresh owned environments. The Lead deliberately narrowed the actual phone run to one owned D profile, direct/error/restore/save/reopen and route transitions, one owned HTTP fixture and one ordinary public HTTPS navigation. Copy/cancel/search and a second profile were omitted; they are not phone passes. Loopback is not DNS proof; public HTTPS success is not proof of exact DNS transport, VPN absence or complete leak prevention. No device network, DNS, VPN, certificate or daily-profile setting changes are part of this work.


## Targeted physical-phone observations

- Evidence root: `.tmp-apk/proxy-fix-work/v13z-rev11-device-20261116/`; nonce `01b96534bec94a6c947c05d3f58c6901`, causal actions in `lead-events.jsonl`. After USB disconnected, the already-paired wireless transport was reverified as raw serial **69a2181d**, PKG110, SDK36, viewport1080×2376. No pairing/network/VPN/device-setting change was made.
- Only one new owned profile: **R11D_01b96534bec9**, UUID **0609bb07-eaf4-4f39-8206-7874e957d811**. Absence → exact save dispatch → fresh summary UUID was journaled before ownership was claimed (seq23). Baseline five saved profiles/three proxies were not edited; profile count became six.
- New editor defaulted to checked **不使用代理（直连）**, with the device/VPN/public-IP warning visible. Unchecked direct + valid name + no endpoint: Save stayed in the editor and showed **请选择代理，或启用“不使用代理（直连）”**. Validation scrolled to the error, causing the original name-visible test guard to stop. A reviewed, form-only scroll restored the top; no false save or blind retry was claimed.
- **恢复原网络设置** restored direct. Save → summary → reopen retained checked direct (seq28). Selecting the existing **QA-Local · HTTP 127.0.0.1:7890（2 个环境使用）** unchecked direct. Save → reopen retained the exact endpoint/unchecked state (seq35). Checking direct → Save → fresh summary restored direct on the **same UUID** (seq41). This proves route persistence, not successful proxied traffic or AndroidKeyStore credential erasure.
- With freshly empty manager runtime state and no browser child process, an ordinary D-card tap followed the normal launch/lock path. NativeBrowserActivity, fresh browser **PID26339 / startTicks6291933**, one blank initial tab and owned-profile home were observed (seq45–46). Subsequent actions freshly required the same foreground/component, PID/startTicks and one-tab counter. No foreign runtime/tab was switched, stopped, adopted or inspected.
- **Live HTTP:** allocated unused reverse **48071→58552** with `--no-rebind` only after recording its prior absence. Entered/read back `http://127.0.0.1:48071/01b96534bec94a6c947c05d3f58c6901/` in that owned native tab. Real page title/nonce and **DIRECT_CHECK** rendered; tapping it changed DOM to **DIRECT_CLICK_OK** and the owned loopback server logged the exact `/clicked` request with HTTP200 (seq47–53). This is a real native-render/input/network observation, not mock DOM; loopback is not DNS proof.
- **Public HTTPS:** navigated that same tab once to `https://example.com/?abs_rev11=01b96534bec94a6c947c05d3f58c6901`. The first immediate snapshot still showed the old HTTP document while navigation was pending. The later document had the current multilingual example.com notice, not the test's historical literal **Example Domain** heading. The prior heading expectation was recorded as not passed (seq58), then explicitly reviewed (seq59): fresh exact HTTPS URL, actual full English/Chinese body and unchanged owned runtime establish rendering (seq60–61). **No second navigation/network retry** or production-code change was used to hide that expectation mismatch. No external HTTP status, exact DNS transport, absence of VPN or leak-free claim is inferred.
- Lead visually inspected the actual `new-direct-default.png`, `missing-route-error.png`, `saved-direct-summary.png`, `direct-http-live.png` and `direct-https-live.png`. The direct option/warning/error, pinned actions, wrapping summary UUID, HTTP response and HTTPS body were visible. Test-page nonce overflow and long address-field horizontal scroll are not a full responsive/visual/security-origin-chrome acceptance pass.
- Cleanup: the exact this-run-owned **48071→58552** reverse was removed and its absence verified (seq62); no unrelated mapping was removed. The loopback fixture PID87796 received only its managed job cancellation and logged **stopped**. The phone remains in the owned D environment on the public HTTPS page; no daily profile/tab cleanup was attempted.

## Acceptance boundaries

This closes the specific **proxy selection is mandatory** defect across UI, storage and actual native Chromium, with bounded physical-phone evidence. It is **not** full product/visual/accessibility/performance/tab-lifecycle acceptance, device credential KEEP/CLEAR acceptance, complete Android SQLite migration/concurrency proof, or execution of the C++ unit suite. The existing rev10 renderer fix remains in the exact selected inputs; its entire matrix was not rerun. No push/public release occurred.
