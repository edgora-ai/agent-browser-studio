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
language, CPU, memory, screen and DPR identity in Blink, the network stack and
workers. Chrome explicitly forwards the versioned profile configuration only
to renderer processes. Canvas `toDataURL`, `toBlob` and `getImageData`
readbacks use detached, stable native pixel noise without modifying the visible
backing canvas. WebGL
1/2 identity now comes from the native parameter path. AudioBuffer and analyser
readbacks apply stable native noise. OffscreenCanvas blob export shares the
same detached Canvas noise, and storage estimates use the configured native
quota. Media device IDs are remapped natively across enumeration, exact/ideal
constraints, track settings/capabilities and audio-output routing. On macOS,
profile font
directories are registered with CoreText before the renderer sandbox, and the
registered font metadata participates in Blink's native allow-list. Canvas noise
now covers 8-bit, float16 and float32 readbacks. Media enumeration exposes a
stable, origin-scoped
desktop device set, and the standard Chromium PDF plugin/MIME set is enforced
in Blink. Geolocation `real`, `disable`, and `custom` policies run in Blink's
native request/result path. See
`CAPABILITY_MATRIX.md` for the acceptance status.
