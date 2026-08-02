# Fingerprint capability alignment requirements

This document defines what “aligned” means for the independent Chromium build.
It intentionally uses only stock-Chrome behavior, public CloakBrowser release
notes, and observable RoxyChrome behavior as comparison inputs. Proprietary
source code, encrypted profile formats, and recovered implementation details
are out of scope.

## Baselines

- Stock Chromium/Chrome: `150.0.7871.114`.
- CloakBrowser wrapper baseline: `0.5.3`; public binary baseline: Chromium
  `150.0.7871.114.3` on macOS and
  Windows (71 publicly reported source-level patches); Linux also has
  `150.0.7871.114.4` (73 publicly reported patches).
- RoxyBrowser product baseline: public release `4.0.0` with Chromium 150.
  Deep comparison evidence still comes from the observable Chromium 149 corpus
  captured locally; exact proprietary implementation details are not an
  acceptance input.

Patch counts are not comparable units of functionality. A row is complete only
when its owning Chromium subsystem consumes the profile identity and the stated
runtime evidence passes.

Status meanings:

- `verified`: native implementation plus runtime evidence.
- `partial`: a native implementation exists, but the public comparison covers
  a deeper surface or the required evidence is incomplete.
- `missing`: no independent native implementation yet.
- `stock`: the desired result is unmodified stock-Chrome parity; a patch is not
  required, but comparative evidence is.

## Identity and rendering

| Capability | Current 150 state | Remaining alignment target | Completion evidence |
|---|---|---|---|
| UA, Navigator and UA-CH | verified | Preserve in top frame, subframes and all Worker types, including after CDP UA operations | DOM + request headers + high-entropy UA-CH across contexts |
| Platform, language and DNT | verified | Preserve across Window, frames and Worker requests | DOM and loopback request-header comparison |
| CPU, memory and touch | verified | Values must belong to one plausible hardware profile | repeated reads, Worker parity and joint-profile validation |
| Screen and DPR | verified | Preserve window/screen geometry coherence and stock window-mode behavior | screen, avail, outer/inner, screenX/Y and headed/headless checks |
| Canvas and OffscreenCanvas | verified | Preserve idempotence for integer and float readbacks | visible backing-store invariance, restart stability, cross-seed distinction |
| AudioBuffer and analyser | verified | Add codec/audio-capability coherence | offline/realtime reads plus codec capability comparison |
| ClientRects | verified | Preserve across zoom/DPR and repeated layout reads | repeat-read, zoom and cross-context checks |
| WebGL identity | verified | Preserve the observable deep capability surface as Chromium evolves | Window/Worker WebGL 1/2: 39/36 extensions, 26/53 parameters and shader precision exactly match six observable RoxyChrome Profiles (`WEBGL_CORPUS.md`) |
| WebGPU identity | verified | Preserve version-matched adapter/device capabilities and cross-API GPU identity | Window/Worker adapter/device info, 23 features, 36 limits and 11 WGSL features match Stock Chrome 150; Windows identity is more coherent than the observable RoxyChrome reference (`WEBGPU_CORPUS.md`) |
| Fonts | verified | Preserve target-platform metrics, fallback, emoji and system rendering coherence | Window/Worker equality across 39 candidates, 390 generic metrics, 468 named metrics and 247 rasters; Local Font Access has no configuration-external family and Canvas/DOM stays within 2 px (`FONT_CORPUS.md`) |
| System colors and selection rendering | verified | Preserve the declared platform and seeded light/dark preference | 19 CSS system colors in preferred/light/dark schemes plus screenshot pixel evidence for Windows/macOS selection paint |
| Speech voices | verified | Maintain locale/platform coherence and playable mapping | enumeration, repeat reads and successful playback selection |
| Plugins and MIME types | verified | Preserve stock version-appropriate plugin identity | Window/Worker exposure and descriptor checks |
| Media devices | verified | Preserve labels, IDs, constraints, capabilities and output routing | enumeration plus exact/ideal constraints and track settings |
| Timezone and geolocation | verified | Preserve through host notifications, frames and Workers | offset/Intl/date plus real/disabled/custom geolocation checks |
| Storage quota | verified | Preserve one managed quota without changing stock API exposure | Window/Worker StorageManager, Buckets and OPFS plus Window legacy temporary/persistent query/request and FileSystem paths across persistent/incognito contexts (`STORAGE_CORPUS.md`) |
| WebAuthn capabilities | verified | Match declared Chrome/platform capabilities | PublicKeyCredential capability and authenticator-transport probes |
| Media codecs and AAC | verified | Match the declared Chrome/platform codec set | `canPlayType`, MediaSource, MediaCapabilities and encode/decode capability corpus |

