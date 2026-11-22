package com.ahoo.abs.android.webapp;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.DatabaseUtils;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.os.SystemClock;
import com.ahoo.abs.core.LaunchSpec;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** Small, private cross-process registry, separate from the rollback-sensitive profile database. */
public final class WebAppRegistry extends SQLiteOpenHelper implements AutoCloseable {
    private static final int LIMIT = 128;
    private static final long HANDOFF_MILLIS = 30_000;
    private static final String[] APP_COLUMNS = {
            "shortcut_id", "profile_id", "manifest_id", "name", "start_url", "scope", "origin"
    };

    public WebAppRegistry(Context context) {
        super(context.getApplicationContext(),
                new File(context.getNoBackupFilesDir(), "web-apps-v1.db").getAbsolutePath(), null, 1);
    }

    @Override public void onConfigure(SQLiteDatabase db) { db.setForeignKeyConstraintsEnabled(true); }

    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE apps (shortcut_id TEXT PRIMARY KEY NOT NULL, profile_id TEXT NOT NULL, "
                + "manifest_id TEXT NOT NULL, name TEXT NOT NULL, start_url TEXT NOT NULL, "
                + "scope TEXT NOT NULL, origin TEXT NOT NULL, UNIQUE(profile_id, manifest_id))");
        db.execSQL("CREATE TABLE handoff (slot INTEGER PRIMARY KEY CHECK(slot=1), token TEXT NOT NULL, "
                + "shortcut_id TEXT NOT NULL REFERENCES apps(shortcut_id) ON DELETE CASCADE, "
                + "session TEXT NOT NULL, revision TEXT NOT NULL, incarnation TEXT NOT NULL, "
                + "pid INTEGER NOT NULL, deadline INTEGER NOT NULL)");
    }

    @Override public void onUpgrade(SQLiteDatabase db, int from, int to) {
        throw new IllegalStateException("WEB_APP_STORAGE_VERSION");
    }

    public WebApp get(String shortcutId) {
        return WebApp.isOpaqueId(shortcutId) ? find(getReadableDatabase(), "shortcut_id=?", shortcutId) : null;
    }

    public List<WebApp> list() {
        List<WebApp> result = new ArrayList<>();
        try (Cursor rows = getReadableDatabase().query("apps", APP_COLUMNS, null, null, null, null,
                "name COLLATE NOCASE, shortcut_id", Integer.toString(LIMIT))) {
            while (rows.moveToNext()) result.add(readApp(rows));
        }
        return result;
    }

    /** After consent only; reinstallation keeps the desktop entry and profile-local identity. */
    public WebApp register(String profile, String id, String name, String start, String scope, String origin) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            WebApp prior = find(db, "profile_id=? AND manifest_id=?", profile, id);
            if (prior == null && DatabaseUtils.queryNumEntries(db, "apps") >= LIMIT) {
                throw new IllegalStateException("WEB_APP_REGISTRY_FULL");
            }
            WebApp app = new WebApp(prior == null ? newId() : prior.shortcutId, profile, id, name, start, scope, origin);
            if (!app.sameInstall(prior)) {
                ContentValues row = new ContentValues();
                row.put("shortcut_id", app.shortcutId);
                row.put("profile_id", app.profileId);
                row.put("manifest_id", app.manifestId);
                row.put("name", app.name);
                row.put("start_url", app.startUrl);
                row.put("scope", app.scope);
                row.put("origin", app.origin);
                if (prior == null) {
                    db.insertOrThrow("apps", null, row);
                } else {
                    db.delete("handoff", "shortcut_id=?", new String[]{app.shortcutId});
                    if (db.update("apps", row, "shortcut_id=?", new String[]{app.shortcutId}) != 1) {
                        throw new IllegalStateException("WEB_APP_RECORD_CHANGED");
                    }
                }
            }
            db.setTransactionSuccessful();
            return app;
        } finally { db.endTransaction(); }
    }

    public void remove(String shortcutId) {
        if (WebApp.isOpaqueId(shortcutId)) {
            getWritableDatabase().delete("apps", "shortcut_id=?", new String[]{shortcutId});
        }
    }

    /** Only the coordinator calls this, after validating the current process's HELLO. No URLs travel in Intents. */
    public String issue(WebApp requested, LaunchSpec launch, String incarnation, int pid) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            WebApp stored = find(db, "shortcut_id=?", requested.shortcutId);
            if (!requested.sameInstall(stored) || !launch.profile.id.equals(stored.profileId)
                    || incarnation == null || pid <= 0) throw new IllegalStateException("WEB_APP_NOT_CURRENT");
            String token = newId();
            ContentValues row = new ContentValues();
            row.put("slot", 1);
            row.put("token", token);
            row.put("shortcut_id", stored.shortcutId);
            row.put("session", launch.sessionId);
            row.put("revision", launch.profile.revision);
            row.put("incarnation", incarnation);
            row.put("pid", pid);
            row.put("deadline", SystemClock.elapsedRealtime() + HANDOFF_MILLIS);
            db.replaceOrThrow("handoff", null, row);
            db.setTransactionSuccessful();
            return token;
        } finally { db.endTransaction(); }
    }

    public void revokeTicket(String token) {
        if (WebApp.isOpaqueId(token)) {
            getWritableDatabase().delete("handoff", "slot=1 AND token=?", new String[]{token});
        }
    }

    /** Early admission only: a replay must not displace a different queued delivery. */
    public boolean canQueue(String token, LaunchSpec launch, String incarnation, int pid) {
        return WebApp.isOpaqueId(token) && incarnation != null && pid > 0
                && pendingShortcut(getReadableDatabase(), token, launch, incarnation, pid) != null;
    }

    /** Verify and burn atomically; only this second check authorizes opening a URL. */
    public WebApp take(String token, LaunchSpec launch, String incarnation, int pid) {
        if (!WebApp.isOpaqueId(token) || incarnation == null || pid <= 0) return null;
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            String shortcutId = pendingShortcut(db, token, launch, incarnation, pid);
            WebApp result = shortcutId == null ? null : find(db, "shortcut_id=?", shortcutId);
            db.delete("handoff", "slot=1 AND token=?", new String[]{token});
            db.setTransactionSuccessful();
            return result != null && launch.profile.id.equals(result.profileId) ? result : null;
        } finally { db.endTransaction(); }
    }

    private static String pendingShortcut(SQLiteDatabase db, String token, LaunchSpec launch,
            String incarnation, int pid) {
        try (Cursor row = db.query("handoff", new String[]{"shortcut_id", "deadline"},
                "slot=1 AND token=? AND session=? AND revision=? AND incarnation=? AND pid=?",
                new String[]{token, launch.sessionId, launch.profile.revision, incarnation, Integer.toString(pid)},
                null, null, null)) {
            if (!row.moveToFirst()) return null;
            long ttl = row.getLong(1) - SystemClock.elapsedRealtime();
            return ttl > 0 && ttl <= HANDOFF_MILLIS ? row.getString(0) : null;
        }
    }

    private static WebApp find(SQLiteDatabase db, String where, String... params) {
        try (Cursor row = db.query("apps", APP_COLUMNS, where, params, null, null, null)) {
            return row.moveToFirst() ? readApp(row) : null;
        }
    }

    private static WebApp readApp(Cursor row) {
        return new WebApp(row.getString(0), row.getString(1), row.getString(2), row.getString(3),
                row.getString(4), row.getString(5), row.getString(6));
    }

    private static String newId() { return UUID.randomUUID().toString(); }
}
