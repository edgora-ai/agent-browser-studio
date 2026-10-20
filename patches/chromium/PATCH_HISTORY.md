# Chromium patch history

This is an append-only provenance ledger for the independent Chromium source.
Released patch files are immutable: a correction is a new numbered patch, not
an edit to an earlier file. `PATCHSET.sha256` makes an accidental rewrite fail
before the patch applicability check runs.

## Preservation rules

1. Keep experimental, diagnostic, cleanup and final-fix commits in the
   Chromium source branch. Do not amend, squash or rebase that branch.
2. Export a released source change as the next numbered patch. After `0043`,
   the next file is `0044-*`.
3. Append its digest to `PATCHSET.sha256` and its provenance to this ledger in
   the same OSS commit. Do not alter prior digest or history rows.
4. Run `check.sh` against the pinned clean upstream commit before release.

## Portable patch ledger

| Patch range | First preserved in OSS commit | Scope |
|---|---|---|
| `0002–0003` | `07a225032f126ba2382a8ff80a4cfb56e600307f` | Navigator, UA-CH, screen and DPR foundation |
| `0004–0006` | `52bbfb1a9d822e0e858b8cf1b24991ff3a369e4d` | Canvas, WebGL and AudioBuffer native paths |
| `0007–0009` | `d1b4a441d8a11839a946b46508a30257f12f6730` | Quota, analyser and OffscreenCanvas |
| `0010–0011` | `cab224f6acc70faf2397380b5fd626986d9deb12` | ClientRects and visible WebRTC identity |
| `0012–0013` | `d7c3390f21bc80c12b77ad6e1cc4ad6a3ae4691c` | WebRTC routing and font allow-list |
| `0014` | `411be60dce12e17309b8fc1d0964a4886b9ddb71` | Geolocation policy |
| `0015–0016` | `29ea8e16f1a5ba7911de7757eadea6ed8902d650` | Media/plugin identity and float canvas |
| `0017–0018` | `7e1af1c790489309ce97494de93fce0f15b96463` | Custom fonts and renderer config forwarding |
| `0019` | `e3aef0093b8241ccc4b1d8e195d9c7f0763f917d` | Media-device remapping |
| `0020` | `3861163b21fb483b6d8ee4c5e0ebafa073a484a6` | WebGPU identity |
| `0021` | `a9e5066c349f0639b8db261aec6fb2cb2dd109df` | Do Not Track |
| `0022` | `29b52bc576666e39dfc8bf4a149a692b247b71b7` | Speech voice identity |
| `0023` | `cd7c30959f89f4ceb35708e64d15519de3e9684a` | Touch identity |
| `0024` | `a1a2decd633470653b6dec79065cccb3f19d5ded` | Idempotent canvas noise |
| `0025` | `1eeab7a0457cb299798e5dcd0db6bdca21db1e9a` | Timezone identity |
| `0026–0028` | `75ed0c0d5793f7af6026789952d255e96b11896f` | Language, Storage Buckets and WebAuthn |
| `0029–0032` | `57e73755f5cdbe4cf148ee5e19ae289776305ed6` | CDP identity, geometry, WebGPU and input routing |
| `0033–0037` | `462a28857088403f926d759eac340b4b9fa2f152` | Theme coherence and occluded CDP input/scroll fixes |
| `0038` | See the append-only `0038` release entry below | Native managed HTTP proxy authentication |
| `0039` | `e78c2cd84e551efc872d8ec321080e6d82ece1c1` | Legacy storage quota coherence |
| `0040` | `0922ab130a2268d12862e30cca6e282507f721ec` | Managed platform-font resolution |
| `0041` | `2152f8799831fd9eb183ae550826cbfdbbedf9a2` | Managed QUIC proxy and SOCKS5 UDP transport |
| `0042` | See the append-only `0042` release entry below | Agent Browser public runtime protocol and legacy aliases |
| `0043` | See the append-only `0043` release entry below | Managed missing-Google-API-key information-bar suppression |

## Chromium 150 source checkpoint

- Upstream baseline: `f405107495a07cb1bfcf687d4af8d91117098db6`
  (`150.0.7871.114`).
