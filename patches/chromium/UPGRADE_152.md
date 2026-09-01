# Chromium 152 upgrade record

Status: **macOS arm64 COMPLETE and locally verified** (2026-09-01).

The independent engine now runs Chromium `152.0.7977.72` at upstream commit
`026bb13a93d60e7adfefa2bbf58d6f57c2d335cc`. The built application was installed
into the managed cache and passed the Stock-152 capability gate, the strict
53-surface native verifier, a real proxy/Ping0 identity run, and the complete
Electron E2E suite with the 152 executable explicitly selected.

Linux and Windows builds remain follow-up work; they were intentionally removed
from the macOS-first critical path.

## Target and source provenance

- Chromium version: `152.0.7977.72`
- Chromium commit: `026bb13a93d60e7adfefa2bbf58d6f57c2d335cc`
- Local source: `~/workspace/chromium-build-152/src`
- Output: `out/AgentBrowserRelease/Chromium.app`

Git pack transfers repeatedly truncated on this network. The verified source tree
therefore uses an immutable official archive plus exact per-file deltas:

- Official archive: `chromium-152.0.7977.65-lite.tar.xz`
- Archive base commit: `fc4d67f1788019a27e32511137ceccbd2fafdaaa`
- Archive SHA-256:
  `1a544857555a0c391753e7f9f3016cc07b0288d9da02260c451aa9082b305066`
- `.65` → `.72` root delta: 174 commits, 172 changed entries, 170 regular
  files verified by Git blob SHA, plus exact Dawn and DevTools gitlink deltas.

`verify-source-provenance.sh` binds the trusted archive SHA and base commit to a
small synthetic Git commit, then requires the exact `.chromium-source-commit`
target. `check.sh` validates this archive+delta mode without triggering a
multi-gigabyte lazy Git fetch.

## Patchset result

- Numbered patches: `0002`–`0050` (**49 patches**)
- `PATCHSET.sha256`: **52/52 entries verified**
  - `args.gn`
  - 2 immutable Blink payload headers
  - 49 numbered patches
- Applied patch markers: 49
- Reject files: 0

The original 45-patch Chromium 152 rebase remains immutable. Compilation and
resume defects were fixed with append-only patches:

- `0047-fix-duplicate-cg-refresh-interval.patch` removes Chromium 152's duplicate
  `GetCGRefreshInterval` definition while retaining the defensive managed version.
- `0048-restore-evolved-fingerprint-payload.patch` restores payload evolution
  lost by the old incremental `apply.sh` behavior, including the public
  `agent-browser-fingerprint-config` protocol and managed generic-font resolver.
- `0049-preserve-generic-font-family-semantics.patch` carries Blink's
  generic-vs-quoted-family distinction into managed font resolution.
- `0050-parse-managed-secure-dns-config.patch` implements the `secureDns`
  configuration consumed by the managed DoH path, with bounded template count
  and length.

`apply.sh` now preserves evolved payloads on incremental resumes instead of
copying the immutable base payload over already-applied changes.

## macOS arm64 build

Canonical release arguments remain enabled:

- `is_official_build = true`
- `is_component_build = false`
- ThinLTO
- `symbol_level = 0`
- `chrome_pgo_phase = 0`
- `proprietary_codecs = true`
- `ffmpeg_branding = "Chrome"`
- Widevine registration enabled
- `target_cpu = "arm64"`
- local Ninja concurrency `-j4`

Verified build output:

```text
/Users/ahoo/workspace/chromium-build-152/src/out/AgentBrowserRelease/
  Chromium.app/Contents/MacOS/Chromium

Mach-O 64-bit executable arm64
Chromium 152.0.7977.72
```

Unsigned build executable SHA-256:

```text
3c4a69566e78ba2fc053697ecd1956248a040e55f560ef751b78679c26b1603d
```

The installer copied, ad-hoc signed, deep-verified and atomically installed the
application at:

```text
~/.agent-browser-studio/chromium-152.0.7977.72/Chromium.app
```

Installed executable SHA-256 (different because code signing mutates Mach-O
signature data):

