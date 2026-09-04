# Independent Firefox 154 native engine

This directory owns the reproducible macOS-first source, patch and verification
chain for the independent Gecko engine. The existing stock-Firefox
`user.js` + WebDriver BiDi preload implementation remains the fallback; this
patch chain adds native surfaces without changing `BrowserFingerprintConfig`
`schemaVersion: 1`.

## Pinned source

- Firefox: `154.0`
- Repository: `https://hg.mozilla.org/releases/mozilla-release`
- Release tag: `FIREFOX_154_0_RELEASE`
- SourceStamp: `9ce1ee6baeb9a3c326dbd180bdece65d8fc2eadc`
- Archive: `https://archive.mozilla.org/pub/firefox/releases/154.0/source/firefox-154.0.source.tar.xz`
- SHA-512: see `SOURCE.sha512`

The source tree and objdir live outside this repository at
`~/workspace/firefox-build-154/src` by default.

## Pinned macOS build toolchain

Firefox 154's Taskcluster definitions use Clang 21 and Rust 1.94.1. The macOS
build gate requires the corresponding local tools instead of silently using the
latest Homebrew or Rust stable releases:

```bash
brew install llvm@21 lld@21 wasi-libc wasi-runtimes
rustup toolchain install 1.94.1-aarch64-apple-darwin --profile default
cargo install cbindgen --version 0.29.4 --locked
```

The official release source archive omits Taskcluster-only inputs, so
`--enable-bootstrap` cannot regenerate the local toolchain graph from that
archive. `build-macos.sh` therefore verifies the exact compiler, linker, Rust,
and cbindgen versions; builds a version-marked merged WASI C/C++ sysroot; and
executes native and WASI link probes before starting `mach build`.

## Checkpoints

```bash
# Download the signed checksum manifest, verify Mozilla's pinned release
# signature, then download and extract the exact source archive.
patches/firefox/prepare-source.sh

# Apply the append-only Gecko chain, then validate its markers and final hashes.
patches/firefox/apply.sh ~/workspace/firefox-build-154/src
patches/firefox/check.sh ~/workspace/firefox-build-154/src

# Build, package, materialize and ad-hoc sign the macOS arm64 engine.
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  patches/firefox/build-macos.sh ~/workspace/firefox-build-154/src

# Read the binary-attested config-channel capabilities.
"$HOME/workspace/firefox-build-154/src/obj-agent-browser-arm64/agent-browser-packaged-app/Nightly.app/Contents/MacOS/firefox" \
  --agent-browser-capabilities

# Install the verified build atomically into the product's managed cache.
npm run install:firefox -- \
  "$HOME/workspace/firefox-build-154/src/obj-agent-browser-arm64/agent-browser-packaged-app/Nightly.app"

# Capture the no-config Window/iframe/Worker/Offscreen stock baseline.
AGENT_BROWSER_FIREFOX_BINARY_PATH="$HOME/workspace/firefox-build-154/src/obj-agent-browser-arm64/agent-browser-packaged-app/Nightly.app/Contents/MacOS/firefox" \
  node patches/firefox/scripts/capture-stock154.mjs

# Verify native Gate A from product config write through binary/page readback.
npm run build
AGENT_BROWSER_FIREFOX_BINARY_PATH="$HOME/workspace/firefox-build-154/src/obj-agent-browser-arm64/agent-browser-packaged-app/Nightly.app/Contents/MacOS/firefox" \
  node patches/firefox/scripts/verify-gate-a154.mjs --force

# Verify deterministic native Canvas/OffscreenCanvas readback noise.
AGENT_BROWSER_FIREFOX_BINARY_PATH="$HOME/workspace/firefox-build-154/src/obj-agent-browser-arm64/agent-browser-packaged-app/Nightly.app/Contents/MacOS/firefox" \
  node patches/firefox/scripts/verify-canvas154.mjs --force

# Verify native WebGL/WebGPU identity on the real headed GPU path. Firefox's
# macOS headless mode exposes navigator.gpu but returns no adapter.
AGENT_BROWSER_FIREFOX_BINARY_PATH="$HOME/workspace/firefox-build-154/src/obj-agent-browser-arm64/agent-browser-packaged-app/Nightly.app/Contents/MacOS/firefox" \
  node patches/firefox/scripts/verify-gpu154.mjs --headed --force

# Verify deterministic native AudioBuffer/Analyser/OfflineAudio readbacks.
AGENT_BROWSER_FIREFOX_BINARY_PATH="$HOME/workspace/firefox-build-154/src/obj-agent-browser-arm64/agent-browser-packaged-app/Nightly.app/Contents/MacOS/firefox" \
  node patches/firefox/scripts/verify-audio154.mjs --force

# Verify permission-preserving native geolocation and DOM-visible storage quota.
AGENT_BROWSER_FIREFOX_BINARY_PATH="$HOME/workspace/firefox-build-154/src/obj-agent-browser-arm64/agent-browser-packaged-app/Nightly.app/Contents/MacOS/firefox" \
  node patches/firefox/scripts/verify-geo-storage154.mjs --force

# Verify the caller-gated native media device persona roster.
AGENT_BROWSER_FIREFOX_BINARY_PATH="$HOME/workspace/firefox-build-154/src/obj-agent-browser-arm64/agent-browser-packaged-app/Nightly.app/Contents/MacOS/firefox" \
  node patches/firefox/scripts/verify-media-devices154.mjs --force

# Verify the caller-gated native speech synthesis voice roster.
AGENT_BROWSER_FIREFOX_BINARY_PATH="$HOME/workspace/firefox-build-154/src/obj-agent-browser-arm64/agent-browser-packaged-app/Nightly.app/Contents/MacOS/firefox" \
  node patches/firefox/scripts/verify-speech-voices154.mjs --force
```