- Preserved branch: `roxy/chromium-150-checkpoint-20260802`.
- Preserved head after patch `0037`:
  `4cce113972524faf9fe01d502fe391a0671a74e2`.
- Preserved head after patch `0041`:
  `4461854586be1840bc84e1577017b4163061af38`.
- Current branch head after the post-release scroll diagnostic cleanup:
  `b4bf6e9f21638c71848e72aed5deb6289f953a7a`; its tree is identical to the
  tagged `0041` source tree.
- Preserved head after patch `0042`:
  `38cdb615cf312444490982b71f5faec5e892c350`.
- Preserved head after patch `0043`:
  `855038800408acc6801e4aa98707d28f6123a631`.

The following source commits intentionally retain the unsuccessful diagnostics
and experiments as well as the fixes, so later Chromium upgrades can recover
the reasoning and bisect behavior:

```text
b9139ca9fa147984dac9acc915715ec4c7bc3044 checkpoint: preserve Chromium 150 Roxy patch stack and wheel routing WIP
73ed8499716e0f7524d8d3429393c37447a13f3e diagnostic: trace managed CDP wheel acknowledgements
716b9d91772562b261b74e66dcb93f475f81abcd experiment: preserve debugger origin across wheel gestures
5d6d2b0bd062702d3b6405bedf7c5d03d6a96d3e experiment: compare upstream per-wheel phase transaction
f84e02c3399b0ddda739d65fb5700910b7faff2b diagnostic: trace compositor scroll offsets
fbd64dd810e3cb9d888247fe5e204dcbefac5359 experiment: request urgent main frame for debugger scroll
7541d586d413b1d9143f8c366b80e8d823c89f20 fixup: post debugger scroll frame request to main thread
1511ddad53b36817a9e147d8418bb943fec29b96 fix: synchronize debugger scroll state without begin frames
9ecf211dc6530770d8d9689a70ccdf5501b2a722 cleanup: remove debugger wheel diagnostics
eeeed6a4a003fa8722a2464da113e8f883009ea1 fix: bound managed debugger input delivery without frames
582137b30be4492ac43885130f64f3a4c61f83ab fix: deduplicate synchronized debugger scroll commits
4cce113972524faf9fe01d502fe391a0671a74e2 fix: reconcile debugger scrolls against absolute offsets
0198524b77609cfe0f898ac1b6f56f5932b1ae21 feat: add native managed proxy authentication
3eb1216fd3259fa220ce2612c16020f190c7eda7 feat: align legacy managed storage quota
e7fc69f9ac673fd3f85f74438efa22154efaf1d7 feat: enforce managed font resolution
4461854586be1840bc84e1577017b4163061af38 feat: enable managed QUIC proxy transport
ef1c9d89ece1192f40fe8ca42f6929ba2d93ed5a diagnostic: trace managed debugger scroll reconciliation
b4bf6e9f21638c71848e72aed5deb6289f953a7a cleanup: remove scroll reconciliation diagnostics
38cdb615cf312444490982b71f5faec5e892c350 feat: add Agent Browser public runtime protocol
855038800408acc6801e4aa98707d28f6123a631 fix: suppress managed missing Google API key infobar
```

## Append-only release entries

### `0038` — 2026-08-02

- First preserved in OSS commit:
  `0003435bc4e2307f4cd23d49ed38a2663d8268c5`.
- Chromium source commit:
  `0198524b77609cfe0f898ac1b6f56f5932b1ae21`.
- Patch SHA-256:
  `e23fb1c02e2336339118e61ff4f66955e921582dca6d8e23a36c31133bb358de`.
- Acceptance: clean upstream `0002–0038` application, incremental Chromium
  build, native 407 challenge corpus, real Electron/Profile E2E, `419/419`
  tests, and the 50-surface plus 61-theme strict verifier.
- Application follow-up `ac193a40a39022626a4be82e404b6c05733f50de`
  adds authenticated SOCKS5 TCP through an ephemeral loopback bridge without
  altering patch `0038`; the expanded acceptance is `421/421` tests and
  `15/15` installed version/input/cookie/proxy journeys.
