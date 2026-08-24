# Chromium 151 upgrade plan

Status: **Phases 1–2 COMPLETE against `151.0.7922.71`** (2026-08-24): the full
45-patch series applies with **0 rejects**, and the strict `check.sh` gate
(`git apply --cached` against the pristine pinned baseline, no reject fallback)
passes end-to-end on 151; all build pins now target the 151 commit. Phases 3–5
(build, re-baseline corpora, full verification) remain and are multi-session.
The matrix stays at the verified Chromium `150.0.7871.114` build until phases
3–5 pass. ⚠️ Note: `151.0.7922.71` is *a* current 151 stable, but not the
newest patch build — upstream shipped `151.0.7922.174` (Win/Mac, 2026-08-20)
and Chrome 152 is due 2026-08-25; the tag fetch for `.174` timed out twice via
the configured proxy, so `.71` was kept per decision (see "Target" below).

## Target

- Upstream stable: `151.0.7922.71` (stable 2026-07-28, 370 security fixes).
  **Target-version note (2026-08-24):** this is *a* 151 stable, but not the
  newest. Latest 151 stable is `151.0.7922.174` (Win/Mac 2026-08-20, `.173`
  Linux); Chrome 152 stable is scheduled 2026-08-25. Because `151.0.7922.71`
  and `.174` are both on the same `151.0.7922.x` patch branch, the rebase
  against `.71` is expected to transfer to `.174` with no new conflicts — but
  the tag must be fetched to confirm. A `git fetch` of `151.0.7922.174` via the
  configured proxy (`127.0.0.1:7890`) timed out twice (≥10 min each), so
  re-targeting is blocked on network. Options: (a) keep `.71` as the 151 target
  (a legitimate, real 151 stable, just not the most recent patch build), (b)
  retry fetching `.174` (needs faster/stable network or a fuller checkout), or
  (c) jump to 152 once it ships (larger rebase surface).
- RoxyBrowser shipped its own Chromium 151 kernel on 2026-08-20 with a
  changelog note that their WebGL output is now aligned with Chrome — our
  per-engine renderer composition (`composeGpuRenderer`, roadmap Slice 79 /
  81.8 补集) already covers the same anomaly class on 150.

## Upstream access

The local checkout uses the GitHub mirror (`github.com/chromium/chromium`,
blob:none). The mirror does not expose `refs/branch-heads/*`; fetch by tag:

```
git -c http.proxy=http://127.0.0.1:7890 fetch --depth=1 origin \
  refs/tags/151.0.7922.71:refs/tags/chromium-151-stable --no-tags
```

Tip commit: `ef35003457`. Base for diffs: `f405107495a07cb1bfcf687d4af8d91117098db6`
(the verified 150.0.7871.114 tag).

## Conflict surface (measured, 2026-08-23)

- Files touched by our patch series: **101**.
- Of those, changed upstream between 150→151: **49**.
- Hunks whose ±3-line context overlaps an upstream change region
  (mechanical scan `/tmp/opencode/conflict-scan.mjs`): **31 files across 15 patches**.
- **Sequential dry-run on the real 151 tip** (files extracted via
  `git show chromium-151-stable:<path>`, patches applied in order with
  `git apply --reject`): **22 of 44 patches apply cleanly; 17 conflict**:

| Patches with rejected hunks | Rejected files |
|---|---|
| 0044 managed-dns-locale-refresh | 9 |
| 0042 agent-browser-public-runtime-protocol | 3 |
| 0035 cdp-occluded-input-completion | 2 |
| 0003 screen-dpr / 0013 font-allowlist / 0017 custom-font-directory / 0021 do-not-track / 0032 cdp-input-routing / 0033 system-theme / 0037 scroll-offset-reconciliation / 0038 managed-proxy-auth / 0040 managed-font-resolution / 0041 managed-quic-proxy / 0043 google-api-key-infobar / 0045 widevine-registration / 0046 window-title-prefix | 1 each |

Cleanly applying: 0002, 0004–0012, 0014–0016, 0018–0020, 0022–0031, 0034,
0036, 0039 (22 patches).

Hot spots by patch:

| Patch | Hot files | Area |
|---|---|---|
| 0044 managed-dns-locale-refresh | 12/30 | net/dns DoH family churned heavily in 151 |
| 0035 cdp-occluded-input-completion | 3/11 | input handler / widget input manager |
| 0033 system-theme-coherence | 2/3 | layout theme |
| 0037 cdp-scroll-offset-reconciliation | 2/7 | layer tree host |
| 0038 managed-proxy-auth | 2/3 | chrome_content_browser_client |
| singles | 0003/0004/0009/0011/0013/0021/0032/0036/0040/0045 | canvas, offscreen canvas, fonts, DNT, widevine.gni, BUILD.gn files |

macOS DisplayLink files (`ui/display/mac/*`) changed upstream but our headless
BeginFrame patch hunks do not overlap the changed regions per the scan; they are
"cold" but must still be re-verified at build time.

## Phase 1 rebase — results (2026-08-24)

Sequential dry-run re-run end-to-end: **0 rejected hunks across all 45
patches** (`upgrade-drive.sh`, `REF=chromium-151-stable`, tip `ef35003457`).
Each resolved patch was also replayed in isolation against its post-predecessor
base and applied cleanly.

Resolved patches (regenerated): `0003`, `0013`, `0021`, `0032`, `0033`, `0035`,
`0038`, `0044`, `0045`, `0046`. `0037` applies clean on 151 unchanged.

Resolution notes per patch:

- `0003/0013/0021/0032/0033`: upstream include-block context drift — re-insert
  the `roxy_fingerprint_config.h` include (and, for `0033`, drop the now-obsolete
  `#include <optional>`). No behavioral change.
