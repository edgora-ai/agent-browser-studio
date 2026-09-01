# WebGL comparative capability corpus

This corpus records public runtime behavior only. It does not inspect or
recover proprietary source/configuration formats. Each RoxyChrome Profile was
copied to a temporary directory before launch, queried through standard WebGL
APIs, closed, and deleted; the original Profile trees were not modified.

## Observable reference — 2026-08-03

- Reference executable: locally installed RoxyChrome `149.0.7827.22`.
- Configured browser identity: Chrome `148.0.7744.0`.
- Contexts per Profile: Window WebGL 1/2 and Dedicated Worker OffscreenCanvas
  WebGL 1/2.
- Corpus: sorted supported extensions, context attributes, 26 WebGL 1 and 53
  WebGL 2 capability parameters, compressed formats, anisotropy/draw-buffer
  limits, and 12 shader-precision cases per WebGL version.
- Normalization excludes only the declared WebGL version number and the
  intentionally Profile-specific unmasked vendor/renderer. It retains
  `VENDOR`, `RENDERER`, context attributes, extensions, parameters and shader
  precision.

| Case | Declared platform | Observable unmasked GPU | Window/Worker parity | Normalized SHA-256 |
|---|---|---|---|---|
| 1 | macOS | Apple M1 | exact | `8f97b97709c5c782ef0b5751e8c2217826721af0bfb8daeba76d29694d040bc2` |
| 2 | macOS | AMD Radeon Pro 560X | exact | `8f97b97709c5c782ef0b5751e8c2217826721af0bfb8daeba76d29694d040bc2` |
| 3 | Windows | AMD Radeon RX 6700 XT / D3D11 | exact | `8f97b97709c5c782ef0b5751e8c2217826721af0bfb8daeba76d29694d040bc2` |
| 4 | Windows | AMD Radeon RX 580 / D3D9Ex | exact | `8f97b97709c5c782ef0b5751e8c2217826721af0bfb8daeba76d29694d040bc2` |
| 5 | macOS | AMD Radeon Pro 5500M | exact | `8f97b97709c5c782ef0b5751e8c2217826721af0bfb8daeba76d29694d040bc2` |
| 6 | Windows | AMD Radeon RX 580 / D3D9Ex | exact | `8f97b97709c5c782ef0b5751e8c2217826721af0bfb8daeba76d29694d040bc2` |

All six observable RoxyChrome Profiles therefore expose one common deep
capability corpus while varying the unmasked identity.

## OSS Chromium 152 result

The installed independent Chromium `152.0.7977.72`, configured as a Windows
NVIDIA RTX 3060 Profile, produces the same normalized SHA-256
`8f97b97709c5c782ef0b5751e8c2217826721af0bfb8daeba76d29694d040bc2`
and exact Window/Worker parity. The strict verifier repeats the corpus across
independent Profiles, a same-Profile close/reopen, different seeds,
Windows/macOS identities, `el-GR`/`el-CY`, headed/headless and native
pass-through modes.

The acceptance gate is implemented in
`src/tools/webgl-corpus.ts` and `src/tools/verify-native-chromium.ts`. A future
Chromium upgrade fails closed if any extension, capability parameter, context
attribute or shader-precision value drifts from the recorded observable
reference. Product fingerprint baselines also retain a deep WebGL corpus hash
so post-launch drift is auditable.

No Chromium source change was required for this evidence: the existing native
vendor/renderer implementation plus Chromium 152's underlying capability
surface already matches the observable RoxyChrome corpus. Patch `0039` only
aligns legacy Storage quota callbacks and does not alter WebGL; patch `0038`
and all earlier patch bytes remain unchanged.