- Verification follow-up `9195ce5066e96e18817967aeb9ec235cbf7342d0`
  adds the HTTP/HTTPS/WSS direct-vs-HTTP-vs-SOCKS corpus for Window, Workers,
  frames, Navigation/Resource Timing, cache and ETag revalidation. It changes
  no Chromium source or released patch bytes.
- Lifecycle verification follow-up
  `d82faf9c2551cccf11bad7484f045f48e9a011f6` expands the strict verifier to
  compare all 50 surfaces across a same-Profile close/reopen and a full headed
  run. The only headed/headless differences are the dynamically matched Stock
  macOS window-decoration values for `screenY` and `innerHeight`; this follow-up
  changes no Chromium source or released patch bytes.

### `0039` — 2026-08-03

- First preserved in OSS commit:
  `e78c2cd84e551efc872d8ec321080e6d82ece1c1`.
- Chromium source commit:
  `3eb1216fd3259fa220ce2612c16020f190c7eda7`
  (`feat: align legacy managed storage quota`).
- Annotated Chromium source tag:
  `roxy-chromium-150-patchset-0039`.
- Patch SHA-256:
  `a111080791715db1fc6886e0b2607cc72ead8949e3343f4873a68d2102107d39`.
- Scope: apply `storageQuotaBytes` to Blink's deprecated temporary/persistent
  quota query and request callbacks without reporting a quota below actual
  usage. No byte in patch `0038` or any earlier payload changed.
- Acceptance: successful incremental Chromium 150 build; strict native
  verification of 52 baseline surfaces, the Window/Worker
  modern/legacy/Buckets/OPFS/FileSystem corpus in persistent and incognito
  contexts, 61 theme cases, restart and headed/headless parity; `424/424`
  tests; and clean-upstream-index application of patches `0002–0039`.
- The next Chromium source change must be exported as `0040-*`; do not amend,
  squash, rebase or replace this source commit, tag, patch or digest row.

### `0040` — 2026-08-03

- First preserved in OSS commit:
  `0922ab130a2268d12862e30cca6e282507f721ec`.
- Chromium source commit:
  `e7fc69f9ac673fd3f85f74438efa22154efaf1d7`
  (`feat: enforce managed font resolution`).
- Annotated Chromium source tag:
  `roxy-chromium-150-patchset-0040`.
- Patch SHA-256:
  `76d717fbff25f48d75ffdef84b491968a113e08ec2ec0d77583e2ebe3845f8bc`.
- Scope: enforce the managed font allow-list at Blink's platform-font lookup,
  map Windows CSS generic and host-alias families to portable managed fonts,
  and prevent undeclared host fonts from entering Canvas/DOM fallback. The
  immutable header payload remains unchanged; patch `0040` evolves it after
  payload installation.
- Acceptance: successful incremental Chromium 150 build; six observable
  RoxyChrome Profiles and controlled Windows/macOS comparison; strict native
  verification of 53 baseline surfaces plus 39 candidate fonts, 390 generic
  metrics, 468 named metrics, 247 glyph/emoji rasters, DOM parity and Local
  Font Access across Window/Worker, same-Profile restart and headed/headless;
  `424/424` tests; and clean-upstream-index application of patches
  `0002–0040` with immutable payload hashes verified.
- No byte in patch `0039`, any earlier patch, or either source payload changed.
  The next Chromium source change must be exported as `0041-*`; do not amend,
  squash, rebase or replace this source commit, tag, patch or digest row.

### `0041` — 2026-08-11

- First preserved in OSS commit:
  `2152f8799831fd9eb183ae550826cbfdbbedf9a2`.
- Chromium source commit:
  `4461854586be1840bc84e1577017b4163061af38`
  (`feat: enable managed QUIC proxy transport`).
- Annotated Chromium source tag:
  `roxy-chromium-150-patchset-0041`.
- Patch SHA-256:
  `171b7036a1a22f4bb124b7e00c5bcd7fd925d314d5912929c5d4899cb6b0fc11`.
