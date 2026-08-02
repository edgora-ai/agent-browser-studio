# Chromium patch history

This is an append-only provenance ledger for the independent Chromium source.
Released patch files are immutable: a correction is a new numbered patch, not
an edit to an earlier file. `PATCHSET.sha256` makes an accidental rewrite fail
before the patch applicability check runs.

## Preservation rules

1. Keep experimental, diagnostic, cleanup and final-fix commits in the
   Chromium source branch. Do not amend, squash or rebase that branch.
2. Export a released source change as the next numbered patch. After `0038`,
   the next file is `0039-*`.
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

## Chromium 150 source checkpoint

- Upstream baseline: `f405107495a07cb1bfcf687d4af8d91117098db6`
  (`150.0.7871.114`).
- Preserved branch: `roxy/chromium-150-checkpoint-20260802`.
- Preserved head after patch `0037`:
  `4cce113972524faf9fe01d502fe391a0671a74e2`.

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
