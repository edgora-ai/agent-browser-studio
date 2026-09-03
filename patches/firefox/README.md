# Independent Firefox 154 native engine

This directory owns the reproducible macOS-first source, patch and verification
chain for the independent Gecko engine. The existing stock-Firefox
`user.js` + WebDriver BiDi preload implementation remains the fallback; this
patch chain adds native surfaces without changing `BrowserFingerprintConfig`
`schemaVersion: 1`.

## Pinned source

- Firefox: `154.0`
- Repository: `https://hg.mozilla.org/releases/mozilla-release`
- Release tag: `FIREFOX_154_0_RELEASE`
- SourceStamp: `9ce1ee6baeb9a3c326dbd180bdece65d8fc2eadc`
- Archive: `https://archive.mozilla.org/pub/firefox/releases/154.0/source/firefox-154.0.source.tar.xz`
- SHA-512: see `SOURCE.sha512`

The source tree and objdir live outside this repository at
`~/workspace/firefox-build-154/src` by default.

## Checkpoints

```bash
# Download the signed checksum manifest, verify Mozilla's pinned release
# signature, then download and extract the exact source archive.
patches/firefox/prepare-source.sh

# Validate immutable artifacts and source provenance.
patches/firefox/check.sh ~/workspace/firefox-build-154/src

# Build the macOS arm64 stock/patched engine incrementally.
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  patches/firefox/build-macos.sh ~/workspace/firefox-build-154/src
```

No binary is considered native-patched merely because its version is `154.0`.
The product and release packager must also obtain the versioned
`--agent-browser-capabilities` response introduced by the Gecko patch chain.
