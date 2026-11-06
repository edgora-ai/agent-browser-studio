"""Run only on the coordinator-registered, independently checked SSD task root.

Usage: ABS_STORAGE_TEST_ROOT=<registered-root>/tests/storage python3 -B run_contract_tests.py
The directory must already exist with mode 0700. All databases remain below it.
No Android library, Gradle, device, network or existing KeyStore access occurs.
"""
import os
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True

from storage_harness import require_root


def main():
    if len(sys.argv) != 1:
        print("Use the explicit ABS_STORAGE_TEST_ROOT environment parameter only", file=sys.stderr)
        return 2
    try:
        root = require_root()
    except (RuntimeError, OSError):
        print("REFUSED: explicit owned 0700 ABS_STORAGE_TEST_ROOT is required; no fallback",
              file=sys.stderr)
        return 2
    print("Synthetic SQL evidence root:", root, flush=True)
    directory = str(Path(os.path.abspath(__file__)).parent)
    suite = unittest.defaultTestLoader.discover(directory, pattern="test_*.py")
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    print("Boundary: original SQL + static source contracts only; Android/KeyStore/build/device NOT run.")
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
