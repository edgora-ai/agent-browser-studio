# TLS, HTTP/2 and HTTP/3 fingerprint corpus

This corpus proves that the independent Chromium build keeps the stock network
protocol fingerprint instead of claiming parity from its version number. It
uses public remote observers because a TLS/QUIC endpoint must see the wire
handshake before browser JavaScript exists.

## Observers and normalization

- `https://tls.peet.ws/api/all` records TLS JA4 plus HTTP/2 SETTINGS,
  connection WINDOW_UPDATE, frame order, pseudo-header/header order and
  priority.
- `https://tls.tlsfingerprint.io/api/client-fingerprint` records the complete
  TLS ClientHello capability surface.
- `https://quic.tlsfingerprint.io/api/client-fingerprint-quic` records a real
  HTTP/3 connection, QUIC Client Initial packet shape, normalized ClientHello
  and transport parameters.

The checked identity removes only connection-specific material: observer IP,
User-Agent/header values, SNI, ClientHello random/session identifiers, Chrome's
intentional TLS-extension permutation and the selected RFC 8701 GREASE code
point. Cipher order, extension multiplicity, supported groups/versions,
signature schemes, ALPN, key shares, HTTP/2 SETTINGS and header order, QUIC
version/connection-ID/packet-number shape, normalized QUIC ClientHello and all
named transport parameters remain in the comparison.

## Controlled comparison

Each browser used two cold processes and fresh temporary profiles on
2026-08-03. Only the same-major Stock Chrome comparison is a release gate;
older Cloak and Roxy builds are observable context.

| Browser | TLS | HTTP/2 | HTTP/3 / QUIC |
|---|---|---|---|
| Stock Google Chrome `150.0.7871.187` | complete, stable | complete, stable | complete, stable |
| Independent Chromium `150.0.7871.114` | **exact Stock 150** | **exact Stock 150** | **exact Stock 150** |
| Cloak Chromium `145.0.7632.109` | stable, older signature set | exact H2 shape | stable, older transport fingerprint |
| Observable RoxyChrome `149.0.7827.22` Profile | stable, older signature set | exact H2 shape | selected Profile route did not establish H3 |

The Roxy observation used an existing declared-Windows Profile through a
temporary copy of its public launch payload. Its H3 failure may be caused by
that Profile's route/proxy policy, so it is recorded as an observation rather
than a product-wide claim.

## Exact identities

The independent and Stock 150 results were byte-for-byte equal after the
bounded normalization:

| Component | Canonical SHA-256 / observable ID |
|---|---|
| TLS corpus SHA-256 | `8fbd90ba5edcac2cf6b72ce214a7e0e45482364e4af1746b15f2102748dff273` |
| TLS JA4 | `t13d1516h2_8daaf6152771_806a8c22fdea` |
| HTTP/2 corpus SHA-256 | `3a09a3a2e605387d2e967b72990c99a5064c4ac779871a8783ee5c8a0238f424` |
| HTTP/2 Akamai fingerprint | `1:65536;2:0;4:6291456;6:262144\|15663105\|0\|m,a,s,p` |
| HTTP/3 corpus SHA-256 | `f0a725279eafc282f9d40d0ab9df533cf0903ce1f24aca0133c0425cc328301e` |
| QUIC top / Client Initial IDs | `9b960c78d5e9235f` / `91fc7b001022ca85` |
| QUIC normalized ClientHello ID | `a45deedc2529fb27` |
| QUIC transport-parameter ID | `b1466e9ebbb4020c` |

Cloak 145 and Roxy 149 produced TLS corpus hash
`76b077df72b8b788f396ab4342b6dff66ccc456b1316b649f466f62a8e6443eb`.
They omit signature-scheme codes `0x0904`, `0x0905` and `0x0906` present in
Stock/independent Chromium 150. Cloak's HTTP/3 corpus hash is
`6baca169227618155bfaa274efa3833b569223c93e579ffd9eecc3c4b6aafa9a`,
with top ID `389a0820a022b8d7` and transport ID `d1ebb3c7cbcd40ec`;
its normalized QUIC ClientHello remains `a45deedc2529fb27`.

## Acceptance

Run the dynamic gate with an installed Stock Chrome of the same major:

```bash
npm run verify:network -- \
  --reference=stock --candidate=managed --samples=2 \
  'stock=/Applications/Google Chrome.app' \
  'managed=/path/to/Chromium.app'
```

The command fails if either browser is incomplete or unstable, their major
versions differ, or any canonical TLS, HTTP/2 or HTTP/3 field differs. Optional
older baselines may be added without weakening the Stock-vs-candidate gate.

This result requires no Chromium patch: the independent build deliberately
retains Chromium's stock TLS, HTTP/2 and QUIC implementation. It also does not
claim proxy-transport support. Managed HTTP and SOCKS5 profiles still disable
QUIC until an authenticated UDP-capable transport is implemented and verified.
The dynamic verifier and bounded canonicalization were first preserved in OSS
commit `592cb125a00c658e11fc6b60013112ea5d2ff2a9`; Chromium source checkpoint
`e7fc69f9ac673fd3f85f74438efa22154efaf1d7` and patchset `0040` are unchanged.
