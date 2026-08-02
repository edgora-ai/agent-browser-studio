# RoxyLite Chromium 150 community patch

This directory is the independent Chromium implementation used by
`roxy-lite-cloak-oss`. It does not contain CloakBrowser Pro binaries, recovered
keys, `lumi.conf` decryption, or code copied from RoxyChrome.

## Baseline

- Chromium tag: `150.0.7871.114`
- Commit: `f405107495a07cb1bfcf687d4af8d91117098db6`
- Config switch: `--roxy-fingerprint-config=<base64url-json>`
- Config schema: `1`

## Apply

```bash
./patches/chromium/check.sh /path/to/chromium/src
./patches/chromium/apply.sh /path/to/chromium/src
```

Released Chromium changes are append-only: add the next numbered patch instead
of rewriting an earlier patch. The current `0002`–`0039` chain therefore keeps
the system-theme and occluded-input fixes independently reviewable and
revertible, while `check.sh` validates the complete order against a clean
upstream index. `PATCHSET.sha256` detects any rewrite of an already released
patch or source payload, and `PATCH_HISTORY.md` records the OSS and Chromium
source provenance. The next Chromium change must start at `0040`.

## Build configuration

Use the checked-in release arguments so the binary exposes the same public
AAC/H.264 codec surface as a normal Chrome installation:

```bash
cp ./patches/chromium/args.gn /path/to/chromium/src/out/RoxyRelease/args.gn
cd /path/to/chromium/src
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer gn gen out/RoxyRelease
autoninja -C out/RoxyRelease chrome
```

The template enables `proprietary_codecs` and uses the Chrome FFmpeg branding.
Anyone distributing a binary built this way is responsible for the applicable
codec patent and distribution requirements in their jurisdictions.

The application creates the encoded configuration from normal profile fields.
No profile encryption key is embedded into Chromium.

## Current implementation

The renderer reads one immutable process-wide configuration directly from
Blink/public common code. There is no page-script injection or JavaScript
prototype replacement. The implementation covers deterministic
Navigator/User-Agent Client Hints, screen/DPR, Canvas, AudioBuffer, WebGL,
WebRTC policy, font enumeration, ClientRects, timezone reporting, media/plugin
enumeration, geolocation policy, and declared-platform system themes.

Native patches now apply the same UA, UA Client Hints headers, platform,
language, CPU, memory, touch, screen and DPR identity in Blink, the network
stack and workers. Do Not Track is also applied through renderer preferences
so the DOM value and Window/Dedicated/Shared/Service Worker request headers
remain consistent. Chrome explicitly forwards the versioned profile configuration
only to renderer processes. Canvas `toDataURL`, `toBlob` and `getImageData`
readbacks use detached, stable native pixel noise without modifying the visible
backing canvas. WebGL
1/2 identity now comes from the native parameter path. AudioBuffer and analyser
readbacks apply stable native noise. OffscreenCanvas blob export shares the
same detached Canvas noise, WebGPU adapter vendor identity is native in both
Window and Worker, and storage estimates use the configured native quota.
Dedicated, Shared, and Service Worker Navigator values use the same immutable
profile identity as Window. Speech synthesis exposes a stable locale/platform
voice list while mapping selected voices to an available system voice for
playback. Media device IDs are remapped natively across
enumeration, exact/ideal constraints, track settings/capabilities and
audio-output routing. On macOS, profile font directories are registered with
CoreText before the renderer sandbox, and the
registered font metadata participates in Blink's native allow-list. Windows
profiles without an external font pack use only core fonts present on both
macOS and Windows, avoiding claims for unavailable Segoe/Calibri families.
Canvas noise now covers 8-bit, float16 and float32 readbacks with an idempotent
per-profile least-significant-bit transform. Media enumeration exposes a
stable, origin-scoped desktop device set, and the standard Chromium PDF
plugin/MIME set is enforced in Blink. Geolocation `real`, `disable`, and
`custom` policies run in Blink's
native request/result path. Storage Buckets and deprecated temporary/persistent
query/request callbacks use the same configured quota as
`navigator.storage.estimate()`; OPFS and the legacy FileSystem path are covered
in persistent and incognito contexts. WebAuthn capability probes use the
profile's declared platform-authenticator identity. See
`CAPABILITY_MATRIX.md` for the acceptance status and `CONFIG_COVERAGE.md` for
the field-by-field native consumer audit.