- Scope: enable Chromium's upstream QUIC-proxy implementation in Release
  builds and advertise `roxy-quic-proxy-v1` alongside the existing native
  proxy-auth capability. The application starts a profile-owned loopback
  MASQUE helper that translates normal CONNECT and RFC 9298 CONNECT-UDP into
  authenticated SOCKS5 CONNECT and UDP ASSOCIATE. Oversized HTTP Datagrams use
  the RFC 9297 DATAGRAM Capsule fallback; credentials cross only a mode-0600
  one-shot file and never enter Chrome arguments or logs.
- Acceptance: successful incremental Chromium 150 build; helper Go tests and
  race detector; real Electron/Profile authenticated SOCKS5 TCP compatibility
  on both `0040` and `0041`; real UDP-capable SOCKS5 HTTP/3 navigation with
  `nextHopProtocol=h3`; mode-0600 deletion and helper lifecycle checks;
  `36/36` test files and `433/433` tests; and immutable-payload verification
  plus clean pinned-upstream-index application of patches `0002–0041`.
- Application input-completion follow-up
  `2ffafa614bf2b5bf987c5cc2fb82528cd5338792` waits for the native viewport to
  reconcile after trusted wheel dispatch by polling `Page.getLayoutMetrics`;
  it does not inject page script or change Chromium patch bytes. Source-build
  and installed-cache J44 both complete at the exact requested scroll offset.
- Release-path verification follow-up
  `a8cc6e53fc6ce0ac07e5c5826439a4f61bae9d1e` covers explicit source/install
  Chromium selection for the real H3 journey and asserts that patch `0041`
  and the packaged helper remain in the release inputs. The rebuilt local App
  retained all 6 Profiles, 1202 files and 4 symlinks byte-for-byte: config
  SHA-256 `dc97fac627544e1521e7a5425ca734c08cff65e262d70faf9f74b527792d8430`
  and Profile-tree SHA-256
  `f54cd1d68782ab7afc521d213fe8d825b1681fe0e72f5bae41a4499a9759ec7f`.
- Wrapper-alignment follow-up
  `b5365086f1c27941f1b7383f3918ac0ee76875eb` adds isolated-world
  actionability and native input across the complete cross-origin OOPIF tree.
  It maps iframe content quads to root coordinates, re-scrolls after layout
  stability checks, repositions after late movement, fails closed on a known
  covering element and preserves an explicit key-down hold duration. J50
  passes `4/4` against both the source and installed `0041` builds; it changes
  no Chromium source or released patch bytes.
- Dual-stack wrapper follow-up
  `c009b0ad8f347931f7aec350d19c6c352dce348e` accepts bracketed IPv6 proxy
  environment URLs, proxy-side-DNS `socks5h` and percent-encoded credentials
  while retaining mode-0600 curl credential handoff. Current acceptance is
  `36/36` fast-suite files and `438/438` tests, plus the complete serial
  Electron suite at 42 passed / 3 conditionally skipped files and 192 passed /
  11 conditionally skipped tests. Go/race and clean `0002–0041` replay remain
  green, and the installed App re-verifies the same config/Profile hashes.
- Test-safety follow-up `d4577c87f8d06f937e20704ee5062f8011db4cef`
  makes README screenshot replacement explicitly opt-in; ordinary full-suite
  runs capture to a temporary directory and leave working-tree assets intact.
- Runtime-independence follow-up
  `c48cb5614c3388353f76f4dc9ac74eb831256144` removes the packaged
  `cloakbrowser` dependency, its upstream download/update/GeoIP paths and the
  fallback launch plan. CloakLite now selects only a configured or locally
  managed independent Chromium build and fails closed when neither exists.
  J51 proves that legacy wrapper binary/license/download variables are ignored
  without network or cache writes. Acceptance is `36/36` fast-suite files and
  `439/439` tests, plus the complete serial Electron suite at 43 passed / 3
  conditionally skipped files and 194 passed / 11 conditionally skipped tests.
  The packaged App independently reports managed Chromium `150.0.7871.114`;
  Go/race and clean `0002–0041` replay remain green. This application-only
  follow-up changes no Chromium source or released patch bytes.