`build-macos.sh` signs the materialized app extracted from the generated DMG,
not the incremental `dist/Nightly.app` tree whose framework resources are source
symlinks. Its verified output is
`obj-agent-browser-arm64/agent-browser-packaged-app/Nightly.app`.

No binary is considered native-patched merely because its version is `154.0`.
The product and release packager must also obtain the strict JSON
`--agent-browser-capabilities` response introduced by the Gecko patch chain.
Patch `0001` advertises the config channel and immutable process snapshot. Patch
`0002` adds binary-attested `navigator-v1` and `screen-v1`: Firefox-shaped UA,
Window and stock-shaped WorkerNavigator identity, hardware concurrency, WebDriver
disarm, screen/work-area geometry, top-level Window geometry, DPR and orientation
are read from the same validated snapshot. It does not add Window-only properties
to WorkerNavigator, and privileged system/browser-chrome callers retain stock
values. The verifier covers Windows, macOS and Android personas plus an eleven-
case invalid-config matrix. The pinned Gate A corpus proves native descriptors,
Window/iframe/DedicatedWorker/SharedWorker consistency and zero preload; a repeated
no-config capture remains byte-identical to the stock corpus. The current build
contains the en-US locale only; non-en-US `Intl` locale availability is therefore
not claimed by Gate A and remains covered by the production fallback.

Patch `0003` adds accepted binary-attested `canvas-v1`. It derives a deterministic
key from the validated Canvas seed and reuses Gecko's central extraction and RFP
randomization paths without changing visible backing buffers. The real verifier
rejects nine malformed Canvas config variants and proves same-seed restart and
fresh-context stability, different-seed separation, and no-config stock behavior
for Canvas 2D `getImageData`/`toDataURL`/`toBlob`, OffscreenCanvas serialization,
WebGL 8-bit and RGBA32F FLOAT readback across Window, iframe, DedicatedWorker and
SharedWorker. The evidence is pinned in
`corpora-154/canvas-firefox-154.0.json`; the post-patch no-config corpus remains
byte-identical to the stock SHA-256 `60a60d231d132239f0e5ae30ba019d8d0fa854ca4155b63bb4c4af0a12699d6a`.

