package com.ahoo.abs.android.data;

/** Deliberately contains no submitted values, SQL, provider messages or causes. */
public final class StorageException extends IllegalStateException {
    public enum Code {
        INVALID_ARGUMENT, BACKUP_ENABLED, DEVICE_PROTECTED_STORAGE, DATABASE_MISSING,
        DATABASE_CORRUPT, UNSUPPORTED_SCHEMA, DATABASE_UNAVAILABLE, SCHEMA_ASSET_INVALID,
        PROFILE_INVALID, PROFILE_NOT_FOUND, PROFILE_ID_RETIRED, REVISION_CONFLICT,
        NAME_CONFLICT, PROFILE_ACTIVE, CREDENTIAL_UPDATE_INVALID, CREDENTIAL_UPDATE_CLOSED,
        CREDENTIALS_UNAVAILABLE, CRYPTO_UNAVAILABLE, INTEGRITY_FAILURE, LAUNCH_ACTIVE,
        LAUNCH_NOT_FOUND, LAUNCH_EXPIRED, LAUNCH_REPLAY, RUNTIME_IDENTITY_MISMATCH,
        RUNTIME_PHASE_INVALID, EXIT_EVIDENCE_REQUIRED, CLOSED
    }

    public enum Operation {
        NONE, OPEN_EXISTING, OPEN_HELPER, CONFIGURE, CHECK_WAL, CHECK_VERSION, READ_META,
        READ, TRANSACTION_BEGIN, TRANSACTION_BODY, TRANSACTION_END
    }

    /** Only these literal class labels may cross the storage boundary. */
    public enum NativeExceptionClass {
        NONE("NONE"),
        SQLITE_EXCEPTION("SQLiteException"),
        SQLITE_CONSTRAINT("SQLiteConstraintException"),
        SQLITE_CANT_OPEN("SQLiteCantOpenDatabaseException"),
        SQLITE_DATABASE_LOCKED("SQLiteDatabaseLockedException"),
        SQLITE_TABLE_LOCKED("SQLiteTableLockedException"),
        SQLITE_READ_ONLY("SQLiteReadOnlyDatabaseException"),
        SQLITE_DATABASE_CORRUPT("SQLiteDatabaseCorruptException"),
        SQLITE_DISK_IO("SQLiteDiskIOException"),
        SQLITE_FULL("SQLiteFullException"),
        SQLITE_MISUSE("SQLiteMisuseException"),
        SQLITE_DATATYPE_MISMATCH("SQLiteDatatypeMismatchException"),
        SQLITE_BIND_OR_COLUMN_RANGE("SQLiteBindOrColumnIndexOutOfRangeException"),
        SQLITE_DONE("SQLiteDoneException"),
        SQLITE_BLOB_TOO_BIG("SQLiteBlobTooBigException"),
        SQLITE_OUT_OF_MEMORY("SQLiteOutOfMemoryException"),
        SQLITE_ACCESS_PERM("SQLiteAccessPermException"),
        SQLITE_ABORT("SQLiteAbortException"),
        UNLISTED_RUNTIME("UNLISTED_RUNTIME");

        public final String className;
        NativeExceptionClass(String className) { this.className = className; }

        static NativeExceptionClass classify(RuntimeException failure) {
            String type = failure.getClass().getName();
            for (NativeExceptionClass candidate : values()) {
                if (candidate != NONE && candidate != UNLISTED_RUNTIME
                        && ("android.database.sqlite." + candidate.className).equals(type)) {
                    return candidate;
                }
            }
            return UNLISTED_RUNTIME;
        }
    }

    public final Code code;
    public final Operation operation;
    public final NativeExceptionClass nativeExceptionClass;

    public StorageException(Code code) {
        this(code, Operation.NONE, NativeExceptionClass.NONE);
    }

    private StorageException(Code code, Operation operation, NativeExceptionClass nativeExceptionClass) {
        super("ABS storage: " + code.name());
        this.code = code;
        this.operation = operation;
        this.nativeExceptionClass = nativeExceptionClass;
    }

    /** Classifies transiently; no exception, message, stack, SQL or submitted value is retained. */
    static StorageException databaseFailure(Operation operation, RuntimeException failure) {
        if (failure instanceof StorageException) {
            StorageException observed = (StorageException) failure;
            return observed.operation != Operation.NONE ? observed
                    : new StorageException(observed.code, operation, observed.nativeExceptionClass);
        }
        return new StorageException(Code.DATABASE_UNAVAILABLE, operation,
                NativeExceptionClass.classify(failure));
    }
}
