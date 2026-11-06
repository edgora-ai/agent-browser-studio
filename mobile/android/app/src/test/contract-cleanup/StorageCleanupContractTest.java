package com.ahoo.abs.android.data;

import android.content.Context;
import android.database.sqlite.SQLiteConstraintException;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteDatabaseLockedException;
import android.database.sqlite.SQLiteException;
import com.ahoo.abs.core.ProfileSpec;
import com.ahoo.abs.core.ProxySpec;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.locks.LockSupport;

/** Standalone host-double regression, NOT Android SQLite, KeyStore, encryption or durability evidence. */
public final class StorageCleanupContractTest {
    private static int checks;
    private StorageCleanupContractTest() {}

    public static void main(String[] args) throws Exception {
        boolean enabled = false;
        assert enabled = true;
        check(enabled, "Assertions required");
        transactions();
        integrityAndInvalidArguments();
        credentialOwnership();
        credentialCodecAndWiping();
        System.out.println("StorageCleanupContractTest: " + checks + " checks passed");
    }

    private static StoreDatabase store(SQLiteDatabase db) {
        SQLiteDatabase.nextDatabase = db;
        return new StoreDatabase(new Context(), "verification_contract.sqlite", false);
    }

    private static void transactions() throws Exception {
        SQLiteDatabase db = new SQLiteDatabase();
        StoreDatabase store = store(db);
        check(store.transaction(database -> { check(Thread.holdsLock(store), "Body escaped original monitor"); return 7; }) == 7, "Result changed");
        check(db.events.equals(Arrays.asList("begin", "success", "end")), "Successful transaction ordering changed");
        blockedOn(store, () -> store.read(database -> null));
        blockedOn(store, () -> store.transaction(database -> null));
        db.events.clear();
        db.beginFailure = new SQLiteDatabaseLockedException("synthetic-unretained-provider-detail");
        StorageException begin = expectStorage(() -> store.transaction(database -> { throw new AssertionError("Body ran after failed begin"); }));
        sanitized(begin, StorageException.Operation.TRANSACTION_BEGIN, StorageException.NativeExceptionClass.SQLITE_DATABASE_LOCKED);
        check(db.events.equals(Arrays.asList("begin")), "Failed begin must not end a transaction");
        db.beginFailure = null;
        db.events.clear();
        StorageException primary = new StorageException(StorageException.Code.INTEGRITY_FAILURE);
        check(expectStorage(() -> store.transaction(database -> { throw primary; })) == primary, "Primary application failure changed identity");
        check(db.events.equals(Arrays.asList("begin", "end")), "Failed body incorrectly marked success");
        db.events.clear();
        db.endFailure = new SQLiteException("synthetic-unretained-end-detail");
        StorageException body = expectStorage(() -> store.transaction(database -> { throw new SQLiteConstraintException("synthetic-unretained-body-detail"); }));
        sanitized(body, StorageException.Operation.TRANSACTION_BODY, StorageException.NativeExceptionClass.SQLITE_CONSTRAINT);
        suppressedEnd(body);
        StorageException exact = new StorageException(StorageException.Code.REVISION_CONFLICT);
        check(expectStorage(() -> store.transaction(database -> { throw exact; })) == exact, "End failure masked original StorageException");
        suppressedEnd(exact);
        AssertionError error = new AssertionError("synthetic-failure");
        try { store.transaction(database -> { throw error; }); throw new AssertionError("Expected primary Error"); }
        catch (AssertionError observed) { check(observed == error, "End failure masked primary Error"); suppressedEnd(observed); }
        StorageException end = expectStorage(() -> store.transaction(database -> 9));
        sanitized(end, StorageException.Operation.TRANSACTION_END, StorageException.NativeExceptionClass.SQLITE_EXCEPTION);
        check(end.getSuppressed().length == 0, "End-only failure was incorrectly suppressed");
        db.successFailure = new SQLiteException("synthetic-unretained-mark-detail");
        StorageException mark = expectStorage(() -> store.transaction(database -> 9));
        sanitized(mark, StorageException.Operation.TRANSACTION_BODY, StorageException.NativeExceptionClass.SQLITE_EXCEPTION);
        suppressedEnd(mark);
        db.successFailure = null;
        db.endFailure = null;
        blockedOn(store, store::close);
        int priorEvents = db.events.size();
        check(expectStorage(() -> store.transaction(database -> null)).code == StorageException.Code.CLOSED, "Closed transaction accepted");
        check(expectStorage(() -> store.read(database -> null)).code == StorageException.Code.CLOSED, "Closed read accepted");
        store.close();
        check(db.events.size() == priorEvents, "Closed store touched database");
    }

