# Agent Browser Chromium 152 patch set

This directory is the independent Chromium implementation used by
Agent Browser Studio. It does not contain CloakBrowser Pro binaries, recovered
keys, `lumi.conf` decryption, or code copied from RoxyChrome.

## Baseline

- Chromium tag: `152.0.7977.72`
- Commit: `026bb13a93d60e7adfefa2bbf58d6f57c2d335cc`
- Config switch: `--agent-browser-fingerprint-config=<base64url-json>`
- Legacy compatibility switch: `--roxy-fingerprint-config=<base64url-json>`
- Config schema: `1`

## Apply

```bash
./patches/chromium/check.sh /path/to/chromium/src
./patches/chromium/apply.sh /path/to/chromium/src
```

Released Chromium changes are append-only: add the next numbered patch instead
of rewriting an earlier patch. The current `0002`–`0055` chain keeps the
system-theme, occluded-input, managed-QUIC, payload-resume and secure-DNS changes
independently reviewable and revertible. `check.sh` validates exact Git checkouts
or the trusted official-archive plus immutable-delta source chain.
`PATCHSET.sha256` detects any rewrite of an already released patch or source
payload, and `PATCH_HISTORY.md` records the OSS and Chromium source provenance.
Patch `0042` adds the Agent Browser public protocol without rewriting
`0002–0041`. Patch `0043` adds an advertised, managed-only switch that hides
the missing-Google-API-key information bar without fabricating a key or
enabling unavailable services. Patch `0044` keeps managed secure DNS inside
the exit proxy, preserves managed ICU locale/fonts and keeps the native refresh
rate. `0045`/`0046` add Widevine registration and the title prefix. The
append-only `0047`–`0050` fixes discovered by the real 152 compile preserve
payload evolution, generic-font semantics and secure-DNS parsing across
incremental resumes. Patch `0051` adds a restricted, fingerprint-independent
proxy local-DNS deny policy without suppressing bad-flag warnings. Patch `0052`
permits DNS-only hints over explicitly configured strict proxy DoH while keeping
multicast names, ordinary proxy preconnects and preloading gates unchanged.
Patch `0053` corrects the GURL accessor and delegate definition after an actual
translation-unit compile rejected `0052`; it does not weaken the DNS policy.
Patch `0054` removes forced clonefile from macOS bundle resource copying after
an actual cross-volume build failure, without changing browser behavior or
release compiler settings. Patch `0055` corrects the shared managed macOS
high-entropy CPU architecture producer: `base::mac::GetCPUType()` maps Intel to
`x86` and both ARM and translated Intel (Rosetta) to `arm`, matching native
Chromium semantics. The API and its include are guarded by `BUILDFLAG(IS_MAC)`;
Blink public/common headers already publicly depend on `//base`, which exports
this API, so no embedder dependency or GN dependency change is needed. Other OS
personas, `bitness: "64"`, low-entropy/off behavior and GPU fall-through remain
unchanged. This source correction changes no payload schema or legacy UA token.
Source constraint tests and normal apply/check are not native compilation,
native CPU/Rosetta runtime tests or Ping0 GPU acceptance; a rebuilt kernel and
independent real-site verification are still required. The next Chromium change
must start at `0056`.

## Build configuration

Use the checked-in release arguments so the binary exposes the same public
AAC/H.264 codec surface as a normal Chrome installation and is compiled as an
official build (ThinLTO, no debug symbols). The template keeps
`is_official_build=true` and `chrome_pgo_phase=0`; the verified build measured
at or above stock Chrome 151 on the string, array-sort and Canvas2D
micro-benchmarks (see docs/verification), so PGO is not required for parity
on this hardware.

```bash
cp ./patches/chromium/args.gn /path/to/chromium/src/out/AgentBrowserRelease/args.gn
cd /path/to/chromium/src
# add target_cpu = "arm64" to args.gn on Apple Silicon, then:
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer gn gen out/AgentBrowserRelease
autoninja -C out/AgentBrowserRelease chrome
```

The template enables `proprietary_codecs` and uses the Chrome FFmpeg branding.
Anyone distributing a binary built this way is responsible for the applicable
codec patent and distribution requirements in their jurisdictions.