- No byte in patch `0040`, any earlier patch, or either source payload changed.
  Patch `0041` remains immutable; later source changes are appended as new
  numbered patches.

### `0042` — 2026-08-11

- Chromium source commit:
  `38cdb615cf312444490982b71f5faec5e892c350`
  (`feat: add Agent Browser public runtime protocol`).
- Annotated Chromium source tag:
  `agent-browser-chromium-150-patchset-0042`.
- Patch SHA-256:
  `52b7ad9fdd29ecc0e0a577cec54d5bf212413170012c458e9e4eb6a549d8787d`.
- Scope: make `--agent-browser-fingerprint-config`,
  `--agent-browser-proxy-auth-file`, and `--agent-browser-capabilities` the
  public runtime protocol. The capability query advertises the fingerprint,
  native proxy-auth, and QUIC-proxy contracts under `agent-browser-*` names.
  The released `roxy-*` switches remain compatibility aliases for existing
  Chromium 149 Profiles and the immutable `0002–0041` application stack.
- Preservation: no byte in `0002–0041` or either immutable source payload was
  rewritten. The next Chromium source change must be exported as `0043-*`;
  do not amend, squash, rebase, or replace this source commit or patch.
- Acceptance: clean pinned-upstream-index replay of `0002–0042`, successful
  incremental Chromium 150 build, and direct verification that the new query
  advertises all three `agent-browser-*` capabilities while the legacy query
  retains the two released `roxy-*` aliases.

### `0043` — 2026-08-12

- Chromium source commit:
  `855038800408acc6801e4aa98707d28f6123a631`
  (`fix: suppress managed missing Google API key infobar`).
- Annotated Chromium source tag:
  `agent-browser-chromium-150-patchset-0043`.
- Patch SHA-256:
  `311c0d382160d93a091871390af6ccd9a9c697f8646df32203260d1c8c795762`.
- Scope: advertise `agent-browser-google-api-key-infobar-v1` and accept
  `--agent-browser-suppress-missing-google-api-key-infobar`. Only that managed
  switch suppresses Chromium's informational bar; the build does not embed a
  Google API key, fake one, or enable unavailable Google services. Manual and
  unmanaged Chromium launches retain upstream behavior.
- Preservation: no byte in `0002–0042` or either immutable source payload was
  rewritten. The next Chromium source change must be exported as `0044-*`;
  do not amend, squash, rebase, or replace this source commit or patch.
- Acceptance: successful incremental Chromium 150 build and direct capability
  query showing all four public `agent-browser-*` contracts. Clean replay,
  installed-App, signature, vault-migration, and full regression results are
  recorded by the corresponding OSS release commit.

### `0044` — 2026-08-13

- Chromium source commit:
  `c35ff15cc18156300f234761276a92f4892f78da`
  (`fix: keep managed secure DNS inside the exit proxy`).
- Annotated Chromium source tag:
  `agent-browser-chromium-150-patchset-0044`.
- Patch SHA-256:
  `c8e3755c1bfb5e2ddcc316ca3b4c034b7dbdb93a9d6a7477ea2d49e8f63382d9`.
- Scope: managed profiles force secure-only DNS over HTTPS and route every
  DoH request -- including the probe, which previously always bypassed the
  proxy -- through the configured exit proxy, so the proxy resolves the DoH
  endpoint and no DNS request leaks to the host resolver. The renderer also
  preserves the managed ICU locale, maps CSS generic families to the declared
  platform fonts, and keeps the native macOS refresh rate so animation frames
  match a standard display timing. Experimental trace commits in the source
  branch are preserved for provenance but their net effect is removed; the
  exported patch contains no diagnostics or logging.
- Preservation: no byte in `0002–0043` or either immutable source payload was
  rewritten. The next Chromium source change must be exported as `0045-*`;
  do not amend, squash, rebase, or replace this source commit or patch.
- Acceptance: `net_unittests` passes all 1108 DNS/NetworkService/DnsConfig
  tests, `check.sh` replays `0002–0044` cleanly on the pinned upstream index,
  and the replay tree is byte-identical to the annotated `0044` source commit.
 HTTP and SOCKS5 proxy modes show zero direct connects, zero host-resolver
 jobs, and zero out-of-proxy DNS traffic in the network log; see the
 `verify-managed-doh` tool and the matching OSS release commit.