- `0035`: `input_handler.cc` include + `widget_input_handler_manager.cc`
  `OnDevToolsSessionConnectionChanged` / `SynchronizeDebuggerScroll*` methods
  (context shifted in 151). No behavioral change.
- `0038`: `chrome/browser/BUILD.gn` `core` source_set — add
  `net/roxy_proxy_auth.{cc,h}` (context shifted). No behavioral change.
- `0044`: `net/dns/dns_http_attempt.{cc,h}` ctor gains a `bool doh_via_proxy`
  parameter (151 renamed the param `request_priority` → `request_priority`,
  context drift). The 6 `ui/display/mac/*` rejects are backports of upstream
  151 commit `d3b9663276a9` (crbug.com/345275139) — **dropped as redundant**;
  `ui/display/mac/screen_utils_mac.mm` (our real change) retained.
- `0045`: `third_party/widevine/cdm/widevine.gni` — wrap
  `enable_widevine_cdm_component` in `declare_args()` (context shifted).
- `0046`: **complete** — `chrome/common/chrome_switches.{cc,h}` declares
  `--agent-browser-window-title-prefix`, and the prefix is now applied in
  `BrowserView::GetWindowTitle()` (chrome/browser/ui/views/frame/browser_view.cc).
  151 moved the window-title computation out of `Browser` into the platform
  `BrowserWindow` layer (`BrowserView::GetWindowTitle()` calls
  `WindowMetadataController::From(browser)->GetWindowTitleForCurrentTab(...)`);
  Chrome on macOS uses the Views browser window, so this covers the Mac target.
  Prefix is prepended to the native window title only (document.title / page
  surfaces unaffected). Cosmetic; no fingerprint/identity impact.

Harness used: `patches/chromium/scripts/upgrade-drive.sh` (full-series dry-run),
`upgrade-resolve.sh` (`prepare` builds post-predecessor base + `git apply --reject`,
`regen` diffs base vs resolved). Predecessors are applied best-effort
(`--reject`) so foundational files (e.g. `roxy_fingerprint_config.h` created by
`0017`) land even when a predecessor itself has its own conflict.

Re-validation after the `0046` re-port (browser_view.cc hunk added post-rebase):
a fresh full-series drive run again produced **0 rejects** (`0046` applies clean
without needing `--reject`), and the strict `check.sh` gate passes end-to-end
against the pinned 151 baseline — all 45 patches apply via plain
`git apply --cached`, payload overlay verified, `PATCHSET.sha256` intact.
(The earlier dry-run's `OK*` entries for `0040`/`0042` were an artifact of the
drive harness not overlaying `files/` payloads; under the real `apply.sh`
payload flow both apply strictly clean.)

## Phase 2 plumbing — results (2026-08-24)

Everything that determines *which* Chromium gets built now targets 151;
everything that *claims verification* intentionally still says 150 until phase 5:

- Pins bumped to `ef35003457e93c278f911a334b06e4a5f8967e06` (= tag
  `151.0.7922.71`): `build-macos.sh`, `build-windows.sh`, `build-linux.sh`,
  `check.sh` (`UPSTREAM_BASELINE`), `.github/workflows/engine-verify.yml`
  (`CHROMIUM_COMMIT`). Default checkout dirs renamed `chromium-src-150` →
  `chromium-src-151`; BUILD.txt labels → `chromium-151.0.7922.71`.
- `PATCHSET.sha256` regenerated — it had gone stale after the rebase (10
  regenerated patches failed hash verification, plus one stray blank line);
  `check.sh` would have aborted. Now 48/48 hashes verify.
- Left at 150 on purpose (verified-state claims, flipped in phase 5):
  `README*` "verified at" lines, `ALIGNMENT_MATRIX.md` baselines, corpus docs,
  verifier fallback defaults (`src/tools/verify-ping0.ts`,
  `verify-managed-doh.ts`, `capture-font-corpus.ts`), unit-test sample strings.

## Phase 1 work order (from the measured dry-run)

1. Resolve `0044` first and re-run the dry-run from scratch: it is the largest
   conflict and later patches (`0046`) sit on top of its context.
2. Then `0042` (3 files), then the input-routing cluster
   (`0032`/`0035`/`0037`), then the remaining singles.
3. After every resolution round, re-extract fresh 151 files and replay the full
   series with `git apply --reject` until zero rejects, before touching the
   real build tree.

## Phases

1. ✅ **Rebase patch series onto 151** — DONE (2026-08-24). All conflicts
   resolved (see results above); full-series drive = 0 rejects; strict
   `check.sh` passes on the pinned 151 baseline; `PATCHSET.sha256` regenerated.
2. ✅ **Version plumbing** — DONE (2026-08-24). Build pins, CI env, baseline
   and BUILD.txt labels moved to 151 (`ef35003457e93c278f911a334b06e4a5f8967e06`);
   verified-state strings intentionally untouched. Smoke suites pass.
3. **Build macOS arm64** via `build-macos.sh` into a separate output dir
   (`AgentBrowserRelease151`); never touch the known-good 150 install.
4. **Re-baseline corpora against stock Chrome 151** — WEBGL / STORAGE / FONT /
   NETWORK_FINGERPRINT corpora were recorded from stock 150-era references;
   the acceptance gates fail closed on drift, so capture fresh stock-151
   references first, then run the strict 53-surface verifier.
5. **Full verification** — unit + e2e suites against the 151 binary,
   external ping0 baseline for both engines, then update ALIGNMENT_MATRIX
   baselines and mark the upgrade verified.

## Explicitly out of scope until phases 1–5 pass

- Shipping/installer defaults stay on the verified 150 engine.
- No persona or identity-string changes ride along with the version bump.