The application creates the encoded configuration from normal profile fields.
No profile encryption key is embedded into Chromium.
New builds advertise the public fingerprint, proxy-auth, and QUIC contracts
through `--agent-browser-capabilities`. Chromium 149 and pre-`0042` builds
remain usable through the unadvertised legacy aliases.

## Current implementation

The renderer reads one immutable process-wide configuration directly from
Blink/public common code. There is no page-script injection or JavaScript
prototype replacement. The implementation covers deterministic
Navigator/User-Agent Client Hints, screen/DPR, Canvas, AudioBuffer, WebGL,
WebRTC policy, font enumeration, ClientRects, timezone reporting, media/plugin
enumeration, geolocation policy, and declared-platform system themes.

Native patches now apply the same UA, UA Client Hints headers, platform,
language, CPU, memory, touch, screen and DPR identity in Blink, the network
stack and workers. Do Not Track is also applied through renderer preferences
so the DOM value and Window/Dedicated/Shared/Service Worker request headers
remain consistent. Chrome explicitly forwards the versioned profile configuration
only to renderer processes. Canvas `toDataURL`, `toBlob` and `getImageData`
readbacks use detached, stable native pixel noise without modifying the visible
backing canvas. WebGL
1/2 identity now comes from the native parameter path. AudioBuffer and analyser
readbacks apply stable native noise. OffscreenCanvas blob export shares the
same detached Canvas noise, WebGPU adapter vendor identity is native in both
Window and Worker, and storage estimates use the configured native quota.
Dedicated, Shared, and Service Worker Navigator values use the same immutable
profile identity as Window. Speech synthesis exposes a stable locale/platform
voice list while mapping selected voices to an available system voice for
playback. Media device IDs are remapped natively across
enumeration, exact/ideal constraints, track settings/capabilities and
audio-output routing. On macOS, profile font directories are registered with
CoreText before the renderer sandbox, and the
registered font metadata participates in Blink's native allow-list. Windows
profiles without an external font pack use only core fonts present on both
macOS and Windows, avoiding claims for unavailable Segoe/Calibri families.
The allow-list is enforced in Blink's platform-font lookup, and Windows CSS
generics resolve to managed portable families before host fallback. Window,
Worker, DOM, Canvas glyph/emoji raster and Local Font Access are covered by the
comparative corpus in `FONT_CORPUS.md`.
Canvas noise now covers 8-bit, float16 and float32 readbacks with an idempotent
per-profile least-significant-bit transform. Media enumeration exposes a
stable, origin-scoped desktop device set, and the standard Chromium PDF
plugin/MIME set is enforced in Blink. Geolocation `real`, `disable`, and
`custom` policies run in Blink's
native request/result path. Storage Buckets and deprecated temporary/persistent
query/request callbacks use the same configured quota as
`navigator.storage.estimate()`; OPFS and the legacy FileSystem path are covered
in persistent and incognito contexts. WebAuthn capability probes use the
profile's declared platform-authenticator identity. See
`CAPABILITY_MATRIX.md` for the acceptance status and `CONFIG_COVERAGE.md` for
the field-by-field native consumer audit.

