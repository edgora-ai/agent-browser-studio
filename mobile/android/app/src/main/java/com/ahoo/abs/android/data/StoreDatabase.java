package com.ahoo.abs.android.data;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.database.Cursor;
import android.database.DatabaseErrorHandler;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteException;
import android.database.sqlite.SQLiteOpenHelper;
import com.ahoo.abs.android.data.StorageException.Operation;

import java.io.File;

/** Database transactions and the controller's process-lifetime file lock are independent. */
final class StoreDatabase implements AutoCloseable {
    static final String DEFAULT_NAME = "abs_profiles_v1.sqlite";
    private static final int VERSION = 1;
    private static final DatabaseErrorHandler FAIL_CORRUPTION = db -> {
        throw new StorageException(StorageException.Code.DATABASE_CORRUPT);
    };

    interface Work<T> { T run(SQLiteDatabase db); }

    final String path;
    final String storeId;
    private final SQLiteDatabase db;
    private final Helper helper;
    private boolean closed;

    StoreDatabase(Context context, String verificationName, boolean existingOnly) {
        if (context == null) StoreChecks.invalid();
        if ((context.getApplicationInfo().flags & ApplicationInfo.FLAG_ALLOW_BACKUP) != 0) {
            throw new StorageException(StorageException.Code.BACKUP_ENABLED);
        }
        if (context.isDeviceProtectedStorage()) {
            throw new StorageException(StorageException.Code.DEVICE_PROTECTED_STORAGE);
        }
        String name = DEFAULT_NAME;
        if (verificationName != null) {
            if (!verificationName.matches("verification_[A-Za-z0-9_-]{1,64}\\.sqlite")) {
                StoreChecks.invalid();
            }
            name = verificationName;
        }
        File directory = context.getNoBackupFilesDir();
        if (directory == null) unavailable();
        File file = new File(directory, name);
        path = file.getAbsolutePath();
        Helper openedHelper = null;
        SQLiteDatabase opened = null;
        Operation operation = existingOnly ? Operation.OPEN_EXISTING : Operation.OPEN_HELPER;
        try {
            if (existingOnly) {
                if (!file.isFile()) {
                    throw new StorageException(StorageException.Code.DATABASE_MISSING);
                }
                SQLiteDatabase.OpenParams params = new SQLiteDatabase.OpenParams.Builder()
                        .setOpenFlags(SQLiteDatabase.OPEN_READWRITE
                                | SQLiteDatabase.NO_LOCALIZED_COLLATORS
                                | SQLiteDatabase.ENABLE_WRITE_AHEAD_LOGGING)
                        .setErrorHandler(FAIL_CORRUPTION)
                        .setJournalMode(SQLiteDatabase.JOURNAL_MODE_WAL).setSynchronousMode(SQLiteDatabase.SYNC_MODE_FULL).build();
                opened = SQLiteDatabase.openDatabase(file, params);
                operation = Operation.CONFIGURE;
                configure(opened);
                operation = Operation.CHECK_WAL;
                if (!opened.isWriteAheadLoggingEnabled()) unavailable();
            } else {
                openedHelper = new Helper(context, path);
                openedHelper.setWriteAheadLoggingEnabled(true);
                opened = openedHelper.getWritableDatabase();
            }
            operation = Operation.CHECK_VERSION;
            if (opened.getVersion() != VERSION) {
                throw new StorageException(StorageException.Code.UNSUPPORTED_SCHEMA);
            }
            operation = Operation.CHECK_WAL;
            if (!opened.isWriteAheadLoggingEnabled()) unavailable();
            operation = Operation.READ_META;
            try (Cursor cursor = opened.rawQuery(
                    "SELECT store_id FROM store_meta WHERE singleton=1", null)) {
                if (!cursor.moveToFirst()) integrity();
                storeId = cursor.getString(0);
                if (storeId == null || !storeId.matches("[0-9a-f]{32}") || cursor.moveToNext()) {
                    integrity();
                }
            }
            db = opened;
            helper = openedHelper;
        } catch (RuntimeException exception) {
            if (openedHelper != null) openedHelper.close();
            else if (opened != null) opened.close();
            throw StorageException.databaseFailure(operation, exception);
        }
    }