Patch `0004` adds accepted `webgl-v1` and `webgpu-v1`. WebGL 1/2 retain
Firefox's masked vendor and extension gating while returning the managed
renderer and debug-extension vendor/renderer across HTML/Offscreen/Workers.
WebGPU changes only `GPUAdapterInfo` vendor/architecture/device/description;
features, limits, WGSL, subgroup sizes and fallback state remain stock. The
headed real-GPU corpus covers Windows/macOS/Android personas, same/different
identity, native descriptors and all page/Worker realms. Firefox macOS headless
exposes `navigator.gpu` but returns no adapter, so the WebGPU acceptance run is
explicitly headed; headless Canvas and stock gates remain independent. Evidence
is pinned in `corpora-154/gpu-firefox-154.0.json`.

Patch `0005` completes Gate B with accepted `audio-v1`. AudioBuffer page-visible
shadow views provide deterministic bounded noise while untouched backing data
stays clean through graph transfer; page writes and Firefox's detachment
lifecycle remain functional. Analyser float/byte frequency/time getters noise
only caller-owned arrays, and OfflineAudioContext shares the AudioBuffer path.
The verifier rejects 37 malformed configs and proves native descriptors,
same/different-seed stability, bounded amplitude/density, clean copy sources,
Window/iframe consistency and stock Window-only Worker exposure. Evidence is
pinned in `corpora-154/audio-firefox-154.0.json`; no-config remains byte-identical
to stock.

Patch `0006` adds accepted `geolocation-v1` and `storage-quota-v1`. Custom and
disabled geolocation are applied only after Firefox's site and OS permission
gates, caller eligibility is captured at the WebIDL boundary, custom one-shots
never enter the provider callback arrays, and marked custom watches skip real
provider updates while remaining clearable. `navigator.storage.estimate()` reports
`max(real quota, usage, configured quota)` at the DOM-visible resolver without
touching QuotaManager accounting. The verifier rejects sixteen malformed configs
and proves exact restart-stable custom coordinates, a 1,510-request one-shot
stress run, permission-preserving denials, real/stock provider parity, and
per-realm IndexedDB write/readback/usage evidence across Window, iframe,
DedicatedWorker and SharedWorker. Evidence is pinned in
`corpora-154/geo-storage-firefox-154.0.json` (reproduced byte-identically by two
independent runs); no-config remains byte-identical to stock.

Patch `0007` adds accepted `media-devices-v1`. When the managed config enables
`mediaDevices`, eligible content callers of `MediaDevices.enumerateDevices()`
receive a persona roster with the configured audioinput/videoinput/audiooutput
counts, persona labels, and per-origin anonymized ids derived from the Canvas key
and bound to the caller origin; the decision is captured synchronously at the
WebIDL boundary so async enumeration cannot re-derive it from a changed subject
principal. All stock gating is preserved exactly: Permissions-Policy
microphone/camera/speaker-selection drops, legacy and capture-permission label/id
gating, speaker visibility tied to microphone info exposure, and full stock
pass-through for RFP-active windows and no-config launches. The verifier rejects
twelve malformed mediaDevices configs and proves pre-permission field-less
rosters, denied-policy empty iframes, restart stability, cross-origin id
separation with identical labels, multi-device personas, stock equality for
disabled configs, and `undefined` mediaDevices on both Worker types. Evidence is
pinned in `corpora-154/media-devices-firefox-154.0.json`; no-config remains
byte-identical to stock.

The full parity capability matrix is still incomplete, so production continues
using the complete `prefs+bidi-preload` fallback and reports
`fingerprintParity: false`. `AGENT_BROWSER_FIREFOX_NATIVE=1` enables an explicit
partial-native A/B launch that writes the private pref, passes
`--agent-browser-native-required`, retains BiDi, and deliberately registers no
fingerprint preload.
