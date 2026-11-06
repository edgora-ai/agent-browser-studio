"""JDK17 source/host-double regression only; never Android SQLite/KeyStore/build/device evidence.

Pass a fresh absolute output directory; all generated sources/classes remain below it.
The doubles only inject begin/mark/end failures and expose monitor/codec contracts.
Unexercised SQL, JSON and KeyStore APIs fail closed instead of supplying a fake backend.
"""
from pathlib import Path
import re
import subprocess
import sys

ANDROID = Path(__file__).resolve().parents[4]
JDK = Path("/opt/homebrew/opt/openjdk@17/bin")

STUBS = {
    "android/content/pm/ApplicationInfo.java": """package android.content.pm;
public class ApplicationInfo { public static final int FLAG_ALLOW_BACKUP = 32768; public int flags; }""",
    "android/content/Context.java": """package android.content;
public class Context {
 public android.content.pm.ApplicationInfo getApplicationInfo() { return new android.content.pm.ApplicationInfo(); }
 public boolean isDeviceProtectedStorage() { return false; }
 public java.io.File getNoBackupFilesDir() { return new java.io.File("/synthetic/no-backup"); }
}""",
    "android/content/ContentValues.java": """package android.content;
public class ContentValues {
 public void put(String key, String value) { throw new AssertionError("SQL not exercised"); }
 public void put(String key, Integer value) { throw new AssertionError("SQL not exercised"); }
 public void put(String key, Long value) { throw new AssertionError("SQL not exercised"); }
 public void put(String key, byte[] value) { throw new AssertionError("SQL not exercised"); }
 public void putNull(String key) { throw new AssertionError("SQL not exercised"); }
}""",
    "android/database/DatabaseErrorHandler.java": """package android.database;
public interface DatabaseErrorHandler { void onCorruption(android.database.sqlite.SQLiteDatabase db); }""",
    "android/database/Cursor.java": """package android.database;
public interface Cursor extends AutoCloseable {
 int FIELD_TYPE_INTEGER = 1;
 boolean moveToFirst(); boolean moveToNext(); int getColumnCount(); int getType(int index);
 long getLong(int index); int getInt(int index); String getString(int index); byte[] getBlob(int index);
 boolean isNull(int index); void close();
}""",
    "android/database/sqlite/SQLiteException.java": """package android.database.sqlite;
public class SQLiteException extends RuntimeException { public SQLiteException(String message) { super(message); } }""",
    "android/database/sqlite/SQLiteConstraintException.java": """package android.database.sqlite;
public class SQLiteConstraintException extends SQLiteException { public SQLiteConstraintException(String message) { super(message); } }""",
    "android/database/sqlite/SQLiteDatabaseLockedException.java": """package android.database.sqlite;
public class SQLiteDatabaseLockedException extends SQLiteException { public SQLiteDatabaseLockedException(String message) { super(message); } }""",
    "android/database/sqlite/SQLiteDatabase.java": """package android.database.sqlite;
import android.database.Cursor;
public class SQLiteDatabase {
 public static final int OPEN_READWRITE = 0, NO_LOCALIZED_COLLATORS = 16, ENABLE_WRITE_AHEAD_LOGGING = 32;
 public static final String JOURNAL_MODE_WAL = "WAL", SYNC_MODE_FULL = "FULL";
 public static SQLiteDatabase nextDatabase;
 public final java.util.List<String> events = new java.util.ArrayList<>();
 public SQLiteException beginFailure, successFailure, endFailure;
 public boolean emptyCursor;
 public void beginTransactionNonExclusive() { events.add("begin"); if (beginFailure != null) throw beginFailure; }
 public void setTransactionSuccessful() { events.add("success"); if (successFailure != null) throw successFailure; }
 public void endTransaction() { events.add("end"); if (endFailure != null) throw endFailure; }
 public void close() { events.add("close"); }
 public int getVersion() { return 2; }
 public boolean isWriteAheadLoggingEnabled() { return true; }
 public void setForeignKeyConstraintsEnabled(boolean enabled) { throw new AssertionError("SQL not exercised"); }
 public void execSQL(String sql) { throw new AssertionError("SQL not exercised"); }
 public long insertOrThrow(String table, String nulls, android.content.ContentValues values) { throw new AssertionError("SQL not exercised"); }
 public int update(String table, android.content.ContentValues values, String where, String[] args) { throw new AssertionError("SQL not exercised"); }
 public int delete(String table, String where, String[] args) { throw new AssertionError("SQL not exercised"); }
 public Cursor rawQuery(String sql, String[] args) {
  boolean empty = emptyCursor;
  if (!empty && !"SELECT store_id FROM store_meta WHERE singleton=1".equals(sql)) throw new AssertionError("SQL not exercised");
  return new Cursor() {
   public boolean moveToFirst() { return !empty; } public boolean moveToNext() { return false; }
   public int getColumnCount() { return 1; } public int getType(int index) { return FIELD_TYPE_INTEGER; }
   public long getLong(int index) { throw new AssertionError("SQL not exercised"); }
   public int getInt(int index) { throw new AssertionError("SQL not exercised"); }
   public String getString(int index) { return "0123456789abcdef0123456789abcdef"; }
   public byte[] getBlob(int index) { throw new AssertionError("SQL not exercised"); }
   public boolean isNull(int index) { throw new AssertionError("SQL not exercised"); }
   public void close() { }
  };
 }
 public static SQLiteDatabase openDatabase(java.io.File file, OpenParams params) { throw new AssertionError("Real files not exercised"); }
 public static class OpenParams {
  public static class Builder {
   public Builder setOpenFlags(int flags) { return this; }
   public Builder setErrorHandler(android.database.DatabaseErrorHandler handler) { return this; }
   public Builder setJournalMode(String mode) { return this; }
   public Builder setSynchronousMode(String mode) { return this; }
   public OpenParams build() { return new OpenParams(); }
  }
 }
}""",
    "android/database/sqlite/SQLiteOpenHelper.java": """package android.database.sqlite;
public abstract class SQLiteOpenHelper implements AutoCloseable {
 private final SQLiteDatabase database = SQLiteDatabase.nextDatabase;
 public SQLiteOpenHelper(android.content.Context context, String path, Object factory, int version, android.database.DatabaseErrorHandler handler) { }
 public void setOpenParams(SQLiteDatabase.OpenParams params) { }
 public void setWriteAheadLoggingEnabled(boolean enabled) { }
 public SQLiteDatabase getWritableDatabase() { return database; }
 public void close() { database.close(); }
 public abstract void onConfigure(SQLiteDatabase db); public abstract void onCreate(SQLiteDatabase db);
 public abstract void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion);
 public abstract void onDowngrade(SQLiteDatabase db, int oldVersion, int newVersion);
}""",
    "android/os/Process.java": """package android.os;
public final class Process { private Process() {} public static int myPid() { throw new AssertionError("Android process not exercised"); } }""",
    "android/security/keystore/KeyProperties.java": """package android.security.keystore;
public final class KeyProperties {
 private KeyProperties() { }
 public static final String KEY_ALGORITHM_AES = "AES", BLOCK_MODE_GCM = "GCM", ENCRYPTION_PADDING_NONE = "NoPadding";
 public static final int PURPOSE_ENCRYPT = 1, PURPOSE_DECRYPT = 2;
}""",
    "android/security/keystore/KeyGenParameterSpec.java": """package android.security.keystore;
public class KeyGenParameterSpec implements java.security.spec.AlgorithmParameterSpec {
 public static class Builder {
  public Builder(String alias, int purposes) { throw new AssertionError("KeyStore must not run in host tests"); }
  public Builder setKeySize(int size) { return this; } public Builder setBlockModes(String... modes) { return this; }
  public Builder setEncryptionPaddings(String... paddings) { return this; }
  public Builder setRandomizedEncryptionRequired(boolean required) { return this; }
  public KeyGenParameterSpec build() { throw new AssertionError("KeyStore must not run in host tests"); }
 }
}""",
    "com/ahoo/abs/android/data/SchemaLoader.java": """package com.ahoo.abs.android.data;
final class SchemaLoader {
 static void create(android.content.Context context, android.database.sqlite.SQLiteDatabase db) { throw new AssertionError("Schema not exercised"); }
 static void upgradeProxyCatalog(android.content.Context context, android.database.sqlite.SQLiteDatabase db) { throw new AssertionError("Schema not exercised"); }
}""",
    "com/ahoo/abs/android/data/ProfileCodec.java": """package com.ahoo.abs.android.data;
import com.ahoo.abs.core.ProfileSpec;
final class ProfileCodec {
 static String toJson(ProfileSpec profile) { throw new AssertionError("JSON not exercised"); }
 static ProfileSpec fromJson(String encoded) { throw new AssertionError("JSON not exercised"); }
 static ProfileSpec freeze(ProfileSpec profile) { throw new AssertionError("JSON not exercised"); }
 static ProfileSpec withCredentialRevision(ProfileSpec profile, String revision) { throw new AssertionError("JSON not exercised"); }
}""",
}


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Pass a fresh absolute output directory")
    output = Path(sys.argv[1])
    if not output.is_absolute() or ".." in output.parts:
        raise SystemExit("Absolute non-traversing output required")
    for ancestor in [output, *output.parents]:
        if ancestor.is_symlink():
            raise SystemExit("No symlink output paths")
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    data = ANDROID / "app/src/main/java/com/ahoo/abs/android/data"
    sources = []
    for name, text in STUBS.items():
        target = output / "host-doubles" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text + "\n")
        sources.append(target)
    production = ["StoreDatabase", "StorageException", "StoreChecks", "StoredProfiles", "Credentials",
                  "CredentialCipher", "ManagedProxy", "StoredProxies", "BootstrapStore", "LaunchRecords",
                  "ProfileRepository", "CredentialUpdate", "ProcessBinding"]
    sources += [data / (name + ".java") for name in production]
    core = ["ValidationException", "CoreValidation", "CanonicalHash", "HostSyntax", "ProxySpec", "ProfileSpec", "LaunchSpec"]
    sources += [ANDROID / ("core/src/main/java/com/ahoo/abs/core/" + name + ".java") for name in core]
    sources.append(Path(__file__).with_name("StorageCleanupContractTest.java"))
    # Verify every caller in the expanded data scope explicitly throws the exception factory.
    for path in [data / (name + ".java") for name in production]:
        for line in path.read_text().splitlines():
            for helper in ("StoreChecks.invalid()", "StoredProfiles.integrity()"):
                if helper + ";" in line and "throw " + helper + ";" not in line:
                    raise AssertionError("Exception factory ignored in " + path.name)
    proxy = (ANDROID / "app/src/main/java/com/ahoo/abs/android/ProxyEditor.java").read_text()
    assert ".ordinal()" not in proxy and not re.search(r"Scheme[.]values[(][)][ ]*\[", proxy)
    assert "ProxySpec.Scheme.HTTP, ProxySpec.Scheme.HTTPS, ProxySpec.Scheme.SOCKS5" in proxy
    # Explicit casts only, one per deliberate consumer: live paste parse, exit probe,
    # save, and the explicit parse-and-fill button.
    assert proxy.count("(ProxySpec.Scheme) protocol.getSelectedItem()") == 4
    geo = (ANDROID / "app/src/main/java/com/ahoo/abs/android/ProxyGeoProbe.java").read_text()
    assert geo.count('@SuppressWarnings("UseNetworkAnnotations")') == 1
    assert "new URL(ENDPOINT).openConnection(proxy)" in geo and "ChromiumNetworkAdapter" in geo
    assert '@DoNotCall' not in "\n".join(path.read_text() for path in [data / "StoreChecks.java", data / "StoredProfiles.java"])
    coordinator = (ANDROID / "app/src/main/java/com/ahoo/abs/android/process/LaunchCoordinator.java").read_text()
    assert "public static LaunchCoordinator get(Context context) {\n        synchronized (LaunchCoordinator.class) {" in coordinator
    assert '"LOCAL_STORAGE_CONFIRMED_COOKIE_ACK").contains(cookie) ? cookie : "UNKNOWN"' in coordinator
    assert "回执不等于磁盘 fsync 或 IDB/全部存储完整性" in coordinator
    assert "仅进入能力验证模式" not in coordinator
    for name in ("Credentials", "StoreDatabase"):
        assert not re.search(r"public\s+(?:static\s+)?synchronized\b", (data / (name + ".java")).read_text())
    classes = output / "classes"
    classes.mkdir()
    # Default javac host invocation only: no product compiler/analyzer flags are changed.
    subprocess.run([str(JDK / "javac"), "-d", str(classes), *map(str, sources)], check=True)
    subprocess.run([str(JDK / "java"), "-ea", "-cp", str(classes), "com.ahoo.abs.android.data.StorageCleanupContractTest"], check=True)
    print("Static helper/proxy/network source guards passed")
    print("Boundary: host doubles only; Android SQLite/KeyStore/encryption/Gradle/device NOT run")


if __name__ == "__main__":
    main()
