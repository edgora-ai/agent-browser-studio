package com.ahoo.abs.android.data;

import android.content.ContentValues;
import android.content.Context;
import android.database.sqlite.SQLiteDatabase;
import android.os.Process;

import com.ahoo.abs.core.LaunchSpec;
import com.ahoo.abs.core.ProfileSpec;

import java.util.UUID;

/** Safe in Application.attachBaseContext: no WebKit, intents, preferences or process control. */
public final class BootstrapStore implements AutoCloseable {
    public enum State { PUBLISHED, CLAIMED, REVOKED, EXIT_UNCONFIRMED, EXIT_CONFIRMED }

    public enum RuntimePhase {
        PUBLISHED(0), CLAIMED(10), DIRECTORY_BOUND(20), PROVIDER_VERIFIED(30),
        PROXY_PENDING(40), PROXY_READY(50), WEBVIEW_CREATED(60), BROWSING(70),
        EXIT_UNCONFIRMED(90), EXIT_CONFIRMED(100);

        final int code;
        RuntimePhase(int code) { this.code = code; }

        static RuntimePhase fromCode(int code) {
            for (RuntimePhase phase : values()) if (phase.code == code) return phase;
            throw new StorageException(StorageException.Code.INTEGRITY_FAILURE);
        }
    }

    public static final class ActiveLaunch {
        public final LaunchSpec launch;
        public final State state;
        public final String incarnationId;
        public final int pid;
        public final String provider;
        public final RuntimePhase phase;

        ActiveLaunch(LaunchSpec launch, State state, String incarnationId, int pid,
                     String provider, RuntimePhase phase) {
            this.launch = launch;
            this.state = state;
            this.incarnationId = incarnationId;
            this.pid = pid;
            this.provider = provider;
            this.phase = phase;
        }
    }

    private final StoreDatabase database;

    /** Opens an existing database without CREATE or SQLiteOpenHelper reconstruction. */
    public BootstrapStore(Context context) {
        database = new StoreDatabase(context, null, true);
    }

    public BootstrapStore(Context context, String verificationDatabaseName) {
        if (verificationDatabaseName == null) StoreChecks.invalid();
        database = new StoreDatabase(context, verificationDatabaseName, true);
    }

    public LaunchSpec publish(String profileId, String expectedRevision, long ttlMillis) {
        StoreChecks.uuid(profileId);
        StoreChecks.uuid(expectedRevision);
        if (ttlMillis < 1 || ttlMillis > 120000) StoreChecks.invalid();
        return database.transaction(db -> {
            if (LaunchRecords.active(db) != null) {
                throw new StorageException(StorageException.Code.LAUNCH_ACTIVE);
            }
            ProfileSpec profile = StoredProfiles.find(db, profileId);
            if (profile == null) throw new StorageException(StorageException.Code.PROFILE_NOT_FOUND);
            if (!profile.revision.equals(expectedRevision)) {
                throw new StorageException(StorageException.Code.REVISION_CONFLICT);
            }
            StoredProfiles.envelope(db, profile);
            long now = System.currentTimeMillis();
            LaunchSpec launch = new LaunchSpec(profile, UUID.randomUUID().toString(),
                    UUID.randomUUID().toString(), now, Math.addExact(now, ttlMillis));
            launch.validateAt(now);
            ContentValues values = new ContentValues();
            values.put("session_id", launch.sessionId);
            values.put("nonce", launch.nonce);
            values.put("profile_id", profile.id);
            values.put("profile_revision", profile.revision);
            values.put("spec_json", ProfileCodec.toJson(profile));
            // This SQL column freezes the profile, not the session-bound launch envelope.
            values.put("config_hash", profile.fingerprint());
            values.put("directory_suffix", launch.directorySuffix());
            values.put("issued_at_ms", launch.issuedAtMillis);
            values.put("expires_at_ms", launch.expiresAtMillis);
            values.put("state", State.PUBLISHED.name());
            values.put("phase", RuntimePhase.PUBLISHED.code);
            db.insertOrThrow("launch_records", null, values);
            ActiveLaunch readback = LaunchRecords.requireActive(db, launch.sessionId);
            if (readback.state != State.PUBLISHED || readback.phase != RuntimePhase.PUBLISHED) {
                StoredProfiles.integrity();
            }
            StoreChecks.same(launch.nonce, readback.launch.nonce);
            StoreChecks.same(launch.configHash(), readback.launch.configHash());
            return readback.launch;
        });
    }

