# Android r13z rev7 — renderer-recovery source checkpoint

Date: 2026-11-15 (Asia/Shanghai). Baseline: rev6 `cdff7cae500a1be1c38038523564706c6be1a57e` on `feat/android-resume-20261027`.

**Status: reviewed source checkpoint; signed/installed candidate; host PASS; device acceptance PARTIAL. Not a published release or a claim that all tab freezes/UI issues are fixed.** This document supersedes preparation-only statements in the local rev7 `HANDOFF.md`; it does not rewrite historical device failures as successes.

## 1. Source scope and behavior

The scoped change is `NativeBrowserActivity.java`, three native-history host tests and the focused `run-recovery-tests.sh` runner. Follow-up reviewed these already-built inputs without modifying them. Two independent read-only reviews found no confirmed source blocker for a checkpoint commit.

- An observer-owned renderer interruption survives old saved-frame `isReady()`, tab hiding and ordinary Activity pause. Owner checks bind generation, observer instance, Shell and WebContents; retired/old callbacks cannot finish another owner's recovery.
- Renderer death clears stale preview/readiness proof. Only an actually committed browser-owned native NTP is renderer-independent. There is **no automatic reload or POST replay**.
- The explicit reload control and menu refresh share one busy gate established before `reload(true)`; Chromium's argument means `checkForRepost`, not cache bypass. The page-area recovery surface leaves address/menu chrome usable.
- Only a fresh matching non-same-document navigation commit, with handle/serial/URL/owner proof followed by valid load-stop or paint/readiness, retires a known interruption. Start, pending URL, abort, error page and stale callbacks are insufficient.
- Retry receives an 8-second **visible foreground** budget. URL rebind within the same visible recovery preserves the deadline. Hiding/pause clears that visible deadline, not the interruption/busy state; still-busy foreground reentry receives a fresh 8-second budget. It is not a remaining-old-budget policy.

The Activity SHA-256 remains `39ca9cf86d31859591c007208b4d01edbd82af2dd9cffa134503e8793c8cd9b9`.

## 2. Candidate identity — build, signing, installation are separate from acceptance

| Item | Verified value |
| --- | --- |
| Package / version / ABI | `com.ahoo.abs.browser` / `1.0.0` / ARM64 |
| Candidate | `.tmp-apk/proxy-fix-work/v13z-rev7/ABS-Browser-v1.0.0-r13z-rev7-arm64-release-candidate.apk` |
| Size | 372,328,420 bytes |
| APK SHA-256 | `34eeb9170431505788dc7f264fe54190b3d46f8969b059b41167beacdc67de1a` |
| Release certificate SHA-256 | `0f186dd70f80892e04443b7105842eef2ac9e641e9ecefa15015158317f1402f` |
| Build properties | non-debuggable, original release certificate, verified V3/RSA4096 signing |
| Device | OnePlus PKG110, Android 16 |

The historical installation receipt records update installation at 12:51:48 +08:00 on 2026-11-15, without uninstall/clear-data/debug changes. Follow-up independently read and hashed the **installed** base APK and checked package version/non-debuggable metadata; it matches the candidate above. Follow-up did not rebuild or reinstall.

Local receipts under `.tmp-apk/proxy-fix-work/v13z-rev7/`:

- `candidate-build-receipt-rev7.json`: `SIGNED_R13Z_REV7_CANDIDATE_NOT_RUNTIME_ACCEPTED`.
- `analysis-receipt-rev7.json`: build UUID `4714d2d8-bcca-4c04-ac62-416f43d40be7`, dependency validation/ErrorProne complete, rejected list empty.
- `signing-receipt-rev7.json`: signing/release-manifest verification.
- `reviewed-build-inputs.json`: 7 source pins + 15 host pins. All 22 matched before/after the fresh follow-up tests and matched the reviewed build inputs.

These receipts/artifacts are local ignored evidence, not a checked-in reproducible Chromium distribution.

## 3. Fresh host regression results

All four commands were rerun under JDK 17 during this follow-up and returned exit 0:

| Command (repository-relative) | Fresh result |
| --- | --- |
| `bash mobile/android/native-kernel/tests/native-history/run-tests.sh` | PASS: history 274; UI source contracts 656; profile seeds 13; lifecycle 262; focus 437 + 17 source contracts; palette 47; overview 369; system bars 1,976; font scale 1,011; recovery/preview 383; 10 recovery mutants rejected |
| `bash mobile/android/native-kernel/tests/native-history/run-newtab-tile-tests.sh` | PASS: 263,775 assertions; 108 cases / 540 constrained states; 24 empty cases / 120 states; 16 mutants rejected; source unchanged |
| `bash mobile/android/native-kernel/tests/native-history/run-recovery-tests.sh` | PASS: 656 UI contracts; 437 focus + 17 contracts; 383 recovery/preview checks; 10 mutants rejected |
| `python3 -B mobile/android/app/src/test/contract-cleanup/run_launch_contracts.py <fresh-absolute-output>` | PASS: 213 launch-coordinator checks |

