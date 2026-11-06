#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "${1:-$SCRIPT_DIR/../../../../..}" && pwd)"
JDK17="${JAVA17_HOME:-/opt/homebrew/opt/openjdk@17}"
TEST_OUTPUT_ROOT="${NATIVE_HISTORY_TEST_OUTPUT_ROOT:-$ROOT/.tmp-apk/proxy-fix-work/v6-java-ui}"
mkdir -p "$TEST_OUTPUT_ROOT"
CLASSES="$(mktemp -d "$TEST_OUTPUT_ROOT/tests.XXXXXX")"
printf 'JDK17 regression output: %s\n' "$CLASSES"
"$JDK17/bin/javac" --release 17 -Xlint:all -Werror -d "$CLASSES" \
    "$ROOT/mobile/android/native-kernel/src/main/java/com/ahoo/abs/android/nativekernel/BrowserHistory.java" \
    "$SCRIPT_DIR/BrowserHistoryTest.java" "$SCRIPT_DIR/NativeBrowserUiSourceContractTest.java" \
    "$SCRIPT_DIR/NativeBrowserLifecycleHostTest.java" "$SCRIPT_DIR/NativeBrowserFocusHostTest.java"
"$JDK17/bin/java" -ea -cp "$CLASSES" BrowserHistoryTest
"$JDK17/bin/java" -ea -cp "$CLASSES" NativeBrowserUiSourceContractTest "$ROOT"
"$JDK17/bin/java" -ea -cp "$CLASSES" NativeBrowserLifecycleHostTest "$ROOT" "$CLASSES"
"$JDK17/bin/java" -ea -cp "$CLASSES" NativeBrowserFocusHostTest "$ROOT" "$CLASSES"
