# Chromium capability alignment matrix

Status meanings: `config` is available to the application, `native` is
implemented in the owning Chromium subsystem, and `verified` has passed the
cross-browser E2E harness. This fork does not inject JavaScript into pages.

| Surface | RoxyChrome 149 baseline | Community 149+ status | Native target |
|---|---|---|---|
| UA + Navigator | Configurable | native | Blink Navigator + network UA |
| UA Client Hints | Configurable | native | Blink + Sec-CH-UA headers |
| Platform/language | Configurable | native | Window/Worker Navigator + network headers |
| CPU/device memory | Configurable | native | Window/Worker Navigator |
| Screen/DPR/depth | Configurable | native | Blink Screen + LocalDOMWindow |
| Canvas | Stable noise | native | 8-bit, float16 and float32 readbacks |
| Audio | Stable noise | native | AudioBuffer + analyser readback paths |
| WebGL vendor/renderer | Configurable | native | WebGL 1/2 parameter path |
| WebRTC | Exit-IP policy | native | allocator + candidate + SDP paths |
| Fonts | Allow-list | partial native | custom font directory loading |
| Timezone | Configurable | native Chromium switch | ICU/V8 process timezone |
| ClientRects | Stable noise | native | Blink layout geometry export |
| Geolocation | Real/disabled/custom | native | Blink request/result path |
| Workers | Identity parity | partial native | remaining worker-only surfaces |
| Plugins/MIME types | Stable 5 PDF / 2 MIME | native | Blink DOMPluginArray |
| Media devices | Stable labels/count/IDs | partial native | exact-device constraint remapping |
| Storage quota | Configurable | native | StorageManager estimate callback |

Alignment is complete only when the required rows are `native` and the same
profile is stable across restarts while different seeds produce distinct,
internally consistent identities.