    /** Session and nonce come ONLY from the singleton database row, never from an Intent. */
    public LaunchSpec claim(String incarnationId) {
        StoreChecks.uuid(incarnationId);
        synchronized (ProcessBinding.CLAIM_LOCK) {
            ProcessBinding.requireUnbound();
            LaunchSpec claimed = database.transaction(db -> {
                ActiveLaunch active = LaunchRecords.active(db);
                if (active == null) throw new StorageException(StorageException.Code.LAUNCH_NOT_FOUND);
                if (active.state != State.PUBLISHED) replay();
                long now = System.currentTimeMillis();
                if (now < active.launch.issuedAtMillis || now >= active.launch.expiresAtMillis) {
                    throw new StorageException(StorageException.Code.LAUNCH_EXPIRED);
                }
                active.launch.validateAt(now);
                LaunchRecords.requireCurrentProfile(db, active);
                ContentValues values = new ContentValues();
                values.put("state", State.CLAIMED.name());
                values.put("phase", RuntimePhase.CLAIMED.code);
                values.put("incarnation_id", incarnationId);
                values.put("pid", Process.myPid());
                values.put("consumed_at_ms", now);
                if (db.update("launch_records", values,
                        "session_id=? AND state='PUBLISHED' AND consumed_at_ms IS NULL",
                        new String[]{active.launch.sessionId}) != 1) replay();
                ActiveLaunch readback = LaunchRecords.requireActive(db, active.launch.sessionId);
                if (readback.state != State.CLAIMED || readback.phase != RuntimePhase.CLAIMED
                        || readback.pid != Process.myPid()) StoredProfiles.integrity();
                StoreChecks.same(incarnationId, readback.incarnationId);
                StoreChecks.same(active.launch.nonce, readback.launch.nonce);
                return readback.launch;
            });
            ProcessBinding.install(database.path, database.storeId, claimed.sessionId, incarnationId);
            return claimed;
        }
    }

    public ActiveLaunch readActive() {
        return database.read(LaunchRecords::active);
    }

    public ActiveLaunch findLaunch(String sessionId) {
        StoreChecks.uuid(sessionId);
        return database.read(db -> LaunchRecords.find(db, sessionId));
    }

    /** Records a real completed stage; this method does not perform or certify that stage. */
    public void noteRuntime(String sessionId, String incarnationId, int pid,
                            String provider, RuntimePhase phase) {
        StoreChecks.uuid(sessionId);
        StoreChecks.uuid(incarnationId);
        if (phase == null || phase.code < 10 || phase.code > 70) phaseInvalid();
        ProcessBinding.require(database.path, database.storeId, sessionId, incarnationId, pid);
        validateProvider(provider, phase);
        database.transaction(db -> {
            ActiveLaunch active = LaunchRecords.requireActive(db, sessionId);
            requireIncarnation(active, incarnationId);
            if (active.state != State.CLAIMED || active.pid != pid) identityMismatch();
            if (phase.code < active.phase.code) phaseInvalid();
            if (active.provider != null && !active.provider.equals(provider)) identityMismatch();
            LaunchRecords.requireCurrentProfile(db, active);
            ContentValues values = new ContentValues();
            values.put("phase", phase.code);
            if (provider == null) values.putNull("provider");
            else values.put("provider", provider);
            update(db, active, values);
            ActiveLaunch readback = LaunchRecords.requireActive(db, sessionId);
            if (readback.phase != phase || readback.pid != pid) StoredProfiles.integrity();
            StoreChecks.same(provider, readback.provider);
            return null;
        });
    }

    /** Atomically retain a stop across a concurrent PUBLISHED-to-CLAIMED transition. */
    public ActiveLaunch requestStop(String sessionId) {
        StoreChecks.uuid(sessionId);
        return database.transaction(db -> {
            ActiveLaunch active = LaunchRecords.requireActive(db, sessionId);
            State stopped = active.state == State.PUBLISHED ? State.REVOKED : State.EXIT_UNCONFIRMED;
            transition(db, active, stopped, RuntimePhase.EXIT_UNCONFIRMED);
            return LaunchRecords.requireActive(db, sessionId);
        });
    }