### `0045` — 2026-08-13

- Chromium source commit:
  `26aeffbdefd3964726fcb7aa7a5358793e4ac27a`
  (`feat: register managed Widevine CDM from --widevine-cdm-path`).
- Annotated Chromium source tag:
  `agent-browser-chromium-150-patchset-0045`.
- Patch SHA-256:
  `6a3abc7e80b6feb3563bec6a33a3ca952ecdb0de53e345b9b430628fb673a9e6`.
- Scope: enables Widevine key-system plumbing in the independent Chromium
  build (`enable_widevine = true`) and registers a CDM supplied at runtime
  through `--widevine-cdm-path`/`--widevine-cdm-version`. The Google
  component updater is disabled (`enable_widevine_cdm_component = false`)
  and `ignore_missing_widevine_signing_cert = true` keeps the build
  reproducible without Google signing material, so the CDM is never bundled
  and nothing phones home for it. Only profiles flagged DRM-enabled receive
  the launch flags; unmanaged or plain launches keep upstream behavior.
- Preservation: no byte in `0002–0044` or either immutable source payload
  was rewritten. The next Chromium source change must be exported as
  `0046-*`; do not amend, squash, rebase, or replace this source commit or
  patch.
- Acceptance: official ThinLTO build succeeds; `check.sh` replay and
  installed binary keep all prior `agent-browser-*` contracts. Real EME
  verification over CDP (`navigator.requestMediaKeySystemAccess`) returns
  `com.widevine.alpha` when a DRM profile is launched with a host CDM
  (Chrome 150 bundle, manifest `4.10.3050.0`) and `NotSupportedError`
  for a plain profile, confirmed both from the build tree and the published
  runtime binary; the OSS `j66-drm` e2e journey covers discovery,
  per-profile enable, managed staging, and the real probe.

### `0046` — 2026-08-13

- Chromium source commit:
  `35d5fe5cc4`
  (`feat: optional OS-level window-title prefix for managed profiles`).
- Patch SHA-256:
  `8220c59fb695d8a7f603068da3b87e1511c1c2b83074c965a99780b70902f1de`.
- Scope: adds an optional OS-level window-title prefix for managed profiles.
  When a managed launch passes `--agent-browser-window-title-prefix=<text>`
  (e.g. the profile name), `Browser::GetWindowTitleForCurrentTab` appends the
  prefix to the native window-frame / taskbar title. `document.title` and
  every page-visible surface stay untouched, so the fingerprint surface is not
  affected; unmanaged and plain launches keep upstream behavior.
- Preservation: no byte in `0002–0045` or either immutable source payload was
  rewritten. The next Chromium source change must be exported as `0047-*`;
  do not amend, squash, rebase, or replace this source commit or patch.
- Acceptance: applied to the preserved Chromium 150 checkout; the exported
  patch replays cleanly and the tree stays byte-identical to the annotated
  source commit. Runtime wiring and the OS-level title check are covered by
  the matching OSS slice and e2e journey.

### `0051` — 2026-10-16 — restricted local-DNS policy, source-only

- Patch: `0051-agent-browser-local-dns-policy.patch`.
- Patch SHA-256:
  `2ee8b807e9135a763b08f8de07b4145cb3fd84faef39e88b3e8304b6ec405535`.
- Derived from read-only Chromium `152.0.7977.72` sources after the existing
  `0002`–`0050` chain. All 95 pre-existing final-source hashes matched before
  generation. No external Chromium file, applied-patch marker, source commit,
  tag, binary, signature, installation or release was created/modified.
