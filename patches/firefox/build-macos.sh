#!/bin/bash
# Incrementally build the pinned Firefox 154 engine for macOS arm64.
set -euo pipefail

PATCH_ROOT="$(cd "$(dirname "$0")" && pwd)"
FIREFOX_SRC="${1:-$HOME/workspace/firefox-build-154/src}"
FIREFOX_STAMP="9ce1ee6baeb9a3c326dbd180bdece65d8fc2eadc"
OBJ_DIR="$FIREFOX_SRC/obj-agent-browser-arm64"
MIN_INITIAL_FREE_GIB="${FIREFOX_BUILD_MIN_FREE_GIB:-70}"
MIN_RESUME_FREE_GIB="${FIREFOX_BUILD_RESUME_MIN_FREE_GIB:-30}"
BUILD_PACKAGE="${FIREFOX_BUILD_PACKAGE:-1}"

free_gib() {
  local free_kib
  free_kib="$(df -Pk "$1" | tail -1 | tr -s ' ' | cut -d ' ' -f 4)"
  [[ "$free_kib" =~ ^[0-9]+$ ]] || { echo "error: unable to determine free disk space" >&2; exit 2; }
  printf '%s\n' "$((free_kib / 1024 / 1024))"
}
if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "error: build-macos.sh requires macOS arm64" >&2
  exit 2
fi
if [[ "$BUILD_PACKAGE" != "0" && "$BUILD_PACKAGE" != "1" ]]; then
  echo "error: FIREFOX_BUILD_PACKAGE must be 0 or 1" >&2
  exit 2
fi
if [[ ! -x "$FIREFOX_SRC/mach" ]]; then
  echo "error: prepared Firefox source is missing: $FIREFOX_SRC/mach" >&2
  echo "run $PATCH_ROOT/prepare-source.sh first" >&2
  exit 2
fi
ACTIVE_DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
if [[ "$ACTIVE_DEVELOPER_DIR" != */Xcode*.app/Contents/Developer ]]; then
  echo "error: DEVELOPER_DIR must point to a full Xcode installation" >&2
  exit 2
fi
export DEVELOPER_DIR="$ACTIVE_DEVELOPER_DIR"
xcodebuild -version >/dev/null

LLVM_PREFIX="${FIREFOX_LLVM_PREFIX:-}"
LLD_PREFIX="${FIREFOX_LLD_PREFIX:-}"
if [[ -z "$LLVM_PREFIX" || -z "$LLD_PREFIX" ]]; then
  if ! command -v brew >/dev/null 2>&1; then
    echo "error: Homebrew LLVM/LLD are required; install them or set FIREFOX_LLVM_PREFIX and FIREFOX_LLD_PREFIX" >&2
    exit 2
  fi
  if [[ -z "$LLVM_PREFIX" ]]; then
    LLVM_PREFIX="$(brew --prefix llvm@21 2>/dev/null)" || {
      echo "error: Homebrew LLVM 21 is required; run: brew install llvm@21" >&2
      exit 2
    }
  fi
  if [[ -z "$LLD_PREFIX" ]]; then
    LLD_PREFIX="$(brew --prefix lld@21 2>/dev/null)" || {
      echo "error: Homebrew LLD 21 is required; run: brew install lld@21" >&2
      exit 2
    }
  fi
fi
if [[ ! -x "$LLVM_PREFIX/bin/clang" || ! -x "$LLVM_PREFIX/bin/clang++" ]]; then
  echo "error: clang/clang++ are missing under FIREFOX_LLVM_PREFIX: $LLVM_PREFIX" >&2
  exit 2
fi
WASI_SYSROOT="${FIREFOX_WASI_SYSROOT:-}"
if [[ -z "$WASI_SYSROOT" ]]; then
  wasi_libc_prefix="$(brew --prefix wasi-libc 2>/dev/null)" || {
    echo "error: Homebrew wasi-libc is required; run: brew install wasi-libc" >&2
    exit 2
  }
  wasi_runtimes_prefix="$(brew --prefix wasi-runtimes 2>/dev/null)" || {
    echo "error: Homebrew wasi-runtimes is required; run: brew install wasi-runtimes" >&2
    exit 2
  }
  if [[ "$(brew list --versions wasi-libc)" != "wasi-libc 33" || \
        "$(brew list --versions wasi-runtimes)" != "wasi-runtimes 23.1.0" ]]; then
    echo "error: Firefox build requires wasi-libc 33 and wasi-runtimes 23.1.0" >&2
    exit 2
  fi
  WASI_SYSROOT="$(dirname "$FIREFOX_SRC")/toolchains/wasi-sysroot-clang21.1.8-libc33-runtimes23.1.0"
  wasi_marker=$'clang=21.1.8\nlld=21.1.8\nwasi-libc=33\nwasi-runtimes=23.1.0'
  if [[ ! -e "$WASI_SYSROOT" ]]; then
    mkdir -p "$(dirname "$WASI_SYSROOT")"
    wasi_staging="$WASI_SYSROOT.staging.$$"
    if [[ -e "$wasi_staging" ]]; then
      echo "error: WASI staging path already exists: $wasi_staging" >&2
      exit 2
    fi
    mkdir "$wasi_staging"
    ditto "$wasi_libc_prefix/share/wasi-sysroot" "$wasi_staging"
    ditto "$wasi_runtimes_prefix/share/wasi-sysroot" "$wasi_staging"
    printf '%s\n' "$wasi_marker" > "$wasi_staging/.agent-browser-toolchain"
    mv "$wasi_staging" "$WASI_SYSROOT"
  elif [[ ! -f "$WASI_SYSROOT/.agent-browser-toolchain" || \
          "$(<"$WASI_SYSROOT/.agent-browser-toolchain")" != "$wasi_marker" ]]; then
    echo "error: refusing to reuse an unrecognized WASI sysroot: $WASI_SYSROOT" >&2
    exit 2
  fi
