# Chromium capability alignment matrix

Status meanings: `config` is available to the application, `renderer` is
applied before page scripts, `native` is implemented in the owning Chromium
subsystem, and `verified` has passed the cross-browser E2E harness.

| Surface | RoxyChrome 149 baseline | Community 149+ status | Native target |
|---|---|---|---|
| UA + Navigator | Configurable | native | Blink Navigator + network UA |
| UA Client Hints | Configurable | native | Blink + Sec-CH-UA headers |
| Platform/language | Configurable | native | Window/Worker Navigator + network headers |
| CPU/device memory | Configurable | native | Window/Worker Navigator |
| Screen/DPR/depth | Configurable | native | Blink Screen + LocalDOMWindow |
| Canvas | Stable noise | partial native | float pixel formats |
| Audio | Stable noise | native | AudioBuffer + analyser readback paths |
| WebGL vendor/renderer | Configurable | native | WebGL 1/2 parameter path |
| WebRTC | Exit-IP policy | partial renderer | P2P/ICE candidate gathering |
| Fonts | Allow-list | partial renderer | font matching and enumeration |
| Timezone | Configurable | renderer + Chromium switch | ICU timezone override |
| ClientRects | Stable noise | renderer | Blink layout geometry export |
| Geolocation | Policy | renderer | browser geolocation service |
| Workers | Identity parity | partial native | remaining worker-only surfaces |
| Plugins/MIME types | Stable | missing | Blink plugin data |
| Media devices | Stable labels/count | missing | media device enumeration |
| Storage quota | Configurable | native | StorageManager estimate callback |

Alignment is complete only when the required rows are `native` and the same
profile is stable across restarts while different seeds produce distinct,
internally consistent identities.