- Scope: advertise `agent-browser-local-dns-policy-v1`; accept only the browser
  policy token `proxy-local-dns-deny` and an optional validated single proxy
  bootstrap host; generate native `MAP * ^NOTFOUND` with only exact loopback
  and bootstrap exceptions. The actual 152 `MappedHostResolver` recognizes
  `^NOTFOUND` rather than `~NOTFOUND` for its immediate failure result.
  Common system/profile/OTR defaults carry typed policy to both the ordinary
  `URLRequestContextBuilder` resolver and the standalone DNS-override resolver.
  Native/off mode needs no fingerprint payload. Explicit existing managed
  strict DoH stays isolated; malformed inputs fail explicitly before that
  isolation, and the network service revalidates the typed policy.
- Preservation: every released patch and immutable source payload, including
  `0044` and `0050`, retains its prior bytes and digest. Only the rolling
  `PATCHED_SOURCE.sha256` digest is refreshed, and the new `0051` patch digest
  is appended to `PATCHSET.sha256`. The final-source manifest now covers 105
  files. No bad-flag infobar suppression, keychain/TLS/page-JS changes or
  prediction-policy changes are included.
- Validation: read-only `git apply --check` against the real post-`0050` tree;
  actual apply plus reverse-check in a disposable bounded scratch fixture
  (10 original files, 1,039,277 bytes; three new source files); full-file Mojo
  syntax parse with bytecode/table writes disabled; manifest read-back and
  checksum verification; independent offline Vitest source-policy guard.
- Not acceptance: native C++/browser tests are present but were not built or
  run, by instruction. Neither the real banner nor external-site/DNS-wire
  behavior has been verified by this source-only task. `apply.sh`/`check.sh`
  final-state verification on the external source tree is intentionally left
  to the authorized follow-up; see the `0051` README section for prerequisite
  order and native test filters. The next native patch is `0052`; do not amend
  or rewrite released earlier patches.

### `0052` — 2026-10-16 — managed proxy DNS-only hints, source-only

- Patch: `0052-agent-browser-managed-proxy-dns-prefetch.patch`.
- Patch SHA-256:
  `7f242fd728140aefdd14f0af5ea99764069a7633346c8385d301ac50e1566a73`.
- Adds a default-deny embedder permission for proxy DNS-only hints. Chrome
  allows it only for enabled managed strict DoH with nonempty validated
  providers; the existing resolver still owns secure-only/proxy routing.
- Keeps default proxy behavior, socket preconnects, preloading gates and
  cancellation/disconnect paths. Multicast `.local` and `.local.` names remain
  skipped because ANY-source secure resolution can still route them to SYSTEM.
- Preserves every prior patch and immutable payload. Five additional source
  targets bring the rolling final-source manifest to 110 files. No GPU,
  keychain, TLS, page evidence or warning-suppression changes are included.
- Validation so far: applicability check against the existing source; six
  native regression cases and an offline patch-contract guard are supplied.
  Native C++ compilation/execution, real DNS-wire and real-page acceptance
  remain unverified; this entry is not a released or accepted native build.

### `0053` — 2026-10-16 — real-compile DNS hint API correction

- Patch: `0053-fix-managed-dns-prefetch-gurl-api.patch`.
- Patch SHA-256:
  `9cf1352f5efe64aee573385dee00360acf91576f265ff027e09df0a6358e23ca`.
- A real Clang invocation of `preconnect_manager_impl.cc` rejected `0052`'s
  `GURL::host_piece()` call: this pinned API exposes `host()` returning
  `std::string_view`. Use that accessor without changing the multicast checks.
- Move the default-deny delegate method out of its inline virtual body to the
  existing implementation file and export the delegate for component builds.
  The decision remains false; no opt-in, proxy, preloading or DNS policy changes.
- Every earlier patch retains its bytes and digest. Only the two already
  recorded final-source identities and rolling manifest digest change; the
  final-source manifest still covers 110 files.
- The pre-correction helper translation unit compiled successfully, but the
  preconnect unit had a genuine compile error and the other units remained
  generated-input/time blocked. Corrected translation-unit compilation is a
  separate required check; this entry claims no full dependency build, link,
  native test, kernel, banner, external-page acceptance or package.

### `0054` — 2026-10-16 — cross-volume macOS bundle-copy correction

- Patch: `0054-fix-cross-volume-macos-bundle-copy.patch`.
- Patch SHA-256:
  `d6dc741c9200876839a87ac0ec9321731355969ff0aabbbc8f4231acd5b7a0b2`.
