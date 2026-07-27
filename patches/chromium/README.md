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

The renderer agent is attached from
`ChromeContentRendererClient::RenderFrameCreated` and installs configuration in
every frame during `DidClearWindowObject`, before page scripts run. The first
milestone covers deterministic Navigator/User-Agent Client Hints, screen/DPR,
Canvas, AudioBuffer, WebGL, WebRTC policy, font enumeration, ClientRects,
timezone reporting, and geolocation policy.

Native patches now apply the same UA, UA Client Hints headers, platform,
language, CPU, memory, screen and DPR identity in Blink, the network stack and
workers. The lifecycle agent remains the compatibility scaffold for surfaces
that have not moved yet. It is not yet claimed to be undetectable: font
fallback, canvas/Skia, audio DSP, WebRTC ICE gathering, media devices and
storage quota still need native subsystem patches. See `CAPABILITY_MATRIX.md`
for the acceptance status.