The verified Chromium 152 build preserves the managed identity across CDP user-agent
operations, bind browser-window bounds to the declared screen geometry, extend
WebGPU adapter architecture/subgroup coherence, and keep trusted native input
routing for CDP-driven mouse, keyboard and wheel events. Managed occluded
windows retain FIFO renderer-ack bookkeeping, use a bounded rAF fallback, and
reconcile compositor scroll offsets into DOM state without duplicating later
commits; pass-through keeps Chromium's stock path. The application layer
paces seeded pointer points across compositor frames and adds exact
installed-version pins with 149 rollback retention, a native-host pass-through
mode, and explicit third-party-cookie compatibility with exact preference
restoration.
Humanized click/type/hover resolution enumerates the complete cross-origin
OOPIF target tree and performs geometry/actionability reads in an isolated
world. Iframe content quads map native coordinates back to the root viewport;
late layout movement triggers a second scroll and pointer move, known
occlusion fails closed, and explicit keyboard hold delays are retained.
Managed HTTP proxy authentication now uses a browser-only 407 challenge path.
The application passes credentials through a mode-0600 one-shot file that the
browser reads and deletes before child processes start; credentials no longer
require an observable extension on the verified build. Managed HTTP proxies
and older Chromium builds still disable QUIC, preventing an unproxied UDP
fallback. Builds advertising `roxy-quic-proxy-v1` route SOCKS5 profiles through
a profile-owned loopback MASQUE helper. Chromium uses ordinary CONNECT for TCP
and RFC 9298 CONNECT-UDP for HTTP/3; the helper authenticates to the configured
upstream with SOCKS5 CONNECT or a per-flow UDP ASSOCIATE while keeping target
DNS resolution at the proxy. Oversized HTTP Datagrams fall back to the RFC 9297
DATAGRAM Capsule, credentials cross only a mode-0600 one-shot file, and the
helper exits with its owning Profile. Older capable-TCP-only builds retain the
ephemeral no-auth-to-authenticated SOCKS bridge. Neither path loads a
page-visible extension.
Blink system colors, list selection and painted text selection now use fixed
Windows/macOS light and dark palettes from the declared platform rather than
the host theme. The seed also owns `prefers-color-scheme`; an unconfigured
pass-through launch continues to expose the native host theme.

The profile timezone is owned by Blink's native `TimeZoneController`, so the
same ICU/V8 timezone is used by Window and Workers and cannot be reset by a
later host-timezone monitor notification.

The application baseline capture records Window and Worker Navigator identity,
UA high-entropy values, Canvas, Audio, ClientRects, WebGL/WebGPU, a deep font
capability hash, plugins, speech voices, media-device counts, storage quota,
DNT, touch state,
preferred color scheme and light/dark system colors.
It is intended for same-profile restart stability and cross-seed distinction
checks once a patched Chromium binary is available.

The local proxy corpus compares direct, HTTP-proxy and SOCKS5 routes across
HTTP and HTTPS Window/Worker/frame/Service Worker requests, WSS, Navigation
and Resource Timing, cache hits and ETag revalidation. The installed 150 build,
stock Chrome 150 and Cloak Chromium 145 share the same structural result; proxy
credentials and proxy-only headers never reach the controlled target origin.
The external wire corpus compares two cold processes against same-major Stock
Chrome and verifies normalized TLS ClientHello/JA4, HTTP/2 SETTINGS and frame/
header order, plus a real HTTP/3 QUIC Client Initial, normalized ClientHello and
transport parameters. The Chromium 150 results are exact Stock; see
`NETWORK_FINGERPRINT_CORPUS.md`. A separate real Electron/Profile gate verifies
that the managed MASQUE-to-SOCKS path reaches the HTTP/3 observer over `h3`
without changing the bounded Chromium ClientHello and transport semantics.

## Runtime verification

After building Chromium, run the strict native verifier against the executable
or macOS application bundle:

```bash
npm run verify:chromium -- /path/to/Chromium.app
```

