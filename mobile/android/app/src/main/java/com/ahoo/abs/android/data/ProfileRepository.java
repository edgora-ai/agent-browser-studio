package com.ahoo.abs.android.data;

import android.content.ContentValues;
import android.content.Context;
import android.database.sqlite.SQLiteDatabase;

import com.ahoo.abs.core.ProfileSpec;

import java.security.MessageDigest;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;

public final class ProfileRepository implements AutoCloseable {
    private final StoreDatabase database;
    private final CredentialCipher cipher;

    public ProfileRepository(Context context) {
        this(context, null, false);
    }

    /** Test names must match verification_[A-Za-z0-9_-]{1,64}.sqlite; null is rejected. */
    public ProfileRepository(Context context, String databaseName) {
        this(context, requireTestName(databaseName), false);
    }

    private ProfileRepository(Context context, String name, boolean existingOnly) {
        database = new StoreDatabase(context, name, existingOnly);
        cipher = new CredentialCipher(database.storeId);
    }

    /** Browser-side credential access must not create or reconstruct a missing database. */
    public static ProfileRepository openExisting(Context context) {
        return new ProfileRepository(context, null, true);
    }

    private static String requireTestName(String name) {
        if (name == null) StoreChecks.invalid();
        return name;
    }

    public List<ProfileSpec> listProfiles() {
        return database.read(StoredProfiles::list);
    }

    public ProfileSpec findProfile(String id) {
        StoreChecks.uuid(id);
        return database.read(db -> StoredProfiles.find(db, id));
    }

    /**
     * Insert: expectedRevision=null. Edit: old revision, and replacement.revision is a new UUID.
     * REPLACE generates a fresh credentialRevision; use the returned frozen object.
     * The CredentialUpdate is consumed and zeroed on both success and failure.
     */
    public ProfileSpec saveProfile(ProfileSpec replacement, String expectedRevision,
                                   CredentialUpdate credentialUpdate) {
        if (credentialUpdate == null) StoreChecks.invalid();
        try (CredentialUpdate update = credentialUpdate; Credentials secrets = update.consume()) {
            if (expectedRevision != null) StoreChecks.uuid(expectedRevision);
            ProfileSpec frozen = ProfileCodec.freeze(replacement);
            return database.transaction(db -> save(db, frozen, expectedRevision, update, secrets));
        }
    }

    public ProfileSpec saveProfileKeepingCredentials(ProfileSpec replacement, String expectedRevision) {
        return saveProfile(replacement, expectedRevision, CredentialUpdate.keep());
    }

    /**
     * Compatibility insert only. It cannot safely edit without an expected revision.
     * Empty credential placeholders never clear or replace an existing password.
     */
    public void saveProfile(ProfileSpec profile, String proxyUsername, String proxyPassword) {
        if (profile == null || profile.proxy == null) StoreChecks.invalid();
        if (profile.proxy.hasCredentials) {
            if (proxyPassword == null) {
                throw new StorageException(StorageException.Code.CREDENTIAL_UPDATE_INVALID);
            }
            char[] password = proxyPassword.toCharArray();
            try {
                saveProfile(profile, null, CredentialUpdate.replace(proxyUsername, password));
            } finally {
                Arrays.fill(password, '\0');
            }
        } else {
            if ((proxyUsername != null && !proxyUsername.isEmpty())
                    || (proxyPassword != null && !proxyPassword.isEmpty())) {
                throw new StorageException(StorageException.Code.CREDENTIAL_UPDATE_INVALID);
            }
            saveProfile(profile, null, CredentialUpdate.clear());
        }
    }

    private ProfileSpec save(SQLiteDatabase db, ProfileSpec replacement, String expected,
                             CredentialUpdate update, Credentials secrets) {
        ProfileSpec old = StoredProfiles.find(db, replacement.id);
        StoredProfiles.requireInactive(db, replacement.id);
        if (expected == null ? old != null : old == null || !expected.equals(old.revision)) {
            conflict();
        }
        if (old != null && old.revision.equals(replacement.revision)) conflict();
        if (StoredProfiles.exists(db, "SELECT 1 FROM profile_revisions WHERE revision=?",
                replacement.revision)) conflict();
        if (StoredProfiles.exists(db, "SELECT 1 FROM profiles WHERE name_key=? AND id<>?",
                StoreChecks.nameKey(replacement.name), replacement.id)) {
            throw new StorageException(StorageException.Code.NAME_CONFLICT);
        }
        CredentialCipher.Envelope previous = old == null ? null : StoredProfiles.envelope(db, old);
        ProfileSpec saved = credentialMetadata(replacement, old, update);
        CredentialCipher.Envelope written = previous;
        if (update.kind == CredentialUpdate.Kind.REPLACE) {
            written = cipher.encrypt(db, saved.id, saved.credentialRevision,
                    secrets.username(), secrets.password());
        } else if (update.kind == CredentialUpdate.Kind.CLEAR) {
            written = null;
        }
        if (old == null) {
            if (StoredProfiles.exists(db, "SELECT 1 FROM profile_ids WHERE id=?", saved.id)) {
                throw new StorageException(StorageException.Code.PROFILE_ID_RETIRED);
            }
            ContentValues identity = new ContentValues();
            identity.put("id", saved.id);
            identity.put("directory_suffix", saved.dataDirectorySuffix());
            db.insertOrThrow("profile_ids", null, identity);
        }
        ContentValues revision = new ContentValues();
        revision.put("profile_id", saved.id);
        revision.put("revision", saved.revision);
        db.insertOrThrow("profile_revisions", null, revision);
        if (old == null) {
            db.insertOrThrow("profiles", null, StoredProfiles.values(saved));
        } else if (db.update("profiles", StoredProfiles.values(saved), "id=? AND revision=?",
                new String[]{saved.id, expected}) != 1) {
            conflict();
        }
        if (update.kind == CredentialUpdate.Kind.REPLACE) {
            ContentValues envelope = new ContentValues();
            envelope.put("profile_id", saved.id);
            envelope.put("credential_revision", saved.credentialRevision);
            envelope.put("iv", written.iv);
            envelope.put("ciphertext", written.ciphertext);
            if (previous == null) db.insertOrThrow("credential_envelopes", null, envelope);
            else if (db.update("credential_envelopes", envelope, "profile_id=?",
                    new String[]{saved.id}) != 1) StoredProfiles.integrity();
        } else if (update.kind == CredentialUpdate.Kind.CLEAR) {
            db.delete("credential_envelopes", "profile_id=?", new String[]{saved.id});
        }
        ProfileSpec readback = StoredProfiles.find(db, saved.id);
        if (readback == null) StoredProfiles.integrity();
        StoreChecks.same(ProfileCodec.toJson(saved), ProfileCodec.toJson(readback));
        verifyEnvelope(db, readback, written, update, secrets);
        StoredProfiles.searchReadback(db, readback);
        return readback;
    }