    private static void suppressedEnd(Throwable primary) {
        Throwable[] suppressed = primary.getSuppressed();
        check(suppressed.length == 1 && suppressed[0] instanceof StorageException, "Missing sanitized end suppression");
        sanitized((StorageException) suppressed[0], StorageException.Operation.TRANSACTION_END, StorageException.NativeExceptionClass.SQLITE_EXCEPTION);
    }

    private static void sanitized(StorageException failure, StorageException.Operation operation, StorageException.NativeExceptionClass type) {
        check(failure.code == StorageException.Code.DATABASE_UNAVAILABLE, "Database failure code changed");
        check(failure.operation == operation && failure.nativeExceptionClass == type, "Operation/class attribution changed");
        check(failure.getCause() == null && "ABS storage: DATABASE_UNAVAILABLE".equals(failure.getMessage()), "Raw provider detail retained");
    }

    private static void integrityAndInvalidArguments() {
        check(StoreChecks.invalid().code == StorageException.Code.INVALID_ARGUMENT, "Invalid helper changed code");
        check(StoredProfiles.integrity().code == StorageException.Code.INTEGRITY_FAILURE, "Integrity helper changed code");
        for (String value : new String[] {null, "", "not-a-uuid"}) {
            check(expectStorage(() -> StoreChecks.uuid(value)).code == StorageException.Code.INVALID_ARGUMENT, "UUID guard fell through");
        }
        check(expectStorage(() -> StoreChecks.nameKey(null)).code == StorageException.Code.INVALID_ARGUMENT, "Name guard fell through");
        String uuid = "12345678-1234-4234-8234-123456789abc";
        check(expectStorage(() -> new ManagedProxy(uuid, uuid, null, null)).code == StorageException.Code.INVALID_ARGUMENT, "Managed proxy guard fell through");
        check(expectStorage(() -> new BootstrapStore(new Context(), null)).code == StorageException.Code.INVALID_ARGUMENT, "Bootstrap name guard fell through");
        check(expectStorage(() -> new StoreDatabase(null, null, false)).code == StorageException.Code.INVALID_ARGUMENT, "Database context guard fell through");
        SQLiteDatabase db = new SQLiteDatabase();
        SQLiteDatabase.nextDatabase = db;
        try (ProfileRepository repository = new ProfileRepository(new Context())) {
            check(expectStorage(() -> repository.saveProxy(null, null)).code == StorageException.Code.INVALID_ARGUMENT, "Repository proxy guard fell through");
            check(expectStorage(() -> repository.saveProfile(null, null, (CredentialUpdate) null)).code == StorageException.Code.INVALID_ARGUMENT, "Repository credential guard fell through");
        }
        db.emptyCursor = true;
        check(expectStorage(() -> StoredProxies.usage(db, uuid)).code == StorageException.Code.INTEGRITY_FAILURE, "Missing count row accepted");
        ProfileSpec profile = new ProfileSpec(uuid, uuid, "Synthetic", new ProxySpec(ProxySpec.Scheme.HTTP,
                "proxy.invalid", 8080, true), "US", "UTC", Arrays.asList("en-US"), ProfileSpec.DeviceMode.NATIVE, "", uuid);
        check(expectStorage(() -> StoredProfiles.envelope(db, profile)).code == StorageException.Code.INTEGRITY_FAILURE, "Missing credential envelope accepted");
    }

    private static void credentialOwnership() throws Exception {
        char[] user = {'u', 's', 'e', 'r'};
        char[] pass = {'t', 'e', 's', 't'};
        Credentials credentials = new Credentials(user, pass);
        blockedOn(credentials, credentials::username);
        blockedOn(credentials, credentials::password);
        check(credentials.username() == user && credentials.password() == pass, "Owned buffers were copied or replaced");
        blockedOn(credentials, credentials::close);
        check(Arrays.equals(user, new char[4]) && Arrays.equals(pass, new char[4]), "Close did not wipe both buffers");
        credentials.close();
        check(expectStorage(credentials::username).code == StorageException.Code.CLOSED, "Closed username exposed");
        check(expectStorage(credentials::password).code == StorageException.Code.CLOSED, "Closed password exposed");
        check("Credentials[redacted]".equals(credentials.toString()), "Credential string was not redacted");
    }