Evidence directory: `.tmp-apk/proxy-fix-work/v13z-rev7-followup-20261115.VCNJym/` (`suite-1.log`, `suite-2.log`, `focused.log`, `launch-contracts.log`, `inputs-before.json`, `host-receipt.json`, `installed-identity-followup.json`). The NTP runner's unique generated output is `.tmp-apk/proxy-fix-work/v13j-font-tests/tests.xVlR8q/`.

**Boundary:** source extraction/fake Android/Chromium objects, fake clocks and simplified chrome-refresh seams do not prove real renderer callbacks, Activity/visibility integration, precise device timing, pixels, accessibility or visual quality. Assertion/mutant counts are not device acceptance scores.

## 4. Existing controlled device evidence and what is still incomplete

Historical evidence: `.tmp-apk/proxy-fix-work/v13z-rev7/device-rev7-loss-20261115/`.

| Subcase | Evidence status |
| --- | --- |
| Six A/B live tab switches | Existing PASS; controlled QA documents/click counters |
| Foreground B controlled renderer crash | Existing PASS: explicit interruption feedback, no automatic request, A unaffected; menu refresh produced a fresh clickable B document |
| Inactive A controlled renderer crash | Existing PASS: B remained live; explicit A retry recovered a fresh clickable document |
| Two taps approximately 0.449 seconds apart | Existing PASS: one retry request, not two |
| Foreground retry timeout | Existing observation at approximately 14.812 seconds; not proof of exact 8-second timeout accuracy |
| Busy A hidden behind B for >8 seconds, then foreground reentry | **NOT COMPLETE** |
| Busy A Home/background for >8 seconds, then original-task return | **NOT COMPLETE** |
| Natural OS memory reclaim / long unattended stability | **NOT TESTED by these controlled crashes** |

The crash mechanism was `am crash`, not a natural OS reclaim event. `matrix-final-rev7.json` / the visibility continuation retain `STOPPED_ON_ASSERTION_OR_TOOL_ERROR_REQUIRES_REVIEW`. A missing “返回浏览器” control came from assuming the UI was already in overview when it was on the exact B document; pending replacement titles can also fall back to the exact QA host. These are test-precondition/selector failures, not proven product regressions. Later overview/counter observations during notification interference remain **INCONCLUSIVE**.

The previous interruption receipt confirms owned QA A/B tabs were **not closed** (`qaTabsClosed=0`). It records restoration of reverse `17890→17890`, font scale 1.0 and night=no, and removal of contaminated owned captures. Do not claim device/UI cleanup is finished.

### Authorized foreground handoff and bounded continuation

The **initial** XML-only/no-screenshot preflight refused acquisition because the exact native QA Activity was not focused; it made no UI inputs. After the human explicitly authorized restoring only the existing ABS Browser task, `am task focus 36957` brought that original task forward: **no Intent, URL, new Activity launch or page recreation was requested**. A fresh strict preflight then proved the exact QA B address and its original document token plus displayed tick/click counters. This is ownership/displayed-document evidence, not completion of the recovery matrix.

The local QA helper initially rejected missing frame metadata. This device's ordinary `dumpsys window` omits frames; `dumpsys window -a` supplies a single lowercase `frame=`. The corrected helper accepts exactly one complete `mFrame=` or `frame=` rectangle and keeps the original fixed bounds, UID/type, visibility, noninteractive-panel, native-focus and exact-QA checks. All **14 offline guard controls** passed (8 earlier controls + 6 rectangle compatibility/negative controls); these are harness checks, not product acceptance. Screenshots remain disabled.

| New guarded attempt | Actual outcome |
| --- | --- |
| First matrix attempt | Exactly one tap command targeted the QA B test button, then an unknown visible overlay interrupted the second XML read; its DOM counter increment was not verified and the temporary XML was discarded. No crash command or reverse change was reached. |
| One fresh guarded restart | First guard rejected `native-activity-not-focused`; zero UI inputs. No automatic foreground takeover followed. |
| Hidden-tab/Home busy-budget cases | **Still NOT COMPLETE**; neither attempt reached fault injection/retry or either lifecycle subcase. These stops establish no new Android product defect. |

