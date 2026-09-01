#!/bin/bash
# Prepare the pinned Chromium 152 source tree with the standard gclient layout.
#
# Usage:
#   ./patches/chromium/prepare-source.sh [/path/to/chromium-build-152]
#
# The argument is the gclient root, not the src directory. The resulting tree is:
#   <gclient-root>/.gclient
#   <gclient-root>/src/.git
#
# Network proxy settings are intentionally inherited from the caller's
# HTTP_PROXY/HTTPS_PROXY/ALL_PROXY environment. Nothing is written to global Git
# configuration. A failed sync is resumable: fix the network and rerun this
# script without deleting the checkout. When the main Git pack cannot be
# transferred reliably, seed an archive with seed-source-archive.sh, advance it
# to the pinned commit with advance-source-compare.mjs, then run this script with
# CHROMIUM_SOURCE_PRESEEDED=1 so gclient syncs DEPS without refetching src.
set -euo pipefail

PATCH_ROOT="$(cd "$(dirname "$0")" && pwd)"
CHROMIUM_COMMIT="026bb13a93d60e7adfefa2bbf58d6f57c2d335cc"
CHROMIUM_SOURCE_URL="${CHROMIUM_SOURCE_URL:-https://chromium.googlesource.com/chromium/src.git}"
GCLIENT_ROOT="${1:-$HOME/workspace/chromium-build-152}"
GCLIENT_JOBS="${GCLIENT_JOBS:-4}"
GCLIENT_PY="${GCLIENT_PY:-}"
GCLIENT_NO_HISTORY="${GCLIENT_NO_HISTORY:-1}"
SOURCE_PRESEEDED="${CHROMIUM_SOURCE_PRESEEDED:-0}"
MIN_FREE_GIB="${CHROMIUM_PREPARE_MIN_FREE_GIB:-125}"
MIN_POST_SYNC_FREE_GIB="${CHROMIUM_POST_SYNC_MIN_FREE_GIB:-90}"

require_positive_integer() {
  local name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "error: $name must be a positive integer, got: $value" >&2
    exit 2
  fi
}

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "error: required command is not on PATH: $command_name" >&2
    exit 2
  fi
}

free_gib() {
  local target="$1"
  local free_kib
  free_kib="$(df -Pk "$target" | tail -1 | tr -s ' ' | cut -d ' ' -f 4)"
  if [[ ! "$free_kib" =~ ^[0-9]+$ ]]; then
    echo "error: unable to determine free disk space for: $target" >&2
    exit 2
  fi
  printf '%s\n' "$((free_kib / 1024 / 1024))"
}

require_free_space() {
  local target="$1"
  local minimum="$2"
  local stage="$3"
  local available
  available="$(free_gib "$target")"
  echo "$stage disk: ${available} GiB free (minimum ${minimum} GiB)"
  if (( available < minimum )); then
    echo "error: insufficient disk for $stage; refusing to start an hours-long Chromium operation" >&2
    exit 2
  fi
}

require_nonempty_directory() {
  local directory="$1"
  if [[ ! -d "$directory" ]] || [[ -z "$(find "$directory" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
    echo "error: gclient sync left a required dependency missing or empty: $directory" >&2
    exit 1
  fi
}

require_positive_integer "GCLIENT_JOBS" "$GCLIENT_JOBS"
require_positive_integer "CHROMIUM_PREPARE_MIN_FREE_GIB" "$MIN_FREE_GIB"
require_positive_integer "CHROMIUM_POST_SYNC_MIN_FREE_GIB" "$MIN_POST_SYNC_FREE_GIB"
for boolean_setting in SOURCE_PRESEEDED GCLIENT_NO_HISTORY; do
  value="${!boolean_setting}"
  if [[ "$value" != "0" && "$value" != "1" ]]; then
    echo "error: $boolean_setting must be 0 or 1, got: $value" >&2
    exit 2
  fi
done
require_command git
if [[ -n "$GCLIENT_PY" ]]; then
  require_command python3
  if [[ ! -f "$GCLIENT_PY" ]]; then
    echo "error: GCLIENT_PY does not point to gclient.py: $GCLIENT_PY" >&2
    exit 2
  fi
  GCLIENT_COMMAND=(python3 "$GCLIENT_PY")
else
  require_command gclient
  GCLIENT_COMMAND=(gclient)
fi

mkdir -p "$GCLIENT_ROOT"
if [[ "$SOURCE_PRESEEDED" == "1" ]]; then
  require_free_space "$GCLIENT_ROOT" "$MIN_POST_SYNC_FREE_GIB" "pre-DEPS-sync"
else
  require_free_space "$GCLIENT_ROOT" "$MIN_FREE_GIB" "pre-sync"
fi

if [[ -e "$GCLIENT_ROOT/.gclient" ]]; then
  if ! grep -Eq "['\"]name['\"][[:space:]]*:[[:space:]]*['\"]src['\"]" "$GCLIENT_ROOT/.gclient"; then
    echo "error: existing .gclient does not define the required src solution: $GCLIENT_ROOT/.gclient" >&2
    exit 2
  fi
else
  (
    cd "$GCLIENT_ROOT"
    "${GCLIENT_COMMAND[@]}" config --name=src --unmanaged "$CHROMIUM_SOURCE_URL"
  )
fi

CHROMIUM_SRC="$GCLIENT_ROOT/src"
SYNC_ARGUMENTS=(-D --jobs "$GCLIENT_JOBS")
if [[ "$GCLIENT_NO_HISTORY" == "1" ]]; then
  SYNC_ARGUMENTS+=(--no-history)
fi
if [[ "$SOURCE_PRESEEDED" == "1" ]]; then
  "$PATCH_ROOT/verify-source-provenance.sh" "$CHROMIUM_SRC" "$CHROMIUM_COMMIT" >/dev/null
  echo "Syncing DEPS for preseeded Chromium $CHROMIUM_COMMIT in $CHROMIUM_SRC"
else
  SYNC_ARGUMENTS+=(--revision "src@$CHROMIUM_COMMIT")
  echo "Syncing Chromium $CHROMIUM_COMMIT into $CHROMIUM_SRC"
fi
echo "A network failure is resumable; rerun this script without deleting the checkout."
(
  cd "$GCLIENT_ROOT"
  "${GCLIENT_COMMAND[@]}" sync "${SYNC_ARGUMENTS[@]}"
)

if [[ ! -d "$CHROMIUM_SRC/.git" ]]; then
  echo "error: gclient did not create the expected Chromium checkout: $CHROMIUM_SRC" >&2
  exit 1
fi

actual_commit="$("$PATCH_ROOT/verify-source-provenance.sh" "$CHROMIUM_SRC" "$CHROMIUM_COMMIT")"

for dependency in \
  third_party/icu \
  third_party/swiftshader \
  third_party/devtools-frontend/src \
  third_party/tflite/src \
  third_party/webrtc; do
  require_nonempty_directory "$CHROMIUM_SRC/$dependency"
done

require_free_space "$GCLIENT_ROOT" "$MIN_POST_SYNC_FREE_GIB" "post-sync"
echo "Chromium source ready: $CHROMIUM_SRC ($actual_commit)"
