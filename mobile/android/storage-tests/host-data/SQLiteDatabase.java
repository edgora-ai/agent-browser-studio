package android.database.sqlite;

import android.content.ContentValues;
import android.database.Cursor;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Host API adapter: SQL runs on Python SQLite over local child stdin/stdout; no socket/server. */
public final class SQLiteDatabase {
    public static final int OPEN_READWRITE = 0, NO_LOCALIZED_COLLATORS = 16, ENABLE_WRITE_AHEAD_LOGGING = 32;
    public static final String JOURNAL_MODE_WAL = "WAL", SYNC_MODE_FULL = "FULL";
    private final java.lang.Process process;
    private final BufferedReader input;
    private final PrintWriter output;
    private boolean successful;
    private boolean closed;
    private SQLiteDatabase(File file) {
        try {
            process = new ProcessBuilder("python3", "-B", System.getProperty("host.bridge"), file.getAbsolutePath())
                    .redirectError(ProcessBuilder.Redirect.INHERIT).start();
            input = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8));
            output = new PrintWriter(new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8), true);
        } catch (IOException exception) { throw new AssertionError(exception); }
    }
    public static SQLiteDatabase openDatabase(File file, OpenParams params) { return new SQLiteDatabase(file); }
    public void beginTransactionNonExclusive() { execSQL("BEGIN IMMEDIATE"); successful = false; }
    public void setTransactionSuccessful() { successful = true; }
    public void endTransaction() { execSQL(successful ? "COMMIT" : "ROLLBACK"); successful = false; }
    public int getVersion() { try (Cursor c = rawQuery("PRAGMA user_version", null)) { c.moveToFirst(); return c.getInt(0); } }
    public void setVersion(int value) { execSQL("PRAGMA user_version=" + value); }
    public boolean isWriteAheadLoggingEnabled() {
        try (Cursor c = rawQuery("PRAGMA journal_mode", null)) { c.moveToFirst(); return "wal".equals(c.getString(0)); }
    }
    public void setForeignKeyConstraintsEnabled(boolean enabled) { execSQL("PRAGMA foreign_keys=" + (enabled ? "ON" : "OFF")); }
    public void execSQL(String sql) { request(sql, Collections.emptyList()); }
    public long insertOrThrow(String table, String nullColumn, ContentValues values) {
        String columns = String.join(",", values.values.keySet());
        String placeholders = String.join(",", Collections.nCopies(values.values.size(), "?"));
        return request("INSERT INTO " + table + "(" + columns + ") VALUES (" + placeholders + ")", new ArrayList<>(values.values.values())).lastId;
    }
    public int update(String table, ContentValues values, String where, String[] args) {
        List<String> columns = new ArrayList<>();
        for (String key : values.values.keySet()) columns.add(key + "=?");
        List<Object> bindings = new ArrayList<>(values.values.values());
        if (args != null) bindings.addAll(Arrays.asList(args));
        return request("UPDATE " + table + " SET " + String.join(",", columns) + " WHERE " + where, bindings).changed;
    }
    public int delete(String table, String where, String[] args) {
        return request("DELETE FROM " + table + " WHERE " + where,
                args == null ? Collections.emptyList() : new ArrayList<>(Arrays.asList(args))).changed;
    }
    public Cursor rawQuery(String sql, String[] args) {
        Result result = request(sql, args == null ? Collections.emptyList() : new ArrayList<>(Arrays.asList(args)));
        return new Rows(result.rows, result.columns);
    }
    private static String encode(Object value) {
        if (value == null) return "n";
        if (value instanceof Number) return "i" + value;
        if (value instanceof byte[]) return "b" + Base64.getEncoder().encodeToString((byte[]) value);
        return "s" + Base64.getEncoder().encodeToString(value.toString().getBytes(StandardCharsets.UTF_8));
    }
    private static Object decode(String value) {
        switch (value.charAt(0)) {
            case 'n': return null;
            case 'i': return Long.valueOf(value.substring(1));
            case 'b': return Base64.getDecoder().decode(value.substring(1));
            case 's': return new String(Base64.getDecoder().decode(value.substring(1)), StandardCharsets.UTF_8);
            default: throw new AssertionError("Unknown bridge value");
        }
    }
    private synchronized Result request(String sql, List<Object> args) {
        if (closed) throw new AssertionError("Closed host database");
        StringBuilder line = new StringBuilder("Q\t").append(Base64.getEncoder().encodeToString(sql.getBytes(StandardCharsets.UTF_8)));
        for (Object value : args) line.append('\t').append(encode(value));
        output.println(line);
        try {
            String response = input.readLine();
            if (response == null) throw new AssertionError("SQLite child terminated");
            String[] fields = response.split("\t");
            if (fields[0].equals("E")) {
                if (fields[1].equals("CONSTRAINT")) throw new SQLiteConstraintException("Synthetic SQL constraint");
                throw new SQLiteException("Synthetic SQL error");
            }
            Result result = new Result();
            result.lastId = Long.parseLong(fields[1]); result.changed = Integer.parseInt(fields[2]);
            result.columns = Integer.parseInt(fields[3]); int count = Integer.parseInt(fields[4]);
            for (int i = 0; i < count; i++) {
                String[] encoded = input.readLine().split("\t", -1);
                Object[] row = new Object[encoded.length];
                for (int j = 0; j < row.length; j++) row[j] = decode(encoded[j]);
                result.rows.add(row);
            }
            return result;
        } catch (IOException exception) { throw new AssertionError(exception); }
    }
    public void close() {
        if (closed) return;
        output.println("C"); output.close(); closed = true;
        try {
            input.close();
            if (!process.waitFor(10, java.util.concurrent.TimeUnit.SECONDS) || process.exitValue() != 0)
                throw new AssertionError("SQLite child did not close cleanly");
        } catch (IOException | InterruptedException exception) { throw new AssertionError(exception); }
    }
    private static final class Result {
        long lastId; int changed; int columns;
        final List<Object[]> rows = new ArrayList<>();
    }
    private static final class Rows implements Cursor {
        private final List<Object[]> rows; private final int columns; private int index = -1;
        Rows(List<Object[]> rows, int columns) { this.rows = rows; this.columns = columns; }
        public boolean moveToFirst() { index = 0; return !rows.isEmpty(); }
        public boolean moveToNext() { return ++index < rows.size(); }
        public int getColumnCount() { return columns; }
        public int getType(int column) { Object v = rows.get(index)[column]; return v == null ? 0 : v instanceof Number ? 1 : v instanceof byte[] ? 4 : 3; }
        public long getLong(int column) { return ((Number) rows.get(index)[column]).longValue(); }
        public int getInt(int column) { return (int) getLong(column); }
        public String getString(int column) { return (String) rows.get(index)[column]; }
        public byte[] getBlob(int column) { return (byte[]) rows.get(index)[column]; }
        public boolean isNull(int column) { return rows.get(index)[column] == null; }
        public void close() { }
    }
    public static final class OpenParams {
        public static final class Builder {
            public Builder setOpenFlags(int flags) { return this; }
            public Builder setErrorHandler(android.database.DatabaseErrorHandler handler) { return this; }
            public Builder setJournalMode(String mode) { return this; }
            public Builder setSynchronousMode(String mode) { return this; }
            public OpenParams build() { return new OpenParams(); }
        }
    }
}
