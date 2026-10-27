#!/usr/bin/env python3
"""Build only inside an explicitly registered, bounded Android state directory."""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import time


TASKS = {
    "help", ":core:contractTest", ":core:check", ":app:assembleDebug",
    ":app:assembleDebugAndroidTest", ":app:lintDebug", ":app:dependencies",
}


def ordinary(path, directory=False):
    path = Path(path).absolute()
    for part in [*reversed(path.parents), path]:
        info = part.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise ValueError("Symlink is not an owned build path: " + str(part))
    info = path.lstat()
    expected = stat.S_ISDIR if directory else stat.S_ISREG
    if not expected(info.st_mode):
        raise ValueError("Unexpected build path type: " + str(path))
    return path


def usage(root):
    total = 0
    pending = [root]
    while pending:
        current = pending.pop()
        try:
            entries = list(os.scandir(current))
        except FileNotFoundError:
            # Gradle atomically renames its own transform staging directories.
            continue
        for item in entries:
            try:
                info = item.stat(follow_symlinks=False)
            except FileNotFoundError:
                continue
            total += info.st_size
            if stat.S_ISDIR(info.st_mode):
                pending.append(Path(item.path))
    return total


def space(path):
    info = os.statvfs(path)
    return info.f_bavail * info.f_frsize


def source_inventory(project):
    extensions = {".java", ".gradle", ".properties", ".xml", ".html", ".js", ".css", ".sql", ".py", ".cjs", ".pro"}
    rows = []
    for folder, names, files in os.walk(project, followlinks=False):
        names[:] = sorted(name for name in names if name not in {".gradle", ".idea", "build", "__pycache__"})
        for name in names:
            if (Path(folder) / name).is_symlink():
                raise ValueError("Source directory symlink is not accepted")
        for name in sorted(files):
            path = Path(folder) / name
            if path.suffix not in extensions or name == "local.properties":
                continue
            ordinary(path)
            if path.stat().st_size > 2 * 1024 * 1024:
                raise ValueError("Unexpected oversized Android source input")
            data = path.read_bytes()
            rows.append({"path": str(path.relative_to(project)), "bytes": len(data),
                         "sha256": hashlib.sha256(data).hexdigest()})
    canonical = json.dumps(rows, sort_keys=True, separators=(",", ":")).encode()
    return {"sha256": hashlib.sha256(canonical).hexdigest(), "files": rows}


def guard(root, marker, host):
    used = usage(root)
    if used + 1024 * 1024 >= marker["capBytes"]:
        raise RuntimeError("Owned Android state budget exhausted")
    if space(root) < marker["developmentReserveBytes"] + 16 * 1024 * 1024:
        raise RuntimeError("Development-volume reserve unavailable")
    if space(host) < marker["hostReserveBytes"]:
        raise RuntimeError("Host-volume reserve unavailable")
    return used


