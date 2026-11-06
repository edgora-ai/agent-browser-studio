# Contract-cleanup host regressions

Run with Python 3 and local JDK 17 (no Gradle, Android SDK, network or device):

```sh
python3 -B mobile/android/app/src/test/contract-cleanup/run_contracts.py /absolute/fresh/output
```

This standalone test source lives outside the default `src/test/java` source set deliberately:
its generated Android API doubles must never enter an APK or Android unit-test classpath.
The runner compiles actual manager data/core sources and the test main. Only transaction
control callbacks, monitors, argument/integrity failure paths, owned-buffer zeroing and the
private strict UTF-8 envelope codec execute. Unused SQL/JSON/KeyStore calls fail closed.

It is **not** Android SQLite, AndroidKeyStore/AES-GCM, fsync/durability, network routing,
Chromium ErrorProne, product-build or device evidence. Existing SQL/static contract tests
remain independent and unweakened. Generated sources/classes are retained under the fresh
explicit output path; the runner never deletes or resets prior results.

## Fresh-session Activity entry

```sh
python3 -B mobile/android/app/src/test/contract-cleanup/run_launch_contracts.py /absolute/fresh/launch-output
```

This independent JDK17 main compiles the **actual** `LaunchCoordinator`, control protocol,
process-owner interfaces and core launch/state-machine classes. Narrow Android Intent/IPC,
Context, lifecycle-lock and bootstrap-store doubles stay only under the explicit output path.
No production source is copied, reimplemented or weakened. Storage/locking and IPC doubles are
controlled inputs, not proof of actual SQLite transactions, kernel locks or Android Binder.

Behavioral coverage: publication/lock/profile-revision/thread gates; no Activity before a
validated HELLO; session-bound fresh marker; exact SESSION/NONCE extras; fresh
`NEW_TASK|CLEAR_TOP` with both `SINGLE_TOP|REORDER_TO_FRONT` explicitly removed; unrelated flags
preserved; first successful dispatch only; duplicate HELLO, Continue, rebind and stale generation;
CLAIMED Continue before the first HELLO; start failure/retry; mismatched/replaced markers;
unsafe entry-point rejection; UID/session/PID/incarnation/owner/bound guards; drain/no-launch;
manager reconstruction and rare marker loss both falling back to non-destructive reuse.

The marker is intentionally **process-local and nonpersistent**. Its loss does not authorize
CLEAR_TOP from a persisted CLAIMED record and does not repair every abnormal reconstruction.
On a standard-launchMode Activity, fresh-only CLEAR_TOP without SINGLE_TOP is intended to
replace the dead session's ActivityRecord, including obsolete Intent/saved state. CLEAR_TOP may
also finish manager Activities above that record; it must never be inferred for a hot session.
Host doubles do **not** execute Android's task manager, verify this behavior or prove a toolbar,
UI-ready state, foreground focus, live-tab preservation or Chromium startup. `startActivity`
returning successfully means only that the request was accepted by this coordinator boundary.
The existing asynchronous explicit-open/HELLO focus policy is unchanged; a user backgrounding
the manager before HELLO, background-activity restrictions and suppressed launches remain
Android/device verification concerns. Normal explicit exit still destroys native WebContents;
this patch does not restore tabs across exit. NativeActivity saved-state/intent defenses remain
independent and are not modified by these tests.