It launches same-seed and different-seed profiles on fixed loopback origins,
reopens the same persistent Profile, then adds adversarial locale, a full
headed run, paired no-config Stock window-mode captures and pass-through.
The 53 checked surfaces include Window/Worker identity, UA-CH, screen/window
geometry, Canvas, Audio, ClientRects, WebGL/WebGPU, plugins, speech,
geolocation, StorageManager/Storage Buckets, legacy quota APIs, OPFS and the
legacy FileSystem path in persistent/incognito contexts, WebAuthn, AAC/H.264 playback,
MediaSource, MediaCapabilities and WebCodecs encode support, media-device
constraint remapping, audio capture, request headers in Window and
Dedicated/Shared/Service Workers, disabled WebRTC candidates, CDP identity,
exact build-version coherence, same-Profile restart stability, cross-seed
distinction and full headed/headless parity. On macOS, the only permitted
window-mode differences are `screenY` and `innerHeight`, and both values must
exactly match the dynamically captured no-config Stock path.
The deep WebGL gate additionally covers Window/Worker WebGL 1/2 extensions,
26/53 capability parameters, compressed formats, draw-buffer/anisotropy limits
and shader precision. Its normalized SHA-256 must match the six-Profile
observable RoxyChrome reference recorded in `WEBGL_CORPUS.md`.
The WebGPU gate covers Window/Worker adapter and default-device identity,
features, limits, preferred canvas format and WGSL language features. Its
capability SHA-256 must match Stock Chrome 150; `WEBGPU_CORPUS.md` also records
the six-Profile RoxyChrome comparison and the mixed Windows/Metal identity that
the joint OSS hardware persona avoids.
The Font gate covers 39 named candidates, 390 generic metrics, 468 named
metrics and 247 quantized glyph/emoji rasters in Window and Worker, plus DOM
width coherence and Local Font Access. It rejects a synthetic missing family,
configuration-external Local Access entries, a Canvas/DOM generic width delta
over 2 px, or identical Windows/macOS output. `FONT_CORPUS.md` records the
six-Profile observable RoxyChrome comparison and the `0040` fixed results.
The Storage gate covers Window/Worker modern estimates and Buckets, OPFS,
Window legacy temporary/persistent quota query/request callbacks and the legacy
FileSystem path. `STORAGE_CORPUS.md` records the pre-`0039` leak, the fixed
values, and the immutable source/patch checkpoint.
An additional 61-case theme corpus checks 19 CSS system colors in preferred,
explicit light and explicit dark schemes, Windows/macOS differences, real
selection screenshot pixels and native-host pass-through. Missing WebGPU or a
mixed pass-through identity/theme is a failure.
The separate direct network-fingerprint gate dynamically fails on any
same-major Stock mismatch in TLS, HTTP/2 or HTTP/3. The managed SOCKS gate uses
an authorized UDP-capable upstream and fails unless a real Profile obtains H3
through CONNECT-UDP, preserves the expected Client Initial and bounded
field-trial-aware ClientHello/transport semantics, removes its one-shot state,
and terminates the helper with the Profile.

The verified macOS arm64 build reports `150.0.7871.114` and passes all 53
surfaces, the deep Font and Storage corpora, and the 61 theme cases. Installed-app acceptance additionally passes
exact 150/149 rollback, trusted humanized input and third-party-cookie
compatibility, authenticated HTTP/SOCKS proxy routing and the managed SOCKS5
HTTP/3 journey without an upstream browser-wrapper dependency, license key or
login. J50 additionally passes the two-level cross-origin frame, late-layout,
occlusion and explicit key-delay corpus against both source and installed
Chromium 150. J51 proves that legacy wrapper variables cannot select or
download a fallback browser.

## Build configuration — Linux

A one-command Linux build path is checked in so the headless Docker image has
a first-party engine (the upstream CloakBrowser project already ships Linux
Chromium 150 builds; this repo keeps the independent path):

```bash
./patches/chromium/build-linux.sh /path/to/chromium/src x64
```

This applies the same patch chain (`apply.sh`), copies `args.gn.linux` into
`out/AgentBrowserRelease/args.gn`, and runs `gn gen` + `autoninja chrome`. The
resulting `out/AgentBrowserRelease/chrome` is wired into the Docker image via
`docker-compose.yml` (`./chromium:/opt/chromium` +
`AGENT_BROWSER_CHROMIUM_BINARY_PATH=/opt/chromium/chrome`). The runtime image
carries the Chromium shared-library and font packages the Linux binary needs.

On Debian/Ubuntu hosts, install build deps once before building:

```bash
sudo ./chromium-src-150/build/install-build-deps.sh --no-prompt
```

## `0051` restricted proxy local-DNS policy (source-only, 2026-10-16)

The new public capability is `agent-browser-local-dns-policy-v1`, advertised by
`--agent-browser-capabilities`. A capability-gated launcher can replace its
**generic** `--host-resolver-rules` / `--host-rules` argument with these
browser-only inputs:

```text
--agent-browser-local-dns-policy=proxy-local-dns-deny
--agent-browser-proxy-bootstrap-host=<one-exact-proxy-host>   (optional)
```

