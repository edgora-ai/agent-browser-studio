package com.ahoo.abs.android.verification;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteException;
import android.os.Bundle;
import com.ahoo.abs.android.ProxyGeoProbe;
import com.ahoo.abs.android.data.BootstrapStore;
import com.ahoo.abs.android.data.CredentialUpdate;
import com.ahoo.abs.android.data.ProfileRepository;
import com.ahoo.abs.android.data.StorageException;
import com.ahoo.abs.core.LaunchSpec;
import com.ahoo.abs.core.ProfileSpec;
import com.ahoo.abs.core.ProxySpec;
import java.io.File;
import java.util.Collections;
import java.util.UUID;
import org.json.JSONObject;

/** No default profile DB, existing browser data, external site or device identifier is read. */
public final class OwnedInstrumentation extends Instrumentation {
    private enum Stage {
        TARGET_CHECKS, PRAGMA_CREATE, PRAGMA_EXEC_SECURE_DELETE, PRAGMA_EXEC_BUSY_TIMEOUT,
        PRAGMA_QUERY_SECURE_DELETE, PRAGMA_QUERY_BUSY_TIMEOUT, REPOSITORY_OPEN, PROFILE_SAVE,
        PROFILE_DIRECT_READBACK, REPOSITORY_REOPEN, BOOTSTRAP_OPEN, BOOTSTRAP_PUBLISH,
        BOOTSTRAP_HASH_READBACK, BOOTSTRAP_CLAIM,
        BOOTSTRAP_LIFECYCLE, GEO_PARSER, COMPLETE
    }

