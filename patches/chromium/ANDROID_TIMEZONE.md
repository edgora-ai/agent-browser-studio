# Android frozen native-timezone verification kernel

## Status and scope

Patch `0057-android-frozen-native-timezone.patch` adds a **separate internal
content-shell APK** on Chromium `152.0.7977.72`. The original
`mobile/android/app` remains the System WebView prototype. This patch does not
replace the system WebView provider, migrate that product UI to Chromium, enable
ordinary browsing admission, or complete Android licensing/distribution.

Source implementation and selected-file patch application are available. Native
C++/Java compilation, native tests, APK installation, Date/Intl realm acceptance
and a new Ping0 score are **NOT_RUN**. Independent source review must finish and
all confirmed blockers must be fixed **before** compilation or installation.
Source-contract tests are not a substitute for those later steps. The current
independent source-review and actual host-test results are recorded in the
[2026-10-27 source review report](../../docs/review/android-native-timezone-source-review-2026-10-27.md).

The existing `0002`–`0056` patches, original payload files and desktop
`RoxyFingerprintConfig` parser are unchanged. The new parser is Android-only and
accepts no desktop identity fields. Navigator, hardware, graphics and screen
consumers retain their unconfigured paths. In particular, the upstream **test
shell** UA/UA-CH surface is not a production Android Chrome identity; this work
does not certify its branding or complete cross-surface identity consistency.

## Frozen input

The opt-in APK target packages exactly one synthetic fixture:

| GN argument `agent_browser_timezone_fixture` | Mode | Timezone |
| --- | --- | --- |
| `"new-york"` | `timezone-only` | `America/New_York` |
| `"shanghai"` | `timezone-only` | `Asia/Shanghai` |
| `"native-control"` | `native-control` | No override; measure the actual host |
| `""` (default) | Target not defined | Ordinary content shell remains unchanged |

The three fixture JSON files contain only schema, mode, a synthetic UUIDv4
profile ID, and, for override mode, the timezone. They deliberately use canonical
ASCII JSON without a trailing newline. A native-control fixture is not the same
as an absent configuration: it provides a bound control receipt but **does not
apply a timezone override**. The ordinary content-shell target also remains
available for a genuinely unconfigured control.

`AgentBrowserTimezoneApplication` reads only that fixed APK asset, with a 2-KiB
limit. In the browser process it initializes argv **before** the parent
Application's `attachBaseContext`, including its first LibraryLoader access. It
adds a fresh secure UUIDv4 `launchId` for each new browser process. Activity
recreation only checks the existing input; it cannot reconfigure the singleton.
Already-initialized argv, missing/malformed assets and changed frozen switches
are startup failures, not opportunities to append a repair.

The resulting payload uses the existing public switch and a required marker:

```text
--agent-browser-fingerprint-config=<unpadded-base64url-canonical-json>
--agent-browser-timezone-required
```

Example decoded override payload (synthetic IDs only):

```json
{"launchId":"22222222-2222-4222-8222-222222222222","mode":"timezone-only","profileId":"11111111-1111-4111-8111-111111111111","schemaVersion":1,"timezone":"America/New_York"}
```

Canonical key order is `launchId`, `mode`, `profileId`, `schemaVersion`, then
`timezone` if present. Native-control mode has exactly the first four fields and
must omit `timezone`. Schema must be integer `1`; both IDs must be lowercase
canonical UUIDv4 with the RFC variant. Values are not coerced. Unknown fields,
duplicate keys, whitespace/escape variants, contradictory aliases, padded or
noncanonical base64, unsupported modes and unknown ICU system IDs are rejected.
Timezone tokens are bounded to 128 ASCII bytes and decoded input to 64 KiB;
encoded size is checked before decoding. The legacy config-switch alias uses
the same narrow contract and never rescues a corrupt public value.

The app rejects initial and later Intent command-line extras. It does not read
`/data/local/tmp/content-shell-command-line`, writable configuration paths,
preferences or page messages. `js-flags` are rejected for configured native
runs, and the GN target requires V8 Intl/ICU support. There is no production
setter, singleton reset, Java default-timezone change, `TZ` environment override
or page-level Date/Intl replacement.

Profile-specific private-directory suffixes derive from the packaged synthetic
profile ID; launch IDs do not change the stable suffix. This is a **source
isolation contract**, not an observed native storage-persistence result.
Profile IDs and launch IDs are correlation identifiers, not credentials or a
cross-application authentication protocol.

## Browser, renderer and Worker path

1. `ShellContentBrowserClient::CreateBrowserMainParts` rejects requested but
   invalid configuration before creating browser main parts. The parser validates
   the IANA/system identity using the bundled ICU data without changing defaults.
2. The Shell browser client forwards only the public config, legacy config and
   required marker to renderer children. It does not add those switches to GPU,
   network or utility processes, or forward desktop font/profile switches.
3. Blink `TimeZoneController::Init` validates the snapshot before its early-return
   path and instantiates the controller for configured runs before Window/Worker
   script contexts. Every newly started renderer receives the same frozen argv.