```text
f83b0a79a0776a19bfdb41fed2e92db0114326f4944152e5b27bd3f16b53ac2c
```

Installer runtime build hash:

```text
7944aa16909510c02fff7e1b237d5fc6466f8cd684a044a2843c94dbb31ea675
```

`codesign --verify --deep --strict` reports the managed bundle valid on disk and
satisfying its Designated Requirement.

## Stock Chrome 152 gate

Reference corpus:

```text
patches/chromium/corpora-152/stock-chrome-152.0.7977.64.json
```

Result: **8/8 gates passed**.

- UA version family: Chrome 152
- WebGL Stock-152 SHA:
  `8f97b97709c5c782ef0b5751e8c2217826721af0bfb8daeba76d29694d040bc2`
- WebGPU Stock-152 SHA:
  `d6f8c588d2270ff32761fa2d512820f27eb932248a492a536696bc60b42c4999`
- WebGL Window/Worker parity
- WebGPU Window/Worker parity
- OPFS available
- Full font canvas Stock-152 SHA parity
- Font Window/Worker canvas parity

The gate now grants Local Font Access permission explicitly and applies bounded
per-stage timeouts, so a permission prompt cannot hang verification indefinitely.

## Strict native verifier

Command:

```bash
npm run verify:chromium -- \
  "$HOME/.agent-browser-studio/chromium-152.0.7977.72/Chromium.app"
```

Result:

```json
{
  "ok": true,
  "version": "152.0.7977.72",
  "checkedSurfaces": 53,
  "sameSeedStable": true,
  "differentSeedsDistinct": true,
  "persistentProfileRestart": "full-surface-verified",
  "passThrough": "verified-native-host-identity-and-theme"
}
```

The verifier covers fresh and restarted Profiles, independent same/different
seeds, `el-GR`/`el-CY`, headed/headless parity, incognito storage and native-host
pass-through. It reports:

- WebGL: four contexts, 26 WebGL1 parameters, 53 WebGL2 parameters and 24
  shader-precision cases, exact Stock-152 SHA.
- WebGPU: two contexts, 23 adapter features, 36 adapter limits, one default
  device feature, 36 device limits and 10 WGSL language features, exact
  Stock-152 SHA.
- Fonts: 39 candidates, 390 generic metrics, 468 named metrics and 247 raster
  cases per context; managed Local Font Access allow-list and ≤2 px Canvas/DOM
  generic parity verified.
- 61 system-theme checks, AAC/H.264, modern/legacy/Buckets/OPFS storage,
  WebAuthn, CDP identity, build-version coherence and audio capture verified.

Chromium 152 exposes extra experimental WebGPU capabilities when launched with
`--enable-unsafe-webgpu`. That flag and `--ignore-gpu-blocklist` were removed
from the stock-parity verifier; otherwise the verifier itself changed the
surface it was trying to measure.

## Application and external verification

Explicit-152 full E2E command:

```bash
AGENT_BROWSER_CHROMIUM_BINARY_PATH="$HOME/.agent-browser-studio/chromium-152.0.7977.72/Chromium.app/Contents/MacOS/Chromium" \
  npm run test:e2e
```

Result:

```text
Test Files  95 passed | 4 skipped (99)
Tests       470 passed | 12 skipped (482)
```

Non-E2E suite:

```text
Test Files  75 passed
Tests       803 passed
```

A real Ping0 run through the configured HTTP proxy reached `finished=true` and
wrote `/private/tmp/ping0-chromium152/ping0-chromium152-local-1.json`
(SHA-256 `0ba3e9c42d28d3a14ad7f9d134931661198746e690f8c2d95e63faf0684f9b05`).
All browser identity categories passed (`identityFailures=0`). Its six reported
failures were external network/site boundary signals (IDC, headless RAF sample,
DNS/multi-exit and service-observed country mismatch), not browser identity
surface failures.

## Remaining work

- Build and verify Linux and Windows on suitable runners.
- Produce signed/notarized distribution artifacts where credentials and real
  platform runners are available.
- Keep retained Chromium 149/150 builds for explicit rollback tests; default
  managed selection now chooses verified 152.
