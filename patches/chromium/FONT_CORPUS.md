# Font capability corpus

This corpus verifies declared-platform font behavior beyond a
`document.fonts.check()` allow-list. It uses only public browser APIs and
observable output; no proprietary source or profile format is an input.

## Coverage

The self-contained probe captures the same cases in Window and Dedicated
Worker:

- 39 named candidates, including one deliberately nonexistent family;
- 13 CSS generic families, 3 styles and 10 multilingual samples: 390 metrics;
- 468 named-family metrics;
- 247 quantized Latin/CJK/emoji glyph rasters;
- matching DOM widths for the normal generic and named cases;
- Local Font Access metadata after an explicit `local-fonts` permission grant.

Raster colors are quantized to four bits before hashing. This removes the
managed one-bit Canvas readback noise without removing glyph shape,
antialiasing or color-emoji differences. Availability requires both a width
difference against three independent generic fallbacks and a positive
`FontFaceSet.check()` result, so a missing family that merely falls back is not
reported as installed.

## Observable comparison

Six existing RoxyChrome Profiles were captured through temporary copies: three
declared Windows and three declared macOS. Profiles within each platform had
identical results. The independent build used seed `24680`, locale `en-US` and
the same Chromium `150.0.7871.114` binary for both declared platforms.

| Browser / declared platform | Available candidates | Deliberately missing family | Local entries / distinct families | Max Canvas-vs-DOM generic width delta | Cases over 2 px |
|---|---:|---:|---:|---:|---:|
| RoxyChrome 149 / Windows | 11 / 39 | unavailable | 631 / host set | 1.7500 px | 0 |
| RoxyChrome 149 / macOS | 39 / 39 | **reported available** | 631 / same host set | 68.8131 px | 130 |
| Independent Chromium 150 / Windows | 15 / 39 | unavailable | 30 / 10 | 1.7657 px | 0 |
| Independent Chromium 150 / macOS | 15 / 39 | unavailable | 76 / 17 | 1.7500 px | 0 |

The independent Local Font Access family sets contain no family outside each
profile's `fonts` configuration. Candidate availability can be larger than the
Local Access family count because Windows compatibility aliases such as
`Helvetica`, `Menlo` and `Times` resolve to managed portable families instead
of exposing the macOS host font.

Both implementations produce platform-shaped rendering, but the independent
build also keeps every Window/Worker component identical:

| Cross-platform differing cases | Availability | Generic metrics | Named metrics | Glyph raster |
|---|---:|---:|---:|---:|
| RoxyChrome observable corpus | 28 / 39 | 390 / 390 | 468 / 468 | 157 / 247 |
| Independent Chromium 150 | 10 / 39 | 390 / 390 | 415 / 468 | 203 / 247 |

## Reproducible hashes

The controlled independent captures produced:

| Declared platform | Availability | Generic metrics | Named metrics | Raster | Local Access | Full corpus |
|---|---|---|---|---|---|---|
| Windows | `3e651de3cbfc8b63a8084323d544bd55ae567cdec9ec3013f74c9020ecee7895` | `857474b8f2a8ef8e9eea0940cd13698ee87cdd9596c848fa285f6f17f23024ee` | `5a9f6d7df681d50596fbede5b090cabd79555bedd0f3f98bf92be06a67d9de77` | `417b13b628d10a5e9f23362357484fa4f0b2be568df7ca002bbe1773d03da564` | `4a401dd7cc44225d526ea7e7fbae7345da79206124e34f3b11b2995b0834419f` | `ba3572836bddba2733f2a655d5968f9343a41d4b3175f8b991c8d32acc148c6e` |
| macOS | `ca246b89d9631b762829b806caacd096196ed975b37419333ecf03dc86189e8b` | `ec2b186b146710299d86e488a4545f6c62b92f6971e910104727ece3cbf9235b` | `238755420eeb63325513c2c1762f98a3810677b13020bb719683ebe2b136d04f` | `7c036fa7de4319dd8d8cfa6abcf7086935f735552979207dba8dcd92fd4cfa88` | `d0db1347d6f261611f5e153eea01310f7bb6b76bd40953b677f28e4a9d97cd16` | `a00ceaaeb1f09f0ed9d987ca53056343e70cead935e7cbf2138abd3588b3a3ed` |

The RoxyChrome Windows/macOS component hashes are respectively
`f666ed8f…` / `039639aa…` for availability, `6b18b6ce…` / `aee299c4…`
for generic metrics, `dd829194…` / `1a605e0f…` for named metrics,
`28947fa4…` / `549d211e…` for raster and the identical `b6417942…` for
Local Font Access.

## Acceptance gate

`verify-native-chromium.ts` now fails unless:

1. Window and Worker availability, generic metrics, named metrics and raster
   are byte-for-byte equal;
2. the deliberately missing family is unavailable in both contexts;
3. Local Font Access succeeds and returns no configuration-external family;
4. every normal generic Canvas/DOM width pair differs by at most 2 px;
5. Windows and macOS differ in all four font components; and
6. the complete corpus remains stable across an independent same-seed Profile,
   a same-Profile restart and headed/headless execution.

Patch `0040-native-managed-font-resolution.patch` moves the allow-list into the
actual Blink platform-font lookup and maps Windows CSS generics to managed
portable families before host fallback can occur.

Patch `0044-agent-browser-managed-dns-locale-refresh.patch` narrows the generic
family set (only CSS `math` and the standard generics are treated as generic
for host-font detection) and passes the generic flag explicitly so
`ManagedGenericFontFamily` maps exactly the declared platform families without
leaking emoji/fangsong/ui- host fonts, while the renderer keeps the managed ICU
locale so font selection stays consistent with the declared language.
