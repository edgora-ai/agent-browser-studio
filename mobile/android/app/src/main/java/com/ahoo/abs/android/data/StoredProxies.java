package com.ahoo.abs.android.data;

import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import com.ahoo.abs.core.ProfileSpec;
import com.ahoo.abs.core.ProxySpec;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** All methods run under the owning StoreDatabase transaction/read boundary. */
final class StoredProxies {
    private static final String SELECT = "SELECT id,revision,name,scheme,host,port FROM proxy_catalog";
    private StoredProxies() { }

    static ManagedProxy find(SQLiteDatabase db, String id) {
        try (Cursor cursor = db.rawQuery(SELECT + " WHERE id=?", new String[]{id})) {
            return cursor.moveToFirst() ? decode(cursor) : null;
        }
    }

    static List<ManagedProxy> list(SQLiteDatabase db) {
        List<ManagedProxy> result = new ArrayList<>();
        try (Cursor cursor = db.rawQuery(SELECT + " ORDER BY name_key,id", null)) {
            while (cursor.moveToNext()) result.add(decode(cursor));
        }
        return result;
    }

    static ManagedProxy endpoint(SQLiteDatabase db, ProxySpec proxy) {
        try (Cursor cursor = db.rawQuery(SELECT + " WHERE scheme=? AND host=? COLLATE NOCASE AND port=?",
                new String[]{proxy.scheme.name(), proxy.host, Integer.toString(proxy.port)})) {
            return cursor.moveToFirst() ? decode(cursor) : null;
        }
    }

    private static ManagedProxy decode(Cursor cursor) {
        try {
            return new ManagedProxy(cursor.getString(0), cursor.getString(1), cursor.getString(2),
                    new ProxySpec(ProxySpec.Scheme.valueOf(cursor.getString(3)),
                            cursor.getString(4), cursor.getInt(5), false));
        } catch (RuntimeException invalid) {
            throw new StorageException(StorageException.Code.INTEGRITY_FAILURE);
        }
    }

    static ContentValues values(ManagedProxy proxy) {
        ContentValues values = new ContentValues();
        values.put("id", proxy.id);
        values.put("revision", proxy.revision);
        values.put("name", proxy.name);
        values.put("name_key", StoreChecks.nameKey(proxy.name));
        values.put("scheme", proxy.proxy.scheme.name());
        values.put("host", proxy.proxy.host);
        values.put("port", proxy.proxy.port);
        return values;
    }

    static boolean sameEndpoint(ProxySpec first, ProxySpec second) {
        return first.scheme == second.scheme && first.host.equalsIgnoreCase(second.host)
                && first.port == second.port && first.hasCredentials == second.hasCredentials;
    }

    static String association(SQLiteDatabase db, String profileId) {
        try (Cursor cursor = db.rawQuery("SELECT proxy_id FROM profile_proxy_links WHERE profile_id=?",
                new String[]{profileId})) {
            return cursor.moveToFirst() ? cursor.getString(0) : null;
        }
    }

    static int usage(SQLiteDatabase db, String proxyId) {
        try (Cursor cursor = db.rawQuery("SELECT count(*) FROM profile_proxy_links WHERE proxy_id=?",
                new String[]{proxyId})) {
            if (!cursor.moveToFirst()) throw StoredProfiles.integrity();
            return cursor.getInt(0);
        }
    }

    static List<ProfileSpec> linkedProfiles(SQLiteDatabase db, String proxyId) {
        List<ProfileSpec> result = new ArrayList<>();
        try (Cursor cursor = db.rawQuery("SELECT profile_id FROM profile_proxy_links WHERE proxy_id=? ORDER BY profile_id",
                new String[]{proxyId})) {
            while (cursor.moveToNext()) {
                ProfileSpec profile = StoredProfiles.find(db, cursor.getString(0));
                if (profile == null || profile.proxy.hasCredentials) throw StoredProfiles.integrity();
                result.add(profile);
            }
        }
        return result;
    }

    /** Import only metadata: never rewrites existing profile revisions, launch snapshots or paths. */
    static void importLegacy(SQLiteDatabase db) {
        for (ProfileSpec profile : StoredProfiles.list(db)) syncAssociation(db, profile);
    }

    /** Also keeps legacy repository callers' inline edits and the catalog consistent atomically. */
    static void syncAssociation(SQLiteDatabase db, ProfileSpec profile) {
        if (profile.proxy.hasCredentials) {
            db.delete("profile_proxy_links", "profile_id=?", new String[]{profile.id});
            return;
        }
        ManagedProxy endpoint = endpoint(db, profile.proxy);
        if (endpoint == null) {
            String id = UUID.randomUUID().toString();
            String host = profile.proxy.authority();
            if (host.length() > 48) host = host.substring(0, 45) + "…";
            String name = profile.proxy.scheme.name() + " · " + host;
            if (StoredProfiles.exists(db, "SELECT 1 FROM proxy_catalog WHERE name_key=?", StoreChecks.nameKey(name))) {
                name += " · " + id.substring(0, 8);
            }
            endpoint = new ManagedProxy(id, UUID.randomUUID().toString(), name, profile.proxy);
            db.insertOrThrow("proxy_catalog", null, values(endpoint));
        }
        bind(db, profile.id, endpoint.id);
    }

    static void bind(SQLiteDatabase db, String profileId, String proxyId) {
        if (proxyId.equals(association(db, profileId))) return;
        ContentValues values = new ContentValues();
        values.put("profile_id", profileId);
        values.put("proxy_id", proxyId);
        if (db.update("profile_proxy_links", values, "profile_id=?", new String[]{profileId}) == 0) {
            db.insertOrThrow("profile_proxy_links", null, values);
        }
    }
}
