#!/usr/bin/env python3
"""Freeze selected product inputs in a registered build root; never apply patches, run GN or start a VM."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

sys.dont_write_bytecode = True
ANDROID = Path(__file__).absolute().parents[2]
MODULE = ANDROID / "native-kernel"
MAX_SOURCE_BYTES = 2 * 1024 * 1024
MAX_TOTAL_BYTES = 8 * 1024 * 1024
MAX_FILES = 128
EXCLUDED_WEBVIEW = frozenset({
    "BrowserApplication.java", "browser/BrowserActivity.java", "browser/BrowserRuntime.java",
    "browser/ProbeAssets.java", "browser/StorageProbe.java", "browser/IdentityReport.java",
})


def read_source(path):
    path = Path(path).absolute()
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        leaf = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            before = os.fstat(leaf)
            if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_nlink != 1 or before.st_size > MAX_SOURCE_BYTES:
                raise ValueError("Unexpected source file identity or size")
            data = bytearray()
            while True:
                block = os.read(leaf, 65536)
                if not block:
                    break
                data.extend(block)
                if len(data) > MAX_SOURCE_BYTES:
                    raise ValueError("Source grew past the per-file limit")
            identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
            if len(data) != before.st_size or identity(before) != identity(os.fstat(leaf)) or identity(before) != identity(os.stat(path.name, dir_fd=fd, follow_symlinks=False)):
                raise ValueError("Source changed while reading")
            return bytes(data)
        finally:
            os.close(leaf)
    finally:
        os.close(fd)


def java_sources(folder):
    found = []
    for root, names, files in os.walk(folder, followlinks=False):
        for name in names:
            if (Path(root) / name).is_symlink():
                raise ValueError("Source directory symlink refused")
        names.sort()
        found.extend(Path(root) / name for name in sorted(files) if name.endswith(".java"))
    if not found:
        raise ValueError("Required Java source set is empty")
    return found


def collect_inputs(android=ANDROID):
    android = Path(android).absolute()
    module = android / "native-kernel"
    prerequisite = android.parents[1] / "patches/chromium/patches/0057-android-frozen-native-timezone.patch"
    if hashlib.sha256(read_source(prerequisite)).hexdigest() != "725b79cd20457bfe0634e7029ffbe3d4a317ad00fbcb369290d4af15a0c59fdf":
        raise ValueError("Native timezone patch prerequisite changed")
    selected = []
    for prefix in (android / "core/src/main/java", android / "app/src/main/java", module / "src/main/java"):
        for source in java_sources(prefix):
            relative = source.relative_to(prefix).as_posix()
            if prefix == android / "app/src/main/java":
                within_package = source.relative_to(prefix / "com/ahoo/abs/android").as_posix()
                if within_package in EXCLUDED_WEBVIEW:
                    continue
            selected.append((source, "java/" + relative, "java"))
    for relative in ("drawable/ic_launcher.xml", "values/strings.xml", "values/styles.xml",
                     "values-night/styles.xml", "xml/data_extraction_rules.xml"):
        selected.append((android / "app/src/main/res" / relative, "res/" + relative, "resource"))
    selected.extend([
        (android / "app/src/main/assets/profile-schema.sql", "assets/profile-schema.sql", "asset"),
        (module / "src/main/assets/native_preflight.js", "assets/native_preflight.js", "asset"),
        (module / "AndroidManifest.xml.jinja2", "AndroidManifest.xml.jinja2", "manifest"),
        (module / "agent_browser_product.gni", "agent_browser_product.gni", "gn"),
        (module / "chromium/agent_browser_android_product_policy.h", "chromium/agent_browser_android_product_policy.h", "native"),
        (module / "chromium/agent_browser_android_product_policy.cc", "chromium/agent_browser_android_product_policy.cc", "native"),
        (module / "chromium/agent_browser_android_product_policy_unittest.cc", "chromium/agent_browser_android_product_policy_unittest.cc", "native"),
        (module / "chromium/product-bootstrap.patch", "chromium/product-bootstrap.patch", "patch"),
        (module / "chromium/product-tabs.patch", "chromium/product-tabs.patch", "patch"),
        (module / "chromium/product-language.patch", "chromium/product-language.patch", "patch"),
        (module / "chromium/product-policy-tests.patch", "chromium/product-policy-tests.patch", "patch"),
        (module / "chromium/product-runtime-release.patch", "chromium/product-runtime-release.patch", "patch"),
        (module / "chromium/product-dns-release.patch", "chromium/product-dns-release.patch", "patch"),
        (module / "chromium/product-java-release.patch", "chromium/product-java-release.patch", "patch"),
        (module / "chromium/product-security-release.patch", "chromium/product-security-release.patch", "patch"),
        (module / "chromium/product-packaging-release.patch", "chromium/product-packaging-release.patch", "patch"),
    ])
    if len(selected) > MAX_FILES:
        raise ValueError("Selected source count exceeds the limit")
    rows = []
    destinations = set()
    total = 0
    for source, destination, kind in selected:
        if (len(destination) > 512 or len(source.relative_to(android).as_posix()) > 512
                or destination in destinations or not re.fullmatch(r"[A-Za-z0-9_./-]+", destination)
                or ".." in destination.split("/")):
            raise ValueError("Invalid or duplicate staged destination")
        destinations.add(destination)
        data = read_source(source)
        if kind == "java" and re.search(rb"\b(?:android\.webkit|androidx\.webkit)\b", data):
            raise ValueError("WebView source escaped the explicit exclusion set")
        total += len(data)
        if total > MAX_TOTAL_BYTES:
            raise ValueError("Selected source bytes exceed the limit")
        rows.append({"source": source.relative_to(android).as_posix(), "destination": destination,
                     "kind": kind, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "data": data})
    return sorted(rows, key=lambda row: row["destination"])


def manifest(rows):
    items = [{key: value for key, value in row.items() if key != "data"} for row in rows]
    canonical = json.dumps(items, sort_keys=True, separators=(",", ":")).encode()
    return {"schemaVersion": 1, "sourceSha256": hashlib.sha256(canonical).hexdigest(), "files": items,
            "bytes": sum(row["bytes"] for row in rows), "fullUpstreamIdentity": "NOT_ESTABLISHED",
            "completeDependencyClosure": False, "nativeExecution": "NOT_RUN",
            "requiredTimezonePatchSha256": "725b79cd20457bfe0634e7029ffbe3d4a317ad00fbcb369290d4af15a0c59fdf"}


def sources_gni(rows):
    prefix = "//content/shell/android/agent_browser_product/"
    groups = {"java": [], "resource": [], "asset": []}
    for row in rows:
        if row["kind"] in groups:
            groups[row["kind"]].append(prefix + row["destination"])
    lines = ["# Generated from the exact staged source manifest; no build-time source globs."]
    for kind in ("java", "resource", "asset"):
        lines.append("agent_browser_product_" + kind + "_sources = [")
        lines.extend("  " + json.dumps(value) + "," for value in groups[kind])
        lines.append("]")
    lines.append("agent_browser_product_asset_destinations = [")
    lines.extend("  " + json.dumps(row["destination"].removeprefix("assets/")) + "," for row in rows if row["kind"] == "asset")
    lines.append("]")
    return ("\n".join(lines) + "\n").encode()


def write_new(directory, relative, data):
    parts = relative.split("/")
    if not parts or any(not part or part in (".", "..") for part in parts):
        raise ValueError("Unsafe output path")
    fd = os.dup(directory)
    try:
        for part in parts[:-1]:
            try:
                os.mkdir(part, 0o700, dir_fd=fd)
                os.fsync(fd)
            except FileExistsError:
                pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            info = os.fstat(child)
            if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
                os.close(child)
                raise ValueError("Unsafe output directory")
            os.close(fd)
            fd = child
        leaf = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        try:
            offset = 0
            while offset < len(data):
                count = os.write(leaf, data[offset:])
                if count <= 0:
                    raise OSError("Short staged source write")
                offset += count
            os.fsync(leaf)
        finally:
            os.close(leaf)
        os.fsync(fd)
        leaf = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
        try:
            before = os.fstat(leaf)
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_nlink != 1
                    or before.st_size != len(data) or stat.S_IMODE(before.st_mode) != 0o600):
                raise ValueError("Unexpected staged source readback identity")
            actual = bytearray()
            while block := os.read(leaf, 65536):
                actual.extend(block)
                if len(actual) > len(data):
                    raise ValueError("Staged source readback overflow")
            if bytes(actual) != data:
                raise ValueError("Staged source readback mismatch")
            identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
            if (identity(before) != identity(os.fstat(leaf))
                    or identity(before) != identity(os.stat(parts[-1], dir_fd=fd, follow_symlinks=False))):
                raise ValueError("Staged source changed during readback")
        finally:
            os.close(leaf)
        if parts[-1] not in os.listdir(fd):
            raise ValueError("Staged source name is not retrievable")
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--state-root", required=True)
    parser.add_argument("--stage-id", required=True)
    parser.add_argument("--host-volume", required=True)
    parser.add_argument("--storage-check", required=True)
    args = parser.parse_args()
    if not args.execute or not re.fullmatch(r"[a-z][a-z0-9-]{0,39}", args.stage_id):
        parser.error("Explicit --execute and a bounded new stage ID are required")
    spec = importlib.util.spec_from_file_location("product_build_guard", ANDROID / "tools/build.py")
    build = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(build)
    os.umask(0o077)
    root = build.ordinary(args.state_root, True)
    marker = json.loads(read_source(build.ordinary(root / "android-build-state.json")))
    if (marker.get("schemaVersion") != 1 or marker.get("budgetReset") is not False
            or marker.get("ownerUid") != os.getuid() or marker.get("stateRoot") != str(root)
            or marker.get("sourceRoot") != str(ANDROID) or marker.get("task") != "android-minimal-browser"
            or root.stat().st_uid != os.getuid() or stat.S_IMODE(root.stat().st_mode) != 0o700):
        raise ValueError("Unregistered product staging root")
    checker = build.ordinary(args.storage_check)
    checked = subprocess.run([sys.executable, "-B", str(checker), "check-mount"], check=True,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    if len(checked.stdout) > 65536 or len(checked.stderr) > 65536:
        raise ValueError("Unexpected storage-check output size")
    host = build.ordinary(args.host_volume, True)
    build.guard(root, marker, host)
    rows = collect_inputs()
    record = manifest(rows)
    gni = sources_gni(rows)
    if build.usage(root) + record["bytes"] + 1024 * 1024 >= marker["capBytes"]:
        raise RuntimeError("Original build quota cannot retain the selected sources")
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            os.mkdir("staged-native", 0o700, dir_fd=root_fd)
            os.fsync(root_fd)
        except FileExistsError:
            pass
        parent = os.open("staged-native", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
    finally:
        os.close(root_fd)
    try:
        info = os.fstat(parent)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError("Unsafe native staging parent")
        os.mkdir(args.stage_id, 0o700, dir_fd=parent)
        os.fsync(parent)
        destination = os.open(args.stage_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        bound = os.fstat(destination)
        directory_identity = lambda value: (value.st_dev, value.st_ino, value.st_uid, stat.S_IMODE(value.st_mode))
    finally:
        os.close(parent)
    try:
        write_new(destination, "README.txt", b"Frozen selected Android product sources. Not a compiled APK, complete dependency closure, native safety proof, emulator or Ping0 result. Original cumulative build quota; all failed/partial outputs retained.\n")
        for row in rows:
            build.guard(root, marker, host)
            write_new(destination, row["destination"], row["data"])
        write_new(destination, "product_sources.gni", gni)
        if manifest(collect_inputs()) != record:
            raise RuntimeError("Product sources changed while staging")
        write_new(destination, "product-source-manifest.json", (json.dumps(record, sort_keys=True, indent=2) + "\n").encode())
        os.fsync(destination)
        named = build.ordinary(root / "staged-native" / args.stage_id, True).lstat()
        if directory_identity(bound) != directory_identity(os.fstat(destination)) or directory_identity(bound) != directory_identity(named):
            raise RuntimeError("Native staging directory identity changed")
    finally:
        os.close(destination)
    build.guard(root, marker, host)
    print(json.dumps({"stageId": args.stage_id, "status": "selected_sources_staged_and_full_readback_verified",
                      "sourceSha256": record["sourceSha256"], "files": len(rows), "bytes": record["bytes"],
                      "nativeExecution": "NOT_RUN", "budgetReset": False}, sort_keys=True))


if __name__ == "__main__":
    main()