def write_json(path, value):
    data = (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def group_members(group):
    result = subprocess.run(
        ["/bin/ps", "-axo", "pid=,pgid="], capture_output=True, text=True, check=True,
    )
    return [int(row.split()[0]) for row in result.stdout.splitlines()
            if len(row.split()) == 2 and int(row.split()[1]) == group]


def wait_group(group):
    deadline = time.monotonic() + 5
    members = group_members(group)
    while members and time.monotonic() < deadline:
        time.sleep(0.1)
        members = group_members(group)
    return members


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-root", required=True)
    parser.add_argument("--gradle", required=True)
    parser.add_argument("--sdk", required=True)
    parser.add_argument("--java-home", required=True)
    parser.add_argument("--read-only-cache", required=True)
    parser.add_argument("--host-volume", required=True)
    parser.add_argument("--storage-check", required=True, help="Registered local storage checker script")
    parser.add_argument("--online", action="store_true", help="Allow missing public Maven dependencies")
    parser.add_argument("--timeout", type=int, default=540)
    parser.add_argument("tasks", nargs="+")
    args = parser.parse_args()
    if any(task not in TASKS for task in args.tasks):
        parser.error("Only development verification tasks are supported")
    if not 10 <= args.timeout <= 1800:
        parser.error("Timeout must be between 10 and 1800 seconds")
    os.umask(0o077)
    root = ordinary(args.state_root, True)
    marker_path = ordinary(root / "android-build-state.json")
    if marker_path.stat().st_size > 16384:
        raise ValueError("Oversized state marker")
    marker = json.loads(marker_path.read_text())
    if (marker.get("schemaVersion") != 1 or marker.get("task") != "android-minimal-browser"
            or marker.get("ownerUid") != os.getuid() or marker.get("stateRoot") != str(root)
            or root.stat().st_uid != os.getuid() or stat.S_IMODE(root.stat().st_mode) != 0o700):
        raise ValueError("Unregistered Android state directory")
    project = ordinary(Path(__file__).absolute().parents[1], True)
    if marker.get("sourceRoot") != str(project):
        raise ValueError("State directory belongs to a different source tree")
    if (project / "local.properties").exists() or (project / "local.properties").is_symlink():
        raise ValueError("Use explicit SDK environment only; local.properties is not consumed by this runner")
    checker = ordinary(args.storage_check)
    subprocess.run([sys.executable, "-B", str(checker), "check-mount"], check=True)
    host = ordinary(args.host_volume, True)
    gradle = ordinary(args.gradle)
    sdk = ordinary(args.sdk, True)
    java = ordinary(args.java_home, True)
    cache = ordinary(args.read_only_cache, True)
    for name in ["gradle-home", "project-cache", "build", "tmp", "android-user-home", "logs"]:
        ordinary(root / name, True)
    guard(root, marker, host)
    number = 1
    while (root / "logs" / ("build-%04d.log" % number)).exists():
        number += 1
    log_path = root / "logs" / ("build-%04d.log" % number)
    result_path = root / "logs" / ("build-%04d.result.json" % number)
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith("ORG_GRADLE_PROJECT_")
                   and key not in {"GRADLE_OPTS", "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS"}}
    before_source = source_inventory(project)
    environment.update({
        "HOME": str(root / "android-user-home"),
        "JAVA_HOME": str(java), "ANDROID_HOME": str(sdk), "ANDROID_SDK_ROOT": str(sdk),
        "ANDROID_USER_HOME": str(root / "android-user-home"),
        "GRADLE_USER_HOME": str(root / "gradle-home"), "GRADLE_RO_DEP_CACHE": str(cache),
        "ABS_ANDROID_BUILD_ROOT": str(root / "build"), "TMPDIR": str(root / "tmp"),
        "ABS_ANDROID_DEBUG_KEYSTORE": str(root / "android-user-home" / "debug.keystore"),
        "JAVA_OPTS": "-Xmx768m -Dfile.encoding=UTF-8",
        "ANDROID_SDK_DISABLE_ANALYTICS": "true",
    })
    if any(task.startswith(":app:assemble") for task in args.tasks):
        key = root / "android-user-home" / "debug.keystore"
        if key.exists():
            ordinary(key)
            if key.stat().st_uid != os.getuid() or stat.S_IMODE(key.stat().st_mode) != 0o600:
                raise ValueError("Unexpected development signing-file ownership or mode")
        else:
            keytool = ordinary(java / "bin" / "keytool")
            key_log = root / "logs" / ("debug-keygen-%04d.log" % number)
            with key_log.open("xb") as output:
                subprocess.run([
                    str(keytool), "-genkeypair", "-keystore", str(key),
                    "-alias", "androiddebugkey", "-storepass", "android", "-keypass", "android",
                    "-keyalg", "RSA", "-keysize", "2048", "-validity", "3650",
                    "-dname", "CN=Android Development,O=Local Test,C=US", "-noprompt",
                ], stdout=output, stderr=subprocess.STDOUT, env=environment, check=True, timeout=30)
            os.chmod(key, 0o600)
    command = [str(gradle), "--no-daemon", "--no-watch-fs", "--max-workers=1",
               "--console=plain", "--project-cache-dir", str(root / "project-cache"),
               "-Duser.home=" + str(root / "android-user-home"), "-p", str(project)]
    if not args.online:
        command.append("--offline")
    command.extend(args.tasks)
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    stop_reason = None
    with log_path.open("xb") as log:
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT,
                                   env=environment, start_new_session=True)
        deadline = time.monotonic() + args.timeout
        try:
            write_json(root / "logs" / ("build-%04d.invocation.json" % number), {
                "startedAt": started, "pid": process.pid, "processGroup": process.pid,
                "command": command, "scope": "owned-gradle-process-group",
            })
            while process.poll() is None:
                guard(root, marker, host)
                if time.monotonic() >= deadline:
                    raise TimeoutError("Owned Android build deadline exceeded")
                time.sleep(0.5)
        except (OSError, ValueError, RuntimeError, TimeoutError, KeyboardInterrupt) as error:
            stop_reason = type(error).__name__ + ": " + str(error)
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)
        exit_code = process.wait()
        log.flush()
        os.fsync(log.fileno())
    remaining = wait_group(process.pid)
    after_source = source_inventory(project)
    source_unchanged = before_source == after_source
    result = {
        "schemaVersion": 1, "startedAt": started, "command": command,
        "exitCode": exit_code, "stopReason": stop_reason, "log": str(log_path),
        "ownedProcessGroupRemaining": remaining, "stateBytes": usage(root),
        "developmentFreeBytes": space(root), "networkDependenciesAllowed": args.online,
        "deviceActions": False, "thirdPartySiteAcceptance": "not-run",
        "sourceUnchanged": source_unchanged, "sourceSha256": before_source["sha256"],
        "sourceFiles": before_source["files"],
        "status": "passed" if exit_code == 0 and stop_reason is None and not remaining and source_unchanged else "failed-or-unverified",
    }
    write_json(result_path, result)
    summary = {key: value for key, value in result.items() if key not in {"command", "sourceFiles"}}
    summary["resultPath"] = str(result_path)
    print(json.dumps(summary, sort_keys=True))
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as failure:
        print(type(failure).__name__ + ": " + str(failure), file=sys.stderr)
        sys.exit(2)