    private String scope;
    private int checks;
    private Stage stage = Stage.TARGET_CHECKS;

    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        scope = arguments == null ? null : arguments.getString("ownedScope");
        start();
    }

    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            Context context = getTargetContext();
            require((context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0, "NOT_DEBUG_TARGET");
            require(context.getPackageName().equals("com.ahoo.abs.android.preview.debug"), "WRONG_TARGET");
            require(scope != null && UUID.fromString(scope).toString().equals(scope), "OWNED_SCOPE_REQUIRED");
            String name = "verification_" + scope + ".sqlite";
            File file = new File(context.getNoBackupFilesDir(), name);
            require(!file.exists(), "REFUSE_EXISTING_TEST_DATABASE");
            verifyReturningPragmas(context, result);
            ProfileSpec saved;
            stage = Stage.REPOSITORY_OPEN;
            try (ProfileRepository repository = new ProfileRepository(context, name)) {
                ProfileSpec initial = profile("owned-fixture-" + scope);
                stage = Stage.PROFILE_SAVE;
                try (CredentialUpdate update = CredentialUpdate.clear()) {
                    saved = repository.saveProfile(initial, null, update);
                }
                require(saved.fingerprint().equals(initial.fingerprint()), "SAVE_READBACK_MISMATCH");
                require(file.isFile(), "DATABASE_NOT_WRITTEN");
                stage = Stage.PROFILE_DIRECT_READBACK;
                try (SQLiteDatabase direct = SQLiteDatabase.openDatabase(file, new SQLiteDatabase.OpenParams.Builder()
                        .setOpenFlags(SQLiteDatabase.OPEN_READONLY)
                        .setErrorHandler(broken -> { throw new IllegalStateException("TEST_DATABASE_CORRUPT"); }).build());
                     Cursor row = direct.rawQuery("SELECT name,revision,config_hash FROM profiles WHERE id=?", new String[]{saved.id})) {
                    require(row.moveToFirst(), "DIRECT_QUERY_MISSING");
                    require(row.getString(0).equals(saved.name), "DIRECT_NAME_MISMATCH");
                    require(row.getString(1).equals(saved.revision), "DIRECT_REVISION_MISMATCH");
                    require(row.getString(2).equals(saved.fingerprint()), "DIRECT_HASH_MISMATCH");
                    require(!row.moveToNext(), "DUPLICATE_ROW");
                }
            }
            stage = Stage.REPOSITORY_REOPEN;
            require(file.isFile(), "DATABASE_MISSING_BEFORE_REOPEN");
            try (ProfileRepository reopened = new ProfileRepository(context, name)) {
                require(reopened.findProfile(saved.id).fingerprint().equals(saved.fingerprint()), "REOPEN_READBACK_FAILED");
                require(reopened.listProfiles().size() == 1 && reopened.listProfiles().get(0).name.equals(saved.name), "SEARCH_FAILED");
                stage = Stage.BOOTSTRAP_OPEN;
                try (BootstrapStore bootstrap = new BootstrapStore(context, name)) {
                    stage = Stage.BOOTSTRAP_PUBLISH;
                    LaunchSpec launch = bootstrap.publish(saved.id, saved.revision, 120000);
                    require(bootstrap.readActive().state == BootstrapStore.State.PUBLISHED, "PUBLISH_NOT_STORED");
                    stage = Stage.BOOTSTRAP_HASH_READBACK;
                    verifyLaunchHashReadback(file, saved, launch, bootstrap, result);
                    String incarnation = UUID.randomUUID().toString();
                    stage = Stage.BOOTSTRAP_CLAIM;
                    LaunchSpec claimed = bootstrap.claim(incarnation);
                    require(claimed.sessionId.equals(launch.sessionId), "CLAIM_SESSION_MISMATCH");
                    require(bootstrap.readActive().pid == android.os.Process.myPid(), "CLAIM_PID_MISMATCH");
                    // This process is already bound. LAUNCH_REPLAY from a separate unbound
                    // process is not covered by this same-process rejection assertion.
                    expect(result, StorageException.Code.RUNTIME_IDENTITY_MISMATCH,
                            () -> bootstrap.claim(UUID.randomUUID().toString()));
                    BootstrapStore.ActiveLaunch unchanged = bootstrap.readActive();
                    require(unchanged != null && unchanged.state == BootstrapStore.State.CLAIMED
                            && unchanged.phase == BootstrapStore.RuntimePhase.CLAIMED,
                            "RECLAIM_CHANGED_ACTIVE_STATE");
                    require(unchanged.pid == android.os.Process.myPid()
                            && incarnation.equals(unchanged.incarnationId) && unchanged.provider == null
                            && claimed.configHash().equals(unchanged.launch.configHash()),
                            "RECLAIM_CHANGED_ACTIVE_BINDING");
                    stage = Stage.BOOTSTRAP_LIFECYCLE;
                    BootstrapStore.ActiveLaunch stopped = bootstrap.requestStop(launch.sessionId);
                    require(stopped.state == BootstrapStore.State.EXIT_UNCONFIRMED
                            && incarnation.equals(stopped.incarnationId), "ATOMIC_STOP_LOST_CLAIM");
                    require(bootstrap.readActive().state == BootstrapStore.State.EXIT_UNCONFIRMED, "UNCONFIRMED_NOT_RETAINED");
                    expect(result, StorageException.Code.EXIT_EVIDENCE_REQUIRED,
                            () -> bootstrap.recordConfirmedExit(launch.sessionId, incarnation));
                    require(bootstrap.readActive() != null, "SELF_CONFIRM_RELEASED_LEASE");
                }
            }
            stage = Stage.GEO_PARSER;
            JSONObject geo = new JSONObject("{\"success\":true,\"ip\":\"203.0.113.7\",\"country_code\":\"NZ\",\"timezone\":{\"id\":\"Pacific/Auckland\"}}");
            ProxyGeoProbe.Observation parsed = ProxyGeoProbe.parse(geo, 1000);
            require(parsed.countryCode.equals("NZ") && parsed.timeZoneId.equals("Pacific/Auckland"), "GEO_PARSER_MISMATCH");
            require(parsed.browserRouting.equals("UNVERIFIED"), "GEO_BECAME_BROWSER_PROOF");
            geo.put("success", "true");
            try {
                ProxyGeoProbe.parse(geo, 1000);
                throw new VerificationFailure("GEO_STRING_BOOLEAN_ACCEPTED");
            } catch (ProxyGeoProbe.ProbeException expected) {
                checks++;
            }
            stage = Stage.COMPLETE;
            result.putInt("checksPassed", checks);
            result.putString("stage", stage.name());
            result.putString("status", "PASSED");
            result.putString("failureCode", "NONE");
            result.putString("causeClass", "NONE");
            result.putString("operation", StorageException.Operation.NONE.name());
            result.putString("scope", "owned-native-SQLite-and-parser-only");
            result.putString("webViewAndPing0", "NOT_RUN");
            finish(Activity.RESULT_OK, result);
        } catch (Exception | AssertionError failure) {
            result.putInt("checksPassed", checks);
            result.putString("failureType", failure.getClass().getSimpleName());
            result.putString("failureCode", failureCode(failure));
            result.putString("stage", stage.name());
            StorageException storage = failure instanceof StorageException ? (StorageException) failure : null;
            result.putString("causeClass", storage == null ? "NONE" : storage.nativeExceptionClass.className);
            result.putString("operation", storage == null ? StorageException.Operation.NONE.name()
                    : storage.operation.name());
            result.putString("status", "FAILED");
            finish(Activity.RESULT_CANCELED, result);
        }
    }

    private void verifyLaunchHashReadback(File file, ProfileSpec saved, LaunchSpec published,
                                          BootstrapStore bootstrap, Bundle result) {
        LaunchSpec reconstructed;
        try (SQLiteDatabase direct = SQLiteDatabase.openDatabase(file, new SQLiteDatabase.OpenParams.Builder()
                .setOpenFlags(SQLiteDatabase.OPEN_READONLY)
                .setErrorHandler(broken -> { throw new VerificationFailure("TEST_DATABASE_CORRUPT"); }).build());
             Cursor row = direct.rawQuery("SELECT config_hash,profile_id,profile_revision,session_id,nonce,"
                     + "issued_at_ms,expires_at_ms FROM launch_records WHERE session_id=?",
                     new String[]{published.sessionId})) {
            require(row.moveToFirst(), "LAUNCH_DIRECT_QUERY_MISSING");
            String profileHash = row.getString(0);
            require(saved.fingerprint().equals(profileHash), "LAUNCH_STORED_PROFILE_HASH_MISMATCH");
            require(!published.configHash().equals(profileHash), "LAUNCH_HASH_DOMAINS_COLLAPSED");
            require(saved.id.equals(row.getString(1)) && saved.revision.equals(row.getString(2)),
                    "LAUNCH_DIRECT_PROFILE_MISMATCH");
            require(row.getType(5) == Cursor.FIELD_TYPE_INTEGER && row.getType(6) == Cursor.FIELD_TYPE_INTEGER,
                    "LAUNCH_DIRECT_TIME_TYPE_MISMATCH");
            reconstructed = new LaunchSpec(saved, row.getString(3), row.getString(4), row.getLong(5), row.getLong(6));
            require(published.configHash().equals(reconstructed.configHash()), "LAUNCH_SQL_ENVELOPE_MISMATCH");
            require(!row.moveToNext(), "DUPLICATE_LAUNCH_ROW");
        }
        BootstrapStore.ActiveLaunch readback = bootstrap.readActive();
        require(readback != null && reconstructed.configHash().equals(readback.launch.configHash()),
                "LAUNCH_RECONSTRUCTED_ENVELOPE_MISMATCH");
        result.putString("storedLaunchHashKind", "PROFILE_FINGERPRINT");
        result.putString("coreLaunchHashKind", "SESSION_NONCE_TIME_ENVELOPE");
        result.putString("launchEnvelopeReadback", "VERIFIED");
    }

    private void verifyReturningPragmas(Context context, Bundle result) throws java.io.IOException {
        stage = Stage.PRAGMA_CREATE;
        File file = new File(context.getNoBackupFilesDir(), "verification_" + scope + "_pragma.sqlite");
        require(!file.exists(), "REFUSE_EXISTING_PRAGMA_DATABASE");
        require(file.createNewFile(), "REFUSE_EXISTING_PRAGMA_DATABASE");
        SQLiteDatabase.OpenParams params = new SQLiteDatabase.OpenParams.Builder()
                .setOpenFlags(SQLiteDatabase.OPEN_READWRITE | SQLiteDatabase.NO_LOCALIZED_COLLATORS
                        | SQLiteDatabase.ENABLE_WRITE_AHEAD_LOGGING)
                .setJournalMode(SQLiteDatabase.JOURNAL_MODE_WAL)
                .setSynchronousMode(SQLiteDatabase.SYNC_MODE_FULL)
                .setErrorHandler(broken -> { throw new VerificationFailure("PRAGMA_DATABASE_CORRUPT"); })
                .build();
        try (SQLiteDatabase db = SQLiteDatabase.openDatabase(file, params)) {
            stage = Stage.PRAGMA_EXEC_SECURE_DELETE;
            result.putString("pragmaSecureDeleteExecSqlException",
                    expectReturningPragmaRejection(db, "PRAGMA secure_delete=ON"));
            stage = Stage.PRAGMA_EXEC_BUSY_TIMEOUT;
            result.putString("pragmaBusyTimeoutExecSqlException",
                    expectReturningPragmaRejection(db, "PRAGMA busy_timeout=5000"));
            stage = Stage.PRAGMA_QUERY_SECURE_DELETE;
            result.putInt("pragmaSecureDeleteSet", pragmaInteger(db, "PRAGMA secure_delete=ON",
                    1, "PRAGMA_SECURE_DELETE_SET_INVALID"));
            result.putInt("pragmaSecureDeleteReadback", pragmaInteger(db, "PRAGMA secure_delete",
                    1, "PRAGMA_SECURE_DELETE_READBACK_INVALID"));
            stage = Stage.PRAGMA_QUERY_BUSY_TIMEOUT;
            result.putInt("pragmaBusyTimeoutSet", pragmaInteger(db, "PRAGMA busy_timeout=5000",
                    5000, "PRAGMA_BUSY_TIMEOUT_SET_INVALID"));
            result.putInt("pragmaBusyTimeoutReadback", pragmaInteger(db, "PRAGMA busy_timeout",
                    5000, "PRAGMA_BUSY_TIMEOUT_READBACK_INVALID"));
        }
        require(file.isFile(), "PRAGMA_DATABASE_NOT_RETAINED");
    }

    private String expectReturningPragmaRejection(SQLiteDatabase db, String sql) {
        try {
            db.execSQL(sql);
            throw new VerificationFailure("PRAGMA_EXEC_SQL_ACCEPTED");
        } catch (SQLiteException observed) {
            checks++;
            return observed.getClass().getSimpleName();
        }
    }

    private int pragmaInteger(SQLiteDatabase db, String sql, int expected, String code) {
        try (Cursor cursor = db.rawQuery(sql, null)) {
            require(cursor.moveToFirst() && cursor.getColumnCount() == 1
                    && cursor.getType(0) == Cursor.FIELD_TYPE_INTEGER, code);
            long actual = cursor.getLong(0);
            require(actual == expected && !cursor.moveToNext(), code);
            return (int) actual;
        }
    }

    private static String failureCode(Throwable failure) {
        if (failure instanceof StorageException) return ((StorageException) failure).code.name();
        if (failure instanceof VerificationFailure) return ((VerificationFailure) failure).code;
        if (failure instanceof SQLiteException) return "NATIVE_SQLITE_FAILURE";
        if (failure instanceof java.io.IOException) return "OWNED_IO_FAILURE";
        return "UNEXPECTED_FAILURE";
    }

    private static final class VerificationFailure extends AssertionError {
        final String code;
        VerificationFailure(String code) {
            super(code);
            this.code = code;
        }
    }

    private static ProfileSpec profile(String name) {
        return new ProfileSpec(UUID.randomUUID().toString(), UUID.randomUUID().toString(), name,
                new ProxySpec(ProxySpec.Scheme.HTTP, "fixture-proxy.invalid", 1 + new java.security.SecureRandom().nextInt(65535), false),
                "NZ", "Pacific/Auckland", Collections.singletonList("en-NZ"), ProfileSpec.DeviceMode.NATIVE,
                "owned-synthetic-model", "");
    }

    private void require(boolean condition, String code) {
        if (!condition) throw new VerificationFailure(code);
        checks++;
    }

    private void expect(Bundle result, StorageException.Code code, Runnable action) {
        result.putString("expectedStorageCode", code.name());
        result.remove("observedStorageCode");
        try {
            action.run();
            throw new VerificationFailure("EXPECTED_STORAGE_REJECTION");
        } catch (StorageException observed) {
            result.putString("observedStorageCode", observed.code.name());
            require(observed.code == code, "WRONG_STORAGE_REJECTION");
        }
    }
}
