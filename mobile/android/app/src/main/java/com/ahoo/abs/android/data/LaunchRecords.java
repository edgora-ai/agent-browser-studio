package com.ahoo.abs.android.data;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

import com.ahoo.abs.core.LaunchSpec;
import com.ahoo.abs.core.ProfileSpec;

final class LaunchRecords {
    private static final String SELECT = "SELECT session_id,nonce,profile_id,profile_revision,"
            + "spec_json,config_hash,directory_suffix,issued_at_ms,expires_at_ms,state,"
            + "incarnation_id,pid,provider,phase FROM launch_records";

    private LaunchRecords() {}

    static BootstrapStore.ActiveLaunch active(SQLiteDatabase db) {
        try (Cursor cursor = db.rawQuery(SELECT + " WHERE state<>'EXIT_CONFIRMED'", null)) {
            if (!cursor.moveToFirst()) return null;
            BootstrapStore.ActiveLaunch result = decode(cursor);
            if (cursor.moveToNext()) StoredProfiles.integrity();
            return result;
        }
    }

    static BootstrapStore.ActiveLaunch find(SQLiteDatabase db, String sessionId) {
        try (Cursor cursor = db.rawQuery(SELECT + " WHERE session_id=?", new String[]{sessionId})) {
            if (!cursor.moveToFirst()) return null;
            BootstrapStore.ActiveLaunch result = decode(cursor);
            if (cursor.moveToNext()) StoredProfiles.integrity();
            return result;
        }
    }

    static BootstrapStore.ActiveLaunch requireActive(SQLiteDatabase db, String sessionId) {
        BootstrapStore.ActiveLaunch active = active(db);
        if (active == null || !active.launch.sessionId.equals(sessionId)) {
            throw new StorageException(StorageException.Code.LAUNCH_NOT_FOUND);
        }
        return active;
    }

    static void requireCurrentProfile(SQLiteDatabase db, BootstrapStore.ActiveLaunch active) {
        ProfileSpec current = StoredProfiles.find(db, active.launch.profile.id);
        if (current == null) StoredProfiles.integrity();
        StoreChecks.same(active.launch.profile.revision, current.revision);
        StoreChecks.same(active.launch.profile.fingerprint(), current.fingerprint());
        StoreChecks.same(ProfileCodec.toJson(active.launch.profile), ProfileCodec.toJson(current));
    }

    private static BootstrapStore.ActiveLaunch decode(Cursor cursor) {
        try {
            ProfileSpec profile = ProfileCodec.fromJson(cursor.getString(4));
            StoreChecks.same(cursor.getString(2), profile.id);
            StoreChecks.same(cursor.getString(3), profile.revision);
            StoreChecks.same(cursor.getString(4), ProfileCodec.toJson(profile));
            LaunchSpec launch = new LaunchSpec(profile, StoreChecks.uuid(cursor.getString(0)),
                    StoreChecks.uuid(cursor.getString(1)), cursor.getLong(7), cursor.getLong(8));
            // LaunchSpec separately reconstructs the nonce/time-bound envelope hash.
            StoreChecks.same(cursor.getString(5), profile.fingerprint());
            StoreChecks.same(cursor.getString(6), launch.directorySuffix());
            String incarnation = cursor.isNull(10) ? null : StoreChecks.uuid(cursor.getString(10));
            int pid = cursor.isNull(11) ? 0 : cursor.getInt(11);
            return new BootstrapStore.ActiveLaunch(launch,
                    BootstrapStore.State.valueOf(cursor.getString(9)), incarnation, pid,
                    cursor.isNull(12) ? null : cursor.getString(12),
                    BootstrapStore.RuntimePhase.fromCode(cursor.getInt(13)));
        } catch (RuntimeException exception) {
            throw new StorageException(StorageException.Code.INTEGRITY_FAILURE);
        }
    }
}
