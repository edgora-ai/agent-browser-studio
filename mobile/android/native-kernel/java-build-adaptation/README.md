# Java build adaptation for the Android native kernel

This directory carries the one build-tooling adaptation that the frozen Android
native build needs before `autoninja` can run Java steps with the frozen
`JAVA_TOOL_OPTIONS=-Xint` environment. It is applied **after** the managed
`0002`–`0058` Chromium patch chain; it never rewrites that chain.

## What it fixes

With `JAVA_TOOL_OPTIONS=-Xint`, every JVM invocation (`javac`, `d8`, `javap`,
`turbine`, …) prints an un-disablable startup hint on stderr:

```text
Picked up JAVA_TOOL_OPTIONS: -Xint
```

Stock `build/android/gyp/util/build_utils.py::CheckOutput` fails any step whose
combined output is nonempty (`fail_on_output`), so the hint — and, depending on
JDK buffering, the empty-line layout it leaves behind — fails Java steps even
when they succeed. The adaptation extends only `_FailureFilter`:

- drop exactly the `Picked up (JAVA_TOOL_OPTIONS|_JAVA_OPTIONS): …` hint lines;
- if a hint was present and nothing but empty lines remains, treat the residual
  layout as empty;
- keep every other line: real warnings, errors, and nonzero exits still fail;
- without a hint in the output, behavior is byte-identical to upstream.

## Provenance and limits

- Pinned upstream blob: `build/android/gyp/util/build_utils.py` at tag
  `152.0.7977.72`, sha-256 `bcd561c08814422c646efc8d5417fb94105f4b8cd536f5f4c7fbbf4191e76687`
  (13,209 bytes).
- Pinned adapted result: sha-256 `0500be2fc77e03bdd1c2d54ed36e1793a2fc82f1bf3f6011594eb7d548293f0c`
  (13,954 bytes).
- The managed patch chain does not touch this file and it is not part of
  `PATCHED_SOURCE.sha256`; applying this adaptation does not invalidate chain
  provenance.
- This repository-hosted patch re-authors the documented contract of the
  machine-local adaptation from the 2026-10-31 handoff (that file, sha-256
  `97c7eb48…`, 14,018 bytes, was never in Git). It implements the same narrow
  contract but is **not** byte-identical to it. Passing these tests is
  component-level evidence only; it is not an APK, a completed build, or a
  runtime acceptance result.

## Use

```bash
python3 mobile/android/native-kernel/java-build-adaptation/apply_java_build_adaptation.py \
  /path/to/chromium/src            # apply (verifies pinned bytes both sides)
python3 mobile/android/native-kernel/java-build-adaptation/apply_java_build_adaptation.py \
  /path/to/chromium/src --check    # verify state without writing
python3 -m unittest \
  mobile.android.native-kernel.build.tests.test_apply_java_build_adaptation \
  # or: python3 mobile/android/native-kernel/java-build-adaptation/tests/test_apply_java_build_adaptation.py
```

The apply step refuses anything but the pinned upstream bytes, is idempotent,
and verifies the adapted result against the pinned sha-256. Do not widen the
filter, drop `-Xint`, disable warnings-as-errors, or otherwise "make it pass":
those are exactly the shortcuts the 2026-10-31 handoff forbids.
