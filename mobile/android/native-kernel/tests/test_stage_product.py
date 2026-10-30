"""Actual small filesystem tests and source selection; no Chromium, Android, VM, network or keystore."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
SOURCE = Path(__file__).absolute().parents[1] / "tools/stage_product.py"
SPEC = importlib.util.spec_from_file_location("native_product_stage", SOURCE)
stage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(stage)
ROOT = None


class ProductStageTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="case-", dir=ROOT))
        self.fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)

    def tearDown(self):
        os.close(self.fd)

    def test_read_source_full_bytes_and_rejects_a_leaf_symlink(self):
        source = self.root / "owned.txt"
        source.write_bytes(b"owned source bytes")
        self.assertEqual(stage.read_source(source), b"owned source bytes")
        link = self.root / "link.txt"
        link.symlink_to(source)
        with self.assertRaises(OSError):
            stage.read_source(link)

    def test_read_source_rejects_a_directory_symlink(self):
        target = self.root / "owned-directory"
        target.mkdir(mode=0o700)
        (target / "source.txt").write_bytes(b"synthetic")
        link = self.root / "link-directory"
        link.symlink_to(target, target_is_directory=True)
        with self.assertRaises(OSError):
            stage.read_source(link / "source.txt")

    def test_read_source_rejects_hardlinks(self):
        source = self.root / "source.txt"
        source.write_bytes(b"synthetic")
        os.link(source, self.root / "other.txt")
        with self.assertRaisesRegex(ValueError, "identity"):
            stage.read_source(source)

    def test_read_source_rejects_oversize_before_reading_contents(self):
        source = self.root / "source.txt"
        source.write_bytes(b"x" * 33)
        with mock.patch.object(stage, "MAX_SOURCE_BYTES", 32), mock.patch.object(stage.os, "read") as read:
            with self.assertRaisesRegex(ValueError, "size"):
                stage.read_source(source)
            read.assert_not_called()

    def test_write_new_is_exclusive_private_full_readback_and_name_retrievable(self):
        data = b"frozen source\x00with exact bytes"
        stage.write_new(self.fd, "java/com/example/Source.java", data)
        path = self.root / "java/com/example/Source.java"
        self.assertEqual(path.read_bytes(), data)
        self.assertIn("Source.java", os.listdir(path.parent))
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
        with self.assertRaises(FileExistsError):
            stage.write_new(self.fd, "java/com/example/Source.java", b"must not replace")
        self.assertEqual(path.read_bytes(), data)

    def test_write_new_refuses_path_traversal_and_absolute_names(self):
        for relative in ("../outside", "/absolute", "a//b", "a/../b", "a/./b"):
            with self.subTest(relative=relative), self.assertRaises(ValueError):
                stage.write_new(self.fd, relative, b"synthetic")

    def test_write_new_refuses_output_directory_symlink_without_writing_target(self):
        target = self.root / "owned-target"
        target.mkdir(mode=0o700)
        (self.root / "link").symlink_to(target, target_is_directory=True)
        with self.assertRaises(OSError):
            stage.write_new(self.fd, "link/source.txt", b"must not be written")
        self.assertFalse((target / "source.txt").exists())

    def test_write_new_retains_partial_when_fsync_fails(self):
        with mock.patch.object(stage.os, "fsync", side_effect=OSError("synthetic sync failure")):
            with self.assertRaises(OSError):
                stage.write_new(self.fd, "partial.txt", b"retained bytes")
        self.assertEqual((self.root / "partial.txt").read_bytes(), b"retained bytes")

    def test_write_new_detects_corruption_after_write_before_readback(self):
        original = stage.os.fsync
        planted = []
        def corrupt_then_sync(fd):
            if stat.S_ISREG(os.fstat(fd).st_mode) and not planted:
                os.pwrite(fd, b"X", 0)
                planted.append(True)
            original(fd)
        with mock.patch.object(stage.os, "fsync", side_effect=corrupt_then_sync):
            with self.assertRaisesRegex(ValueError, "readback mismatch"):
                stage.write_new(self.fd, "corrupt.txt", b"original bytes")
        self.assertEqual(planted, [True])
        self.assertEqual((self.root / "corrupt.txt").read_bytes(), b"Xriginal bytes")

    def test_selected_real_product_inputs_exclude_all_webview_implementation(self):
        rows = stage.collect_inputs()
        sources = {row["source"] for row in rows}
        destinations = {row["destination"] for row in rows}
        self.assertEqual(len(destinations), len(rows))
        self.assertLessEqual(len(rows), stage.MAX_FILES)
        self.assertLess(sum(row["bytes"] for row in rows), stage.MAX_TOTAL_BYTES)
        for relative in stage.EXCLUDED_WEBVIEW:
            self.assertNotIn("app/src/main/java/com/ahoo/abs/android/" + relative, sources)
        self.assertIn("java/com/ahoo/abs/core/NativeTimezoneLaunchConfig.java", destinations)
        self.assertIn("java/com/ahoo/abs/android/nativekernel/NativeBrowserApplication.java", destinations)
        self.assertIn("java/com/ahoo/abs/android/nativekernel/NativeBrowserRuntime.java", destinations)
        self.assertIn("java/com/ahoo/abs/android/nativekernel/NativeBrowserActivity.java", destinations)
        self.assertIn("java/com/ahoo/abs/android/process/LaunchCoordinator.java", destinations)
        self.assertIn("chromium/product-bootstrap.patch", destinations)
        self.assertTrue(all("debug.keystore" not in item and "androidTest" not in item for item in sources))

    def test_generated_gni_has_exact_flat_asset_names_and_no_source_globs(self):
        rows = stage.collect_inputs()
        gni = stage.sources_gni(rows).decode()
        self.assertIn('"profile-schema.sql"', gni)
        self.assertIn('"native_preflight.js"', gni)
        self.assertIn("agent_browser_product_java_sources = [", gni)
        self.assertIn("agent_browser_product_resource_sources = [", gni)
        self.assertIn("agent_browser_product_asset_sources = [", gni)
        self.assertNotIn("*", gni)
        self.assertNotIn("/Users/", gni)
        self.assertNotIn("/Volumes/", gni)

    def test_source_manifest_is_deterministic_metadata_only_and_not_execution_proof(self):
        rows = stage.collect_inputs()
        first = stage.manifest(rows)
        self.assertEqual(first, stage.manifest(stage.collect_inputs()))
        self.assertTrue(all("data" not in row for row in first["files"]))
        self.assertEqual(first["nativeExecution"], "NOT_RUN")
        self.assertEqual(first["completeDependencyClosure"], False)
        changed = [dict(row) for row in rows]
        changed[0]["sha256"] = "0" * 64
        self.assertNotEqual(first["sourceSha256"], stage.manifest(changed)["sourceSha256"])
        json.dumps(first)


if __name__ == "__main__":
    state = os.environ.get("ABS_ANDROID_STATE_ROOT")
    if not state:
        raise SystemExit("ABS_ANDROID_STATE_ROOT is required; no temporary-directory fallback")
    parent = Path(state).absolute()
    marker = json.loads(stage.read_source(parent / "android-build-state.json"))
    if marker.get("ownerUid") != os.getuid() or marker.get("stateRoot") != str(parent) or marker.get("sourceRoot") != str(stage.ANDROID):
        raise SystemExit("Unregistered parent")
    ROOT = parent / "tests" / "native-product-stage"
    ROOT.mkdir(mode=0o700, exist_ok=True)
    info = ROOT.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise SystemExit("Unsafe source-stage test root")
    unittest.main()
