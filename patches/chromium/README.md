# RoxyLite Chromium 149+ community patch

This directory is the independent Chromium implementation used by
`roxy-lite-cloak-oss`. It does not contain CloakBrowser Pro binaries, recovered
keys, `lumi.conf` decryption, or code copied from RoxyChrome.

## Baseline

- Chromium tag: `149.0.7827.22`
- Commit: `e44bf5d2837ae8a8b51feb6025022cfc81bf3865`
- Config switch: `--roxy-fingerprint-config=<base64url-json>`
- Config schema: `1`

## Apply

```bash
./patches/chromium/check.sh /path/to/chromium/src
./patches/chromium/apply.sh /path/to/chromium/src
```

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
enumeration, and geolocation policy.

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
native request/result path. Storage Buckets use the same configured quota as
`navigator.storage.estimate()`, and WebAuthn capability probes use the
profile's declared platform-authenticator identity. See
`CAPABILITY_MATRIX.md` for the acceptance status and `CONFIG_COVERAGE.md` for
the field-by-field native consumer audit.

The profile timezone is owned by Blink's native `TimeZoneController`, so the
same ICU/V8 timezone is used by Window and Workers and cannot be reset by a
later host-timezone monitor notification.

The application baseline capture records Window and Worker Navigator identity,
UA high-entropy values, Canvas, Audio, ClientRects, WebGL/WebGPU, fonts,
plugins, speech voices, media-device counts, storage quota, DNT and touch state.
It is intended for same-profile restart stability and cross-seed distinction
checks once a patched Chromium binary is available.

## Runtime verification

After building Chromium, run the strict native verifier against the executable
or macOS application bundle:

```bash
npm run verify:chromium -- /path/to/Chromium.app
```

It launches two fresh profiles with the same seed and one with a different
seed on one fixed localhost origin. The verifier checks Window/Worker identity,
UA-CH, screen, Canvas, Audio, ClientRects, WebGL/WebGPU, plugins, speech,
geolocation, StorageManager/Storage Buckets, WebAuthn, AAC/H.264 playback,
MediaSource, MediaCapabilities and WebCodecs encode support, media-device
constraint remapping, identity request headers in Window
and Dedicated/Shared/Service Workers, disabled WebRTC candidates, restart
stability and cross-seed distinction. Missing WebGPU is a failure.
On macOS, fake audio capture can remain pending in stock Chrome as well as the
patched build; the verifier reports that limitation explicitly while still
strictly checking audio-device enumeration and seed behavior, plus exact video
device remapping.
