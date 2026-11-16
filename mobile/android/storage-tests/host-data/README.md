# Explicit-direct host contracts

`../run_direct_host_tests.py` compiles the **actual production** core and data Java
(including `ProfileCodec`, `ProfileRepository`, `StoreDatabase`, `BootstrapStore`,
`StoredProfiles` and `StoredProxies`) with Java 17. No Gradle/product build occurs.

## Run

First obtain an explicitly authorized evidence directory: absolute, owned, mode
0700, named `tests/storage`, with no symlink components. The runner requires it
in `ABS_STORAGE_TEST_ROOT`; it has no fallback and never deletes/reset evidence.
Pass a **fresh absolute** output directory whose parent already exists:

```sh
ABS_STORAGE_TEST_ROOT=/approved/task/tests/storage \
  python3 -B mobile/android/storage-tests/run_direct_host_tests.py \
  /approved/task/storage-host/fresh-run
```

Set `JAVA17_BIN` to a JDK17 `bin` directory if the existing repository Homebrew
JDK17 location is unavailable. Keep `python3` available for the stdio adapter.
The original suites remain separately runnable:

```sh
ABS_STORAGE_TEST_ROOT=/approved/task/tests/storage \
  python3 -B mobile/android/storage-tests/run_contract_tests.py
python3 -B mobile/android/app/src/test/contract-cleanup/run_contracts.py \
  /approved/task/storage-host/fresh-cleanup-run
```

## What actually executes

- Existing `CoreContractTest` and `MonitorContractTest`, plus direct model tests.
- Real `ProfileCodec` serialization/parsing through explicit host JSON API
  doubles. Six hardcoded pre-direct hash vectors cover HTTP/HTTPS/SOCKS5, each
  with and without credentials. Old JSON key order/shape must roundtrip exactly.
  Direct requires an explicit null-valued `proxy` key and a distinct hash domain;
  missing, malformed or mismatched proxy inputs must reject, never select direct.
- Real repository CAS, direct/proxy transitions, new-ID direct duplication,
  reopen/readback, catalog unlink, credentials CLEAR/KEEP, REPLACE rejection,
  rollback on SQL failure, missing/mismatched association validation, catalog
  multiprofile endpoint refresh, and active-profile/catalog-edit rejection.
- Production schema asset and production SQLiteOpenHelper callbacks. A synthetic
  v2 database containing proxy links, revisions, opaque credential envelopes and
  frozen launch rows is upgraded to v3 with all table values unchanged. A
  synthetic v1 fixture imports its catalog while original table values remain
  unchanged. These fixtures are metadata fixtures, not harvested app databases.
- Direct publish/claim and frozen hash validation, with direct credential lookup
  returning null. The process double binds to the host JVM PID only.

## Deliberate limits

`SQLiteDatabase.java` is an Android API double forwarding SQL/bindings to a child
`python3` process over **stdin/stdout only**. Python's SQLite executes the actual
schema and SQL against fresh private synthetic files below the admitted root.
There is no socket, listening server, device, browser, backend or network call.
The JSON implementation is a test double, not Android platform `org.json`.
The helper and process lifecycle are host simulations, not Android evidence.

`CredentialCipher` is compiled unchanged; no test invokes AndroidKeyStore
creation, encryption or decryption. Authentication compatibility/CLEAR uses an
explicitly opaque, length-valid synthetic envelope and tests metadata retention,
validation/deletion/rollback only. It is not cryptographic or device proof.
Passing these contracts does not prove native runtime routing, network isolation,
platform persistence/fsync, or readiness; explicit direct remains unprotected
and admission/runtime evidence remains UNVERIFIED.