    private static void credentialCodecAndWiping() throws Exception {
        Method wipe = method("wipe", ByteBuffer.class);
        wipe.invoke(null, new Object[]{null});
        ByteBuffer heap = ByteBuffer.allocate(8);
        Arrays.fill(heap.array(), (byte) 7);
        heap.position(2).limit(3);
        wipe.invoke(null, heap);
        check(Arrays.equals(heap.array(), new byte[8]), "Wipe ignored bytes outside position/limit");
        byte[] backing = new byte[12];
        Arrays.fill(backing, (byte) 7);
        ByteBuffer parent = ByteBuffer.wrap(backing);
        parent.position(2).limit(9);
        ByteBuffer slice = parent.slice();
        slice.position(1).limit(3);
        wipe.invoke(null, slice);
        for (int i = 0; i < backing.length; i++) check(backing[i] == (i >= 2 && i < 9 ? 0 : 7), "Slice wipe ignored array offset/capacity");
        wipe.invoke(null, ByteBuffer.allocateDirect(8));
        wipe.invoke(null, ByteBuffer.wrap(new byte[8]).asReadOnlyBuffer());
        Method encode = method("encode", char[].class, char[].class);
        Method decode = method("decode", byte[].class);
        char[] user = {'u', '\u00e9'};
        char[] pass = {'p', '\ud83d', '\ude00'};
        byte[] encoded = (byte[]) encode.invoke(null, user, pass);
        try (Credentials decoded = (Credentials) decode.invoke(null, encoded)) {
            check(Arrays.equals(user, decoded.username()) && Arrays.equals(pass, decoded.password()), "Strict UTF-8 codec changed");
        }
        for (byte[] invalid : new byte[][] {new byte[0], ByteBuffer.allocate(14).putInt(2).array(),
                ByteBuffer.allocate(14).putInt(1).putInt(-1).array(),
                ByteBuffer.allocate(14).putInt(1).putInt(20000).array(),
                ByteBuffer.allocate(14).putInt(1).putInt(1).put((byte) 0xff).array(),
                Arrays.copyOf(encoded, encoded.length + 1)}) {
            check(reflectedFailure(decode, (Object) invalid).code == StorageException.Code.CREDENTIALS_UNAVAILABLE, "Invalid credential envelope accepted");
        }
        check(reflectedFailure(encode, new char[]{'\ud800'}, new char[]{'p'}).code == StorageException.Code.CREDENTIAL_UPDATE_INVALID, "Malformed UTF-16 accepted");
        Arrays.fill(encoded, (byte) 0);
        Arrays.fill(user, '\0');
        Arrays.fill(pass, '\0');
    }

    private static Method method(String name, Class<?>... types) throws Exception {
        Method result = CredentialCipher.class.getDeclaredMethod(name, types);
        result.setAccessible(true);
        return result;
    }

    private static StorageException reflectedFailure(Method method, Object... args) throws Exception {
        try { method.invoke(null, args); throw new AssertionError("Expected codec rejection"); }
        catch (InvocationTargetException failure) {
            check(failure.getCause() instanceof StorageException, "Unexpected codec failure");
            return (StorageException) failure.getCause();
        }
    }

    private static StorageException expectStorage(Runnable action) {
        try { action.run(); throw new AssertionError("Expected storage rejection"); }
        catch (StorageException failure) { checks++; return failure; }
    }

    private static void blockedOn(Object monitor, Runnable action) throws Exception {
        CountDownLatch entered = new CountDownLatch(1);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread worker = new Thread(() -> {
            entered.countDown();
            try { action.run(); } catch (Throwable observed) { failure.set(observed); }
        }, "storage-monitor-regression");
        worker.setDaemon(true);
        synchronized (monitor) {
            worker.start();
            check(entered.await(5, TimeUnit.SECONDS), "Worker did not enter");
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (worker.isAlive() && worker.getState() != Thread.State.BLOCKED && System.nanoTime() < deadline) LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(1));
            check(worker.getState() == Thread.State.BLOCKED, "Method escaped original monitor");
        }
        worker.join(5000);
        check(!worker.isAlive(), "Worker did not finish");
        if (failure.get() != null) throw new AssertionError("Worker failed", failure.get());
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
        checks++;
    }
}