- Source provenance remains pinned Chromium `152.0.7977.72`, target
  `026bb13a93d60e7adfefa2bbf58d6f57c2d335cc`, with the verified archive base
  `fc4d67f1788019a27e32511137ceccbd2fafdaaa`. No baseline or sidecar was changed.
- The real complete-target attempt reached 54,154/54,745, then failed copying
  a helper `app.icns` across the actual source/output volumes: forced macOS
  clonefile (`/bin/cp -Rc`) returned EXDEV. The failed build, generated Ninja
  log and completed objects are retained, not relabeled as successful.
- An actual 85,977-byte icon copy control reproduced `-Rc` exit 1 and verified
  ordinary `-R` exit 0, exact bytes/SHA-256, unchanged source and independent
  output identity. The patch changes only the macOS `copy_bundle_data` command;
  the Linux command and every compiler/runtime/codec/warning policy stay intact.
- Normal apply/check and 111 final-source hashes passed. The new build-file
  identity is `a93cd30b3e5092aea3f926bbe0c6b37990be0b72bbbb0b6352221d8a3211da61`;
  the rolling manifest SHA-256 is
  `df73d9ad6be9521b6471a2fe14df2a64fbc3d1d050ef95cbf931d66c1c59eca4`.
  Every earlier patch/payload hash and all previous 110 final-source hashes are
  unchanged. GN regeneration preserved the release `args.gn` identity and the
  real incremental dry-run lists 643 remaining actions in the same output.
- This is a build-portability correction, not a full link, new-kernel runtime,
  native test, banner, external-page or package acceptance result.

### `0055` — 2026-10-16 — native macOS CPU metadata, source-only

- Patch: `0055-native-macos-cpu-metadata.patch`.
- Patch SHA-256:
  `1843601b7848bbce5f8eb3b98336669026ba1174428e92ef718aa99f70b1349b`.
- The same ARM64 Chromium 152 build reported managed UA-CH architecture `x86`
  while its independently bound native/off control reported `arm`. The previous
  persona/coherence gate allowed this difference and did not establish physical
  CPU truth. Neither that gate nor the off control's site failure waives any
  managed real-site finding or proves the cause of Ping0's GPU finding.
- Correct only the shared managed `MacIntel` metadata producer on macOS. Use
  Chromium's real `base::mac::GetCPUType()` enum: Intel maps to `x86`, ARM and
  translated Intel (Rosetta) both map to `arm`. Guard the include and call with
  `BUILDFLAG(IS_MAC)`, not a build-architecture, UA-token or config-based CPU
  guess. The API is `BASE_EXPORT`; Blink public/common headers already have
  `//base` in `public_deps`. No new GN or embedder dependency is introduced.
- Other OS personas, bitness `64`, low-entropy/off behavior, platform/UA strings
  and every GPU field/path are unchanged. The patch changes just this header;
  initial payloads and all 53 earlier patch digests remain immutable.
- Normal provenance/apply/check exited 0. All 111 final-source hashes were read
  back; only the header identity changed to
  `42274e00369814a09b7309ef32708e5eb8b714e36aeb1f48f9822ccb0d6b405b`.
  The source-manifest SHA-256 is
  `e83ed04672ca2d9ca98939fbf00406dede5fdca27c21dc66587dcc4c975e8a1a`;
  the patchset has 58 inputs. Native HEAD, pinned baseline and archive provenance
  sidecars are unchanged. Old preparation/source commitments must not authorize
  a run of a future rebuilt kernel.
- The targeted source constraints first ran with 5 failed/0 skipped tests, then
  passed 5/5 after the forward patch. They reconstruct the immutable header
  chain and verify the guarded enum mapping, unchanged non-CPU bytes and exact
  manifests. This is source/provenance evidence, not native compilation/gtest,
  Intel/Rosetta runtime, complete kernel/link, browser/fixture, banner, Ping0,
  installation or package acceptance. Rebuild and real-site acceptance remain
  separate required work; no browser or network was started for this patch.