The uniquely identified localhost fixture was started as a managed job, its response gate was opened during independent cleanup, and only that exact job was stopped/collected. Reverse was never changed and was independently verified as `17890→17890`. All eight generated owned remote XML leaves were independently verified absent. The first outer scratch-cleanup error was a repeated cleanup after the inner XML cleanup had already removed its leaf, not a residual file; the next attempt's cleanup was fully successful. **QA A/B remain unclosed (`qaTabsClosed=0`)** because native foreground ownership was lost. No screenshots, reinstall, clear-data, settings changes or unrelated-tab interactions occurred. All 22 frozen source/host inputs and the candidate APK hash/size still match.

Follow-up evidence in the directory from §3: `authorized-task-restore.json`, `complete-window-preflight.json`, `lifecycle-matrix-cdf5f47b74.json`, `lifecycle-matrix-18dad1ce1c.json`, `matrix-stop-action-audit.json` and `device-followup-resource-receipt.json`; managed fixture job `bash-8195867449924b23` was explicitly stopped and collected. The immediate restore receipt retains its metadata-guard PAUSED result; the later complete-window preflight is the separate successful ownership proof. Do not rewrite either receipt as lifecycle PASS. Metadata-only SystemUI queries are not an authoritative empty heads-up guarantee; the unknown overlay was not identified as a specific notification and no private window/notification contents were logged.

### Renewed quiet handoff: original QA scope no longer proven

After the human selected “continue now” again, the `quiet2` run initially stopped on non-native focus. Metadata proved **one unique existing task 36957** (five references to that same task, not five tasks). With renewed permission, exactly one `am task focus 36957` restored it and the native-focus/window guard passed. However, the subsequent fresh XML could prove **neither an exact QA A/B address nor an owned QA overview**; it was discarded without recording unknown contents. No page click/key input, crash, retry, reverse change, tab closure, URL or new Intent was issued. This does **not** prove the original QA cards were closed/destroyed, nor establish a product defect.

Two prelaunch harness errors were corrected before that scope check: counting duplicate references as separate tasks, and an ad-hoc `runpy` import-path failure (resolved by directly executing the reviewed script). Neither changed product code or performed fault injection. Evidence: `quiet2-owned-task-diagnostic.json`, `quiet2-authorized-task-focus.json`, `lifecycle-matrix-b1c44b4119.json`, `lifecycle-matrix-172e73b2f6.json`, `quiet2-resource-receipt.json`. Gate cleanup passed; exact fixture job `bash-57d34b59edb24ff5` was stopped/collected and localhost 17903 verified closed; all **10** generated owned XML leaves absent; reverse still `17890→17890`; 22 frozen inputs unchanged. Hidden-tab/Home remain **NOT COMPLETE**. A fresh handoff must identify the original QA documents/cards themselves, not merely the ABS application; do not recreate them or navigate unknown content to force progress.

### Missing-B permission: A identified, exclusive QA scope still unavailable

The human reported no visible RECOVERY B, then explicitly allowed **only one missing controlled QA B**, conditional on first verifying original A; no permission to recreate A or disturb other tabs was given. A fresh XML proved original A's exact QA URL. One owned overview tap then revealed three cards: unique known A, one startup-labelled card, and one unrecognized card. No unique reserved B-host binding was established, so no unknown card was selected and no title/content from it was recorded. Both preparations stopped **before** a new-tab command, URL input, temporary reverse or fault. The human subsequently reported manually closing QA residue; a fresh post-action check still found the same *classification counts*. This neither establishes which tab was closed nor proves an Android closure defect.

Evidence in the follow-up directory: `missing-b-preflight.json`, `missing-b-creation.json`, `missing-b-owned-card-counts.json`, `missing-b-reserved-host-binding.json`, `missing-b-creation-quiet4.json`, `missing-b-post-human-card-counts.json`, `missing-b-scope-resource-receipt.json`. The latter independently confirms one owned overview tap, zero keys/text/new tabs/Intents/faults/reverse mutations or automated tab closures; exact fixture jobs `bash-cefa44921001448f` and `bash-3f5c2e056e22481d` stopped/collected; localhost 17903 closed; all **16** generated owned XML leaves absent; reverse `17890→17890`; all 22 pinned inputs and candidate APK hash/bytes unchanged. The prepared lifecycle scripts were **not reached**. Hidden-tab/Home remain **NOT COMPLETE**; do not attribute the original B absence or unresolved extra-card classification to a product bug or user action without evidence. Stop further automatic phone acquisition rather than repeating generic readiness handoffs.

### Offline-only ownership contract hardening — no further phone acquisition

