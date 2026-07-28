# Native configuration coverage

This audit maps every schema-1 profile field to its authoritative Chromium
consumer. A field is not considered covered merely because the application can
serialize it.

| Configuration field | Native consumer / invariant |
|---|---|
| `schemaVersion` | `RoxyFingerprintConfig` rejects versions other than `1` |
| `seed` | Canvas, Audio, ClientRects, media IDs and stable tokens |
| `platform` | Window/Worker Navigator, UA metadata, media/plugin labels |
| `platformVersion` | low/high entropy UA Client Hints |
| `userAgent` | browser network UA and Window/Worker Navigator |
| `appVersion` | validated redundant value; Blink derives the same value from configured UA |
| `vendor` | invariant `Google Inc.` from Chromium's native Navigator implementation |
| `languages` | Window/Worker Navigator plus browser language launch settings |
| `hardwareConcurrency` | shared Window/Worker `NavigatorBase` |
| `deviceMemory` | shared Window/Worker `NavigatorDeviceMemory` |
| `maxTouchPoints` | Blink `NavigatorEvents` |
| `screen.*` | Blink `Screen` and `LocalDOMWindow`; `pixelDepth` delegates to configured `colorDepth` |
| `storageQuotaBytes` | Blink `StorageManager::estimate()` callback |
| `canvas.*` | detached 8-bit, float16 and float32 Canvas/OffscreenCanvas readbacks |
| `audio.*` | `AudioBuffer` and all analyser readback variants |
| `webgl.*` | WebGL 1/2 debug renderer parameter path in Window/Worker |
| `webgpu.*` | `GPUAdapter.info` / `GPUDevice.adapterInfo` vendor in Window/Worker |
| `webrtc.*` | native allocator routing plus ICE candidate and SDP rewriting |
| `timezone` | Chromium ICU/V8 `--time-zone-for-testing` process setting |
| `geolocation.*` | Blink native request/result policy |
| `mediaDevices.*` | enumeration, constraints, track settings/capabilities and output routing |
| `fonts` | Blink platform font cache and Local Font Access allow-list |
| `doNotTrack` | renderer preferences, DOM value and Window/Worker request headers |
| `speechSynthesis.*` | browser TTS voice list plus synthetic-to-actual playback mapping |

Fields such as search engine, image/audio blocking, password prompts, domain
blocking, port-scan policy and an empty TLS cipher blacklist are browser product
policies rather than fingerprint schema fields. They require separate product
requirements and are not evidence of a native identity mismatch.
