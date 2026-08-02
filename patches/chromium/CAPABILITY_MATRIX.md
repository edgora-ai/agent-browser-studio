# Chromium capability alignment matrix

Status meanings: `config` is available to the application, `native` is
implemented in the owning Chromium subsystem, and `verified` has passed an
explicit comparative/runtime acceptance harness. This fork does not inject
JavaScript into pages.

| Surface | Public/observable RoxyChrome baseline | Community Chromium 150 status | Native target |
|---|---|---|---|
| UA + Navigator | Configurable | verified | Blink Navigator + network UA |
| UA Client Hints | Configurable | verified | Blink + Sec-CH-UA headers |
| Do Not Track | Enabled identity/header | verified | renderer preferences + Worker requests |
| Platform/language | Configurable | verified | Window/Worker Navigator + network headers |
| CPU/memory/touch | Configurable | verified | Window/Worker Navigator + touch identity |
| Screen/DPR/depth | Configurable | verified | Blink Screen + LocalDOMWindow |
| Canvas | Stable noise | verified | idempotent 8-bit, float16 and float32 readbacks |
| Audio | Stable noise | verified | AudioBuffer + analyser readback paths |
| WebGL vendor/renderer | Configurable | partial | WebGL 1/2 full parameter and capability corpus remains |
| WebGPU adapter | Configurable | partial | adapter info is native; full features/limits/device corpus remains |
| WebRTC | Real/altered/disabled | verified | allocator + candidate + SDP paths |
| Fonts | Allow-list + profile directory | partial | CoreText registration is native; cross-platform metrics/fallback/emoji remain |
| Timezone | Configurable | verified | Blink `TimeZoneController` + ICU/V8 process timezone |
| ClientRects | Stable noise | verified | Blink layout geometry export |
| Geolocation | Real/disabled/custom | verified | Blink request/result path |
| Workers | Identity parity | verified | shared Navigator/Canvas/WebGL/WebGPU/storage paths |
| Plugins/MIME types | Stable PDF identity | verified | Blink DOMPluginArray |
| Speech voices | Locale/platform identity | verified | browser TTS list + playback mapping |
| Media devices | Stable labels/count/IDs | verified | enumeration, constraints, settings and output routing |
| Storage quota | Configurable | partial | StorageManager/Buckets are native; deeper legacy/incognito paths remain |
| WebAuthn capabilities | Platform-shaped | verified | PublicKeyCredential capability and availability paths |
| AAC/H.264 codecs | Chrome codec surface | verified | media MIME, MSE, MediaCapabilities and WebCodecs paths |

Installed Chromium `150.0.7871.114` also verifies native trusted CDP input,
seeded humanized mouse/keyboard/wheel behavior, exact 150/149 selection and
rollback, native-host pass-through, and explicit third-party-cookie
compatibility with exact preference restoration. The strict verifier checks 48
surfaces; the targeted installed-app journeys pass `8/8` without a license
environment.

Alignment is complete only when the required rows are `native` and the same
profile is stable across restarts while different seeds produce distinct,
internally consistent identities.