Work continued on the host only. AST extraction of just the historical helper's pure `window_policy` (without importing its device modules) reproduced five unsafe metadata acceptances: Activity component suffix, duplicate UID, duplicate package, duplicate type and type-token suffix. These are **QA-harness defects, not demonstrated Android product defects**. The historical helper/runners and receipts remain unchanged; they are not approved for blind reuse.

A separate opt-in [pure parser and synthetic controls](../../mobile/android/native-kernel/tests/device-qa/README.md) now require exact component/user identity, unique Window order/tokens, unambiguous complete field tokens including empty duplicates, real `fl=` flags, and explicit original-task binding. Task identities are checked for conflicts before package filtering, with repeated same-identity references deduplicated. Unverified OEM edge packages and unsupported dump shapes pause rather than being inferred safe. Card classification returns counts only; familiar titles/hosts and startup labels do not prove native origin, exact URL or ownership.

- **37 synthetic unittest methods PASS**, also under Python `-W error`; final independent read-only review found no confirmed blocker within this declared host-only contract. Review did not independently execute the tests or verify hashes. Initial draft receipts are superseded by `offline-ownership-20261115/reviewed-receipt.json` and `controls-reviewed.log` in the follow-up directory.
- The Java main, new-tab and focused recovery suites were rerun again: all PASS (`offline-ownership-20261115/host/` and `host-receipt.json`). All 22 frozen source/host inputs, candidate APK bytes/hash and historical helper hash remain unchanged.
- This new module is **not connected to any device runner or APK**, has no device/process/network operations, and supplies neither input authorization nor real-device format compatibility evidence. No phone commands, fixtures, fault injection, installation, rebuild, push or publication occurred in this offline work. The last observed card classification remains A1/B0/startup-labelled1/unrecognized1; hidden-tab/Home are still **NOT COMPLETE**, and the reported tab-freeze, visual polish and navigation-bar consistency are not accepted as fixed.

### Host-only audit of the unexecuted lifecycle matrix

The prepared `run_lifecycle_quiet4.py` / `qa_fixture_quiet4.py` were reviewed without importing or running them. The audit preserves historical files/receipts and does not add device evidence. Five future-runner gates remain:

1. **Early busy is not a fresh-eight-second discriminator.** Runner lines 184–190 and 202–212 sample busy within eight seconds of return, then leave A or release its response. They never keep the response gated through a foreground timeout after reentry. A remaining-old-budget or never-expiring implementation could satisfy these observations. Future cases must distinguish fresh from remaining budget using bounded observations, and independently demonstrate timeout/retry reappearance with justified timing uncertainty; late or boundary-straddling tool observations are INCONCLUSIVE, not an exact timer measurement or product failure.
2. **Home command return is not pause proof.** Lines 193–198 dwell after the key command, but only check launcher afterwards. Prove the intended hidden/background state before the current foreground budget expires and before beginning that dwell; a later launcher sample cannot establish the entire preceding interval. Retain an independently verified original-task return, without URL or new Intent.
3. **Request arrival is not document delivery.** Fixture lines 43–49 increment counts before waiting/sending. Isolated AST controls show both a gate timeout/504 and a broken pipe after 200 headers can retain `ΔA=1` without a complete document write. These are limits of the counter, **not full-runner false-PASS reproductions**: the matrix also requires a fresh clickable document. A future fixture should record per-request token/run identity and pending/released/timed-out/write outcome; correlate its response with the actually displayed document, not a counter alone. A completed server write still does not by itself establish a committed/live document.
4. **Cleanup errors must invalidate overall acceptance.** The runner sets PASS before `finally` (line 227); cleanup exceptions only append `cleanup.ERROR` (248–249), while exit classification checks only the earlier status (256–257). Isolated execution of just that AST cleanup loop and terminal check reproduced gate, reverse-drift and scratch failures each preserving PASS/exit 0. All three independent cleanup attempts still occurred; the defect is success aggregation, not skipping those attempts. A future runner must retain subcase results separately and finish non-success if any required cleanup/verification or receipt save fails; preserve externally changed mappings rather than overwriting them.

5. **Asynchronous readiness needs bounded observations.** Opening the gate is not proof that the new document has committed by the next XML dump. Historical `click_live` also requires ticks to advance in the very same observation as a successful click; an isolated synthetic control rejects an unchanged document with the correct click increment but no next 250ms tick yet. Use bounded, independently guarded readiness/tick sampling and classify unavailable timing/tool evidence separately rather than coupling those conditions to one sample.