4. Override mode uses the canonical ICU system ID and requires
   `SetIcuTimeZoneAndNotifyV8` to succeed. Failure is a native startup failure;
   it cannot continue with a host-timezone success receipt.
5. The process's ICU default is frozen, and V8 uses explicit `kSkip`, not host
   re-detection. The existing Worker notification path is retained; new isolates
   initialize against the frozen ICU state. Host monitor notifications cannot
   replace the active override. Mutable clear/change override paths reject a
   frozen native timezone.

This is **renderer-process-wide**, not different timezones for multiple contexts
inside one renderer. A/B fixtures require separate, owned browser-process
lifetimes. It does not modify the Android system timezone, browser-process ICU
default or another app's process.

## Bounded receipts

Java reports the SHA-256 of the exact canonical payload and its browser PID:

```text
ABS_ANDROID_TIMEZONE_V1 frozen=1 input_sha256=<64 lowercase hex> pid=<browser PID>
```

A successfully initialized renderer reports:

```text
ABS_ANDROID_TIMEZONE_V1 applied=1 input_sha256=<same digest> pid=<renderer PID> canonical_timezone=<canonical ICU ID>
```

Explicit native control reports `applied=0 mode=native-control` instead. Receipts
do not include the encoded payload, arbitrary Intent values, private paths or
exception text. Collect only precisely owned process output; do not collect
unfiltered device logs. A digest matches inputs, **not** Date/Intl behavior or
worker coverage. Since each new process has a new launch ID, cross-launch digest
changes are expected; correlate each launch separately.

## Later Linux build, only after review and admission

The exact APK target is:

```text
//content/shell/android:agent_browser_timezone_apk
```

Expected APK name: `apks/AgentBrowserNativeTimezone.apk`; expected application ID:
`com.ahoo.abs.android.native_timezone.preview`. It is a test-only native shell,
not the existing `com.ahoo.abs.android.preview.debug` WebView app.

Use a verified Linux x86-64 host, the pinned source/dependency revision and its
matching Android toolchain. Validate the full patch chain and final-source
manifest through the existing check/apply workflow. Do not infer provenance from
a synthetic Git seed, LASTCHANGE or an assertion stamp. A selected-file scratch
application proves only those selected bytes, not complete upstream provenance.

Do not copy desktop release args into the Android output. After review and
explicit storage/toolchain admission, a **fresh**, operator-selected Android
output may use these core arguments:

```gn
target_os = "android"
target_cpu = "arm64"
is_debug = false
is_component_build = false
symbol_level = 0
v8_enable_i18n_support = true
agent_browser_timezone_fixture = "new-york"
```

Keep other pinned Android defaults and record the resolved args. Use a separate
admitted fresh output/fixture for `shanghai` and `native-control`; do not overwrite
another build or silently change a frozen input. Account for the full source,
dependencies, linking temporaries, outputs and retained evidence. Existing
lightweight Gradle/emulator budgets do not authorize a Chromium build or an
automatic download. This document does not launch a build.

Added native test source, still requiring actual compilation/execution:

- `blink_common_unittests`: `AgentBrowserAndroidTimezoneConfigTest.*` covers
  structural/ICU validity, missing required input, invalid aliases/encoding,
  profile/launch identities, explicit control and immutable parsed snapshots.
- `content_browsertests`: `AgentBrowserAndroidTimezoneBrowserTest.*` invokes the
  actual Shell forwarding method for renderer/GPU/utility argv and checks native
  Window plus freshly created/terminated DedicatedWorker Date/Intl readings.
- [Read-only multi-realm fixture](../../mobile/android/native-kernel-tests/README.md)
  supplies the separate frame, module-worker, SharedWorker and ServiceWorker
  acceptance paths. Missing lifecycle coverage must remain explicit.

## Acceptance is a separate gate

For New York require winter/summer offsets `300/240`; for Shanghai require
`-480/-480`. Read `Intl.DateTimeFormat().resolvedOptions().timeZone` and actual
`Date#getTimezoneOffset()` in Window, same/cross-origin frames, classic/module
DedicatedWorker, nested/recreated workers, SharedWorker and classic/module
ServiceWorker. A control records actual host values without prescribing them.

Unsupported realms, timeout, missing receipt, mismatched process/config, missing
native offsets, or absent lifecycle evidence cannot count as PASS. SharedWorker
reconnection does not prove its termination/recreation. SW install/activation
and a message do not prove stopping and event wakeup without a Window. Browser
cold restart, background recovery, new renderer, and controlled host-timezone
notifications require their own recorded tests, without changing the real system
timezone to force a result.

The original WebView lifecycle/storage regressions remain separate, including
the unresolved host SQLite retained-budget failure. New native storage must be
verified afresh by direct data inspection and readback. No real accounts, cloud
services, credentials or user browser data are test inputs. This fixture does
not establish proxy authentication, DNS/IPv6/WebRTC/UDP enforcement, GPU identity,
RAF performance, production UA/header coherence, complete storage durability or
a Ping0/CreepJS pass. Keep external egress fenced during lab testing; the native
shell does not inherit the WebView prototype's network/admission policy.