## Automation and network behavior

| Capability | Current 150 state | Remaining alignment target | Completion evidence |
|---|---|---|---|
| `navigator.webdriver` and basic headless identity | stock/verified | Remain stock-looking without `--enable-automation` | headed/headless DOM and descriptor checks |
| CDP-generated input behavior | verified | Preserve native trusted-event routing as Chromium evolves | installed Chromium 150 trusted mouse/keyboard/wheel corpus, including exact occluded-window scroll offset/delta completion, with no untrusted events |
| Humanized interaction policy | verified | Preserve seeded, bounded mouse, keyboard and scroll behavior at the app layer | deterministic distribution/range tests, compositor-paced pointer points and installed Chromium 150 E2E; no page injection |
| HTTP proxy authentication | verified | Preserve browser-only Basic/Digest challenge handling without an extension | real Electron/profile 407 E2E, one-shot-file deletion and extension-surface audit |
| SOCKS5 TCP | verified | Preserve authenticated routing and proxy-side name resolution through the loopback bridge | unit rejection/echo corpus plus real Electron/Profile remote-domain E2E and bridge lifecycle check |
| SOCKS5 UDP / QUIC / HTTP3 | missing | Managed proxies currently fail closed with QUIC disabled; add UDP-capable proxy transport | controlled SOCKS5 UDP-associate and HTTP/3 endpoint test |
| Proxy timing, cache and header signals | verified | Preserve direct/HTTP/SOCKS structural parity as Chromium evolves | HTTP/HTTPS Window/Worker/frame/Service Worker headers, WSS, Navigation/Resource Timing, cache and ETag revalidation corpus against stock Chrome and Cloak |
| WebRTC routing and visible identity | verified | Maintain proxy-coherent candidates, SDP and disabled mode | ICE/SDP plus leak tests in Window and frame contexts |
| TLS, HTTP/2 and HTTP/3 stock parity | verified | Preserve the same-major Stock Chromium wire identity without spoofing | two cold-process samples: normalized TLS ClientHello/JA4, H2 SETTINGS/WINDOW_UPDATE/frame/header order and H3 QUIC Client Initial/ClientHello/transport parameters exactly match Stock Chrome 150 (`NETWORK_FINGERPRINT_CORPUS.md`) |
| Third-party-cookie compatibility mode | verified | Preserve explicit opt-in for embedded auth/payment/challenge flows | real cross-site iframe cookie E2E, opt-in isolation and exact preference restoration |

## Profile coherence and lifecycle

| Capability | Current state | Target | Completion evidence |
|---|---|---|---|
| Same-seed restart stability | verified | Preserve on Chromium 150 | at least two fresh user-data directories and one restart |
| Cross-seed distinction | verified | Extend to all seeded deep surfaces | pairwise diff with required-distinct field set |
| Joint hardware profiles | verified | Preserve versioned CPU/RAM/GPU/screen/DPR/font/audio tuples and reject incoherent overrides | 1,000-config Windows/macOS seed corpus, partial-constraint resolution, conflict rejection and native runtime checks |
| Headed/headless parity | verified | Preserve the same declared identity with only measured stock differences | full 53-surface paired capture; only Stock-matched `screenY`/`innerHeight` window-decoration differences on macOS |
| Persistent-context parity | verified | Preserve identity and capabilities after closing and reopening the same Profile | full 53-surface fresh-directory, same-directory restart and independent-directory comparison |
| Pass-through/debug mode | verified | Preserve a stock comparison mode without mixed identity | 53-surface native-host comparison, including host theme, with all managed profile consumers disabled |
| Version pin and rollback | verified | Select an installed exact build and retain previous known-good build | installed Chromium 150/149 exact selection and rollback integration tests |
| Signed multi-platform distribution | missing | macOS arm64/x64, Windows x64, Linux x64/arm64 | reproducible build metadata, checksums/signatures and platform E2E |

