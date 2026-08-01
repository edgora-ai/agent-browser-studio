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
- RoxyChrome baseline: public/observable Chromium 149 behavior previously
  captured by the cross-browser harness. Exact proprietary implementation
  details are not an acceptance input.

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

| Capability | Current 149 state | Chromium 150 target | Completion evidence |
|---|---|---|---|
| UA, Navigator and UA-CH | verified | Preserve in top frame, subframes and all Worker types, including after CDP UA operations | DOM + request headers + high-entropy UA-CH across contexts |
| Platform, language and DNT | verified | Preserve across Window, frames and Worker requests | DOM and loopback request-header comparison |
| CPU, memory and touch | verified | Values must belong to one plausible hardware profile | repeated reads, Worker parity and joint-profile validation |
| Screen and DPR | verified | Add window/screen geometry coherence | screen, avail, outer/inner, screenX/Y and headed/headless checks |
| Canvas and OffscreenCanvas | verified | Preserve idempotence for integer and float readbacks | visible backing-store invariance, restart stability, cross-seed distinction |
| AudioBuffer and analyser | verified | Add codec/audio-capability coherence | offline/realtime reads plus codec capability comparison |
| ClientRects | verified | Preserve across zoom/DPR and repeated layout reads | repeat-read, zoom and cross-context checks |
| WebGL identity | partial | Cover the stock parameter/capability set, not only vendor and renderer | WebGL 1/2 parameter corpus compared with a plausible reference GPU |
| WebGPU identity | partial | Cover adapter info, features, limits, device IDs and subgroup properties | Window/Worker adapter corpus and cross-API GPU consistency |
| Fonts | partial | Add target-platform metrics, fallback, emoji and system rendering coherence | availability + measured glyph corpus + canvas emoji/reference metrics |
| System colors and selection rendering | missing | Match the declared platform | CSS system-color and selection rendering probes |
| Speech voices | verified | Maintain locale/platform coherence and playable mapping | enumeration, repeat reads and successful playback selection |
| Plugins and MIME types | verified | Preserve stock version-appropriate plugin identity | Window/Worker exposure and descriptor checks |
| Media devices | verified | Preserve labels, IDs, constraints, capabilities and output routing | enumeration plus exact/ideal constraints and track settings |
| Timezone and geolocation | verified | Preserve through host notifications, frames and Workers | offset/Intl/date plus real/disabled/custom geolocation checks |
| Storage quota | partial | Cover `StorageManager`, Storage Buckets and legacy quota paths | normal/persistent/incognito-shaped contexts across all quota APIs |
| WebAuthn capabilities | verified | Match declared Chrome/platform capabilities | PublicKeyCredential capability and authenticator-transport probes |
| Media codecs and AAC | verified | Match the declared Chrome/platform codec set | `canPlayType`, MediaSource, MediaCapabilities and encode/decode capability corpus |

## Automation and network behavior

| Capability | Current 149 state | Chromium 150 target | Completion evidence |
|---|---|---|---|
| `navigator.webdriver` and basic headless identity | stock/verified | Remain stock-looking without `--enable-automation` | headed/headless DOM and descriptor checks |
| CDP-generated input behavior | missing | Remove synthetic input distinctions while preserving normal input semantics | trusted mouse/keyboard/touch event corpus against stock Chrome |
| Humanized interaction policy | missing | Seeded, bounded mouse, keyboard and scroll behavior at the app layer | deterministic tests plus distribution/range checks; no page injection |
| HTTP proxy authentication | partial | Prefer native version-aware authentication; extension fallback must not alter observable state | authenticated HTTP/HTTPS proxy E2E and extension-surface audit |
| SOCKS5 TCP | partial | Native authenticated routing with remote DNS | DNS-leak and authenticated routing tests |
| SOCKS5 UDP / QUIC / HTTP3 | missing | Preserve UDP/QUIC where the proxy supports it | controlled SOCKS5 UDP-associate and HTTP/3 endpoint test |
| Proxy timing, cache and header signals | missing | Avoid proxy-only timing/header/cache identity drift | direct-vs-proxy controlled origin corpus |
| WebRTC routing and visible identity | verified | Maintain proxy-coherent candidates, SDP and disabled mode | ICE/SDP plus leak tests in Window and frame contexts |
| TLS, HTTP/2 and HTTP/3 stock parity | stock, unverified | Do not diverge from the same stock Chromium build | JA4/HTTP2 settings/HTTP3 comparative harness; no spoofed claims |
| Third-party-cookie compatibility mode | missing | Explicit opt-in for embedded auth/payment/challenge flows | partitioned/unpartitioned cookie E2E |

## Profile coherence and lifecycle

| Capability | Current state | Target | Completion evidence |
|---|---|---|---|
| Same-seed restart stability | verified | Preserve on Chromium 150 | at least two fresh user-data directories and one restart |
| Cross-seed distinction | verified | Extend to all seeded deep surfaces | pairwise diff with required-distinct field set |
| Joint hardware profiles | partial | Generate CPU/RAM/GPU/screen/DPR/font/audio as one plausible profile | profile corpus constraints and cross-field invariant tests |
| Headed/headless parity | partial | Same declared identity with only unavoidable stock differences | paired headed/headless capture and allow-listed diff |
| Persistent-context parity | partial | No incognito/storage/window geometry drift | fresh vs persistent comparative capture |
| Pass-through/debug mode | missing | Explicitly disable spoofing without leaving a mixed identity | stock comparison with all profile consumers disabled |
| Version pin and rollback | missing | Select an installed exact build and retain previous known-good build | install/select/rollback integration tests |
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

The Chromium `149.0.7827.22` macOS arm64 build passes three fresh launches with
37 stable fingerprint fields, same-seed restart stability, cross-seed
distinction, Window/Dedicated/Shared/Service Worker request identity, native
Storage Buckets quota, WebAuthn capabilities, media-device remapping and
AAC/H.264 playback, decoding and encoding. The Chromium 150 patch sequence
applies to a clean `150.0.7871.114` index, but a Chromium 150 binary has not yet
been built and runtime-verified. The installed-cache application journey also
passes profile creation, native launch, CDP Chrome/Windows identity checks and
shutdown without using a CloakBrowser license.

Using the stage labels in this matrix, 17 of 36 engine/network/lifecycle rows
are currently `verified`, 9 are `partial`, 9 are `missing`, and 1 stock-network
row remains unverified. These counts are workflow gates, not a browser quality
percentage: several missing rows are packaging or network operations, while
several verified surface rows still have a deeper Chromium 150 target stated
in their target column.

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
