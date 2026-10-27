package com.ahoo.abs.android.verification;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.ComponentName;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.ApplicationInfo;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.Binder;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.os.Parcel;
import android.os.Process;
import android.os.RemoteException;
import android.system.Os;
import com.ahoo.abs.android.browser.ControlProtocol;
import com.ahoo.abs.android.data.BootstrapStore;
import com.ahoo.abs.android.data.CredentialUpdate;
import com.ahoo.abs.android.data.ProfileRepository;
import com.ahoo.abs.android.data.StorageException;
import com.ahoo.abs.android.process.LaunchCoordinator;
import com.ahoo.abs.core.LaunchReplayGuard;
import com.ahoo.abs.core.LaunchSpec;
import com.ahoo.abs.core.ProfileSpec;
import com.ahoo.abs.core.ProxySpec;
import com.ahoo.abs.core.RuntimeStateMachine;
import java.io.File;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.file.LinkOption;
import java.nio.file.StandardOpenOption;
import java.util.Collections;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Exercises the real coordinator with native SQLite and Messenger. Only fresh scoped fixtures
 * are opened; service/activity requests are intercepted, and no browser or process is started.
 * Reflection is confined to this test APK: production exposes no test-only control endpoint.
 */
public final class LifecycleInstrumentation extends Instrumentation {
    private String scope;
    private String selected;
    private File root;
    private Bundle result;
    private int passed;
    private int failed;
    private int checks;

    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        scope = arguments == null ? null : arguments.getString("ownedScope");
        selected = arguments == null ? "all" : arguments.getString("lifecycleCase", "all");
        start();
    }

    @Override public void onStart() {
        result = new Bundle();
        try {
            Context target = getTargetContext();
            require((target.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0, "NOT_DEBUG_TARGET");
            require("com.ahoo.abs.android.preview.debug".equals(target.getPackageName()), "WRONG_TARGET");
            require(scope != null && UUID.fromString(scope).toString().equals(scope), "OWNED_SCOPE_REQUIRED");
            root = new File(target.getNoBackupFilesDir(), "lifecycle_verification_" + scope);
            require(!root.exists() && root.mkdir(), "REFUSE_EXISTING_FIXTURE_ROOT");
            Os.chmod(root.getAbsolutePath(), 0700);
            runCase("drain_send_failure_status", h -> {
                h.hello();
                h.endpoint.failDrains = 1;
                h.stop();
                require(h.endpoint.drainAttempts == 1 && h.endpoint.drainsDelivered == 0, "DRAIN_FAULT_NOT_EXERCISED");
                require(!h.coordinator.status().contains("已请求退出"), "DRAIN_SEND_FAILURE_MASKED_BY_SUCCESS_STATUS");
                h.assertGate();
            });
            runCase("failed_drain_hello_retry", h -> {
                h.hello();
                h.endpoint.failDrains = 1;
                h.stop();
                require(h.machine.state() == RuntimeStateMachine.State.DRAINING, "FIRST_DRAIN_NOT_RECORDED");
                h.reply(h.endpoint.helloDestination, ControlProtocol.HELLO_REPLY, false);
                require(h.endpoint.drainAttempts == 2 && h.endpoint.drainsDelivered == 1,
                        "HELLO_FALSE_DID_NOT_RETRY_FAILED_DRAIN expectedAttempts=2 actual=" + h.endpoint.drainAttempts);
                require(h.machine.state() == RuntimeStateMachine.State.DRAINING, "DRAIN_RETRY_CHANGED_EVIDENCE_STATE");
                h.assertGate();
            });
            runCase("repeat_stop_exit_wait", h -> repeatStop(h, false));
            runCase("repeat_stop_exit_unknown", h -> repeatStop(h, true));
            runCase("stop_before_hello", h -> {
                h.stop();
                require(h.endpoint.drainAttempts == 0, "DRAIN_SENT_BEFORE_VALIDATED_HELLO");
                require(h.machine.state() == RuntimeStateMachine.State.STARTING, "UNVALIDATED_STOP_MUTATED_MACHINE");
                h.hello();
                require(h.endpoint.drainsDelivered == 1, "VALIDATED_STOP_DID_NOT_DRAIN");
                h.assertGate();
            });
            runCase("drain_reply_before_hello", h -> {
                h.stop();
                h.reply(h.endpoint.helloDestination, ControlProtocol.DRAIN_REPLY, false);
                require(h.endpoint.exitAttempts == 0, "EXIT_SENT_FOR_UNVALIDATED_DRAIN_REPLY");
                require(!h.validated(), "DRAIN_REPLY_VALIDATED_CONNECTION");
                h.assertGate();
            });
            runCase("late_old_hello", h -> {
                Messenger old = h.endpoint.helloDestination;
                h.reconnect();
                h.reply(old, ControlProtocol.HELLO_REPLY, false);
                require(!h.validated(), "OLD_HELLO_VALIDATED_NEW_CONNECTION");
                require(h.machine.state() == RuntimeStateMachine.State.STARTING, "OLD_HELLO_ADVANCED_MACHINE");
                require(h.context.activityRequests == 0, "OLD_HELLO_OPENED_ACTIVITY");
                h.hello();
                require(h.validated() && h.machine.state() == RuntimeStateMachine.State.PROBING, "CURRENT_HELLO_NOT_ACCEPTED");
            });
            runCase("late_old_drain_reply", h -> {
                h.hello();
                h.stop();
                Messenger old = h.endpoint.drainDestination;
                h.reconnect();
                h.reply(old, ControlProtocol.DRAIN_REPLY, false);
                require(h.endpoint.exitAttempts == 0, "OLD_DRAIN_REPLY_EXITED_NEW_CONNECTION");
                require(h.machine.state() == RuntimeStateMachine.State.DRAINING, "OLD_DRAIN_REPLY_ADVANCED_MACHINE");
                h.hello();
                require(h.endpoint.drainsDelivered == 1, "RECONNECTED_HELLO_DID_NOT_RETRY_DRAIN");
                h.assertGate();
            });
            runCase("duplicate_hello", h -> {
                h.hello();
                h.hello();
                require(h.context.activityRequests == 1,
                        "DUPLICATE_HELLO_REOPENED_ACTIVITY expected=1 actual=" + h.context.activityRequests);
                require(h.machine.state() == RuntimeStateMachine.State.PROBING, "DUPLICATE_HELLO_CHANGED_MACHINE");
                onMain(() -> h.coordinator.open(h.profile));
                waitForIdleSync();
                h.hello();
                require(h.context.activityRequests == 2, "EXPLICIT_REOPEN_DID_NOT_REACTIVATE_ACTIVITY");
                h.hello();
                require(h.context.activityRequests == 2, "REOPEN_DUPLICATE_HELLO_REACTIVATED_AGAIN");
            });
            runCase("duplicate_drain_reply", h -> {
                h.hello();
                h.stop();
                Messenger destination = h.endpoint.drainDestination;
                h.reply(destination, ControlProtocol.DRAIN_REPLY, false);
                h.reply(destination, ControlProtocol.DRAIN_REPLY, false);
                require(h.endpoint.exitAttempts == 1,
                        "DUPLICATE_DRAIN_REPLY_REPEATED_EXIT expected=1 actual=" + h.endpoint.exitAttempts);
                require(h.machine.state() == RuntimeStateMachine.State.EXIT_WAIT, "DRAIN_RECEIPT_NOT_EXIT_WAIT");
                h.assertGate();
            });
            runCase("hello_already_drained", h -> {
                h.reply(h.endpoint.helloDestination, ControlProtocol.HELLO_REPLY, true);
                require(h.endpoint.exitAttempts == 1, "DRAINED_HELLO_DID_NOT_REQUEST_SELF_EXIT");
                require(h.machine.state() == RuntimeStateMachine.State.EXIT_WAIT,
                        "DRAINED_HELLO_DID_NOT_ENTER_EXIT_WAIT actual=" + h.machine.state());
                h.assertGate();
            });
            runCase("binding_and_exit_gate", h -> {
                Bundle wrong = h.identity(false);
                wrong.putString(ControlProtocol.SESSION, UUID.randomUUID().toString());
                h.deliver(h.endpoint.helloDestination, ControlProtocol.HELLO_REPLY, wrong);
                wrong = h.identity(false);
                wrong.putString(ControlProtocol.INCARNATION, UUID.randomUUID().toString());
                h.deliver(h.endpoint.helloDestination, ControlProtocol.HELLO_REPLY, wrong);
                wrong = h.identity(false);
                wrong.putInt(ControlProtocol.PID, 0);
                h.deliver(h.endpoint.helloDestination, ControlProtocol.HELLO_REPLY, wrong);
                require(!h.validated() && h.machine.state() == RuntimeStateMachine.State.STARTING,
                        "FOREIGN_BINDING_ADVANCED_MACHINE");
                require(h.endpoint.drainAttempts == 0 && h.endpoint.exitAttempts == 0, "FOREIGN_BINDING_SENT_CONTROL");
                h.hello();
                h.stop();
                h.reply(h.endpoint.drainDestination, ControlProtocol.DRAIN_REPLY, false);
                require(h.machine.state() == RuntimeStateMachine.State.EXIT_WAIT, "DRAIN_REPLY_CLAIMED_DEATH");
                h.assertGate();
            });
            require(passed + failed != 0, "UNKNOWN_LIFECYCLE_CASE");
            result.putString("status", failed == 0 ? "PASSED" : "FAILED");
            result.putString("failureCode", failed == 0 ? "NONE" : "LIFECYCLE_ASSERTIONS_FAILED");
        } catch (Exception | AssertionError failure) {
            failed++;
            result.putString("status", "FAILED");
            result.putString("failureCode", failureCode(failure));
        }
        result.putInt("testsPassed", passed);
        result.putInt("testsFailed", failed);
        result.putInt("checksPassed", checks);
        result.putString("scope", "fresh-scoped-SQLite-real-coordinator-Messenger-only");
        result.putString("browserWebViewNetworkAndProcessActions", "NOT_RUN");
        finish(failed == 0 ? Activity.RESULT_OK : Activity.RESULT_CANCELED, result);
    }

    private void repeatStop(Harness h, boolean timeout) throws Exception {
        h.hello();
        onMain(() -> {
            h.machine.requestDrain(h.launch.sessionId);
            h.machine.drainComplete(h.launch.sessionId);
            if (timeout) h.machine.exitTimedOut(h.launch.sessionId);
        });
        RuntimeStateMachine.State before = h.machine.state();
        h.stop();
        require(h.endpoint.drainsDelivered == 1,
                "REPEATED_STOP_DID_NOT_RETRY_DRAIN state=" + before + " actualAttempts=" + h.endpoint.drainAttempts);
        require(h.machine.state() == before, "REPEATED_STOP_WEAKENED_EXIT_STATE");
        require(!h.coordinator.status().contains("ValidationException"), "REPEATED_STOP_INVALID_TRANSITION");
        h.assertGate();
    }

    private void runCase(String name, CaseBody body) {
        if (!"all".equals(selected) && !name.equals(selected)) return;
        try {
            try (Harness harness = new Harness(new File(root, name))) {
                body.run(harness);
            }
            passed++;
            result.putString("case_" + name, "PASS");
        } catch (Exception | AssertionError failure) {
            failed++;
            result.putString("case_" + name, "FAIL " + failureCode(failure));
        }
    }

    private final class Harness implements AutoCloseable {
        final ScopedContext context;
        final File database;
        final ProfileSpec profile;
        final LaunchSpec launch;
        final String incarnation = UUID.randomUUID().toString();
        final BootstrapStore store;
        final RuntimeStateMachine machine;
        final FileChannel lockChannel;
        final FileLock lock;
        LaunchCoordinator coordinator;
        FaultEndpoint endpoint;

        Harness(File directory) throws Exception {
            require(!directory.exists() && directory.mkdir(), "REFUSE_EXISTING_CASE_DIRECTORY");
            Os.chmod(directory.getAbsolutePath(), 0700);
            context = new ScopedContext(getTargetContext(), directory);
            database = new File(directory, "abs_profiles_v1.sqlite");
            require(!database.exists(), "REFUSE_EXISTING_TEST_DATABASE");
            try (ProfileRepository repository = new ProfileRepository(context)) {
                ProfileSpec input = new ProfileSpec(UUID.randomUUID().toString(), UUID.randomUUID().toString(),
                        "lifecycle-synthetic", new ProxySpec(ProxySpec.Scheme.HTTP, "192.0.2.1", 8080, false),
                        "", "UTC", Collections.singletonList("en-US"), ProfileSpec.DeviceMode.NATIVE, "", "");
                profile = repository.saveProfile(input, null, CredentialUpdate.clear());
                require(input.fingerprint().equals(profile.fingerprint()), "PROFILE_SAVE_READBACK_MISMATCH");
                require(repository.findProfile(profile.id) != null && repository.listProfiles().size() == 1,
                        "SYNTHETIC_PROFILE_SEARCH_FAILED");
            }
            store = new BootstrapStore(context);
            launch = store.publish(profile.id, profile.revision, 120000);
            // Each case needs an independent claimed row, not a process-global browser binding.
            // This fixture-only SQL never runs against a pre-existing database or real launch.
            try (SQLiteDatabase direct = openDirect(false)) {
                direct.execSQL("UPDATE launch_records SET state='CLAIMED',phase=10,incarnation_id=?,pid=?,consumed_at_ms=? "
                                + "WHERE session_id=? AND state='PUBLISHED'",
                        new Object[]{incarnation, Process.myPid(), System.currentTimeMillis(), launch.sessionId});
            }
            assertStored(BootstrapStore.State.CLAIMED);
            machine = new RuntimeStateMachine(launch, new LaunchReplayGuard(8), System.currentTimeMillis());
            File lifetime = new File(directory, "browser-runtime.lck");
            require(lifetime.createNewFile(), "LIFECYCLE_FIXTURE_LOCK_EXISTS");
            Os.chmod(lifetime.getAbsolutePath(), 0600);
            lockChannel = FileChannel.open(lifetime.toPath(), StandardOpenOption.READ,
                    StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS);
            lock = lockChannel.lock();
            onMain(() -> {
                Constructor<LaunchCoordinator> constructor = LaunchCoordinator.class.getDeclaredConstructor(Context.class);
                constructor.setAccessible(true);
                coordinator = constructor.newInstance(context);
                set(coordinator, "current", launch);
                set(coordinator, "incarnation", incarnation);
                set(coordinator, "pid", Process.myPid());
                set(coordinator, "machine", machine);
                invoke(coordinator, "bindControl");
                endpoint = new FaultEndpoint(launch, incarnation);
                context.connection.onServiceConnected(component(), endpoint);
            });
            waitForIdleSync();
            require(endpoint.helloDestination != null, "NATIVE_MESSENGER_HELLO_NOT_DELIVERED");
        }

        void hello() throws Exception { reply(endpoint.helloDestination, ControlProtocol.HELLO_REPLY, false); }

        void stop() throws Exception {
            onMain(coordinator::stop);
            waitForIdleSync();
        }

        void reconnect() throws Exception {
            onMain(() -> {
                ServiceConnection connection = context.connection;
                connection.onServiceDisconnected(component());
                endpoint = new FaultEndpoint(launch, incarnation);
                connection.onServiceConnected(component(), endpoint);
            });
            waitForIdleSync();
            require(endpoint.helloDestination != null, "RECONNECT_HELLO_NOT_DELIVERED");
        }

        Bundle identity(boolean drained) {
            Bundle value = new Bundle();
            value.putString(ControlProtocol.SESSION, launch.sessionId);
            value.putString(ControlProtocol.INCARNATION, incarnation);
            value.putInt(ControlProtocol.PID, Process.myPid());
            value.putBoolean("drained", drained);
            value.putString(ControlProtocol.COOKIE, "NOT_ATTEMPTED");
            return value;
        }

        void reply(Messenger destination, int what, boolean drained) throws Exception {
            deliver(destination, what, identity(drained));
        }

        void deliver(Messenger destination, int what, Bundle data) throws Exception {
            require(destination != null, "MISSING_NATIVE_REPLY_DESTINATION");
            Message message = Message.obtain(null, what);
            message.setData(data);
            destination.send(message);
            waitForIdleSync();
        }

        boolean validated() throws Exception { return (Boolean) get(coordinator, "validatedControl"); }

        void assertGate() throws Exception {
            assertStored(BootstrapStore.State.EXIT_UNCONFIRMED);
            try {
                store.publish(profile.id, profile.revision, 120000);
                throw new FixtureFailure("NEXT_ENVIRONMENT_GATE_RELEASED_WITHOUT_DEATH");
            } catch (StorageException expected) {
                require(expected.code == StorageException.Code.LAUNCH_ACTIVE, "WRONG_NEXT_ENVIRONMENT_GATE_FAILURE");
            }
            require(machine.state() != RuntimeStateMachine.State.EXIT_CONFIRMED, "IPC_RECEIPT_CONFIRMED_PROCESS_DEATH");
        }

        void assertStored(BootstrapStore.State state) {
            try (SQLiteDatabase direct = openDirect(true);
                 Cursor row = direct.rawQuery("SELECT state,session_id,nonce,incarnation_id,pid FROM launch_records WHERE session_id=?",
                         new String[]{launch.sessionId})) {
                require(row.moveToFirst() && state.name().equals(row.getString(0)), "DIRECT_SQL_STATE_MISMATCH");
                require(launch.sessionId.equals(row.getString(1)) && launch.nonce.equals(row.getString(2))
                        && incarnation.equals(row.getString(3)) && Process.myPid() == row.getInt(4), "DIRECT_SQL_BINDING_MISMATCH");
                require(!row.moveToNext(), "DUPLICATE_SYNTHETIC_LAUNCH");
            }
            BootstrapStore.ActiveLaunch active = store.readActive();
            BootstrapStore.ActiveLaunch found = store.findLaunch(launch.sessionId);
            require(active != null && active.state == state && found != null && found.state == state,
                    "STORE_READBACK_OR_SEARCH_MISMATCH");
            require(launch.configHash().equals(active.launch.configHash())
                    && launch.configHash().equals(found.launch.configHash()), "STORE_ENVELOPE_READBACK_MISMATCH");
        }

        SQLiteDatabase openDirect(boolean readOnly) {
            return SQLiteDatabase.openDatabase(database, new SQLiteDatabase.OpenParams.Builder()
                    .setOpenFlags(readOnly ? SQLiteDatabase.OPEN_READONLY : SQLiteDatabase.OPEN_READWRITE)
                    .setErrorHandler(broken -> { throw new FixtureFailure("SYNTHETIC_DATABASE_CORRUPT"); }).build());
        }

        @Override public void close() throws Exception {
            try {
                if (coordinator != null) onMain(() -> {
                    ((Handler) get(coordinator, "main")).removeCallbacksAndMessages(null);
                    invoke(coordinator, "unbindControl");
                    ((BootstrapStore) get(coordinator, "store")).close();
                });
            } finally {
                try {
                    lock.release();
                } finally {
                    lockChannel.close();
                    store.close();
                }
            }
        }
    }

    /** Native IMessenger wire adapter: fail one real send, or deliver to a real Handler Messenger. */
    private static final class FaultEndpoint extends Binder {
        final LaunchSpec launch;
        final String incarnation;
        final Messenger sink;
        Messenger helloDestination;
        Messenger drainDestination;
        int failDrains;
        int drainAttempts;
        int drainsDelivered;
        int exitAttempts;

        FaultEndpoint(LaunchSpec launch, String incarnation) {
            this.launch = launch;
            this.incarnation = incarnation;
            sink = new Messenger(new Handler(Looper.getMainLooper(), message -> {
                if (message.sendingUid != Process.myUid()) throw new FixtureFailure("FIXTURE_NATIVE_CALLER_UID_MISMATCH");
                if (message.what == ControlProtocol.HELLO) helloDestination = message.replyTo;
                if (message.what == ControlProtocol.DRAIN) {
                    drainsDelivered++;
                    drainDestination = message.replyTo;
                }
                return true;
            }));
        }

        @Override protected boolean onTransact(int code, Parcel data, Parcel reply, int flags) throws RemoteException {
            if (code != IBinder.FIRST_CALL_TRANSACTION) return super.onTransact(code, data, reply, flags);
            data.enforceInterface("android.os.IMessenger");
            Message message = data.readInt() == 0 ? null : Message.CREATOR.createFromParcel(data);
            if (message == null) throw new FixtureFailure("FIXTURE_NATIVE_MESSAGE_MISSING");
            Bundle identity = message.getData();
            if (!launch.sessionId.equals(identity.getString(ControlProtocol.SESSION))
                    || !launch.nonce.equals(identity.getString(ControlProtocol.NONCE))
                    || !incarnation.equals(identity.getString(ControlProtocol.INCARNATION))) {
                throw new FixtureFailure("OUTBOUND_CONTROL_BINDING_MISMATCH");
            }
            if (message.what == ControlProtocol.DRAIN) {
                drainAttempts++;
                if (failDrains > 0) {
                    failDrains--;
                    message.recycle();
                    throw new RemoteException("SYNTHETIC_DRAIN_SEND_FAILURE");
                }
            }
            if (message.what == ControlProtocol.EXIT_SELF) exitAttempts++;
            sink.send(message);
            return true;
        }
    }

    private static final class ScopedContext extends ContextWrapper {
        final File directory;
        ServiceConnection connection;
        int activityRequests;

        ScopedContext(Context base, File directory) { super(base); this.directory = directory; }
        @Override public Context getApplicationContext() { return this; }
        @Override public File getNoBackupFilesDir() { return directory; }
        @Override public boolean bindService(Intent service, ServiceConnection value, int flags) {
            if (connection != null) throw new FixtureFailure("FIXTURE_DUPLICATE_BIND");
            connection = value;
            return true;
        }
        @Override public void unbindService(ServiceConnection value) {
            if (connection != value) throw new FixtureFailure("FIXTURE_WRONG_UNBIND");
            connection = null;
        }
        @Override public void startActivity(Intent intent) { activityRequests++; }
    }

    private void onMain(CheckedAction action) throws Exception {
        AtomicReference<Throwable> failure = new AtomicReference<>();
        runOnMainSync(() -> {
            try { action.run(); }
            catch (Exception | AssertionError observed) { failure.set(observed); }
        });
        Throwable observed = failure.get();
        if (observed instanceof Exception) throw (Exception) observed;
        if (observed instanceof AssertionError) throw (AssertionError) observed;
    }

    private static ComponentName component() {
        return new ComponentName("com.ahoo.abs.android.preview.debug", "synthetic.LifecycleEndpoint");
    }

    private static Object get(Object target, String name) throws Exception {
        Field field = LaunchCoordinator.class.getDeclaredField(name);
        field.setAccessible(true);
        return field.get(target);
    }

    private static void set(Object target, String name, Object value) throws Exception {
        Field field = LaunchCoordinator.class.getDeclaredField(name);
        field.setAccessible(true);
        field.set(target, value);
    }

    private static void invoke(Object target, String name) throws Exception {
        Method method = LaunchCoordinator.class.getDeclaredMethod(name);
        method.setAccessible(true);
        try { method.invoke(target); }
        catch (InvocationTargetException failure) {
            Throwable cause = failure.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            if (cause instanceof AssertionError) throw (AssertionError) cause;
            throw new AssertionError(cause);
        }
    }

    private void require(boolean value, String assertion) {
        if (!value) throw new FixtureFailure(assertion);
        checks++;
    }

    private static String failureCode(Throwable failure) {
        if (failure instanceof FixtureFailure) return failure.getMessage();
        if (failure instanceof StorageException) return ((StorageException) failure).code.name();
        return failure.getClass().getSimpleName();
    }

    private interface CheckedAction { void run() throws Exception; }
    private interface CaseBody { void run(Harness harness) throws Exception; }
    private static final class FixtureFailure extends AssertionError {
        private static final long serialVersionUID = 1L;
        FixtureFailure(String assertion) { super(assertion); }
    }
}
