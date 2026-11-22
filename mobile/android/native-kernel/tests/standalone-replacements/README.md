# Standalone replacement and prerender guard regression tests

**Scope: `CONTROL_FLOW_ONLY`.** These focused tests exercise source-extracted
C++ role/clone/revalidation/revocation and Shell eligibility blocks, not a copy of
the production predicates. They are not Chromium browser tests, compilation of
Chromium objects, a full link, device/emulator validation, or proof of real
prerender activation behavior.

## Run

Supply the real, read-only **pre-patch** source snapshot. The runner applies the
canonical product patch strictly to its own private copy before extracting code:

```sh
python3 mobile/android/native-kernel/tests/standalone-replacements/run_tests.py \
  --run --pre /path/to/real/pre \
  --output-root /path/to/existing/private/scratch
```

The default patch is `mobile/android/native-kernel/chromium/product-pwa.patch`.
Use `--patch /path/to/a/captured.patch` to compare a frozen release input, and
`--case shell` or `--case renderer` for independent first-failure evidence.
Use `--prepare-only` instead of `--run` to apply/extract without invoking a host
compiler. Importing the runner performs no I/O. The host compiler defaults to
`CXX` or `c++`; C++20 support is required.

Each run retains a fresh small scratch tree, generated source, host executable,
and `result.json`. It never modifies the preimages or product patch, uses a
network/device/remote build, cleans up old artifacts, or overwrites an earlier
result. The manifest records input/source/fragment SHA-256 values and commands,
including the first failed command and its output.

## What is exercised

- Ordinary secure top-level, same-origin/in-scope documents with no prior role
  never gain one, in any loader state.
- An accredited committed source may preserve its exact existing scope and
  browser document token across repeated local replacements.
- Provisional, non-current-loader, wrong-document-token, subframe, revoked,
  insecure, cross-origin, opaque-origin, and out-of-scope sources cannot pass
  their role to a replacement.
- The replacement is rechecked after the production `InitializeWindow` call
  site. Revocation, non-top-level context, MHTML, insecure context, actual
  cross/opaque origin, or an escaped URL all discard the incoming scope.
- Failed accreditation cannot later rearm itself even when the context is made
  valid; ordinary documents do not acquire role from their URLs.
- Scope escape synchronously clears accreditation and sets sticky frame
  revocation; returning in scope cannot rearm or clone it.
- Dedicated installed Android Shells decline prerender, while ordinary Android
  Shells and all non-Android Shells retain the original eligible default.

The unchanged production URL-scope helper is included verbatim. `GURL`,
`SecurityOrigin`, document/frame/window objects, and role installation are small
host fakes. The URL stand-in only handles the canonical ASCII fixture inputs;
it does not implement Chromium URL normalization or claim GURL conformance.
The host installs a controlled post-`InitializeWindow` context instead of
executing real window initialization. Browser document installation, actual
browser/renderer IPC, secure-context computation, public API availability, and
prerender cancellation/activation still require real Chromium build/runtime
validation.
