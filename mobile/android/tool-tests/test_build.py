"""Host build-harness tests; no Gradle, Android, network or signing key is used."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
SOURCE = Path(__file__).absolute().parents[1] / "tools" / "build.py"
SPEC = importlib.util.spec_from_file_location("abs_android_build", SOURCE)
build = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build)
ROOT = None


class BuildHarnessTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="case-", dir=ROOT))
        os.chmod(self.root, 0o700)

    def test_usage_handles_a_transform_directory_renamed_before_scandir(self):
        with mock.patch.object(build.os, "scandir", side_effect=FileNotFoundError("renamed")):
            self.assertEqual(build.usage(self.root), 0)

    def test_usage_does_not_hide_permission_errors(self):
        with mock.patch.object(build.os, "scandir", side_effect=PermissionError("denied")):
            with self.assertRaises(PermissionError):
                build.usage(self.root)

    def test_ordinary_rejects_symlink_without_following(self):
        target = self.root / "own-input.txt"
        target.write_text("synthetic")
        link = self.root / "own-link.txt"
        link.symlink_to(target)
        with self.assertRaisesRegex(ValueError, "Symlink"):
            build.ordinary(link)

    def test_usage_counts_link_only_not_its_target_contents(self):
        target = self.root / "own-input.txt"
        target.write_bytes(b"x" * 123)
        link = self.root / "own-link.txt"
        link.symlink_to(target)
        expected = target.lstat().st_size + link.lstat().st_size
        self.assertEqual(build.usage(self.root), expected)

    def test_guard_rejects_budget_and_reserves(self):
        marker = {"capBytes": 8 * 1024 * 1024, "developmentReserveBytes": 100, "hostReserveBytes": 200}
        with mock.patch.object(build, "usage", return_value=8 * 1024 * 1024):
            with self.assertRaisesRegex(RuntimeError, "budget"):
                build.guard(self.root, marker, self.root)
        with mock.patch.object(build, "usage", return_value=0), mock.patch.object(build, "space", return_value=0):
            with self.assertRaisesRegex(RuntimeError, "reserve"):
                build.guard(self.root, marker, self.root)

    def test_source_inventory_changes_with_code_and_rejects_links(self):
        source = self.root / "Example.java"
        source.write_text("class Example {}")
        first = build.source_inventory(self.root)
        source.write_text("class Example { int value; }")
        self.assertNotEqual(first["sha256"], build.source_inventory(self.root)["sha256"])
        (self.root / "Alias.java").symlink_to(source)
        with self.assertRaisesRegex(ValueError, "Symlink"):
            build.source_inventory(self.root)

    def test_inventory_excludes_private_build_state(self):
        (self.root / "Example.java").write_text("class Example {}")
        first = build.source_inventory(self.root)
        (self.root / "debug.keystore").write_bytes(b"synthetic-not-a-key")
        (self.root / "local.properties").write_text("synthetic=not-loaded")
        self.assertEqual(first, build.source_inventory(self.root))

    def test_receipt_is_exclusive_private_and_readable(self):
        receipt = self.root / "result.json"
        build.write_json(receipt, {"status": "synthetic"})
        self.assertEqual(stat.S_IMODE(receipt.stat().st_mode), 0o600)
        self.assertEqual(json.loads(receipt.read_text()), {"status": "synthetic"})
        with self.assertRaises(FileExistsError):
            build.write_json(receipt, {"status": "must-not-overwrite"})

    def test_actual_owned_process_group_is_observed_and_reaped(self):
        child = subprocess.Popen([sys.executable, "-B", "-c", "import threading; threading.Event().wait(60)"],
                                 start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            self.assertIsNone(child.poll())
            self.assertIn(child.pid, build.group_members(child.pid))
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
            child.wait(timeout=5)
        self.assertNotEqual(child.returncode, 0)
        self.assertEqual(build.wait_group(child.pid), [])


if __name__ == "__main__":
    state = os.environ.get("ABS_ANDROID_STATE_ROOT")
    if not state:
        raise SystemExit("ABS_ANDROID_STATE_ROOT is required; no temporary-directory fallback")
    parent = build.ordinary(state, True)
    marker = json.loads(build.ordinary(parent / "android-build-state.json").read_text())
    if marker.get("ownerUid") != os.getuid() or marker.get("stateRoot") != str(parent):
        raise SystemExit("Unregistered parent")
    ROOT = parent / "tests" / "build-runner"
    ROOT.mkdir(mode=0o700, exist_ok=True)
    build.ordinary(ROOT, True)
    unittest.main()
