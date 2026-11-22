"""Actual small filesystem tests and source selection; no Chromium, Android, VM, network or keystore."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
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
        self.assertIn("java/com/ahoo/abs/android/nativekernel/NativePwaBridge.java", destinations)
        self.assertIn("java/com/ahoo/abs/android/process/LaunchCoordinator.java", destinations)
        self.assertIn("chromium/product-bootstrap.patch", destinations)
        self.assertIn("chromium/product-tabs.patch", destinations)
        self.assertIn("chromium/product-policy-tests.patch", destinations)
        for release_patch in ("runtime", "dns", "java", "security", "packaging"):
            self.assertIn(f"chromium/product-{release_patch}-release.patch", destinations)
        self.assertIn("chromium/product-input-lifecycle.patch", destinations)
        self.assertIn("chromium/product-webaudio-destination.patch", destinations)
        self.assertIn("chromium/agent_browser_android_product_policy_unittest.cc", destinations)
        product_gni = next(row["data"] for row in rows if row["destination"] == "agent_browser_product.gni")
        # Chromium's android_apk template consumes its version code as a GN string.
        self.assertIn(b'version_code = "10000"', product_gni)
        self.assertIn(b'debuggable = false', product_gni)
        self.assertTrue(all("debug.keystore" not in item and "androidTest" not in item for item in sources))

    def test_product_java_compiles_per_class_jni_source_jar(self):
        rows = {row["destination"]: row["data"] for row in stage.collect_inputs()}
        product_gni = rows["agent_browser_product.gni"].decode()
        java = product_gni.split('  android_library("${_prefix}_java") {', 1)[1]
        java = java.split("\n  }\n", 1)[0]
        # A generic native-header dep cannot supply *Jni.java to Java compilation.
        self.assertRegex(java, r'(?m)^\s*srcjar_deps\s*=\s*\[\s*'
                              r'"//content/shell:agent_browser_product_jni_headers"\s*,?\s*\]')
        self.assertNotIn("libagent_browser_product__jni_registration", java)
        apk = product_gni.split("  android_apk(target_name) {", 1)[1]
        self.assertRegex(apk, r'(?m)^\s*srcjar_deps\s*=\s*\[\s*'
                             r'"//content/shell/android:libagent_browser_product__jni_registration"\s*,?\s*\]')
        bridge = rows["java/com/ahoo/abs/android/nativekernel/NativePwaBridge.java"]
        self.assertIn(b"NativePwaBridgeJni.get()", bridge)
        self.assertIn(
            b'+      "android/agent_browser_product/java/com/ahoo/abs/android/nativekernel/NativePwaBridge.java",',
            rows["chromium/product-pwa.patch"])

    def test_release_runtime_guards_native_readiness_and_avoids_raw_android_log(self):
        rows = stage.collect_inputs()
        app = next(row["data"].decode() for row in rows
                   if row["destination"].endswith("/NativeBrowserApplication.java"))
        runtime = next(row["data"].decode() for row in rows
                       if row["destination"].endswith("/NativeBrowserRuntime.java"))
        self.assertNotIn("android.util.Log.", app)
        self.assertIn("import org.chromium.base.Log;", app)
        self.assertIn("BrowserStartupController.getInstance().isFullBrowserStarted()", runtime)
        self.assertLess(runtime.index("isFullBrowserStarted()"),
                        runtime.index("ShellManager.flushPersistentStorageForShutdown("))
        self.assertIn('barrier.nativeOutcome = "NOT_ATTEMPTED";', runtime)
        self.assertIn('historyConfirmed == null || nativeOutcome == null', runtime)
        self.assertNotIn('finishDrain(drainGeneration, current, callback, "NOT_ATTEMPTED")', runtime)

    def test_security_overlay_disables_devtools_for_independent_product_or_preflight(self):
        rows = stage.collect_inputs()
        patch = next(row["data"].decode() for row in rows
                     if row["destination"] == "chromium/product-security-release.patch")
        self.assertIn("+  if (!IsAgentBrowserProductPreflight() &&", patch)
        self.assertIn("+          kAgentBrowserProductProfileSwitch))", patch)

    def test_packaging_overlay_keeps_the_default_and_forwards_the_override(self):
        rows = stage.collect_inputs()
        patch = next(row["data"].decode() for row in rows
                     if row["destination"] == "chromium/product-packaging-release.patch")
        self.assertEqual(2, patch.count('"debuggable",'))
        self.assertIn('+    _debuggable = debuggable_apks', patch)
        self.assertIn('+    if (defined(invoker.debuggable))', patch)
        self.assertIn('+      _debuggable = invoker.debuggable', patch)

    def test_native_regression_inputs_are_frozen_in_manifest(self):
        rows = stage.collect_inputs()
        frozen = stage.manifest(rows)
        for relative, kind in (
                ("chromium/agent_browser_android_product_policy_unittest.cc", "native"),
                ("chromium/product-policy-tests.patch", "patch"),
                ("chromium/product-runtime-release.patch", "patch"),
                ("chromium/product-dns-release.patch", "patch"),
                ("chromium/product-java-release.patch", "patch"),
                ("chromium/product-security-release.patch", "patch"),
                ("chromium/product-packaging-release.patch", "patch"),
                ("chromium/product-input-lifecycle.patch", "patch"),
                ("chromium/product-webaudio-destination.patch", "patch"),
                ("chromium/agent_browser_android_pwa_bridge.cc", "native"),
                ("chromium/product-pwa.patch", "patch")):
            with self.subTest(relative=relative):
                row = next(item for item in rows if item["destination"] == relative)
                data = stage.read_source(stage.MODULE / relative)
                self.assertEqual(row["source"], "native-kernel/" + relative)
                self.assertEqual(row["kind"], kind)
                self.assertEqual(row["data"], data)
                self.assertEqual(row["bytes"], len(data))
                self.assertEqual(row["sha256"], hashlib.sha256(data).hexdigest())
                self.assertIn({key: value for key, value in row.items() if key != "data"},
                              frozen["files"])
                changed = [dict(item) for item in rows]
                next(item for item in changed if item["destination"] == relative)["sha256"] = "0" * 64
                self.assertNotEqual(frozen["sourceSha256"], stage.manifest(changed)["sourceSha256"])
                self.assertNotIn(relative, stage.sources_gni(rows).decode())

    def test_native_proxy_test_patch_applies_and_reverses_with_patch_tool(self):
        patch_tool = os.environ.get("ABS_ANDROID_PATCH_TOOL") or shutil.which("patch")
        self.assertIsNotNone(patch_tool, "The patch tool is required to validate staged patches")
        patch = stage.read_source(stage.MODULE / "chromium/product-policy-tests.patch")
        # This is the unmodified Android sources block from Chromium 152's
        # content_browsertests target. No Chromium checkout or git apply is used:
        # git can otherwise report success while skipping ignored subdirectories.
        original = b'''test("content_browsertests") {
  sources = []
  if (is_android) {
    sources += [
      "../browser/gpu/gpu_background_kill_android_browsertest.cc",
      "../browser/navigation_transitions/back_forward_transition_animation_manager_android_browsertest.cc",
      "../browser/network/quic_connection_migration_android_browsertest.cc",
      "../browser/renderer_host/android_spare_renderer_navigation_throttle_browsertest.cc",
      "../browser/renderer_host/render_widget_host_view_android_browsertest.cc",

      # TODO(crbug.com/40267166): move out of Android once we can capture
      # for other platforms.
      "../browser/renderer_host/navigation_transitions/navigation_entry_screenshot_browsertest.cc",
    ]
  }

}
'''
        fixtures = {"minimal": original}
        # Supply a freshly captured complete content/test/BUILD.gn to exercise
        # exactly the same bytes intended for deployment, not just this fixture.
        captured_gn = os.environ.get("ABS_ANDROID_CONTENT_TEST_BUILD_GN")
        if captured_gn:
            fixtures["captured"] = stage.read_source(Path(captured_gn))
        anchor = (b'      "../browser/renderer_host/navigation_transitions/'
                  b'navigation_entry_screenshot_browsertest.cc",\n')
        added = (b'\n      "../shell/android/agent_browser_product/chromium/'
                 b'agent_browser_android_product_policy_unittest.cc",\n')
        for name, original in fixtures.items():
            with self.subTest(fixture=name):
                self.assertEqual(original.count(anchor), 1)
                self.assertNotIn(b"agent_browser_android_product_policy_unittest.cc", original)
                work = self.root / name
                target = work / "content/test/BUILD.gn"
                target.parent.mkdir(mode=0o700, parents=True)
                target.write_bytes(original)
                expected = original.replace(anchor, anchor + added)
                for options, expected_after in (
                        (["--dry-run", "--forward"], original),
                        (["--forward"], expected),
                        (["--dry-run", "--reverse"], expected),
                        (["--reverse"], original)):
                    with self.subTest(options=options):
                        result = subprocess.run(
                            [patch_tool, "-p1", "-F", "0", "--batch", *options],
                            input=patch, cwd=work, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, timeout=15, check=False)
                        self.assertEqual(result.returncode, 0, result.stdout.decode(errors="replace"))
                        self.assertEqual(target.read_bytes(), expected_after)

    def test_network_mode_dns_and_capture_overlays_roundtrip_without_fuzz(self):
        patch_tool = shutil.which("patch")
        self.assertIsNotNone(patch_tool, "patch is required for executable overlay regression")
        repo = stage.ANDROID.parent.parent
        native = stage.ANDROID / "native-kernel/chromium"
        prefix = "content/shell/android/agent_browser_product/chromium/"
        originals = {}
        for name in ("agent_browser_android_product_policy.h",
                     "agent_browser_android_product_policy.cc",
                     "agent_browser_android_product_policy_unittest.cc"):
            originals[prefix + name] = stage.read_source(native / name)
        dns_patch = stage.read_source(native / "product-dns-release.patch")
        capture_patch = stage.read_source(repo / "patches/chromium/patches/0063-android-product-capture-per-type.patch")
        # The policy source is actual selected product code. For the unrelated
        # shell delegate, use exact patch preimage hunks with neutral line gaps;
        # this proves dependent -F0 patching, not a full Chromium compile/device run.
        shell = []
        shell_diff = capture_patch.decode().split("--- a/content/shell/browser/shell.cc\n", 1)[1]
        for line in shell_diff.splitlines(keepends=True):
            if line.startswith("@@ "):
                start = int(line.split(" ")[1][1:].split(",")[0])
                self.assertLessEqual(len(shell), start - 1)
                shell.extend(["\n"] * (start - 1 - len(shell)))
            elif line.startswith((" ", "-")) and not line.startswith("---"):
                shell.append(line[1:])
        originals["content/shell/browser/shell.cc"] = "".join(shell).encode()
        work = self.root / "network-mode-overlays"
        for relative, data in originals.items():
            target = work / relative
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            target.write_bytes(data)

        def apply(data, reverse=False, dry=False):
            options = ["--reverse" if reverse else "--forward"]
            if dry:
                options.append("--dry-run")
            result = subprocess.run([patch_tool, "-p1", "-F", "0", "--batch", *options],
                                    input=data, cwd=work, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, timeout=15, check=False)
            self.assertEqual(result.returncode, 0, result.stdout.decode(errors="replace"))
            self.assertNotIn(b"fuzz", result.stdout.lower())

        def snapshot():
            return {name: (work / name).read_bytes() for name in originals}

        apply(dns_patch, dry=True)
        self.assertEqual(snapshot(), originals)
        apply(dns_patch)
        dns_state = snapshot()
        apply(capture_patch, dry=True)
        self.assertEqual(snapshot(), dns_state)
        apply(capture_patch)
        final_state = snapshot()
        cc = final_state[prefix + "agent_browser_android_product_policy.cc"].decode()
        startup = cc.split("void VerifyAgentBrowserProductPreflightStartup()", 1)[1].split(
            "bool ParseAgentBrowserProductProxyConfig", 1)[0]
        self.assertIn("!product_network_mode", startup)
        self.assertIn("if (product_profile || product_network_mode)", startup)
        self.assertIn("CHECK(ParseAgentBrowserProductNetworkConfig(command))", startup)
        for forbidden in ("no-sandbox", "disable-web-security", "ignore-certificate-errors",
                          "remote-debugging-port", "remote-debugging-pipe", "remote-debugging-socket-name"):
            self.assertIn('"' + forbidden + '"', startup)
        parser = cc.split("bool ParseAgentBrowserProductNetworkConfig", 1)[1].split(
            "void ConfigureAgentBrowserProductNetworkContextParams", 1)[0]
        self.assertIn("if (!command.HasSwitch(kAgentBrowserProductProfileSwitch))", parser)
        legacy = parser.split("if (!command.HasSwitch(kAgentBrowserProductNetworkModeSwitch))", 1)[1].split(
            "} else {", 1)[0]
        self.assertIn("if (!ParseAgentBrowserProductProxyConfig(command, &config))", legacy)
        self.assertNotIn("CreateDirect", legacy)
        self.assertIn('"direct"', parser)
        for conflict in ('entry.first.find("proxy")', 'entry.first == "host-resolver-rules"',
                         'entry.first == "host-rules"', 'entry.first == "agent-browser-local-dns-policy"'):
            self.assertIn(conflict, parser)
        self.assertIn("config = net::ProxyConfig::CreateDirect()", parser)
        strict = cc.split("bool ParseAgentBrowserProductProxyConfig", 1)[1].split(
            "bool ParseAgentBrowserProductNetworkConfig", 1)[0]
        self.assertNotIn("CreateDirect", strict)
        self.assertIn("rules.type = net::ProxyConfig::ProxyRules::Type::PROXY_LIST", strict)
        self.assertIn("rules.single_proxies.SetSingleProxyServer(server)", strict)
        network = cc.split("void ConfigureAgentBrowserProductNetworkContextParams", 1)[1].split(
            "bool IsAgentBrowserProductPreflightUrlAllowed", 1)[0]
        self.assertIn("CHECK(ParseAgentBrowserProductNetworkConfig(command, &config, &mode))", network)
        branch = network.index("if (mode == AgentBrowserProductNetworkMode::kDirect)")
        for owner in ("initial_proxy_config", "proxy_config_client_receiver.is_valid()",
                      "proxy_config_poller_client.is_valid()", "initial_custom_proxy_config",
                      "custom_proxy_config_client_receiver.is_valid()", "agent_browser_local_dns_policy"):
            self.assertLess(network.index("CHECK(!params->" + owner + ")"), branch)
        direct = cc.index("if (mode == AgentBrowserProductNetworkMode::kDirect)")
        deny = cc.index("auto dns_policy = network::mojom::AgentBrowserLocalDnsPolicy::New();")
        self.assertLess(cc.index("CHECK(!params->agent_browser_local_dns_policy)"), direct)
        self.assertLess(direct, cc.index("return;", direct))
        self.assertLess(cc.index("return;", direct), deny)
        self.assertIn("mode=normal no-proxy-protection=1", cc[direct:deny])
        self.assertIn("kProductDirectTrafficAnnotation", cc[direct:deny])
        self.assertIn("kProxyLocalDnsDeny", cc[deny:])
        self.assertIn("dns_policy->proxy_bootstrap_host = chain.First().GetHost()", cc[deny:])
        self.assertIn("audio_granted = it->second.audio && OsCaptureGrantedViaJava(true, false)", cc)
        self.assertIn("video_granted = it->second.video && OsCaptureGrantedViaJava(false, true)", cc)
        unit = final_state[prefix + "agent_browser_android_product_policy_unittest.cc"].decode()
        for name in ("ExplicitDirectIsNotAutomaticOrSystem", "AbsentModeStillRequiresStrictProxy",
                     "DirectRejectsEveryProxyAndStaleDnsControl", "BothModesRejectExistingInitialOwner",
                     "BothModesRejectForeignUpdateAndCustomOwners", "RejectsExistingDnsPolicyOwner",
                     "DnsOnlyTargetsNeverReachTheResolverBackend",
                     "ExplicitDirectUsesNormalResolverWithoutDenyPolicy"):
            self.assertIn(name, unit)
        self.assertIn("result.Fallback(net::ERR_PROXY_CONNECTION_FAILED", unit)
        # Retain exact small poststates for a builder to compare, never execute.
        poststates = self.root / "network-mode-poststates"
        poststates.mkdir(mode=0o700)
        manifest = {"proof": "SOURCE_AND_SYNTHETIC_PATCH_ROUNDTRIP_ONLY",
                    "nativeExecution": "NOT_RUN", "files": {}}
        for name, data in final_state.items():
            if name.startswith(prefix):
                (poststates / Path(name).name).write_bytes(data)
                manifest["files"][Path(name).name] = hashlib.sha256(data).hexdigest()
        (poststates / "sha256.json").write_text(json.dumps(manifest, indent=2) + "\n")
        print("Network-mode poststates: " + str(poststates))
        apply(capture_patch, reverse=True, dry=True)
        self.assertEqual(snapshot(), final_state)
        apply(capture_patch, reverse=True)
        self.assertEqual(snapshot(), dns_state)
        apply(dns_patch, reverse=True, dry=True)
        self.assertEqual(snapshot(), dns_state)
        apply(dns_patch, reverse=True)
        self.assertEqual(snapshot(), originals)

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