fi
if [[ ! -f "$WASI_SYSROOT/include/wasm32-wasip1/string.h" || \
      ! -f "$WASI_SYSROOT/include/wasm32-wasip1/c++/v1/cstring" || \
      ! -f "$WASI_SYSROOT/lib/wasm32-wasip1/crt1.o" || \
      ! -f "$WASI_SYSROOT/lib/wasm32-wasip1/libc++.a" ]]; then
  echo "error: invalid FIREFOX_WASI_SYSROOT: $WASI_SYSROOT" >&2
  exit 2
fi
export WASI_SYSROOT
export CC="$LLVM_PREFIX/bin/clang"
export CXX="$LLVM_PREFIX/bin/clang++"
export PATH="$LLD_PREFIX/bin:$LLVM_PREFIX/bin:$HOME/.cargo/bin:$PATH"
RUSTUP_TOOLCHAIN="${FIREFOX_RUST_TOOLCHAIN:-1.94.1-aarch64-apple-darwin}"
export RUSTUP_TOOLCHAIN
if [[ "$(rustc --version)" != "rustc 1.94.1 (e408947bf 2026-03-25)" ]]; then
  echo "error: Firefox build requires Rust 1.94.1; run: rustup toolchain install 1.94.1-aarch64-apple-darwin --profile default" >&2
  exit 2
fi
rust_sysroot="$(rustc --print sysroot)"
if ! "$rust_sysroot/lib/rustlib/aarch64-apple-darwin/bin/rust-objcopy" --version >/dev/null; then
  echo "error: Rust 1.94.1 rust-objcopy is not executable" >&2
  exit 2
fi
if ! command -v cbindgen >/dev/null 2>&1 || [[ "$(cbindgen --version)" != "cbindgen 0.29.4" ]]; then
  echo "error: cbindgen 0.29.4 is required; run: cargo install cbindgen --version 0.29.4 --locked" >&2
  exit 2
fi
compiler_version="$($CC --version)"
if [[ "$compiler_version" != *"clang version 21.1.8"* ]]; then
  echo "error: Firefox build requires clang 21.1.8: $compiler_version" >&2
  exit 2
fi
linker_version="$($CC --target=arm64-apple-darwin -fuse-ld=lld -Wl,--version 2>&1)" || {
  echo "error: clang cannot execute the bundled lld linker" >&2
  exit 2
}
if [[ "$linker_version" != "Homebrew LLD 21.1.8" ]]; then
  echo "error: Firefox build requires Homebrew LLD 21.1.8: $linker_version" >&2
  exit 2
fi
wasi_c_probe="$(mktemp -t agent-browser-wasi-c).wasm"
wasi_cxx_probe="$(mktemp -t agent-browser-wasi-cxx).wasm"
if ! printf '%s\n' 'int main(void) { return 0; }' | \
  "$CC" --target=wasm32-wasip1 --sysroot="$WASI_SYSROOT" -x c \
    -o "$wasi_c_probe" - || \
   ! printf '%s\n' '#include <cstring>' 'int main() { return 0; }' | \
  "$CXX" -std=gnu++20 --target=wasm32-wasip1 --sysroot="$WASI_SYSROOT" \
    -x c++ -o "$wasi_cxx_probe" -; then
  rm -f "$wasi_c_probe" "$wasi_cxx_probe"
  echo "error: WASI C/C++ link probe failed; run: brew install wasi-libc wasi-runtimes" >&2
  exit 2
fi
rm -f "$wasi_c_probe" "$wasi_cxx_probe"

"$PATCH_ROOT/verify-source-provenance.sh" "$FIREFOX_SRC" "$FIREFOX_STAMP"
"$PATCH_ROOT/check.sh" "$FIREFOX_SRC"

if [[ -d "$OBJ_DIR" ]]; then
  minimum="$MIN_RESUME_FREE_GIB"; stage="resume build"
else
  minimum="$MIN_INITIAL_FREE_GIB"; stage="initial build"
fi
available="$(free_gib "$FIREFOX_SRC")"
echo "$stage disk: ${available} GiB free (minimum ${minimum} GiB)"
if (( available < minimum )); then
  echo "error: insufficient disk for $stage" >&2
  exit 2
fi

