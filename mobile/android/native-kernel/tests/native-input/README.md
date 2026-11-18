# Exact-method host regression — CONTROL_FLOW_ONLY

**Verified on 2026-11-16 with the canonical patch and Clang AddressSanitizer +
UndefinedBehaviorSanitizer:** baseline 6 PASS / 5 expected FAIL; patched 11 PASS.
Both variants were actually compiled and executed. The private run receipt is
`run-3jmg_i5p/result.json` under the output root documented below.
This is an independent host control-flow regression, not a Chromium native unit
suite, fake gesture-filter test, Android acceptance result, or proof that the
three-tab device freeze is fixed.

## What is real and what is stubbed

`input_manager.original.cc` is the exact 554-byte upstream
`InputManager::RecreateRenderInputRouterSupport` method captured at lines 741–753
of the authoritative `input_manager.cc` (full-file SHA-256
`449cbbdbf146bf9a632b854430e3f17bcd322894267a99e7c55d8ae09fd7024e`).
Its independent pinned SHA-256 is
`b7c81622a78135acbc67f4a400849ebdf5f0ab6f46e26d2d88a234921ec1edeb`.
The permanent fixture has no dependency on an ignored `.tmp-apk` source capture.

The runner reads the **current canonical**
`chromium/product-input-lifecycle.patch`, extracts exactly its production
`components/viz/service/input/input_manager.cc` diff, and applies that diff with
`patch -p1 -F0 --batch --forward` to an owned copy of the fixed original method.
Because the fixture contains only the method, the upstream line-745 hunk applies
at an expected line offset; fuzz is still exactly zero. It then explicitly
reverse-applies the same diff and requires byte-for-byte restoration. It never
regenerates or substitutes its own guard. Both compiled variants include the
actual original/patch-derived method bytes, with the **same** fixture source and
compiler flags. A malformed/inapplicable/changed patch is a failure, not a skip.

The rest is intentionally host stubs: integer FrameSinkId; parent/root maps;
factory root/child choice mirroring the upstream oldest-parent condition;
support/provider generation numbers; `std::weak_ptr` lifetime observers; RIR
object identity; mobile-optimization notification counting. No fake gesture
filter, input event generator, touch ACK, scroll dispatch, real `base::WeakPtr`,
Android receiver/transfer or Chromium runtime is implemented. Pointer-address
reuse cannot hide replacement because generation/provider serials are monotonic.
Snapshots retain only weak tokens, never strong references to old lifetimes.

Parent lookup was checked against real `frame_sink_manager_impl.cc` lines
974–983 (SHA-256
`25ed3f1ccd56c24f34a0c868a3c27ff24b1ab95ff7ae2f335261d6f035aaacda`).
The stub CHECKs that the child is not itself a root sink; no mapping returns
invalid 0; otherwise `.at()` returns the oldest **direct** parent, never the
ultimate root ancestor. Its single-parent map intentionally does not simulate
multiple-parent ordering. Existing null-child setup checks cover a nested
child → nonroot parent → root, missing-parent invalid, and root-child CHECK
rejection, without adding to the eleven cases. Stub CHECK throws for observation;
it does not prove real Chromium CHECK/crash semantics.

The two variants demonstrate only whether this exact method preserves a root
support/provider/lifetime when the same RIR survives, and whether child/type
transitions still reconstruct. These are deliberately narrower than proving
actual native gesture delivery or resolving the observed freeze.

## Eleven identical cases and expected red/green shape

| Case | Original expectation | Patched expectation |
|---|---|---|
| null root allocates + notifies | PASS | PASS |
| null child allocates + notifies | PASS | PASS |
| root detach/attach support generation | FAIL | PASS |
| root detach/attach provider identity | FAIL | PASS |
| root detach/attach old weak observers | FAIL | PASS |
| root detach/attach exact same RIR object | PASS | PASS |
| root reuse avoids reset/allocation/renotify | FAIL | PASS |
| three root sinks × 30 rounds (90 calls) | FAIL | PASS |
| child → child still reconstructs/notifies | PASS | PASS |
| root → child reconstructs | PASS | PASS |
| root → child → root reconstructs both times | PASS | PASS |

The runner requires exactly the same eleven ordered case names; baseline exit
must be 1 with **these exact five failures** (6 PASS), not a crash or compilation
error. Patched must exit 0 with 11 PASS and no runtime diagnostics. Both use an
unchanged C++ fixture; no preprocessor switch or baseline-specific test behavior
changes the expectations. The 90-call case executes all rounds before evaluating
final stability. Root detach is topology-only; recreate is called on reattach,
not while the hierarchy edge is absent.

## Reproduction commands

Run from repository root. Requirements: Python 3, host `patch` supporting the
listed GNU/BSD-style flags, and a C++17 compiler (default `clang++`).

Prepare and verify canonical patch forward/reverse **without compiling/running**:

```sh
python3 mobile/android/native-kernel/tests/native-input/run_control_flow.py --prepare-only
```

Compile both variants and execute expected baseline-red / patched-green checks:

```sh
python3 mobile/android/native-kernel/tests/native-input/run_control_flow.py --run --cxx clang++
```

Optional separate sanitizer run, if supported by the selected host toolchain:

```sh
python3 mobile/android/native-kernel/tests/native-input/run_control_flow.py --run --cxx clang++ --sanitize
```

There is no default build mode: bare invocation only reports missing explicit
mode. The script is import-safe. It records the actual compiler argv/version,
patch SHA-256, original/patched method hashes, C++ fixture hash, binary hashes,
return codes and stdout/stderr under a new private directory:

`.tmp-apk/proxy-fix-work/v13z-rev12-host-test/run-<unique>/`

All new directories are 0700, files are 0600 (compiler binary mode comes from the
compiler under umask 077). There is **no destructive or automatic cleanup**, no
remote/device command, no change to canonical patches/stager/tracked inputs,
and no reliance on a global temporary directory. The output root is refused if
it is a symlink, not owned by the current user, or not mode 0700. Repeated runs
retain independent receipts rather than overwrite earlier output.

Actual compile command generated for each variant is:

```text
<resolved-cxx> -std=c++17 -O0 -g -Wall -Wextra -Werror -pedantic \
  [-fsanitize=address,undefined -fno-omit-frame-pointer] \
  -I <owned-run>/<baseline-or-patched> \
  mobile/android/native-kernel/tests/native-input/control_flow_test.cc \
  -o <owned-run>/<variant>-control-flow-test
```

The runner also records actual `patch` argv. Its optional prepare-only result is
`PREPARED_ONLY_NO_BUILD_OR_TEST_RUN`; a successful compiled run is explicitly
`CONTROL_FLOW_ONLY_EXPECTED_RED_GREEN`. Any compile/runtime/patch mismatch is
`FAILED`, with logs retained. A concurrent canonical-patch/fixture change during
a compiled run is rejected.

## Evidence separation

Preparation/static parsing is not execution. Even an eventual host 11/11 result
must remain labeled CONTROL_FLOW_ONLY. The real Chromium native-unit compile/run
and on-device three-tab freeze reproduction/recovery are separate evidence tracks
owned by Lead; no result here substitutes for them.
