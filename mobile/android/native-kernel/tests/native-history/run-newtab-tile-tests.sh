#!/usr/bin/env bash
# Dedicated task61 suite. Never invokes/changes the existing nine-host runner.
# All generated sources, diagnostics and retained failures stay in the unique run directory.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
JDK17="${JAVA17_HOME:-/opt/homebrew/opt/openjdk@17}"
MODE="${1:-}"
if [[ $# -gt 1 || ( -n "$MODE" && "$MODE" != --fixture-control ) ]]; then
  printf '%s\n' 'usage: bash run-newtab-tile-tests.sh [--fixture-control]' >&2
  exit 2
fi
BASE="$ROOT/.tmp-apk/proxy-fix-work/v13j-font-tests"
mkdir -p "$BASE"
OUT="$(mktemp -d "$BASE/tests.XXXXXX")"
printf 'OUTPUT %s\n' "$OUT"
python3 - "$ROOT" "$JDK17" "$OUT" "$MODE" <<'PY'
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

root, jdk, output = (Path(arg).resolve() for arg in sys.argv[1:4])
mode = sys.argv[4]
allowed = root / '.tmp-apk/proxy-fix-work/v13j-font-tests'
assert output.is_relative_to(allowed) and output != allowed
source = root / 'mobile/android/native-kernel/tests/native-history/NativeNewTabTileHostTest.java'
runner = root / 'mobile/android/native-kernel/tests/native-history/run-newtab-tile-tests.sh'
production = root / 'mobile/android/native-kernel/src/main/java/com/ahoo/abs/android/nativekernel'
pinned = [source, runner, production / 'NewTabPage.java', production / 'NativeBrowserActivity.java', production / 'BrowserHistory.java']

def receipt():
    return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest() for path in pinned}

before = receipt()
(output / 'inputs-before.json').write_text(json.dumps(before, indent=2) + '\n')
classes = output / 'harness-classes'
classes.mkdir()
commands = [
    ('javac', [str(jdk / 'bin/javac'), '--release', '17', '-Xlint:all', '-Werror', '-d', str(classes), str(source)], 45),
    ('java', [str(jdk / 'bin/java'), '-ea', '-cp', str(classes), 'NativeNewTabTileHostTest', str(root), str(output)] + ([mode] if mode else []), 120),
]
status = 0
for name, command, timeout in commands:
    (output / (name + '-command.json')).write_text(json.dumps({'argv': command, 'timeout_seconds': timeout}, indent=2) + '\n')
    start = time.monotonic()
    with (output / (name + '.stdout.log')).open('wb') as stdout, (output / (name + '.stderr.log')).open('wb') as stderr:
        try:
            result = subprocess.run(command, cwd=root, stdout=stdout, stderr=stderr, timeout=timeout, check=False)
            status = result.returncode
        except subprocess.TimeoutExpired:
            status = 124
        except OSError as error:
            stderr.write((repr(error) + '\n').encode())
            status = 127
    (output / (name + '-status.json')).write_text(json.dumps({'exit_code': status, 'elapsed_seconds': round(time.monotonic() - start, 3)}, indent=2) + '\n')
    print(name + ' exit_code=' + str(status), flush=True)
    print((output / (name + '.stdout.log')).read_text(), end='', flush=True)
    print((output / (name + '.stderr.log')).read_text(), end='', file=sys.stderr, flush=True)
    if status:
        break

after = receipt()
(output / 'inputs-after.json').write_text(json.dumps(after, indent=2) + '\n')
if before != after:
    print('ERROR: test/production input changed during this run', file=sys.stderr)
    status = status or 3
(output / 'run-status.json').write_text(json.dumps({'exit_code': status, 'mode': mode or 'ACTUAL_UNMODIFIED_SOURCE', 'inputs_unchanged': before == after}, indent=2) + '\n')
print('RETAINED_OUTPUT ' + str(output), flush=True)
sys.exit(status if 0 <= status <= 255 else 1)
PY
