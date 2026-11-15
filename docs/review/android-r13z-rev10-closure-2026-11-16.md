# Android r13z rev10 — persistent renderer and targeted phone checkpoint

## Status and artifact

**Targeted owned-tab runtime pass; not a fully accepted or published product release.** The package remains native Chromium/Shell/WebContents with Java product UI, not Android System WebView. Rev8 and rev9 were installed and rejected for startup crashes; they are not successful runtime checkpoints.

- Product-source commit: `cde901d9087bc8e59accfd2dc5759d1bb88553d9`.
- Package: `com.ahoo.abs.browser`, version `1.0.0`, ARM64, non-debuggable, original release signer.
- Repository-relative APK: `.tmp-apk/proxy-fix-work/v13z-rev10/ABS-Browser-v1.0.0-r13z-rev10-arm64-release-candidate.apk`.
- Size: **372359928 bytes**; SHA-256: `7d3c0c32396b0f70b490c35b9a09424c95cf358768d47bb3305e73f063cfc585`.
- Certificate SHA-256: `0f186dd70f80892e04443b7105842eef2ac9e641e9ecefa15015158317f1402f`.
- Update installation used `adb install -r --no-incremental` on 2026-11-15; no data clear. Independent verification confirmed that the installed `base.apk` hash equals the candidate hash. Physical-tab checks completed on 2026-11-16, Asia/Shanghai.

Build-only receipts remain immutable historical build evidence, including their pre-runtime `NOT_RUNTIME_ACCEPTED` status. The later device evidence described below supplies the limited runtime result; it does not promote full product acceptance.

## Fix and regressions

A product-opt-in, manager-owned `ContentViewRenderView` remains attached while retained tab layers change. Product Shells suppress the stock Chromium toolbar, including after fullscreen exit; the ABS address/navigation chrome remains. Inactive tabs cache overlay state rather than mutate the active renderer.

Rev8 hit a `Chrome_UIThread` startup fatal. Rev9 fixed early window/attachment ordering but called native `SetOverlayVideoMode()` before `SetCurrentWebContents()` had initialized its compositor, producing a startup SIGSEGV. Rev10 makes the renderer setter store/reset state only. At the existing WebContents bind points it validates live identities, binds WebContents first, rechecks identities/liveness after JNI, then marks readiness and replays the latest overlay. Native destruction clears readiness; stock embedding retains its original bind path without new overlay replay. There is no invented JNI or `setCurrentWebContents(null)` unbinding.

The commit changes the release Java patch and two host regression files. The full host suite passed; the strict persistent-renderer regression passed **406 executable checks plus one production-AST relation**, including empty/dead/reentrant/bind-failure cases and stock behavior. Host tests do not prove Android rendering/input. Patch forward/reverse checks passed without fuzz. Fresh product/content-shell Java ErrorProne/dependency analyses completed; no native C++ compilation or linking ran, and all three packaged native libraries match rev9 byte-for-byte.

## Physical-phone operation evidence

Only ordinary product UI was used on PKG110/Android 16. The existing counter baseline was one unowned tab, which was not selected for testing, captured or closed. New A/B ownership was established by this-run menu creation, counter transitions **1 → 2 → 3**, fresh blank addresses and exact fixture-URL navigation; historical page names were not treated as ownership.

The fixed local fixtures retain historical titles `ABS_REV9_20261115_A/B`. Those names identify fixture content, **not the installed APK version**. They generate owned DOM, a two-second JavaScript counter, an increment button, a text input and twenty paragraphs; no cookie or storage read/write is used. The long address was entered in read-back-verified chunks before Enter; an initial incomplete harness submission was recorded and repaired only on the newly owned A tab, not counted as a successful navigation.

Six functional alternations **A → B → A → B → A → B** followed initial input and one button click per page. Every revisit checked the exact active URL, increasing timer, another real button response and the page's retained input:

| Page | Initial click count | Count after three revisits | Preserved value |
| --- | ---: | ---: | --- |
| A | 1 | 4 | `OWNED_REV10_A_DRAFT` |
| B | 1 | 4 | `OWNED_REV10_B_DRAFT` |

Two further A/B selections captured the distinct live pages. A screenshot visibly shows tick **150**, count **4** and its A draft; B shows tick **58**, count **4** and its B draft. Both screenshots were checked before and after capture against the exact owned URL, then actually reviewed. The browser's before/after samples both reported **PID 15185**, with no observed restart; a final own-PID crash-buffer read found no fatal marker. There was no per-switch process sampling, so this does not independently prove uninterrupted browser/renderer process lifetime. This is evidence of continued execution and interaction, not a frame-time benchmark or a general no-crash guarantee.

A bounded B-page swipe moved paragraph 1 from `[72,1387][1008,1621]` to `[72,469][1008,703]`; the reverse gesture restored its initial bounds. The draft and count were retained and browser-chrome bounds stayed unchanged. Refresh was also exercised on owned A while connecting the fixture transport. No force-stop, induced crash, daily-tab close, profile edit or proxy edit was performed.

## Test transport and cleanup

Historical UI-Demo instructions referenced QA-Local port 17891. Read-only inspection of the **current normal settings UI** instead proved UI-Demo uses QA-Local at `127.0.0.1:7890`. The earlier `ERR_PROXY_CONNECTION_FAILED` was therefore not accepted as a tab-switch result. A temporary device-7890 reverse reached a loopback-only guard at host 17892 that allowed only `http://rafqa.test:80` through the unchanged 17890 relay to the existing fixture. A host check confirmed another origin was rejected. No application profile/proxy setting or relay/policy source was changed.

After the checks, only this-run-owned reverses **7890 → 17892** and **17891 → 17890** were removed. The prior **17890 → 17890** reverse was preserved, as were the existing relay and fixture. The managed origin-guard job was stopped. The two newly created test tabs and their drafts remain; no daily or unknown tab was operated or closed.

Machine-local evidence (ignored, not published) is under `.tmp-apk/proxy-fix-work/v13z-rev10-device-20261115/`: install/signature receipts, `session.json`, `owned-ui-events.jsonl`, `session_qa.py`, `owned-A-rev10.png`, `owned-B-rev10.png`, own-PID crash-buffer output, `runtime-receipt-rev10.json` and `owned-route-cleanup-final.json`. Build evidence is under `v13z-rev10/`; host logs and patch poststates are under `v13z-rev10-lead/`.

## UI review and remaining acceptance

The two physical screenshots have the same native back/address/tab-count/menu layout, readable controls and insets, Android status/gesture bars and no duplicate stock Chromium toolbar. Website headings are document content, not another app navigation bar. Overview/history headers are intentional panel navigation; neither panel nor any unowned page was captured.

- **Static/source and build:** verified for the frozen change.
- **G3 / targeted G4 runtime:** ordinary startup, exact navigation, A/B continuity, buttons, drafts, a bounded scroll and screenshot continuity verified on this device.
- **Visual evidence:** actual A/B browser chrome reviewed, not an HTML design mockup. The fixture's colors and cards are not a claimed redesign of the application.
- **G4/G5 still incomplete:** full app-screen/state review, narrow/landscape/large-font and theme matrices, TalkBack, fullscreen/video transitions, frame-time measurement, hidden-tab/Home recovery budgets and natural OS reclaim were not accepted by this run. Source guards do not substitute for these device cases. User aesthetic approval is not implied.

Cold tab restoration, full Chromium/DEPS reproducibility, licensing closure and unrelated earlier product acceptance gaps remain separate work. No Git push, publication or formal release was authorized or performed.
