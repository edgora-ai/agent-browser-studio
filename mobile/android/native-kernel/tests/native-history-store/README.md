# Production history Store host regressions

Run from the checkout (no SDK, Gradle build, installation, network or device needed):

```sh
bash mobile/android/native-kernel/tests/native-history-store/run-tests.sh
```

Set `JAVA17_HOME` if JDK 17 is elsewhere. `NATIVE_HISTORY_STORE_TEST_OUTPUT_ROOT`
optionally chooses the generated class-output parent; the default is the host temporary
directory. Test fixture files are newly created isolated host temporary directories, never
application/profile data. The runner prints its output path and does not delete user data.

The runner compiles **the actual production** `BrowserHistoryStore.java` and
`BrowserHistory.java` with `javac --release 17 -Xlint:all -Werror`. There is no copied
persistence algorithm, extracted method, or source-substring-only contract. A package-private
`Executor` constructor controls task scheduling; every task still executes on a separate
real host thread. A virtual main `Looper` permits deterministic publication/callback races
without sleeps. The default production shared executor is also exercised.

Storage uses genuine local `FileInputStream` / `FileOutputStream` / `FileDescriptor.sync()`
through a minimal Android `AtomicFile` boundary. Context directory lookup and **every**
storage stub entry/read/write/close assert that production never accesses disk on main.
Faults include partial writes, start/finish/rollback failures, a *nonthrowing* rejected
commit with same-length old/new bytes, failed readback, oversized files and files growing
past the cap during reading. Backup recovery and mutations before loaded-model publication
are executed, not inferred from source text.

Cases cover async initialization and application-context retention; pending navigation,
title, removal and clear order; captured visit time and merge counts; detached UI rows;
immutable, coalesced ordered snapshots; debounce during a write; initialization/in-flight
flush durability fences; dirty retry after failure; exact-profile-key and legacy filename
isolation; corruption/site caps; lifecycle-listener cancellation/re-registration; callback
exception independence; main ownership of public methods; named background-priority worker.

## Unknown baseline and retained intents

A transient read/directory/executor failure never authorizes overwriting unread history.
Later explicit flush/debounce rereads on the worker, then main replays the retained journal
before any save. Persistent, asynchronously cancellable listeners receive recovery
publications; `hasLoadError()` distinguishes an unreadable baseline from an empty one.
An explicit clear intentionally resets the baseline, including clear during an in-flight
recovery. Oversized files retain the previous explicit empty-model corruption policy.

Deferred title payloads use the model's exact 200-UTF-16-unit sanitizer before capture.
Consecutive title-only updates for the same origin coalesce; the tests inspect actual
retained closure payloads with giant input, then execute recovery and verify final state.
**Residual limit:** the number of arbitrary visit/remove/clear intents during an indefinitely
unreadable baseline is not hard-capped. Exact replay preserves unknown stored timestamps,
merge-window counts, eviction and ordering; dropping/summarizing those intents would need
an explicit overflow/failure product policy. This remains a potential memory/replay-time
risk during an exceptionally long I/O outage, not a claim of bounded journal event count.

## Boundary / non-claims

These are host tests, **not** Android framework `AtomicFile` conformance tests, device
StrictMode/tracing, a power-loss or directory-fsync guarantee, a performance benchmark, or
release acceptance. Queue and AtomicFile internals are minimal documented stubs. Explicit
production worker-side readback prevents a successful fence when `finishWrite()` silently
leaves stale data; an Android-device smoke/trace remains separate future verification.
Host test-driver joins/waits do not exist in production Store code. Existing UI/Activity/
Runtime host integrations remain owned by the Lead's separate harness.
