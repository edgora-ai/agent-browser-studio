package com.ahoo.abs.android.data;

import android.content.Context;
import android.database.sqlite.SQLiteDatabase;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

final class SchemaLoader {
    private SchemaLoader() {}

    static void create(Context context, SQLiteDatabase db) {
        load(context, db, false);
    }

    static void upgradeProxyCatalog(Context context, SQLiteDatabase db) {
        if (load(context, db, true) != 2) invalid();
    }

    private static int load(Context context, SQLiteDatabase db, boolean proxyOnly) {
        int executed = 0;
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                context.getAssets().open("profile-schema.sql"), StandardCharsets.UTF_8))) {
            StringBuilder statement = new StringBuilder();
            boolean started = false;
            int size = 0;
            String line;
            while ((line = reader.readLine()) != null) {
                size += line.length();
                if (size > 1024 * 1024) invalid();
                if (line.equals("-- @statement")) {
                    if (started) executed += execute(db, statement, proxyOnly);
                    statement.setLength(0);
                    started = true;
                } else if (started) {
                    statement.append(line).append('\n');
                } else if (!line.trim().isEmpty() && !line.startsWith("--")) {
                    invalid();
                }
            }
            if (!started) invalid();
            executed += execute(db, statement, proxyOnly);
            return executed;
        } catch (IOException exception) {
            throw new StorageException(StorageException.Code.SCHEMA_ASSET_INVALID);
        }
    }

    private static int execute(SQLiteDatabase db, StringBuilder statement, boolean proxyOnly) {
        String sql = statement.toString().trim();
        if (sql.isEmpty() || !sql.endsWith(";")) invalid();
        if (proxyOnly && !sql.startsWith("CREATE TABLE proxy_catalog (")
                && !sql.startsWith("CREATE TABLE profile_proxy_links (")) return 0;
        db.execSQL(sql);
        return 1;
    }

    private static void invalid() {
        throw new StorageException(StorageException.Code.SCHEMA_ASSET_INVALID);
    }
}