(
  cd "$FIREFOX_SRC"
  MOZCONFIG="$PATCH_ROOT/mozconfig.macos-arm64" ./mach build
)

app=""
while IFS= read -r candidate; do
  if [[ -x "$candidate/Contents/MacOS/firefox" ]]; then
    if [[ -n "$app" ]]; then
      echo "error: multiple Firefox app bundles found in $OBJ_DIR/dist" >&2
      exit 1
    fi
    app="$candidate"
  fi
done < <(find "$OBJ_DIR/dist" -maxdepth 1 -type d -name '*.app' | LC_ALL=C sort)
if [[ -z "$app" ]]; then
  echo "error: built Firefox app bundle not found in $OBJ_DIR/dist" >&2
  exit 1
fi

if [[ "$BUILD_PACKAGE" == "1" ]]; then
  (cd "$FIREFOX_SRC" && MOZCONFIG="$PATCH_ROOT/mozconfig.macos-arm64" ./mach package)
  dmg=""
  while IFS= read -r candidate; do
    if [[ -n "$dmg" ]]; then
      echo "error: multiple Firefox DMGs found in $OBJ_DIR/dist" >&2
      exit 1
    fi
    dmg="$candidate"
  done < <(find "$OBJ_DIR/dist" -maxdepth 1 -type f -name 'firefox-154.0*.dmg' | LC_ALL=C sort)
  if [[ -z "$dmg" ]]; then
    echo "error: packaged Firefox DMG not found in $OBJ_DIR/dist" >&2
    exit 1
  fi

  mountpoint="$(mktemp -d -t agent-browser-firefox-dmg)"
  package_staging=""
  mounted=0
  cleanup_package_mount() {
    if [[ "$mounted" == "1" ]]; then
      hdiutil detach "$mountpoint" >/dev/null 2>&1 || true
    fi
    [[ -z "$mountpoint" || ! -d "$mountpoint" ]] || rmdir "$mountpoint" 2>/dev/null || true
    [[ -z "$package_staging" || ! -e "$package_staging" ]] || rm -rf "$package_staging"
  }
  trap cleanup_package_mount EXIT
  hdiutil attach -readonly -nobrowse -mountpoint "$mountpoint" "$dmg" >/dev/null
  mounted=1
  packaged_app=""
  while IFS= read -r candidate; do
    if [[ -n "$packaged_app" ]]; then
      echo "error: multiple Firefox app bundles found in packaged DMG" >&2
      exit 1
    fi
    packaged_app="$candidate"
  done < <(find "$mountpoint" -maxdepth 1 -type d -name '*.app' | LC_ALL=C sort)
  if [[ -z "$packaged_app" ]]; then
    echo "error: Firefox app bundle not found in packaged DMG" >&2
    exit 1
  fi

  package_output="$OBJ_DIR/agent-browser-packaged-app"
  package_marker=$'Firefox 154.0 packaged app\nSourceStamp: '"$FIREFOX_STAMP"
  package_staging="$package_output.staging.$$"
  [[ ! -e "$package_staging" ]] || {
    echo "error: packaged-app staging path already exists: $package_staging" >&2
    exit 2
  }
  mkdir "$package_staging"
  ditto "$packaged_app" "$package_staging/$(basename "$packaged_app")"
  printf '%s\n' "$package_marker" > "$package_staging/.agent-browser-packaged-app"
  hdiutil detach "$mountpoint" >/dev/null
  mounted=0
  rmdir "$mountpoint"
  mountpoint=""
  if [[ -e "$package_output" ]]; then
    if [[ ! -f "$package_output/.agent-browser-packaged-app" || \
          "$(<"$package_output/.agent-browser-packaged-app")" != "$package_marker" ]]; then
      echo "error: refusing to replace an unrecognized packaged-app directory: $package_output" >&2
      exit 2
    fi
    rm -rf "$package_output"
  fi
  mv "$package_staging" "$package_output"
  package_staging=""
  app="$package_output/$(basename "$packaged_app")"
  trap - EXIT

  xattr -cr "$app"
  codesign --force --deep --sign - --timestamp=none "$app"
  codesign --verify --deep --strict "$app"
fi

binary="$app/Contents/MacOS/firefox"
version_output="$("$binary" --version)"
if [[ "$version_output" != *"154.0"* ]]; then
  echo "error: built Firefox reported an unexpected version: $version_output" >&2
  exit 1
fi
source_stamp="$(awk -F= '$1 == "SourceStamp" { print $2 }' "$app/Contents/Resources/application.ini")"
if [[ "$source_stamp" != "$FIREFOX_STAMP" ]]; then
  echo "error: built Firefox reported an unexpected SourceStamp: ${source_stamp:-<empty>}" >&2
  exit 1
fi
architecture="$(file "$binary")"
if [[ "$architecture" != *"Mach-O 64-bit executable arm64"* ]]; then
  echo "error: built Firefox is not a native arm64 Mach-O: $architecture" >&2
  exit 1
fi

echo "Firefox engine built: $app"
echo "version: $version_output"
echo "source: $source_stamp"
echo "architecture: $architecture"
