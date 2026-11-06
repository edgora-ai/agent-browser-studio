"""Contract tests for the Java startup-hint build adaptation.

Covers exact-byte application against the pinned 152.0.7977.72 fixture and the
real CheckOutput behavior: the JVM hint and its empty-line layout are tolerated,
while real warnings, errors and nonzero exits keep failing. No Chromium, JVM,
network or keystore access.
"""
import hashlib
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest

sys.dont_write_bytecode = True
BUILD_ROOT = Path(__file__).absolute().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "apply_java_build_adaptation",
    BUILD_ROOT / "apply_java_build_adaptation.py")
apply_mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(apply_mod)

FIXTURE_ORIG = BUILD_ROOT / "tests/fixtures/build_utils_152_0_7977_72.py"
FIXTURE_ADAPTED = BUILD_ROOT / "tests/fixtures/build_utils_152_0_7977_72.adapted.py"
PATCH = BUILD_ROOT / "patches/build_utils-java-startup-hint.patch"

JVM_HINT = "Picked up JAVA_TOOL_OPTIONS: -Xint\n"


def load_build_utils(path):
    """Import a build_utils.py copy with a stub gn_helpers module."""
    saved = sys.modules.get("gn_helpers")
    sys.modules["gn_helpers"] = types.ModuleType("gn_helpers")
    try:
        spec = importlib.util.spec_from_file_location("build_utils_under_test", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        if saved is None:
            sys.modules.pop("gn_helpers", None)
        else:
            sys.modules["gn_helpers"] = saved
    return module


class ProvenanceTests(unittest.TestCase):
    def test_fixture_matches_pinned_original_bytes(self):
        self.assertEqual(
            hashlib.sha256(FIXTURE_ORIG.read_bytes()).hexdigest(),
            apply_mod.ORIGINAL_SHA256)

    def test_adapted_fixture_matches_pinned_result_bytes(self):
        self.assertEqual(
            hashlib.sha256(FIXTURE_ADAPTED.read_bytes()).hexdigest(),
            apply_mod.PATCHED_SHA256)

    def test_patch_is_a_single_hunk_inside_failure_filter(self):
        text = PATCH.read_text()
        self.assertEqual(text.count("\n@@"), 1)
        self.assertIn("@@ -184,6 +184,18 @@", text)
        self.assertIn("_FailureFilter", FIXTURE_ORIG.read_text())


class ApplyScriptTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="adapt-"))
        (self.root / "build/android/gyp/util").mkdir(parents=True)
        shutil.copyfile(
            FIXTURE_ORIG, self.root / "build/android/gyp/util/build_utils.py")
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)

    def tearDown(self):
        shutil.rmtree(self.root)

    def test_apply_produces_pinned_bytes_and_is_idempotent(self):
        for _ in range(2):
            rc = subprocess.run(
                [sys.executable, str(BUILD_ROOT / "apply_java_build_adaptation.py"),
                 str(self.root)], capture_output=True, text=True)
            self.assertEqual(rc.returncode, 0, rc.stderr)
        adapted = (self.root / "build/android/gyp/util/build_utils.py").read_bytes()
        self.assertEqual(hashlib.sha256(adapted).hexdigest(),
                         apply_mod.PATCHED_SHA256)

    def test_check_mode_reports_state_without_writing(self):
        rc = subprocess.run(
            [sys.executable, str(BUILD_ROOT / "apply_java_build_adaptation.py"),
             str(self.root), "--check"], capture_output=True, text=True)
        self.assertEqual(rc.returncode, 0)
        self.assertIn("not yet applied", rc.stdout)
        before = (self.root / "build/android/gyp/util/build_utils.py").read_bytes()
        self.assertEqual(
            hashlib.sha256(before).hexdigest(), apply_mod.ORIGINAL_SHA256)

    def test_unexpected_bytes_are_refused(self):
        target = self.root / "build/android/gyp/util/build_utils.py"
        target.write_text("tampered\n")
        rc = subprocess.run(
            [sys.executable, str(BUILD_ROOT / "apply_java_build_adaptation.py"),
             str(self.root)], capture_output=True, text=True)
        self.assertEqual(rc.returncode, 2)
        self.assertIn("unexpected build_utils.py bytes", rc.stderr)


class CheckOutputBehaviorTests(unittest.TestCase):
    """Exercise the real CheckOutput with the adaptation loaded from the fixture."""

    @classmethod
    def setUpClass(cls):
        cls.module = load_build_utils(FIXTURE_ADAPTED)

    def run_cmd(self, script):
        return self.module.CheckOutput(["/bin/sh", "-c", script])

    def test_banner_only_stderr_is_tolerated(self):
        self.assertEqual(self.run_cmd(f"echo '{JVM_HINT.strip()}' >&2"), "")

    def test_banner_with_residual_empty_lines_is_tolerated(self):
        self.assertEqual(
            self.run_cmd(f"printf '%s\\n\\n' '{JVM_HINT.strip()}' >&2"), "")

    def test_banner_plus_real_warning_still_fails(self):
        with self.assertRaises(self.module.CalledProcessError):
            self.run_cmd(
                f"printf '%s\\nWARNING: real problem\\n' '{JVM_HINT.strip()}' >&2")

    def test_banner_plus_java_error_still_fails(self):
        with self.assertRaises(self.module.CalledProcessError):
            self.run_cmd(
                f"printf '%s\\nerror: some real failure\\n' '{JVM_HINT.strip()}' >&2")

    def test_real_warning_without_banner_still_fails(self):
        with self.assertRaises(self.module.CalledProcessError):
            self.run_cmd("echo 'WARNING: untouched path' >&2")

    def test_empty_stderr_layout_without_hint_keeps_upstream_behavior(self):
        # Upstream fails any nonempty stderr, including whitespace-only output
        # (FilterLines rejoin leaves "\n", which is truthy). Without a hint in
        # the output the adaptation must keep exactly that failing behavior.
        with self.assertRaises(self.module.CalledProcessError):
            self.run_cmd("printf '\\n' >&2")

    def test_nonzero_exit_still_fails_despite_clean_filtered_output(self):
        with self.assertRaises(self.module.CalledProcessError):
            self.run_cmd(f"echo '{JVM_HINT.strip()}' >&2; exit 3")

    def test_banner_on_stdout_plus_warning_on_stderr_still_fails(self):
        with self.assertRaises(self.module.CalledProcessError):
            self.run_cmd(
                f"echo '{JVM_HINT.strip()}'; echo 'WARNING: real' >&2")


class UpstreamComparisonTests(unittest.TestCase):
    """Pin the exact delta: without a hint both versions behave identically."""

    def test_only_failure_filter_changed(self):
        original = FIXTURE_ORIG.read_text()
        adapted = FIXTURE_ADAPTED.read_text()
        start = original.index("def _FailureFilter")
        orig_end = original.index("def CheckOutput")
        adapt_end = adapted.index("def CheckOutput")
        self.assertEqual(original[:start], adapted[:start])
        self.assertEqual(original[orig_end:], adapted[adapt_end:])


if __name__ == "__main__":
    unittest.main()