    synchronized <T> T read(Work<T> work) {
        requireOpen();
        try {
            return work.run(db);
        } catch (SQLiteException exception) {
            throw StorageException.databaseFailure(Operation.READ, exception);
        }
    }

    synchronized <T> T transaction(Work<T> work) {
        requireOpen();
        try {
            db.beginTransactionNonExclusive();
            try {
                T result = work.run(db);
                db.setTransactionSuccessful();
                return result;
            } catch (SQLiteException exception) {
                throw StorageException.databaseFailure(Operation.TRANSACTION_BODY, exception);
            } finally {
                try {
                    db.endTransaction();
                } catch (SQLiteException exception) {
                    throw StorageException.databaseFailure(Operation.TRANSACTION_END, exception);
                }
            }
        } catch (SQLiteException exception) {
            throw StorageException.databaseFailure(Operation.TRANSACTION_BEGIN, exception);
        }
    }

    private void requireOpen() {
        if (closed) throw new StorageException(StorageException.Code.CLOSED);
    }

    @Override
    public synchronized void close() {
        if (!closed) {
            if (helper != null) helper.close();
            else db.close();
            closed = true;
        }
    }

    private static void configure(SQLiteDatabase db) {
        try {
            db.setForeignKeyConstraintsEnabled(true);
            requirePragmaInteger(db, "PRAGMA secure_delete=ON", 1);
            requirePragmaInteger(db, "PRAGMA secure_delete", 1);
            requirePragmaInteger(db, "PRAGMA busy_timeout=5000", 5000);
            requirePragmaInteger(db, "PRAGMA busy_timeout", 5000);
            db.execSQL("PRAGMA synchronous=FULL");
        } catch (RuntimeException exception) {
            throw StorageException.databaseFailure(Operation.CONFIGURE, exception);
        }
    }

    private static void requirePragmaInteger(SQLiteDatabase db, String sql, long expected) {
        try (Cursor cursor = db.rawQuery(sql, null)) {
            if (!cursor.moveToFirst() || cursor.getColumnCount() != 1
                    || cursor.getType(0) != Cursor.FIELD_TYPE_INTEGER
                    || cursor.getLong(0) != expected || cursor.moveToNext()) {
                unavailable();
            }
        }
    }

    private static void unavailable() {
        throw new StorageException(StorageException.Code.DATABASE_UNAVAILABLE);
    }

    private static void integrity() {
        throw new StorageException(StorageException.Code.INTEGRITY_FAILURE);
    }

    private static final class Helper extends SQLiteOpenHelper {
        private final Context context;

        Helper(Context context, String path) {
            super(context, path, null, VERSION, FAIL_CORRUPTION);
            this.context = context;
            setOpenParams(new SQLiteDatabase.OpenParams.Builder()
                    .setOpenFlags(SQLiteDatabase.OPEN_READWRITE
                            | SQLiteDatabase.NO_LOCALIZED_COLLATORS
                                | SQLiteDatabase.ENABLE_WRITE_AHEAD_LOGGING)
                    .setErrorHandler(FAIL_CORRUPTION)
                    .setJournalMode(SQLiteDatabase.JOURNAL_MODE_WAL).setSynchronousMode(SQLiteDatabase.SYNC_MODE_FULL).build());
        }

        @Override public void onConfigure(SQLiteDatabase db) { configure(db); }
        @Override public void onCreate(SQLiteDatabase db) { SchemaLoader.create(context, db); }

        @Override
        public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
            throw new StorageException(StorageException.Code.UNSUPPORTED_SCHEMA);
        }

        @Override
        public void onDowngrade(SQLiteDatabase db, int oldVersion, int newVersion) {
            throw new StorageException(StorageException.Code.UNSUPPORTED_SCHEMA);
        }
    }
}
