#!/usr/bin/env python3
"""CONTROL_FLOW_ONLY. Requires explicit --prepare-only or --run; no import I/O.

Consumes the canonical product patch and the permanently pinned original method.
Never installs, talks to a device/remote host, changes tracked inputs or cleans up.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile

METHOD_SHA256 = "b7c81622a78135acbc67f4a400849ebdf5f0ab6f46e26d2d88a234921ec1edeb"
TARGET = "components/viz/service/input/input_manager.cc"
SCOPE = "CONTROL_FLOW_ONLY"
CASES = (
    "initial_null_root_allocates_notifies",
    "initial_null_child_allocates_notifies",
    "root_detach_attach_support_generation",
    "root_detach_attach_provider_identity",
    "root_detach_attach_weak_lifetime",
    "root_detach_attach_same_rir",
    "root_reuse_no_reallocation_or_renotify",
    "three_sinks_thirty_rounds",
    "child_to_child_still_recreates",
    "root_to_child_reconstructs",
    "root_child_root_round_trip_reconstructs",
)
BASELINE_FAILURES = {
    "root_detach_attach_support_generation",
    "root_detach_attach_provider_identity",
    "root_detach_attach_weak_lifetime",
    "root_reuse_no_reallocation_or_renotify",
    "three_sinks_thirty_rounds",
}


def need(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def write_new(path, data):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)


def production_diff(canonical):
    """Extract exactly one canonical production-file diff, not a rewritten guard."""
    header = ("diff --git a/" + TARGET + " b/" + TARGET + "\n").encode()
    blocks, current = [], []
    for line in canonical.splitlines(keepends=True):
        if line.startswith(b"diff --git "):
            if current:
                blocks.append(b"".join(current))
            current = [line]
        elif current:
            current.append(line)
    if current:
        blocks.append(b"".join(current))
    matching = [block for block in blocks if block.startswith(header)]
    need(len(matching) == 1, "canonical patch must contain exactly one input_manager.cc diff")
    selected = matching[0]
    prefix = header + ("--- a/" + TARGET + "\n+++ b/" + TARGET + "\n").encode()
    need(selected.startswith(prefix) and b"\n@@ " in selected, "unexpected production diff format")
    need(b"GIT binary patch" not in selected and b"rename from " not in selected,
         "production source must be an ordinary textual patch")
    return selected


def check_results(completed, expected_failures):
    expected_rc = 1 if expected_failures else 0
    need(completed.returncode == expected_rc, "unexpected host fixture exit (crash/build failure is not expected red)")
    lines = completed.stdout.decode("utf-8", errors="strict").splitlines()
    need(lines and lines[0] == "SCOPE\t" + SCOPE, "fixture scope marker missing")
    observed = []
    failures = set()
    for line in lines[1:-1]:
        fields = line.split("\t", 2)
        need(len(fields) >= 2 and fields[0] in ("PASS", "FAIL"), "unexpected fixture output")
        observed.append(fields[1])
        if fields[0] == "FAIL":
            need(len(fields) == 3 and fields[2], "failure reason missing")
            failures.add(fields[1])
    need(tuple(observed) == CASES, "must execute the same exact eleven cases in the same order")
    need(failures == expected_failures, "unexpected baseline/patched failure set")
    expected_summary = "SUMMARY\tpassed=" + str(11 - len(failures)) + "\tfailed=" + str(len(failures))
    need(lines[-1] == expected_summary, "fixture summary mismatch")
    need(not completed.stderr, "unexpected runtime diagnostic/sanitizer output")
    return {"passed": 11 - len(failures), "failed": len(failures), "failureCases": sorted(failures)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--prepare-only", action="store_true", help="apply/reverse patch; do not invoke compiler or binaries")
    mode.add_argument("--run", action="store_true", help="explicitly compile and execute host stubs after Lead review")
    parser.add_argument("--cxx", default="clang++", help="host C++17 compiler, resolved without shell interpolation")
    parser.add_argument("--sanitize", action="store_true", help="add AddressSanitizer + UndefinedBehaviorSanitizer")
    args = parser.parse_args()
    os.umask(0o077)
    here = Path(__file__).resolve().parent
    repo = here.parents[4]
    canonical_path = repo / "mobile/android/native-kernel/chromium/product-input-lifecycle.patch"
    out_root = repo / ".tmp-apk/proxy-fix-work/v13z-rev12-host-test"
    need(not out_root.is_symlink(), "refusing symlink output root")
    out_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = out_root.stat()
    need(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700,
         "output root must already be owned and mode 0700")
    work = Path(tempfile.mkdtemp(prefix="run-", dir=out_root))
    report = {"scope": SCOPE, "status": "PREPARING", "workDirectory": str(work),
              "compilerExecuted": False, "binariesExecuted": False, "commands": [],
              "chromiumNativeUnitCompiledOrRun": False, "deviceActions": False,
              "noGestureAckOrTransferSemanticsProven": True}

    def command(label, argv, cwd, timeout):
        result = subprocess.run([str(arg) for arg in argv], cwd=cwd,
                                env={**os.environ, "LC_ALL": "C"},
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                check=False, timeout=timeout)
        write_new(work / (label + ".stdout"), result.stdout)
        write_new(work / (label + ".stderr"), result.stderr)
        report["commands"].append({"label": label, "argv": [str(arg) for arg in argv],
                                   "cwd": str(cwd), "returnCode": result.returncode})
        return result

    code = 2
    try:
        original = (here / "input_manager.original.cc").read_bytes()
        need(sha(original) == METHOD_SHA256, "pinned original method hash mismatch")
        need(original.count(b"void InputManager::RecreateRenderInputRouterSupport(") == 1
             and original.endswith(b"}\n"), "original fixture must be exactly one complete method")
        canonical = canonical_path.read_bytes()
        diff = production_diff(canonical)
        diff_path = work / "production-only.patch"
        write_new(diff_path, diff)
        report.update({"canonicalPatchPath": str(canonical_path), "canonicalPatchSha256": sha(canonical),
                       "productionDiffSha256": sha(diff), "originalMethodSha256": sha(original),
                       "fixtureSha256": sha((here / "control_flow_test.cc").read_bytes())})
        patch = shutil.which("patch")
        need(patch is not None, "host patch executable not found")
        baseline, patched, reversed_tree = (work / name for name in ("baseline", "patched", "reverse-check"))
        write_new(baseline / TARGET, original)
        write_new(patched / TARGET, original)
        forward_args = [patch, "-p1", "-F0", "--batch", "--forward", "-i", diff_path]
        dry = command("patch-forward-dry-run", forward_args + ["--dry-run"], patched, 15)
        need(dry.returncode == 0, "canonical production diff does not apply at fuzz zero")
        applied = command("patch-forward", forward_args, patched, 15)
        need(applied.returncode == 0, "forward patch failed")
        patched_bytes = (patched / TARGET).read_bytes()
        need(patched_bytes != original, "production patch changed no method bytes")
        write_new(reversed_tree / TARGET, patched_bytes)
        reverse_args = [patch, "-p1", "-F0", "--batch", "--reverse", "-i", diff_path]
        reversed_result = command("patch-reverse", reverse_args, reversed_tree, 15)
        need(reversed_result.returncode == 0, "reverse patch failed")
        need((reversed_tree / TARGET).read_bytes() == original, "reverse patch must restore exact original bytes")
        report.update({"forwardAppliedAtFuzzZero": True, "reverseRestoredExactOriginal": True,
                       "patchedMethodSha256": sha(patched_bytes)})
        write_new(baseline / "method-under-test.inc", original)
        write_new(patched / "method-under-test.inc", patched_bytes)
        if args.prepare_only:
            report["status"] = "PREPARED_ONLY_NO_BUILD_OR_TEST_RUN"
            code = 0
        else:
            cxx = shutil.which(args.cxx)
            need(cxx is not None, "host C++ compiler not found")
            report["compiler"] = cxx
            report["compilerExecuted"] = True
            version = command("compiler-version", [cxx, "--version"], work, 15)
            need(version.returncode == 0, "compiler version probe failed")
            flags = ["-std=c++17", "-O0", "-g", "-Wall", "-Wextra", "-Werror", "-pedantic"]
            if args.sanitize:
                flags += ["-fsanitize=address,undefined", "-fno-omit-frame-pointer"]
            for name, tree in (("baseline", baseline), ("patched", patched)):
                binary = work / (name + "-control-flow-test")
                built = command("compile-" + name,
                                [cxx, *flags, "-I", tree, here / "control_flow_test.cc", "-o", binary], work, 120)
                need(built.returncode == 0, "host " + name + " compilation failed; inspect compile log")
                report[name + "BinarySha256"] = sha(binary.read_bytes())
            report["binariesExecuted"] = True
            old = command("execute-baseline", [work / "baseline-control-flow-test"], work, 20)
            report["baseline"] = check_results(old, BASELINE_FAILURES)
            new = command("execute-patched", [work / "patched-control-flow-test"], work, 20)
            report["patched"] = check_results(new, set())
            # Detect concurrent patch/fixture edits rather than blessing a stale run.
            need(canonical_path.read_bytes() == canonical, "canonical patch changed during run; review and rerun")
            need((here / "input_manager.original.cc").read_bytes() == original, "original fixture changed during run")
            need(sha((here / "control_flow_test.cc").read_bytes()) == report["fixtureSha256"], "fixture changed during run")
            report["status"] = "CONTROL_FLOW_ONLY_EXPECTED_RED_GREEN"
            code = 0
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        report["status"] = "FAILED"
        report["error"] = str(error)
        print(str(error), file=sys.stderr)
    finally:
        write_new(work / "result.json", (json.dumps(report, ensure_ascii=False, indent=2) + "\n").encode())
        print("scope=" + SCOPE)
        print("status=" + report["status"])
        print("result=" + str(work / "result.json"))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