The bootstrap host must come from the effective proxy snapshot, not a target
site or an allow-list supplied by a page. It is one ASCII DNS hostname (LDH
labels, at most 63 bytes per label / 253 bytes total, one optional trailing dot)
or IP literal; URLs, ports, credentials, wildcards, multiple hosts, spaces and
mapping expressions are rejected. Canonical IPv4 is required. IPv6 accepts
bracketed or bare literals and is normalized to the unbracketed canonical
`HostPortPair` hostname. There is no replacement-address input. Without a
bootstrap argument, the only exclusions are **exactly** `localhost` and
`127.0.0.1`; there is no `*.localhost`, `127.*` or implicit `::1` exclusion.
An explicit bootstrap argument can permit exactly the configured IPv6 proxy.

Consumption and isolation:

1. `SystemNetworkContextManager::ConfigureDefaultNetworkContextParams()` parses
   the switches in the browser process. This is the shared system/profile/OTR/
   storage-partition defaults entry point, also used after network-service
   restarts; it is not a prefetch-only hook. The typed nullable
   `NetworkContextParams.agent_browser_local_dns_policy` carries only a mode
   enum and an optional bootstrap host, never fingerprint data.
2. `NetworkContext::MakeURLRequestContext()` feeds the internally constructed
   fixed rules into `URLRequestContextBuilder::set_host_mapping_rules()` before
   considering generic mapping switches. The builder's production resolver
   factory creates `MappedHostResolver`. In this **actual 152 baseline** its
   immediate failure sentinel is `^NOTFOUND`, so the native rule is
   `MAP * ^NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1` plus the exact validated
   bootstrap exclusion. `~NOTFOUND` is not the `HostPortPair` failure sentinel.
   Both address and service-endpoint requests are denied before the underlying
   cache/hosts/system/DNS resolver can run.
3. `NetworkContext::CreateHostResolver(config_overrides)` passes the same fixed
   rules to its separately created standalone resolver. Proxy-selection failure
   and per-resolver DNS overrides cannot remove the wrapper. The existing
   `ProxyCheckingHostResolverRequest` proxy-selection shortcut is not relied on
   as the sole privacy barrier.
4. The parser and deny policy require **no fingerprint configuration**, so
   native/off-mode launches remain protected. The browser-only accessor
   `StubResolverConfigReader::IsManagedSecureDnsEnabled()` exposes the unchanged
   `0044` managed strict DoH opt-in condition. Its existing caller and shared
   defaults use the same condition. A valid explicit managed strict DoH launch
   gets no deny policy
   and retains `kSecure` / no plaintext fallback / DoH-through-proxy behavior
   from `0044`/`0050`. Launchers should omit both new switches for that path.
   Input validation happens **before** the DoH opt-out: an unsupported mode,
   empty/invalid bootstrap or bootstrap without a mode `CHECK`-fails rather
   than silently becoming stock. The network-service consumer revalidates the
   typed policy; unknown Mojo enum values are also rejected by Mojo.

`0051` does not edit `bad_flags_prompt.cc`, suppress any bad-flag information
bar, add `--disable-infobars` / `--test-type`, or change keychain, TLS, page JS,
renderer identity, or speculative-prediction behavior. A launcher still passing
an old generic bad flag will still get upstream's warning. Actual banner and
network-wire acceptance require a rebuilt engine plus the separate gated
launcher integration; neither is claimed by this source change.

Apply this **after** the immutable `0002`–`0050` chain. `apply.sh` copies the
original payloads first, preserves evolved payloads on incremental resumes,
then applies/skips patches in number order and verifies the rolling final-file
`PATCHED_SOURCE.sha256` (110 files after `0052`). Do not change `0044`/`0050`, recopy an old payload over
an evolved header, or forge an applied-patch marker. On archive-seeded trees,
`check.sh` requires `apply.sh`'s exact marker for `0051` and the final source
bytes; a tree still at `0050` cannot pass that final-state check. On a pinned
Git baseline it simulates the whole chain in a temporary index. Those scripts
were **not** run against the external source tree for this change, since source
writes were prohibited.

