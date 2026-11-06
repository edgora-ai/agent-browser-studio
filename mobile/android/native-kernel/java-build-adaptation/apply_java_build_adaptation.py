#!/usr/bin/env python3
"""Apply the Java startup-hint build adaptation to a Chromium checkout.

The frozen Android native build sets JAVA_TOOL_OPTIONS=-Xint, which makes every
JVM print an un-disablable "Picked up JAVA_TOOL_OPTIONS" hint on stderr. The
stock build_utils.CheckOutput treats any nonempty stderr as a build failure, so
the hint (plus the empty-line layout it leaves behind) fails Java build steps.
This script applies the repository-hosted adaptation to
build/android/gyp/util/build_utils.py after the managed 0002-0058 patch chain,
verifying exact source identity before and after. It never widens the change,
rewrites the managed chain, or suppresses real warnings, errors, or nonzero
exits.
"""
import argparse
import hashlib
import os
import subprocess
import sys
from pathlib import Path

# Chromium 152.0.7977.72 upstream blob identity, verified against the tag
# (gitiles blob bcd561c08814422c646efc8d5417fb94105f4b8cd536f5f4c7fbbf4191e76687).
ORIGINAL_SHA256 = "bcd561c08814422c646efc8d5417fb94105f4b8cd536f5f4c7fbbf4191e76687"
# Result of applying patches/build_utils-java-startup-hint.patch to it.
PATCHED_SHA256 = "0500be2fc77e03bdd1c2d54ed36e1793a2fc82f1bf3f6011594eb7d548293f0c"
TARGET = "build/android/gyp/util/build_utils.py"


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 16), b""):
            digest.update(block)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("chromium_src", type=Path, help="Chromium src checkout root")
    parser.add_argument(
        "--check", action="store_true", help="only verify state; do not modify")
    args = parser.parse_args()

    repo = Path(__file__).absolute().parent
    patch = repo / "patches" / "build_utils-java-startup-hint.patch"
    target = args.chromium_src / TARGET

    if not target.is_file():
        print(f"FAIL: missing {target}", file=sys.stderr)
        return 2
    actual = sha256_file(target)
    if actual == PATCHED_SHA256:
        print("ALREADY_APPLIED: build_utils.py matches the pinned adapted bytes")
        return 0
    if actual != ORIGINAL_SHA256:
        print(
            f"FAIL: unexpected build_utils.py bytes (sha256 {actual}); refusing "
            "to adapt anything but the pinned Chromium 152.0.7977.72 file",
            file=sys.stderr)
        return 2
    if args.check:
        print("CHECK_OK: original bytes match; adaptation not yet applied")
        return 0

    result = subprocess.run(
        ["git", "-C", str(args.chromium_src), "apply", "--whitespace=nowarn",
         str(patch)], capture_output=True, text=True)
    if result.returncode != 0:
        print(f"FAIL: git apply rejected the patch: {result.stderr}",
              file=sys.stderr)
        return 2
    adapted = sha256_file(target)
    if adapted != PATCHED_SHA256:
        print(f"FAIL: post-apply bytes mismatch (sha256 {adapted})",
              file=sys.stderr)
        return 2
    print(f"APPLIED: build_utils.py adapted, sha256 {adapted}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
