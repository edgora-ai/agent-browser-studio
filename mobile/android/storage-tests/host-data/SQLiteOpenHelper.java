package android.database.sqlite;
/** Host helper lifecycle double; calls production onCreate/onUpgrade/onDowngrade. */
public abstract class SQLiteOpenHelper implements AutoCloseable {
    private SQLiteDatabase database;
    private final String path;
    private final int version;
    public SQLiteOpenHelper(android.content.Context context, String path, Object factory, int version,
                            android.database.DatabaseErrorHandler handler) { this.path = path; this.version = version; }
    public void setOpenParams(SQLiteDatabase.OpenParams params) { }
    public void setWriteAheadLoggingEnabled(boolean enabled) { }
    public SQLiteDatabase getWritableDatabase() {
        if (database != null) return database;
        database = SQLiteDatabase.openDatabase(new java.io.File(path), new SQLiteDatabase.OpenParams());
        onConfigure(database);
        int old = database.getVersion();
        if (old != version) {
            database.beginTransactionNonExclusive();
            try {
                if (old == 0) onCreate(database);
                else if (old < version) onUpgrade(database, old, version);
                else onDowngrade(database, old, version);
                database.setVersion(version); database.setTransactionSuccessful();
            } finally { database.endTransaction(); }
        }
        return database;
    }
    public void onConfigure(SQLiteDatabase db) { }
    public abstract void onCreate(SQLiteDatabase db);
    public abstract void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion);
    public void onDowngrade(SQLiteDatabase db, int oldVersion, int newVersion) { throw new AssertionError("Downgrade"); }
    public void close() { if (database != null) database.close(); }
}