Offline validation covers patch applicability to the verified post-`0050`
source, a bounded 1,039,277-byte-original-file scratch apply/reverse-check, Mojo
syntax parsing, immutable checksums, and the independent source-policy test
`tests/unit/chromium-local-dns-policy-source.test.ts`. Native tests are included
but were **not built or executed**: `AgentBrowserLocalDnsPolicyTest.*` and
`NetworkContextTest.AgentBrowserLocalDnsPolicy*` in `services_unittests`, plus
`SystemNetworkContextManagerBrowsertest.AgentBrowserLocalDnsPolicyDefaultsWithoutFingerprint`
in `browser_tests`. Source-policy tests are not substitutes for those tests,
actual startup/banner verification, proxy-failure DNS-wire checks, or external
site acceptance.

## `0052` DNS-only hints with managed strict proxy DoH (source-only, 2026-10-16)

Chromium's actual Chrome network-hints handler reaches `PreconnectManagerImpl`,
which normally skips DNS when its proxy lookup reports a non-DIRECT proxy. A
configured strict resolver alone does not change that skip. `0052` adds an
embedder permission that defaults to false; Chrome opts in only for enabled
managed secure DNS with a nonempty, fully parsed provider configuration.

The exception applies only to DNS-only jobs (`num_sockets == 0`). Ordinary
proxy socket preconnects and every existing `IsPreconnectEnabled` gate retain
their previous behavior. `.local` and `.local.` names remain skipped even with
the opt-in: the resolver's default ANY source can otherwise send those names
to the system resolver despite secure mode. There is no site-specific rule,
plaintext-DNS fallback, page-evidence override or warning suppression.

The patch includes native `PreconnectManagerImplTest.TestProxy*` cases for
permission, successful and failed resolution, disabled preloading, multicast
names and unchanged proxy socket preconnects. The offline contract test is
`tests/unit/chromium-managed-dns-prefetch-source.test.ts`; it does **not**
compile or execute those C++ cases. A rebuilt kernel, positive correlated DoH
and proxy evidence, and completed real-page findings are still required before
claiming a fix or packaging the application.

## `0053` real-compile prefetch correction (2026-10-16)

The real pinned Clang compile rejected `GURL::host_piece()` in `0052`.
`GURL::host()` is the available `std::string_view` accessor in this tree; `0053`
uses it while preserving the `.local` / `.local.` proxy skip. The default-deny
virtual delegate method moves to the existing implementation file, with an
exported delegate for component builds, rather than leaving a nonempty inline
virtual body. No browser warning, proxy, preloading, GPU or DNS decision changes.

This append-only correction preserves `0051` / `0052` bytes and keeps the
rolling final-source count at 110. The offline guard is
`tests/unit/chromium-managed-dns-prefetch-compile-source.test.ts`. Its source
checks cannot stand in for recompiling the corrected units, linking the engine,
running native cases or completing real-page and banner acceptance.

## `0054` cross-volume macOS bundle resource copies (2026-10-16)

The full Chrome target reached action 54,154/54,745 before macOS `/bin/cp -Rc`
failed copying a helper app icon with `clonefile failed: Cross-device link`.
The real source and output are on different volumes. A separate small control
with the exact same source icon and output volume reproduced `-Rc` exit 1 and
verified `-R` exit 0, equal bytes/SHA-256, unchanged source, and distinct output
file identity.

The append-only patch changes only Apple `copy_bundle_data` on a macOS host to
ordinary `/bin/cp -R`, preserving independent copies without requiring
clonefile. The Linux branch, browser behavior, warning policy, optimization,
ThinLTO and codec options are unchanged. The rolling source manifest adds
`build/toolchain/apple/toolchain.gni` (111 files); all previous 110 source
identities and earlier patch/payload digests remain unchanged.

Normal provenance/apply/check and all 111 final-source hashes passed. GN
regeneration preserved `args.gn`; the actual same-output incremental dry-run
contains 643 remaining actions. Full build/link completion and real browser,
banner, DNS/GPU and site acceptance remain separate, still-unmet gates.
