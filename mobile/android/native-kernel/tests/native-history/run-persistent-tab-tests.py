#!/usr/bin/env python3
"""Patch temporary copies of an explicit original Chromium snapshot and run JDK17 fake hosts.
No Android build, physical Surface timing, or visual acceptance is established.
"""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot-root", type=Path, required=True,
                        help="Original Chromium root containing content/shell/android/java/src")
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[5])
    parser.add_argument("--java-home", type=Path, default=Path(os.environ.get(
        "JAVA17_HOME", os.environ.get("JAVA_HOME", "/opt/homebrew/opt/openjdk@17"))))
    args = parser.parse_args()
    root = args.repo_root.resolve(strict=True)
    snapshot = args.snapshot_root.resolve(strict=True)
    module = root / "mobile/android/native-kernel"
    test = module / "tests/native-history/NativePersistentTabHostTest.java"
    relative = Path("content/shell/android/java/src/org/chromium/content_shell")
    inputs = [snapshot / relative / name for name in ("ShellManager.java", "Shell.java")]
    if not all(source.is_file() for source in inputs):
        parser.error("snapshot-root must contain original ShellManager.java and Shell.java")
    java = args.java_home.resolve(strict=True) / "bin"
    with tempfile.TemporaryDirectory(prefix="native-persistent-tab-") as temporary:
        work = Path(temporary).resolve(strict=True)
        print(f"Temporary patched source / fake-host output: {work}", flush=True)
        destination = work / relative
        destination.mkdir(parents=True)
        for source in inputs:
            shutil.copyfile(source, destination / source.name)
        for name in ("product-tabs.patch", "product-java-release.patch"):
            patch = module / "chromium" / name
            subprocess.run(["git", "apply", "--check", str(patch)], cwd=work, check=True)
            subprocess.run(["git", "apply", str(patch)], cwd=work, check=True)
        classes = work / "classes"
        classes.mkdir()
        subprocess.run([str(java / "javac"), "--release", "17", "-Xlint:all", "-Werror",
                        "-d", str(classes), str(test)], check=True)
        subprocess.run([str(java / "java"), "-ea", "-cp", str(classes),
                        "NativePersistentTabHostTest", str(work), str(work / "host")], check=True)
    print("Fake-host only: no Android build/device, physical Surface timing, or visual acceptance.",
          flush=True)


if __name__ == "__main__":
    main()