## Product-level capabilities

These do not prove browser stealth, but they are required for feature parity of
the complete product rather than only the engine:

- version-aware automatic updates with rollback;
- Docker/server mode and Python/JavaScript/.NET integration surfaces;
- Widevine/DRM discovery for persistent profiles;
- Windows and Linux production verification;
- team workspace semantics (RBAC, locks, conflict handling), not only object
  storage backup;
- proxy health/history/rotation as managed assets.

CloakLite already has product capabilities that a browser wrapper alone does
not provide: local profile management, encrypted credentials, approval gates,
audit history, durable automation jobs, AI tools, MCP, extension management,
fingerprint drift baselines and S3-compatible sync. Those strengths do not
waive any engine row above.

## Current verified build

The independently built Chromium `150.0.7871.114` macOS arm64 binary at upstream
commit `f405107495a07cb1bfcf687d4af8d91117098db6` passes the strict 53-surface
verifier across a same-Profile close/reopen, an independent same-seed Profile,
a different seed, `el-GR`/`el-CY` locale coherence, a full headed run and
native-host pass-through. Headed/headless results are identical except for the
same macOS window-decoration `screenY` and `innerHeight` differences measured
from Stock Chrome 150 and the managed binary's no-config path. A further 61
checks cover preferred/light/dark CSS system colors and actual selection
screenshot pixels for both declared platforms. Verified runtime surfaces include
Window/Dedicated/Shared/Service Worker identity, AAC/H.264,
audio capture, native modern/Buckets/legacy storage quota and OPFS/FileSystem
persistent/incognito parity, WebAuthn, media-device remapping,
WebRTC disable mode, the RoxyChrome-matched WebGL 1/2 capability hash, the
Stock-150 WebGPU adapter/device capability hash, the Window/Worker/DOM/Local
Access font corpus, CDP identity, system-theme
coherence and exact
build-version coherence.

The installed-cache journey retains Chromium `149.0.7827.22` alongside 150 and
passes exact selection, rollback, pass-through, trusted humanized input and
third-party-cookie compatibility/restoration and authenticated HTTP/SOCKS
proxy routing (`15/15` targeted E2E) with the
license environment explicitly absent. Installing 150 leaves the existing
CloakLite config and six-profile tree byte-for-byte unchanged.

Using the stage labels in this matrix, 34 of 36 engine/network/lifecycle rows
are currently `verified`, none is `partial`, and 2 are `missing`. The two hard
missing rows are SOCKS5 UDP/QUIC/HTTP3 and signed multi-platform distribution.
These counts are workflow gates, not a browser quality percentage.

## Completion gates

The alignment goal is complete only when all of the following are true:

1. Every row above is `verified` or is explicitly proven to have stock-Chrome
   behavior; no `partial` or `missing` row remains in the agreed platform scope.
2. The Chromium 150 patch series applies in order to a clean upstream index and
   its source payload matches the built checkout.
3. The strict verifier covers Window, subframes, Dedicated/Shared/Service
   Workers, headed/headless and persistent contexts where applicable.
4. Same identity is stable across fresh launches and restarts; different seeds
   differ only on seeded surfaces and remain internally coherent.
5. Direct and proxied network comparisons pass without page JavaScript
   injection or prototype replacement.
6. Packaged CloakLite selects the verified independent binary without a license
   key and passes the complete unit, E2E and installed-app smoke suites.