    private static ProfileSpec credentialMetadata(ProfileSpec replacement, ProfileSpec old,
                                                  CredentialUpdate update) {
        if (update.kind == CredentialUpdate.Kind.REPLACE) {
            if (!replacement.proxy.hasCredentials) credentialInvalid();
            return ProfileCodec.freeze(ProfileCodec.withCredentialRevision(
                    replacement, UUID.randomUUID().toString()));
        }
        if (update.kind == CredentialUpdate.Kind.CLEAR) {
            if (replacement.proxy.hasCredentials || !replacement.credentialRevision.isEmpty()) {
                credentialInvalid();
            }
        } else if (old == null) {
            if (replacement.proxy.hasCredentials) credentialInvalid();
        } else if (replacement.proxy.hasCredentials != old.proxy.hasCredentials
                || !replacement.credentialRevision.equals(old.credentialRevision)) {
            credentialInvalid();
        }
        return replacement;
    }

    private void verifyEnvelope(SQLiteDatabase db, ProfileSpec profile,
                                CredentialCipher.Envelope expected, CredentialUpdate update,
                                Credentials secrets) {
        CredentialCipher.Envelope actual = StoredProfiles.envelope(db, profile);
        if (expected == null) {
            if (actual != null) StoredProfiles.integrity();
            return;
        }
        if (actual == null || !MessageDigest.isEqual(expected.iv, actual.iv)
                || !MessageDigest.isEqual(expected.ciphertext, actual.ciphertext)) {
            StoredProfiles.integrity();
        }
        if (update.kind == CredentialUpdate.Kind.REPLACE) {
            try (Credentials readback = cipher.decrypt(db, profile.id,
                    profile.credentialRevision, actual)) {
                if (!Arrays.equals(secrets.username(), readback.username())
                        || !Arrays.equals(secrets.password(), readback.password())) {
                    StoredProfiles.integrity();
                }
            }
        }
    }

    /** No website directories are removed. Deleted IDs/revisions remain retired. */
    public void deleteProfile(String id) {
        StoreChecks.uuid(id);
        database.transaction(db -> {
            StoredProfiles.requireInactive(db, id);
            if (StoredProfiles.find(db, id) == null) {
                throw new StorageException(StorageException.Code.PROFILE_NOT_FOUND);
            }
            if (db.delete("profiles", "id=?", new String[]{id}) != 1) StoredProfiles.integrity();
            if (StoredProfiles.find(db, id) != null || StoredProfiles.exists(db,
                    "SELECT 1 FROM credential_envelopes WHERE profile_id=?", id)) {
                StoredProfiles.integrity();
            }
            return null;
        });
    }

    /** expectedRevision is the profile revision. Returns null only for explicit no-credentials. */
    public Credentials getCredentials(String id, String expectedRevision) {
        StoreChecks.uuid(id);
        StoreChecks.uuid(expectedRevision);
        Credentials[] output = new Credentials[1];
        boolean delivered = false;
        try {
            Credentials result = database.transaction(db -> {
                BootstrapStore.ActiveLaunch active = LaunchRecords.active(db);
                if (active == null || active.state != BootstrapStore.State.CLAIMED
                        || !active.launch.profile.id.equals(id)) {
                    throw new StorageException(StorageException.Code.RUNTIME_IDENTITY_MISMATCH);
                }
                ProcessBinding.require(database.path, database.storeId, active.launch.sessionId,
                        active.incarnationId, active.pid);
                if (!expectedRevision.equals(active.launch.profile.revision)) conflict();
                LaunchRecords.requireCurrentProfile(db, active);
                if (!active.launch.profile.proxy.hasCredentials) return null;
                output[0] = cipher.decrypt(db, id, active.launch.profile.credentialRevision,
                        StoredProfiles.envelope(db, active.launch.profile));
                return output[0];
            });
            delivered = true;
            return result;
        } finally {
            if (!delivered && output[0] != null) output[0].close();
        }
    }

    private static void conflict() {
        throw new StorageException(StorageException.Code.REVISION_CONFLICT);
    }

    private static void credentialInvalid() {
        throw new StorageException(StorageException.Code.CREDENTIAL_UPDATE_INVALID);
    }

    @Override public void close() { database.close(); }
}
