# Chromium 152 upgrade plan

Status: **Phases 1–2 COMPLETE against `152.0.7977.72`** (2026-08-30): the full
45-patch series applies with **0 rejects**, and the strict `check.sh` gate
passes end-to-end on the 152 pinned baseline. **Phases 3–5 (build, corpora,
full verification) remain** — the matrix stays at the verified Chromium
`150.0.7871.114` build until they pass. This supersedes `151.0.7922.71` in
[UPGRADE_151.md](UPGRADE_151.md); Phase 2 plumbing now targets 152.

## Target (decided 2026-08-30)

- **Upstream stable: `152.0.7977.72`** — the newest 152 stable tag on
  `152.0.7977.x` (verified via `git ls-remote` against the GitHub mirror; tag
  tip commit `026bb13a93`), fetched into the build tree as
  `refs/tags/chromium-152-stable`.
- Why skip 151: `151.0.7922.71` was already superseded by `.174`, and 152
  stable shipped on schedule (2026-08-25). Shipping 151 in late August would
  arrive already one major behind RoxyBrowser's 151 kernel (2026-08-20) and
  behind stock stable. One larger rebase > two sequential ones.
- RoxyBrowser shipped its own Chromium 151 kernel on 2026-08-20 with a
  changelog note that their WebGL output is now aligned with Chrome — our
  per-engine renderer composition (`composeGpuRenderer`, Slice 79 / 81.8)
  already covers the same anomaly class on 150 and carries to 152 unchanged.

## Upstream access

The build tree is `~/workspace/chromium-build-151/src` (git-blob:none partial
checkout; the name is historical). Tag staged with:

```
git -c http.proxy=http://127.0.0.1:7890 fetch --depth=1 origin \
  refs/tags/152.0.7977.72:refs/tags/chromium-152-stable --no-tags
```

Network note: the local proxy (127.0.0.1:7890) is flaky for large promisor
blob batches — `git ls-remote`/tag fetch succeed with retries, but
`checkout` may need several attempts (blobs arrive incrementally). If a
checkout stalls, retry; every attempt makes forward progress. Switching the
promisor remote to the GitHub mirror temporarily also works.

## Conflict surface (measured 2026-08-30)

- Files touched by our patch series: **95** (`/tmp/chromium-152-upgrade/touched.txt`, grep `^diff --git`).
- Sequential dry-run on the real 152 tip (`upgrade-drive.sh`, `REF=chromium-152-stable`, 45 patches, `git apply --reject` attribution): **42 of 45 patches apply cleanly; 3 conflict with rejected hunks** (vs 151: 101 files, 22/44 clean, 17 conflicting — 152 is dramatically cleaner).

| Patches with rejected hunks | Files | Area |
|---|---|---|
| `0003-native-screen-and-dpr` | 2 (`local_dom_window.cc`, `screen.cc`) | include-block context drift — `navigation/impression.h` gone, `document.h` inserted |
| `0025-native-timezone-identity` | 1 (`timezone_controller.cc`) | include-block drift — `features.h`/`switches.h` inserted |
| `0044-agent-browser-managed-dns-locale-refresh` | 1 (`network_service.cc` signature) | `ConfigureStubHostResolver` gained a `provider` param in 152 — signature shift |

`0040` and `0042` report `OK*` (applied with `--reject`, no new `.rej`) — this is the expected false-positive when the pristine-`REF` drive harness does not overlay `files/` payloads, identical to the 151 run. Under the real `apply.sh` payload flow they apply strictly clean (`check.sh` proves it).

Hot spots by value:
- 152 has **no** `ui/display/mac/*` storm (151 dropped 6 backports as redundant), no `0042`/`0035` cluster, and no `BUILD.gn` churn.

## Phase 1 rebase — results (2026-08-30)

Full-series drive re-run after regen: **0 rejected hunks across all 45 patches**.

Regenerated patches (minimal context re-insertion, no behavioral change):
- `0003` — re-insert `roxy_fingerprint_config.h` include after `features.h` / after `permissions_policy_feature` (upstream added/removed lines around the insertion point).
- `0025` — re-insert `roxy_fingerprint_config.h` include before `thread_safe_browser_interface_broker_proxy.h` (upstream inserted `features.h`/`switches.h` above it).
- `0044` — add `bool doh_via_proxy` tail param to `NetworkService::ConfigureStubHostResolver` `.cc` signature to match the header the same patch already extends (upstream added a sibling param, shifting context by one line).

Harness: `patches/chromium/scripts/upgrade-drive.sh` (full-series dry-run) + `patches/chromium/scripts/upgrade-resolve.sh` (`prepare` → hand-edit `OUT/files` → `regen`).

## Phase 2 plumbing — results (2026-08-30)

Everything that determines *which* Chromium gets built now targets 152;
everything that *claims verification* intentionally still says 150 until phase 5:

- Pins bumped to `026bb13a93d60e7adfefa2bbf58d6f57c2d335cc` (= tag `152.0.7977.72`):
  `build-macos.sh`, `build-linux.sh`, `build-windows.sh`, `check.sh` (`UPSTREAM_BASELINE`),
  `.github/workflows/engine-verify.yml` (`CHROMIUM_COMMIT`). Default checkout dirs renamed
  `chromium-src-151` → `chromium-src-152`; `BUILD.txt` labels and `check.sh` comments → `chromium-152.0.7977.72`.
  `apply.sh` comment → `152`.
- `PATCHSET.sha256` regenerated — 3 regenerated patches failed hash verification; now 48/48 hashes verify.
- Left at 150 on purpose (verified-state claims, flipped in phase 5):
  `README*` "verified at" lines, `ALIGNMENT_MATRIX.md` baselines, corpus docs,
  verifier fallback defaults (`src/tools/verify-ping0.ts`, `verify-managed-doh.ts`, `capture-font-corpus.ts`), unit-test sample strings.

## Phases

1. ✅ **Rebase patch series onto 152** — DONE (2026-08-30). All conflicts resolved; full-series drive = 0 rejects; 3 patches regenerated.
2. ✅ **Version plumbing** — DONE (2026-08-30). Build pins, CI env, baseline and `PATCHSET.sha256` moved to 152; verified-state strings intentionally untouched.
3. **Build macOS arm64** via `build-macos.sh` into a separate output dir (`AgentBrowserRelease152`); never touch the known-good 150 install.
4. **Re-baseline corpora against stock Chrome 152** — WEBGL / STORAGE / FONT / NETWORK_FINGERPRINT corpora were recorded from stock 150-era references; the acceptance gates fail closed on drift, so capture fresh stock-152 references first, then run the strict 53-surface verifier.
5. **Full verification** — unit + e2e suites against the 152 binary, external ping0 baseline for both engines, then update ALIGNMENT_MATRIX baselines and mark the upgrade verified.

## Explicitly out of scope until phases 1–5 pass

- Shipping/installer defaults stay on the verified 150 engine.
- No persona or identity-string changes ride along with the version bump.
