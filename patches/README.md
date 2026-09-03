# Independent Browser Engine Patches

The production Chromium 149+ implementation lives in
[`chromium/`](./chromium/README.md). The macOS-first Firefox 154 native source,
build and append-only patch chain is being established in
[`firefox/`](./firefox/README.md); the existing stock-Firefox prefs/BiDi path
remains its fallback until the native capability matrix passes.

Both engines consume the public Agent Browser fingerprint config schema and do
not depend on proprietary browser distributions or binaries.