Local evidence: `round2-lifecycle-audit/ast-cleanup-audit.json` (three controls), `ast-fixture-audit.json` (two controls), `ast-async-audit.json` (one ordering control) in the follow-up directory. Only selected AST statements/methods ran against in-memory fakes; no legacy imports, server, ADB, UI input or fault. The stored missing-B/resource receipts were cross-checked for internal consistency, not re-queried on the phone. Their legacy `nativeStartup` field denotes a startup **label count**, not native/about:blank proof. These are harness/oracle limitations; the matrices were never reached and no Android defect or new device PASS is inferred. Fresh exclusive QA scope remains unproved, so no automatic phone acquisition or historical-runner resume is authorized.

## 5. Safe continuation plan

The latest permission permits only missing B after A reproof; it does not permit changing A, selecting/closing unidentified cards, or routing unrelated pages through the test fixture. Before using the shared temporary reverse, require a freshly verifiable QA-only card set. The last observed set fails that condition. Any future continuation needs that scope problem resolved, not another blind rerun. This is necessary but not sufficient: the historical runner must also be replaced/reviewed against the ownership and lifecycle-oracle gates above before use.

Obtain a quiet, awake, idle-call foreground handoff on one of the existing exact owned QA documents:

- A: `http://renderer-a.qa.test/rev7loss/a?router=1#ready`
- B: `http://renderer-b.qa.test/rev7loss/b?router=1#ready`

Do not navigate or close unrelated tabs/profiles. Require exact native Activity plus fresh exact QA URL or uniquely bound owned QA overview before inputs. Check visible window structures; unknown overlays, calls, asleep/unrelated focus or notifications mean PAUSE, never automatic dismissal or foreground takeover. XML and window checks are non-atomic/best effort; no blanket SystemUI whitelist or private notification logging.

For a healthy A, re-prove its unique active renderer ownership, induce at most one fresh controlled fault, close the owned response gate and make one explicit retry. Record fresh request-count deltas (`ΔA=1`, `ΔB=0`) and monotonic input/observation intervals. After positively proving the intended hidden/background state, dwell for at least 9 seconds, then observe A busy/retry-GONE in a bounded early-return sample without a second request. That sample alone does not establish a fresh eight-second policy. Use separately reviewed cases to distinguish remaining versus fresh budget and to verify the gated foreground timeout/retry. Repeat via intentional Home with pre-dwell background proof and verified original-task/component return with no URL. If sampling exceeds the budget, mark tool-timing INCONCLUSIVE, not product failure. Open the existing gate and verify a fresh clickable A document while B's document identity stays unchanged. Use bounded asynchronous readiness observations; gate release or one XML sample is not commit/liveness proof.

Use a fresh run directory/id. Do **not** blindly rerun historical scripts: fixed output names collide with exclusive saves; old visibility setup assumes overview; its save-before-cleanup `finally` can prevent resource restoration. A fresh fixture must have unique ownership/health, bind localhost only, be a tracked managed job, and restore only its own compare-matched temporary reverse. Independently attempt gate, reverse and exact scratch cleanup even if receipt saving fails. Stop only the exact owned job. Close only newly re-identified unique QA A/B cards, re-detect state after each close, and preserve startup/other tabs.

## 6. Remaining product/release boundaries

- User-reported tab freezes are not globally closed by this checkpoint. Complete hidden-tab/Home integration, then separately test natural reclaim and longer real browsing.
- Confirm callback reachability for a navigation that starts before GONE but successfully commits after GONE. The observer conservatively clears old navigation proof; this ordering is a review follow-up, **not an established reachable bug** or a reason to patch the installed candidate speculatively.
- Reliable web previews, 200% font tab-card/History crowding, narrow/landscape behavior and accessibility remain acceptance work. Host checks do not establish polished native UI or consistent navigation bars on all real pages.
- Do not repeat old v5/v8 gaps as current facts: [r13q](android-r13q-closure-2026-11-14.md) has scoped cookie/localStorage SIGKILL+reboot evidence; [r13t](android-r13t-final-2026-11-14.md) records real audio/video media permission/capture work. Their documented limits still apply.
- Full Chromium/DEPS source/build reproducibility and NOTICE/license closure remain open.
- The earlier DSH `Attachment object is missing.` interruption is separate from Android product acceptance; no DSH repair is claimed here.

Source/test/runner and the initial handoff/README checkpoint were committed locally as `9366e31a92ea921f36e37ec87046245e60bd5d08` (`fix(android): recover interrupted renderers with explicit retry`). The authorized device continuations changed no frozen product/test input and their follow-up commits were documentation-only. The later offline ownership contract adds separate host-only files; it does not change the built candidate or runtime acceptance. Preserve unrelated `.build-source-sha.txt` and `release-1.0.1-20260926-preserved/`. No push, publish or formal-release claim.
