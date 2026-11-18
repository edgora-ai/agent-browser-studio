#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "${1:-$SCRIPT_DIR/../../../../..}" && pwd)"
JDK17="${JAVA17_HOME:-/opt/homebrew/opt/openjdk@17}"
OUTPUT_ROOT="${NATIVE_HISTORY_STORE_TEST_OUTPUT_ROOT:-${TMPDIR:-/tmp}}"
mkdir -p "$OUTPUT_ROOT"
CLASSES="$(mktemp -d "$OUTPUT_ROOT/native-history-store.XXXXXX")"
printf 'Production history Store host test output: %s\n' "$CLASSES"
"$JDK17/bin/javac" --release 17 -Xlint:all -Werror -d "$CLASSES" \
    "$ROOT/mobile/android/native-kernel/src/main/java/com/ahoo/abs/android/nativekernel/BrowserHistory.java" \
    "$ROOT/mobile/android/native-kernel/src/main/java/com/ahoo/abs/android/nativekernel/BrowserHistoryStore.java" \
    "$SCRIPT_DIR/android/content/Context.java" \
    "$SCRIPT_DIR/android/os/Handler.java" "$SCRIPT_DIR/android/os/Looper.java" \
    "$SCRIPT_DIR/android/os/Process.java" "$SCRIPT_DIR/android/util/AtomicFile.java" \
    "$SCRIPT_DIR/org/chromium/base/Log.java" \
    "$SCRIPT_DIR/BrowserHistoryStoreHostTest.java"
"$JDK17/bin/java" -ea -cp "$CLASSES" com.ahoo.abs.android.nativekernel.BrowserHistoryStoreHostTest
