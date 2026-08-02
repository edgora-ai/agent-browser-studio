# Native configuration coverage

This audit maps every schema-1 profile field to its authoritative Chromium
consumer. A field is not considered covered merely because the application can
serialize it.

| Configuration field | Native consumer / invariant |
|---|---|
| `schemaVersion` | `RoxyFingerprintConfig` rejects versions other than `1` |
| `seed` | Canvas, Audio, ClientRects, media IDs, preferred color scheme and stable tokens |
| `platform` | Window/Worker Navigator, UA metadata, media/plugin labels, CSS system colors and selection rendering |
| `platformVersion` | low/high entropy UA Client Hints |
| `userAgent` | browser network UA and Window/Worker Navigator |
| `appVersion` | validated redundant value; Blink derives the same value from configured UA |
| `vendor` | invariant `Google Inc.` from Chromium's native Navigator implementation |
| `languages` | Window/Worker Navigator plus browser language launch settings |
| `hardwareConcurrency` | shared Window/Worker `NavigatorBase` |
| `deviceMemory` | shared Window/Worker `NavigatorDeviceMemory` |
| `maxTouchPoints` | Blink `NavigatorEvents` |
| `hardwareProfile.*` | launch-time joint-persona gate constrains CPU/RAM/GPU/screen/DPR/font/audio before the constituent native consumers receive them |
| `screen.*` | Blink `Screen` and `LocalDOMWindow`; `pixelDepth` delegates to configured `colorDepth` |
| `storageQuotaBytes` | Blink `StorageManager::estimate()`, `StorageBucket::estimate()` and deprecated temporary/persistent query/request callbacks; verified with OPFS and legacy FileSystem in persistent/incognito contexts |
| `canvas.*` | detached 8-bit, float16 and float32 Canvas/OffscreenCanvas readbacks |
| `audio.*` | `AudioBuffer` and all analyser readback variants |
| `webgl.*` | WebGL 1/2 debug renderer plus 39/36 extensions, 26/53 capability parameters and shader-precision corpus in Window/Worker |
| `webgpu.*` | Window/Worker `GPUAdapter.info` / `GPUDevice.adapterInfo`, 23 adapter features, 36 adapter/device limits and WGSL capability corpus |
| `webauthn.*` | `PublicKeyCredential` client capabilities, conditional mediation and platform-authenticator availability |
| `webrtc.*` | native allocator routing plus ICE candidate and SDP rewriting |
| `timezone` | Blink `TimeZoneController` authoritative ICU/V8 process override for Window and Workers |
| `geolocation.*` | Blink native request/result policy |
| `mediaDevices.*` | enumeration, constraints, track settings/capabilities and output routing |
| `fonts` | Blink platform font cache and Local Font Access allow-list |
| `doNotTrack` | renderer preferences, DOM value and Window/Worker request headers |
| `speechSynthesis.*` | browser TTS voice list plus synthetic-to-actual playback mapping |

Fields such as search engine, image/audio blocking, password prompts, domain
blocking, port-scan policy and an empty TLS cipher blacklist are browser product
policies rather than fingerprint schema fields. They require separate product
requirements and are not evidence of a native identity mismatch.

AAC/H.264 support is a build invariant rather than a profile field. The checked
in `args.gn` enables Chrome FFmpeg branding and proprietary codecs, while the
runtime verifier checks MIME playback, MediaSource, MediaCapabilities and the
AAC/H.264 WebCodecs encoders.