    /** Unclaimed tickets only. Revocation still holds the singleton lease. */
    public void revoke(String sessionId) {
        StoreChecks.uuid(sessionId);
        database.transaction(db -> {
            ActiveLaunch active = LaunchRecords.requireActive(db, sessionId);
            if (active.state == State.REVOKED && active.incarnationId == null) return null;
            if (active.state != State.PUBLISHED || active.incarnationId != null) replay();
            transition(db, active, State.REVOKED, RuntimePhase.EXIT_UNCONFIRMED);
            return null;
        });
    }

    /** A failure/stop request is NOT evidence of death and never releases the lease. */
    public void markExitUnconfirmed(String sessionId, String incarnationId) {
        StoreChecks.uuid(sessionId);
        if (incarnationId != null) StoreChecks.uuid(incarnationId);
        database.transaction(db -> {
            ActiveLaunch active = LaunchRecords.requireActive(db, sessionId);
            requireIncarnation(active, incarnationId);
            transition(db, active, State.EXIT_UNCONFIRMED, RuntimePhase.EXIT_UNCONFIRMED);
            return null;
        });
    }

    /**
     * Trusted main-controller evidence submission only: it MUST first verify actual death
     * and that the independent noBackupFilesDir lifetime lock is free. This data store
     * cannot observe that proof and never infers it from TTL, PID age, a callback or a flag.
     * The browser process cannot confirm its own exit. Keep controller calls off Intents.
     */
    public void recordConfirmedExit(String sessionId, String incarnationId) {
        StoreChecks.uuid(sessionId);
        if (incarnationId != null) StoreChecks.uuid(incarnationId);
        database.transaction(db -> {
            ActiveLaunch active = LaunchRecords.requireActive(db, sessionId);
            requireIncarnation(active, incarnationId);
            if (active.state != State.REVOKED && active.state != State.EXIT_UNCONFIRMED) {
                throw new StorageException(StorageException.Code.EXIT_EVIDENCE_REQUIRED);
            }
            if (active.pid == Process.myPid()
                    || ProcessBinding.isCurrentRuntime(database.path, sessionId)) {
                throw new StorageException(StorageException.Code.EXIT_EVIDENCE_REQUIRED);
            }
            transition(db, active, State.EXIT_CONFIRMED, RuntimePhase.EXIT_CONFIRMED);
            if (LaunchRecords.active(db) != null) StoredProfiles.integrity();
            return null;
        });
    }

    private static void transition(SQLiteDatabase db, ActiveLaunch active,
                                   State state, RuntimePhase phase) {
        ContentValues values = new ContentValues();
        values.put("state", state.name());
        values.put("phase", phase.code);
        update(db, active, values);
        ActiveLaunch readback = LaunchRecords.find(db, active.launch.sessionId);
        if (readback == null || readback.state != state || readback.phase != phase) {
            StoredProfiles.integrity();
        }
        StoreChecks.same(active.incarnationId, readback.incarnationId);
        if (readback.pid != active.pid) StoredProfiles.integrity();
    }

    private static void update(SQLiteDatabase db, ActiveLaunch active, ContentValues values) {
        if (db.update("launch_records", values, "session_id=? AND state=?",
                new String[]{active.launch.sessionId, active.state.name()}) != 1) replay();
    }

    private static void requireIncarnation(ActiveLaunch active, String incarnation) {
        if (active.incarnationId == null ? incarnation != null
                : !active.incarnationId.equals(incarnation)) identityMismatch();
    }

    private static void validateProvider(String provider, RuntimePhase phase) {
        if (provider == null) {
            if (phase.code >= RuntimePhase.PROVIDER_VERIFIED.code) phaseInvalid();
            return;
        }
        if (provider.trim().isEmpty() || provider.length() > 240) phaseInvalid();
        for (int i = 0; i < provider.length(); i++) {
            char c = provider.charAt(i);
            if (c < 32 || c > 126) phaseInvalid();
        }
    }

    private static void replay() { throw new StorageException(StorageException.Code.LAUNCH_REPLAY); }
    private static void phaseInvalid() {
        throw new StorageException(StorageException.Code.RUNTIME_PHASE_INVALID);
    }
    private static void identityMismatch() {
        throw new StorageException(StorageException.Code.RUNTIME_IDENTITY_MISMATCH);
    }

    @Override public void close() { database.close(); }
}
