# Fingerprint capability alignment requirements

This document defines what “aligned” means for the independent Chromium build.
It intentionally uses only stock-Chrome behavior, public CloakBrowser release
notes, and observable RoxyChrome behavior as comparison inputs. Proprietary
source code, encrypted profile formats, and recovered implementation details
are out of scope.

## Baselines

- Stock Chromium/Chrome: `150.0.7871.114`.
- CloakBrowser wrapper baseline: public release
  [`0.5.7`](https://github.com/CloakHQ/CloakBrowser/releases/tag/v0.5.7).
  The platform-specific public binary baseline is Chromium
  `150.0.7871.114.6` on Windows/Linux and `150.0.7871.114.3` on macOS.
- RoxyBrowser product baseline: public release
  [`4.0.2`](https://roxybrowser.com/changelog#1311) with Chromium 150.
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
| Humanized interaction policy | verified | Preserve seeded, bounded mouse, keyboard and scroll behavior at the app layer | isolated-world actionability, full cross-origin OOPIF recursion, iframe content-quad coordinate mapping, post-settle re-scroll, occlusion fail-closed, explicit key-hold timing and installed Chromium 150 J44/J50; no page-world prototype modification |
| HTTP proxy authentication | verified | Preserve browser-only Basic/Digest challenge handling without an extension | real Electron/profile 407 E2E, one-shot-file deletion and extension-surface audit |
| SOCKS5 TCP | verified | Preserve authenticated routing and proxy-side name resolution through the loopback bridge | unit rejection/echo corpus plus real Electron/Profile remote-domain E2E and bridge lifecycle check |
| SOCKS5 UDP / QUIC / HTTP3 | verified | Preserve authenticated TCP/UDP routing, proxy-side DNS and fail-closed behavior on older/HTTP-only paths | profile-owned MASQUE bridge, per-flow SOCKS5 UDP ASSOCIATE, RFC 9297 oversized-datagram Capsule fallback and real Electron/Profile HTTP/3 E2E |
| Proxy timing, cache and header signals | verified | Preserve IPv4/IPv6, direct/HTTP/SOCKS structural parity as Chromium evolves | HTTP/HTTPS Window/Worker/frame/Service Worker headers, WSS, Navigation/Resource Timing, cache and ETag revalidation corpus against stock Chrome and Cloak; bracketed IPv6 and proxy-side-DNS environment URL parsing |
| Managed secure DNS inside exit proxy | verified | Keep every DNS query (including the DoH probe) inside the exit proxy with no host-resolver fallback | network-log corpus for HTTP and SOCKS5 modes showing zero direct connects, zero host-resolver jobs and zero out-of-proxy DNS; `verify-managed-doh` tool and 1108 green DNS/NetworkService unit tests |
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

- version-aware automatic updates with rollback — ✅ verified (see the Release store & rollback table below);
- Docker/server mode and Python/JavaScript/.NET integration surfaces — ✅ verified (see the Server mode & integration surfaces table below);
- Widevine/DRM discovery for persistent profiles — ✅ verified (see the DRM/Widevine table below);
- Windows and Linux production verification;
- team workspace semantics (RBAC, locks, conflict handling), not only object
  storage backup — ✅ verified (see the Team RBAC table below);
- proxy health/history/rotation as managed assets — ✅ verified (see the Proxy health assets table below).

### DRM / Widevine — verified

| Capability | Current state | Target | Completion evidence |
|---|---|---|---|
| Widevine/DRM for persistent profiles | verified | Discover a host CDM, enable per profile, and register it in the independent build without bundling Google components | CDM discovery (Chrome/Brave/Edge/Chromium app bundles, user-data, configured override, managed copy); per-profile gating; real EME probe over CDP returning `com.widevine.alpha` for a DRM profile (host Chrome 150 CDM `4.10.3050.0`) and `NotSupportedError` for a plain profile; confirmed on the build-tree binary and the published runtime (`j66-drm` e2e) |

### Team workspace RBAC — verified

| Capability | Current state | Target | Completion evidence |
|---|---|---|---|
| Team workspace semantics (RBAC) | verified | Member-role model (owner > admin > member > viewer) with enforcement on sync push, force push and destructive profile ops, travelling with the sync snapshot | role hierarchy and permission-matrix unit tests; mock-S3 e2e proving the manifest ships on push, pull adopts a remotely-demoted viewer role, and push is blocked by team policy until the owner role is restored; viewer read-only, admin force-push/member management, owner-only rename/admin grants (`j67-team-rbac` e2e + `team` unit suite) |

### Server mode & integration surfaces — verified

| Capability | Current state | Target | Completion evidence |
|---|---|---|---|
| Headless server mode | verified | Run the full controller (scheduler + MCP + REST) without a window or tray for Linux VMs, containers and CI | `--headless` / `--server` / `AGENT_BROWSER_HEADLESS=1` startup branch; e2e `j68-server-mode` proves zero GUI windows while `/health` reports `mode: "headless"` and profile launch/stop work over REST |
| Docker deployment | verified | Ship a repeatable controller image with the proxy bridge and Node 22 runtime | `Dockerfile` (golang:1.25 build stage + node:22 runtime with apt shared-lib layer) + `docker-compose.yml` (data volume, 26582 port); Linux engine binary remains the platform-limited piece tracked under signed multi-platform distribution |
| Python integration surface | verified | Zero-dependency REST client for profiles, proxies, DRM, team RBAC, runs and jobs | `sdk/python/agent_browser_client.py` stdlib-only client exercised against a live headless instance (health → create → launch cdpPort → status → stop → team) |
| OpenAPI discovery for JS/.NET | verified | Any consumer can generate a client from the running controller | `GET /openapi.json` served on the loopback REST API, documented for JavaScript/.NET consumers |

### Release store & rollback — verified

| Capability | Current state | Target | Completion evidence |
|---|---|---|---|
| Version-aware update check | verified | Compare a release manifest against the running version and surface only installable releases | manifest parse/validate (product match, numeric version sort, sha256 format, duplicate rejection), `minSupported` gating, http(s)/file/local manifest sources; unit + REST e2e (`j69-updates`) |
| Staged install with integrity | verified | Download + sha256-verify + atomically stage a payload without touching the active runtime | payload archives verified against the declared sha256 (mismatch rejected), zip extracted with path-traversal/size caps via the shared zip-writer, directory payloads copied; payload lands under `<appData>/updates/releases/<version>/payload` |
| Version pin + manual rollback | verified | Keep the previous known-good release and switch back on demand | `activateVersion` pins the active version and remembers the previous; `rollback` restores it; both audited and persisted (`j69` + `update-manager` unit suite) |
| Crash-loop auto-rollback | verified | After repeated abnormal starts, fall back to the previous known-good automatically | `noteAppCrashed`/`noteAppStarted`/`markAppHealthy` with a 3-strike threshold and 10-min cooldown to prevent flip-flopping; unit-tested |
| Release retention & audit | verified | Keep active + previous + newest staged, record every transition | retention prunes to 3 payloads; install/activate/rollback/auto-rollback recorded in the audit log and persisted history |

### Proxy health assets — verified

| Capability | Current state | Target | Completion evidence |
|---|---|---|---|
| Rolling health score + risk tiers | verified | Turn proxies from config entries into risk-managed assets | per-proxy score (checks/successes/latency/drift), good/watch/poor tiers, cooldown after repeated failures, persisted history of up to 20 detection points (IP/country/tz/provider/latency/error) and suggestion text; `proxy-health` unit suite |
| Exit-IP / geo drift + bindings | verified | Detect proxy churn and which profiles use a proxy | distinct-exit-IP and geo-drift counters plus per-profile binding computation surfaced in REST/UI; unit-tested |
| Rotation with healthy fallbacks | verified | Automatically route around an unhealthy proxy to a healthy fallback | `pickRotationFallback` skips unhealthy/self names, `recordProxyRotation` persists the switch and audits it; REST rotate/rotation + UI badge; e2e `j70` rotates an unhealthy proxy to `fallback-a` |
| Managed-assets UI (history timeline) | verified | Operators can inspect a proxy risk asset, its history and fallback state in-app | Proxy tab health badge/summary/bindings/rotation row plus an expandable 📈 history timeline rendering recent success/failure detections; e2e `j70` (detect -> poor -> rotate -> history) + `j29` regression |

CloakLite already has product capabilities that a browser wrapper alone does
not provide: local profile management, encrypted credentials, approval gates,
audit history, durable automation jobs, AI tools, MCP, extension management,
fingerprint drift baselines and S3-compatible sync. Those strengths do not
waive any engine row above.

RoxyBrowser `4.0.2` publicly emphasizes AI Agent 2.0 orchestration of RPA,
Skills and prompts, scheduled templates, live monitoring and rolling logs.
CloakLite already covers those capability categories through tool-calling
Skills, task templates, durable scheduled jobs, Activity and run traces. This
is category alignment, not a claim that the proprietary template catalogs or
platform adapters are identical.

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
proxy routing. Patchset `0041` additionally advertises the managed QUIC
capability and passes a real UDP-capable SOCKS5 HTTP/3 Profile journey with no
license environment. J50 verifies trusted type/click/key input through two
cross-origin OOPIF levels, late-layout reconciliation, covered-target rejection
and exact explicit key-hold timing on both the source and installed Chromium
builds. J51 verifies that the packaged controller has no upstream wrapper
dependency or fallback: legacy wrapper environment variables are ignored and a
missing independent build fails closed without downloads or cache writes.
Installing the updated App leaves the existing CloakLite config and six-profile
tree byte-for-byte unchanged.

Using the stage labels in this matrix, 35 of 36 engine/network/lifecycle rows
are currently `verified`, none is `partial`, and 1 is `missing`. The remaining
hard missing row is signed multi-platform distribution. These counts are
workflow gates, not a browser quality percentage.

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
5. Direct and proxied network comparisons, including managed SOCKS5 HTTP/3,
   pass without page JavaScript injection or prototype replacement.
6. Packaged CloakLite contains no upstream wrapper dependency, selects only the
   verified independent binary without a license key or fallback, and passes the
   complete unit, E2E and installed-app smoke suites.