Chromium 150 additions preserve the managed identity across CDP user-agent
operations, bind browser-window bounds to the declared screen geometry, extend
WebGPU adapter architecture/subgroup coherence, and keep trusted native input
routing for CDP-driven mouse, keyboard and wheel events. Managed occluded
windows retain FIFO renderer-ack bookkeeping, use a bounded rAF fallback, and
reconcile compositor scroll offsets into DOM state without duplicating later
commits; pass-through keeps Chromium's stock path. The application layer
paces seeded pointer points across compositor frames and adds exact
installed-version pins with 149 rollback retention, a native-host pass-through
mode, and explicit third-party-cookie compatibility with exact preference
restoration.
Managed HTTP proxy authentication now uses a browser-only 407 challenge path.
The application passes credentials through a mode-0600 one-shot file that the
browser reads and deletes before child processes start; credentials no longer
require an observable extension on the verified build. Managed HTTP/SOCKS
launches disable QUIC until an authenticated UDP-capable proxy transport is
implemented, preventing an unproxied UDP fallback.
Authenticated SOCKS5 TCP profiles use an ephemeral loopback bridge: Chromium
speaks its supported no-auth SOCKS5 dialect to loopback, while the bridge
authenticates to the configured upstream and forwards the unresolved target
domain. The bridge is owned by the profile process lifecycle and never loads a
page-visible extension.
Blink system colors, list selection and painted text selection now use fixed
Windows/macOS light and dark palettes from the declared platform rather than
the host theme. The seed also owns `prefers-color-scheme`; an unconfigured
pass-through launch continues to expose the native host theme.

The profile timezone is owned by Blink's native `TimeZoneController`, so the
same ICU/V8 timezone is used by Window and Workers and cannot be reset by a
later host-timezone monitor notification.

The application baseline capture records Window and Worker Navigator identity,
UA high-entropy values, Canvas, Audio, ClientRects, WebGL/WebGPU, fonts,
plugins, speech voices, media-device counts, storage quota, DNT, touch state,
preferred color scheme and light/dark system colors.
It is intended for same-profile restart stability and cross-seed distinction
checks once a patched Chromium binary is available.

The local proxy corpus compares direct, HTTP-proxy and SOCKS5 routes across
HTTP and HTTPS Window/Worker/frame/Service Worker requests, WSS, Navigation
and Resource Timing, cache hits and ETag revalidation. The installed 150 build,
stock Chrome 150 and Cloak Chromium 145 share the same structural result; proxy
credentials and proxy-only headers never reach the controlled target origin.

## Runtime verification

After building Chromium, run the strict native verifier against the executable
or macOS application bundle:

```bash
npm run verify:chromium -- /path/to/Chromium.app
```

It launches same-seed and different-seed profiles on fixed loopback origins,
reopens the same persistent Profile, then adds adversarial locale, a full
headed run, paired no-config Stock window-mode captures and pass-through.
The 52 checked surfaces include Window/Worker identity, UA-CH, screen/window
geometry, Canvas, Audio, ClientRects, WebGL/WebGPU, plugins, speech,
geolocation, StorageManager/Storage Buckets, legacy quota APIs, OPFS and the
legacy FileSystem path in persistent/incognito contexts, WebAuthn, AAC/H.264 playback,
MediaSource, MediaCapabilities and WebCodecs encode support, media-device
constraint remapping, audio capture, request headers in Window and
Dedicated/Shared/Service Workers, disabled WebRTC candidates, CDP identity,
exact build-version coherence, same-Profile restart stability, cross-seed
distinction and full headed/headless parity. On macOS, the only permitted
window-mode differences are `screenY` and `innerHeight`, and both values must
exactly match the dynamically captured no-config Stock path.
The deep WebGL gate additionally covers Window/Worker WebGL 1/2 extensions,
26/53 capability parameters, compressed formats, draw-buffer/anisotropy limits
and shader precision. Its normalized SHA-256 must match the six-Profile
observable RoxyChrome reference recorded in `WEBGL_CORPUS.md`.
The WebGPU gate covers Window/Worker adapter and default-device identity,
features, limits, preferred canvas format and WGSL language features. Its
capability SHA-256 must match Stock Chrome 150; `WEBGPU_CORPUS.md` also records
the six-Profile RoxyChrome comparison and the mixed Windows/Metal identity that
the joint OSS hardware persona avoids.
The Storage gate covers Window/Worker modern estimates and Buckets, OPFS,
Window legacy temporary/persistent quota query/request callbacks and the legacy
FileSystem path. `STORAGE_CORPUS.md` records the pre-`0039` leak, the fixed
values, and the immutable source/patch checkpoint.
An additional 61-case theme corpus checks 19 CSS system colors in preferred,
explicit light and explicit dark schemes, Windows/macOS differences, real
selection screenshot pixels and native-host pass-through. Missing WebGPU or a
mixed pass-through identity/theme is a failure.

The verified macOS arm64 build reports `150.0.7871.114` and passes all 52
surfaces, the deep Storage corpus, and the 61 theme cases. Installed-app acceptance additionally passes
exact 150/149 rollback, trusted humanized input and third-party-cookie
compatibility and authenticated HTTP/SOCKS proxy routing (`15/15` targeted E2E)
without a CloakBrowser license key or login.
