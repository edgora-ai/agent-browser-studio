package com.ahoo.abs.android.data;

import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

import com.ahoo.abs.core.ProfileSpec;

import java.util.ArrayList;
import java.util.List;

final class StoredProfiles {
    private static final String SELECT = "SELECT id,revision,name,name_key,has_credentials,"
            + "credential_revision,spec_json,config_hash,directory_suffix FROM profiles";

    private StoredProfiles() {}

    static ProfileSpec find(SQLiteDatabase db, String id) {
        try (Cursor cursor = db.rawQuery(SELECT + " WHERE id=?", new String[]{id})) {
            if (!cursor.moveToFirst()) return null;
            ProfileSpec profile = decode(cursor);
            if (cursor.moveToNext()) integrity();
            return profile;
        }
    }

    static List<ProfileSpec> list(SQLiteDatabase db) {
        List<ProfileSpec> result = new ArrayList<>();
        try (Cursor cursor = db.rawQuery(SELECT + " ORDER BY name_key,id", null)) {
            while (cursor.moveToNext()) result.add(decode(cursor));
        }
        return result;
    }

    private static ProfileSpec decode(Cursor cursor) {
        ProfileSpec profile = ProfileCodec.fromJson(cursor.getString(6));
        StoreChecks.same(cursor.getString(0), profile.id);
        StoreChecks.same(cursor.getString(1), profile.revision);
        StoreChecks.same(cursor.getString(2), profile.name);
        StoreChecks.same(cursor.getString(3), StoreChecks.nameKey(profile.name));
        if (cursor.getInt(4) != (profile.proxy.hasCredentials ? 1 : 0)) integrity();
        StoreChecks.same(cursor.isNull(5) ? "" : cursor.getString(5), profile.credentialRevision);
        StoreChecks.same(cursor.getString(7), profile.fingerprint());
        StoreChecks.same(cursor.getString(8), profile.dataDirectorySuffix());
        StoreChecks.same(cursor.getString(6), ProfileCodec.toJson(profile));
        return profile;
    }

    static ContentValues values(ProfileSpec profile) {
        ContentValues values = new ContentValues();
        values.put("id", profile.id);
        values.put("revision", profile.revision);
        values.put("name", profile.name);
        values.put("name_key", StoreChecks.nameKey(profile.name));
        values.put("has_credentials", profile.proxy.hasCredentials ? 1 : 0);
        if (profile.proxy.hasCredentials) values.put("credential_revision", profile.credentialRevision);
        else values.putNull("credential_revision");
        values.put("spec_json", ProfileCodec.toJson(profile));
        values.put("config_hash", profile.fingerprint());
        values.put("directory_suffix", profile.dataDirectorySuffix());
        return values;
    }

    static void requireInactive(SQLiteDatabase db, String id) {
        if (exists(db, "SELECT 1 FROM launch_records WHERE profile_id=? "
                + "AND state<>'EXIT_CONFIRMED' LIMIT 1", id)) {
            throw new StorageException(StorageException.Code.PROFILE_ACTIVE);
        }
    }

    static boolean exists(SQLiteDatabase db, String sql, String... arguments) {
        try (Cursor cursor = db.rawQuery(sql, arguments)) {
            return cursor.moveToFirst();
        }
    }

    static CredentialCipher.Envelope envelope(SQLiteDatabase db, ProfileSpec profile) {
        try (Cursor cursor = db.rawQuery("SELECT credential_revision,iv,ciphertext "
                + "FROM credential_envelopes WHERE profile_id=?", new String[]{profile.id})) {
            if (!cursor.moveToFirst()) {
                if (profile.proxy.hasCredentials) integrity();
                return null;
            }
            if (!profile.proxy.hasCredentials) integrity();
            StoreChecks.same(profile.credentialRevision, cursor.getString(0));
            CredentialCipher.Envelope result = new CredentialCipher.Envelope(
                    cursor.getBlob(1), cursor.getBlob(2));
            if (cursor.moveToNext()) integrity();
            return result;
        }
    }

    static void searchReadback(SQLiteDatabase db, ProfileSpec profile) {
        try (Cursor cursor = db.rawQuery("SELECT id FROM profiles "
                + "WHERE id=? AND revision=? AND name_key=?", new String[]{profile.id,
                profile.revision, StoreChecks.nameKey(profile.name)})) {
            if (!cursor.moveToFirst() || !profile.id.equals(cursor.getString(0))
                    || cursor.moveToNext()) integrity();
        }
    }

    static void integrity() {
        throw new StorageException(StorageException.Code.INTEGRITY_FAILURE);
    }
}
