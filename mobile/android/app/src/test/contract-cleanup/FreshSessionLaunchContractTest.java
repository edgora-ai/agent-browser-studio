package com.ahoo.abs.android.process;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Bundle;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.os.Process;
import com.ahoo.abs.android.browser.ControlProtocol;
import com.ahoo.abs.android.data.BootstrapStore;
import com.ahoo.abs.android.data.BootstrapStore.ActiveLaunch;
import com.ahoo.abs.android.data.BootstrapStore.State;
import com.ahoo.abs.android.webapp.WebApp;
import com.ahoo.abs.android.webapp.WebAppRegistry;
import com.ahoo.abs.android.webapp.WebAppShortcuts;
import com.ahoo.abs.core.LaunchSpec;
import com.ahoo.abs.core.ProfileSpec;
import com.ahoo.abs.core.ProxySpec;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** Executes production LaunchCoordinator; doubles model dispatch, NOT Android task/UI behavior. */
public final class FreshSessionLaunchContractTest {
    private static final int RETAIN = Intent.FLAG_ACTIVITY_NEW_TASK
            | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT;
    private static final int FRESH = Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP;
    private static final String OTHER_SESSION = "30000000-0000-4000-8000-000000000001";
    private static int checks;

    private FreshSessionLaunchContractTest() { }

    public static void main(String[] args) throws Exception {
        boolean enabled = false;
        assert enabled = true;
        check(enabled && Runtime.version().feature() == 17, "Run with assertions and JDK17");
        firstDispatchAndRetainedContinue();
        continueBeforeFirstHello();
        publicationGates();
        claimedAndLostMarkersReuse();
        failedDispatchRetainsAuthority();
        markerOwnershipAcrossDispatch();
        unsafeEntryPoints();
        handshakeGatesAndStaleConnections();
        stopDoesNotConsume();
        disconnectedExitCanRetry();
        exitControlTimeoutIsFailClosed();
        webAppHandoff();
        webAppFailClosed();
        webAppScopeAndLabel();
        System.out.println("FreshSessionLaunchContractTest: " + checks + " checks passed");
    }

    private static void firstDispatchAndRetainedContinue() throws Exception {
        Fixture f = new Fixture();
        f.context.extraFlags = 0x00010000;
        f.openFresh();
        check(f.context.attempts.isEmpty(), "No Activity before a validated HELLO");
        f.claimAndConnect();
        f.context.duringStart = () -> check(f.launch.sessionId.equals(f.marker()), "Consume only after start returns");
        f.reply(f.hello());
        check(f.context.starts.size() == 1, "Fresh first dispatch missing");
        check(f.last().getFlags() == (FRESH | f.context.extraFlags), "Fresh must remove BOTH reuse flags and retain unrelated flags");
        check(f.marker() == null, "Successful fresh dispatch consumes marker");
        Bundle extras = f.last().getExtras();
        check(extras.size() == 2 && f.launch.sessionId.equals(extras.getString(ControlProtocol.SESSION))
                && f.launch.nonce.equals(extras.getString(ControlProtocol.NONCE)), "Exact immutable intent envelope changed");
        check(BootstrapStore.active.launch == f.launch && BootstrapStore.publications == 1, "Identity or publication changed");
        f.context.duringStart = null;
        f.reply(f.hello());
        check(f.context.starts.size() == 1, "Duplicate unsolicited HELLO cannot reopen/focus the Activity");
        for (int i = 0; i < 4; i++) {
            f.coordinator.open(f.profile);
            f.reply(f.hello());
            check(f.last().getFlags() == (RETAIN | f.context.extraFlags), "Continue must retain hot-session flags");
            check(f.marker() == null && BootstrapStore.publications == 1, "Continue cannot mint another marker/session");
        }
        Messenger oldInbox = f.inbox;
        f.connect();
        oldInbox.send(f.hello());
        check(f.context.starts.size() == 5, "Stale endpoint generation delivered a start");
        f.reply(f.hello());
        check(f.context.starts.size() == 6 && f.last().getFlags() == (RETAIN | f.context.extraFlags), "Rebind must not repeat fresh flags");
    }

    private static void continueBeforeFirstHello() throws Exception {
        Fixture f = new Fixture();
        f.openFresh();
        f.claim();
        f.coordinator.open(f.profile);
        f.coordinator.open(f.profile);
        check(f.launch.sessionId.equals(f.marker()) && f.context.attempts.isEmpty(),
                "Early CLAIMED Continue must not erase or consume the pending fresh marker");
        f.connect();
        f.reply(f.hello());
        check(f.last().getFlags() == FRESH && f.marker() == null && BootstrapStore.publications == 1,
                "Early Continue changed the single fresh first dispatch");
    }

    private static void publicationGates() throws Exception {
        Fixture f = new Fixture();
        ProcessLifecycle.lockFree = false;
        f.coordinator.open(f.profile);
        check(BootstrapStore.publications == 0 && f.marker() == null, "Busy browser lock minted fresh authority");
        f = new Fixture();
        ProcessLifecycle.failPublication = true;
        f.coordinator.open(f.profile);
        check(BootstrapStore.publications == 0 && f.marker() == null, "Failed publication hold minted authority");
        f = new Fixture();
        BootstrapStore.failPublish = true;
        f.coordinator.open(f.profile);
        check(BootstrapStore.publications == 0 && f.marker() == null, "Failed store.publish minted authority");
        f = new Fixture();
        BootstrapStore.active = new ActiveLaunch(f.launch, State.PUBLISHED, null, 0);
        f.coordinator.open(f.profile);
        check(BootstrapStore.publications == 0 && f.context.connection == null && f.marker() == null, "Existing PUBLISHED cannot be republished");
        f = new Fixture();
        f.claim();
        ProfileSpec changedRevision = profile(f.profile.id, UUID.randomUUID().toString());
        f.coordinator.open(changedRevision);
        check(f.context.connection == null && f.marker() == null, "Profile revision mismatch bypassed gate");
        f.coordinator.open(profile(UUID.randomUUID().toString(), UUID.randomUUID().toString()));
        check(f.context.connection == null && f.marker() == null, "Different active profile bypassed gate");
        f = new Fixture();
        Looper.onMain = false;
        try {
            f.coordinator.open(f.profile);
            throw new AssertionError("Wrong-thread open accepted");
        } catch (IllegalStateException expected) {
            check(BootstrapStore.publications == 0 && f.marker() == null, "Wrong thread minted marker");
        } finally {
            Looper.onMain = true;
        }
    }

    private static void claimedAndLostMarkersReuse() throws Exception {
        Fixture f = new Fixture();
        f.claim();
        f.coordinator.open(f.profile);
        f.connect();
        f.reply(f.hello());
        check(f.last().getFlags() == RETAIN && f.marker() == null && BootstrapStore.publications == 0,
                "Existing CLAIMED launch must not infer fresh authority");
        f = new Fixture();
        f.openFresh();
        f.claim();
        f.coordinator = newCoordinator(f.context); // Simulated manager recreation: no durable marker.
        f.coordinator.open(f.profile);
        f.connect();
        f.reply(f.hello());
        check(f.last().getFlags() == RETAIN && f.marker() == null, "Recreated manager must prefer safe reuse, not task destruction");
        f = new Fixture();
        f.openFresh();
        f.setMarker(null); // Rare lost in-memory marker does NOT authorize clearing a live Activity.
        f.claimAndConnect();
        f.reply(f.hello());
        check(f.last().getFlags() == RETAIN, "Missing marker must not be reconstructed from HELLO/profile/state");
    }

    private static void failedDispatchRetainsAuthority() throws Exception {
        Fixture f = new Fixture();
        f.openFresh();
        f.claimAndConnect();
        f.context.failStart = true;
        f.reply(f.hello());
        check(f.context.attempts.size() == 1 && f.context.starts.isEmpty(), "Failed start incorrectly became success");
        check(f.launch.sessionId.equals(f.marker()), "Failed start consumed the fresh marker");
        check(f.coordinator.status().contains("SecurityException"), "Existing start exception handling changed");
        f.context.failStart = false;
        f.coordinator.open(f.profile);
        f.reply(f.hello());
        check(f.context.attempts.size() == 2 && f.last().getFlags() == FRESH && f.marker() == null,
                "First successful retry must still be fresh exactly once");
        f.coordinator.open(f.profile);
        f.reply(f.hello());
        check(f.last().getFlags() == RETAIN, "Successful retry must consume fresh authority");
    }

    private static void markerOwnershipAcrossDispatch() throws Exception {
        Fixture f = new Fixture();
        f.openFresh();
        f.claimAndConnect();
        f.setMarker(OTHER_SESSION);
        f.reply(f.hello());
        check(f.last().getFlags() == RETAIN && OTHER_SESSION.equals(f.marker()), "A start consumed another session's marker");
        f = new Fixture();
        f.openFresh();
        f.claimAndConnect();
        final Fixture captured = f;
        f.context.duringStart = () -> captured.setMarker(OTHER_SESSION);
        f.reply(f.hello());
        check(f.last().getFlags() == FRESH && OTHER_SESSION.equals(f.marker()), "Post-dispatch clear consumed a replacement marker");
    }

    private static void unsafeEntryPoints() throws Exception {
        for (int bad = 0; bad < 6; bad++) {
            Fixture f = new Fixture();
            f.openFresh();
            f.claimAndConnect();
            f.context.badEntry = bad;
            f.reply(f.hello());
            check(f.context.attempts.isEmpty() && f.launch.sessionId.equals(f.marker()), "Unsafe entry point launched or consumed marker: " + bad);
            f.context.badEntry = -1;
            f.coordinator.open(f.profile);
            f.reply(f.hello());
            check(f.last().getFlags() == FRESH && f.marker() == null, "Entry-point rejection lost first dispatch authority");
        }
    }

    private static void handshakeGatesAndStaleConnections() throws Exception {
        for (int bad = 0; bad < 6; bad++) {
            Fixture f = new Fixture();
            f.openFresh();
            f.claimAndConnect();
            Message m = f.hello();
            ActiveLaunch original = BootstrapStore.active;
            if (bad == 0) m.sendingUid++;
            if (bad == 1) m.getData().putString(ControlProtocol.SESSION, OTHER_SESSION);
            if (bad == 2) m.getData().putInt(ControlProtocol.PID, 999);
            if (bad == 3) m.getData().putString(ControlProtocol.INCARNATION, OTHER_SESSION);
            if (bad == 4) BootstrapStore.active = null;
            if (bad == 5) field("bound").set(f.coordinator, false);
            f.reply(m);
            check(f.context.attempts.isEmpty() && f.launch.sessionId.equals(f.marker()), "Invalid HELLO consumed/launched fresh authority: " + bad);
            BootstrapStore.active = original;
            if (bad == 5) field("bound").set(f.coordinator, true);
            f.reply(f.hello());
            check(f.last().getFlags() == FRESH && f.marker() == null, "Invalid HELLO incorrectly consumed first valid launch");
        }
        Fixture f = new Fixture();
        f.openFresh();
        f.claimAndConnect();
        field("current").set(f.coordinator, new LaunchSpec(f.profile, OTHER_SESSION,
                UUID.randomUUID().toString(), System.currentTimeMillis(), System.currentTimeMillis() + 120000));
        f.setMarker(OTHER_SESSION);
        f.reply(f.hello());
        check(f.context.attempts.isEmpty() && OTHER_SESSION.equals(f.marker()), "Stale owner session consumed new session marker");
    }

    private static void stopDoesNotConsume() throws Exception {
        for (boolean exitUnconfirmed : List.of(false, true)) {
            Fixture f = new Fixture();
            f.openFresh();
            f.claimAndConnect();
            if (exitUnconfirmed) BootstrapStore.active = new ActiveLaunch(f.launch, State.EXIT_UNCONFIRMED, f.incarnation, 456);
            else field("stopping").set(f.coordinator, true);
            f.reply(f.hello());
            check(f.context.attempts.isEmpty() && f.launch.sessionId.equals(f.marker()), "Drain must not start an Activity or consume fresh marker");
            check(f.binder.sent.get(f.binder.sent.size() - 1).what == ControlProtocol.DRAIN, "Stop no longer uses original drain path");
        }
    }

    private static void disconnectedExitCanRetry() throws Exception {
        Fixture f = new Fixture();
        f.openFresh(); f.claimAndConnect(); f.reply(f.hello());
        ServiceConnection stale = f.context.connection;
        Messenger staleInbox = f.inbox;
        stale.onServiceDisconnected(new ComponentName("test.abs", "Control"));
        f.context.expectPublication = false;
        f.coordinator.stop();
        check(f.context.connection != stale, "Disconnected binding must be replaced on explicit exit");
        f.connect();
        staleInbox.send(f.hello());
        check(f.binder.sent.size() == 1, "Old inbox cannot drain through replacement connection");
        f.reply(f.hello());
        check(f.binder.sent.get(f.binder.sent.size()-1).what == ControlProtocol.DRAIN,
                "Reconnected stop must validate HELLO then drain");
        check(f.context.starts.size() == 1, "Exit reconnect must not reopen browser");
        ServiceConnection dead = f.context.connection;
        dead.onBindingDied(new ComponentName("test.abs", "Control"));
        check(!(boolean) field("bound").get(f.coordinator), "Dead binding must release stuck bound state");
        f.coordinator.stop();
        check(f.context.connection != dead, "Retry after binding death must obtain new connection");
        ServiceConnection empty = f.context.connection;
        empty.onNullBinding(new ComponentName("test.abs", "Control"));
        check(!(boolean) field("bound").get(f.coordinator), "Null binding must release stuck bound state");
        f.coordinator.stop();
        check(f.context.connection != empty, "Retry after null binding must obtain new connection");
    }

    private static void exitControlTimeoutIsFailClosed() throws Exception {
        Fixture f = new Fixture();
        f.openFresh(); f.claimAndConnect(); f.reply(f.hello());
        f.coordinator.stop();
        android.os.Handler handler = (android.os.Handler) field("main").get(f.coordinator);
        Runnable stale = handler.queued.get(handler.queued.size()-1);
        f.coordinator.stop();
        Runnable timeout = handler.queued.get(handler.queued.size()-1);
        stale.run();
        check((boolean) field("bound").get(f.coordinator), "Stale timeout must not invalidate new stop attempt");
        timeout.run();
        check(!(boolean) field("bound").get(f.coordinator), "Current timeout must release stuck control connection");
        check(BootstrapStore.active != null && BootstrapStore.active.state != State.EXIT_CONFIRMED,
                "Timeout cannot clear environment gate or claim process death");
        check(f.coordinator.status().contains("超时"), "Exit timeout must be visible and actionable");
        f.coordinator.reconcile();
        check(f.coordinator.status().contains("超时"), "Refresh cannot replace exit failure with generic persisted state");
    }

    private static void webAppHandoff() throws Exception {
        Fixture f = new Fixture();
        WebApp app = WebAppRegistry.make(f.profile.id);
        f.coordinator.openWebApp(f.profile, app);
        check(f.context.attempts.isEmpty() && WebAppRegistry.issues == 0, "No pin handoff before HELLO");
        f.claimAndConnect();
        Message wrongIncarnation = f.hello();
        wrongIncarnation.getData().putString(ControlProtocol.INCARNATION, OTHER_SESSION);
        f.reply(wrongIncarnation);
        check(f.context.attempts.isEmpty() && WebAppRegistry.issues == 0, "Mismatched HELLO cannot issue pin handoff");
        f.reply(f.hello());
        check(WebAppRegistry.issues == 1 && WebAppRegistry.issued.sameInstall(app)
                && f.launch.sessionId.equals(WebAppRegistry.session) && f.incarnation.equals(WebAppRegistry.incarnation)
                && f.profile.revision.equals(WebAppRegistry.revision) && WebAppRegistry.pid == 456,
                "Private handoff binds install, session, incarnation, revision and PID");
        Bundle envelope = f.last().getExtras();
        check(f.last().getFlags() == FRESH && envelope.size() == 3
                && WebAppRegistry.TICKET.equals(envelope.getString(ControlProtocol.WEB_APP_TICKET))
                && f.launch.sessionId.equals(envelope.getString(ControlProtocol.SESSION))
                && f.launch.nonce.equals(envelope.getString(ControlProtocol.NONCE)), "Fresh opaque envelope only");
        f.reply(f.hello());
        check(WebAppRegistry.issues == 1 && f.context.starts.size() == 1, "Duplicate HELLO must not open another app");
        f.coordinator.openWebApp(f.profile, app);
        f.reply(f.hello());
        check(WebAppRegistry.issues == 2 && f.context.starts.size() == 2 && f.last().getFlags() == RETAIN,
                "Warm app uses exact retained session path");
        f.coordinator.open(f.profile);
        f.reply(f.hello());
        check(f.last().getExtras().size() == 2 && WebAppRegistry.issues == 2, "Ordinary Continue does not reuse pin handoff");
    }

    private static void webAppFailClosed() throws Exception {
        Fixture f = new Fixture();
        WebApp app = WebAppRegistry.make(f.profile.id);
        f.coordinator.openWebApp(f.profile, WebAppRegistry.make(OTHER_SESSION));
        check(BootstrapStore.publications == 0, "Reject apps owned by another profile");
        f.context.supportWebApps = false;
        f.coordinator.openWebApp(f.profile, app);
        check(BootstrapStore.publications == 0, "Fallback runtime cannot launch native apps");
        f.context.supportWebApps = true;
        WebAppShortcuts.state = WebAppShortcuts.PinState.UNAVAILABLE;
        f.coordinator.openWebApp(f.profile, app);
        check(BootstrapStore.publications == 0, "Unknown pin state does not publish");
        WebAppShortcuts.state = WebAppShortcuts.PinState.CONFIRMED;
        f.coordinator.openWebApp(f.profile, app);
        f.claimAndConnect();
        WebAppShortcuts.state = WebAppShortcuts.PinState.NOT_PINNED;
        f.reply(f.hello());
        check(f.context.attempts.isEmpty() && WebAppRegistry.issues == 0, "Recheck pin after HELLO");
        WebAppShortcuts.state = WebAppShortcuts.PinState.CONFIRMED;
        f.coordinator.openWebApp(f.profile, app);
        f.coordinator.cancelWebAppOpen();
        f.reply(f.hello());
        check(f.context.attempts.isEmpty() && WebAppRegistry.issues == 0, "Losing manager foreground doesn't fall back to a plain open");
        f.coordinator.openWebApp(f.profile, app);
        f.coordinator.open(profile(OTHER_SESSION, f.profile.revision));
        f.reply(f.hello());
        check(f.context.attempts.isEmpty() && WebAppRegistry.issues == 0, "Blocked explicit open cannot deliver an older pin request");
        f.coordinator.openWebApp(f.profile, app);
        WebAppRegistry.failIssue = true;
        f.reply(f.hello());
        check(f.context.attempts.isEmpty(), "Registry revocation/unavailability fails without navigation");
        f.coordinator.openWebApp(f.profile, app);
        WebAppRegistry.failIssue = false;
        f.context.failStart = true;
        f.reply(f.hello());
        check(WebAppRegistry.issues == 1 && WebAppRegistry.revocations == 1 && f.launch.sessionId.equals(f.marker()),
                "Failed dispatch revokes only its pin handoff and retains fresh session authority");
        f.reply(f.hello());
        check(f.context.attempts.size() == 1, "Failed pin dispatch is not replayed by duplicate HELLO");
        f.context.failStart = false;
        f.coordinator.open(f.profile);
        f.reply(f.hello());
        check(f.last().getExtras().size() == 2 && f.last().getFlags() == FRESH,
                "A new ordinary open recovers fresh authority without a pin handoff");
    }

    private static void webAppScopeAndLabel() {
        WebApp app = WebAppRegistry.make(OTHER_SESSION);
        for (String path : List.of("/web", "/web/start?q=1#anchor", "/web/%E7%BD%91")) {
            check(app.contains("https://app.test" + path), "Valid scoped path rejected: " + path);
        }
        for (String url : List.of("https://app.test/web2", "https://app.test/web/../out",
                "https://app.test/web/%2E%2e/out", "https://app.test/web/a%2Fb", "https://app.test/web/a%5Cb",
                "https://app.test/web/%252e%252e", "https://app.test/web/%00", "https://app.test:443/web",
                "https://app.test:444/web", "https://app.test.evil.test/web", "https://app.test@evil.test/web",
                "http://app.test/web", "https://APP.test/web", "data:text/html,hello")) {
            check(!app.contains(url), "Out-of-scope path accepted: " + url);
        }
        check("网页 应用".equals(WebApp.displayName(" 网页\n\u202e\r应用 ")), "Control / bidi characters must not alter origin display");
        check(WebApp.displayName("好".repeat(100)).length() == 80, "Page name must be bounded");
        check(!WebApp.isOpaqueId("00000000-0000-0000-0000-000000000000")
                && !WebApp.isOpaqueId("78B03BDE-882F-4625-BD0A-E55E205119CB") && WebApp.isOpaqueId(WebAppRegistry.TICKET),
                "Only canonical opaque v4 IDs may be passed to Android intents");
    }

    private static ProfileSpec profile(String id, String revision) {
        return new ProfileSpec(id, revision, "host-only", new ProxySpec(ProxySpec.Scheme.HTTP, "192.0.2.1", 8080, false),
                "US", "America/New_York", List.of("en-US"), ProfileSpec.DeviceMode.NATIVE, "host-only-model", "");
    }

    private static LaunchCoordinator newCoordinator(Context context) throws Exception {
        Constructor<LaunchCoordinator> c = LaunchCoordinator.class.getDeclaredConstructor(Context.class);
        c.setAccessible(true);
        return c.newInstance(context);
    }

    private static Field field(String name) throws Exception {
        Field f = LaunchCoordinator.class.getDeclaredField(name);
        f.setAccessible(true);
        return f;
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
        checks++;
    }

    private static final class Fixture {
        final ProfileSpec profile = profile(UUID.randomUUID().toString(), UUID.randomUUID().toString());
        final String incarnation = UUID.randomUUID().toString();
        final LaunchSpec launch;
        final HostContext context = new HostContext();
        LaunchCoordinator coordinator;
        HostBinder binder;
        Messenger inbox;

        Fixture() throws Exception {
            Looper.onMain = true;
            ProcessLifecycle.lockFree = true;
            ProcessLifecycle.publicationHeld = false;
            ProcessLifecycle.failPublication = false;
            BootstrapStore.active = null;
            BootstrapStore.publications = 0;
            BootstrapStore.failPublish = false;
            WebAppRegistry.issued = null;
            WebAppRegistry.issues = WebAppRegistry.revocations = 0;
            WebAppRegistry.failIssue = false;
            WebAppShortcuts.state = WebAppShortcuts.PinState.CONFIRMED;
            android.system.Os.alive = true;
            long now = System.currentTimeMillis();
            launch = new LaunchSpec(profile, UUID.randomUUID().toString(), UUID.randomUUID().toString(), now, now + 120000);
            BootstrapStore.nextLaunch = launch;
            coordinator = newCoordinator(context);
        }
        void openFresh() {
            coordinator.open(profile);
            check(BootstrapStore.publications == 1 && launch.sessionId.equals(marker()), "Publish did not create session-bound authority");
            check(!ProcessLifecycle.publicationHeld, "Publication lock must still release");
        }
        void claim() {
            BootstrapStore.active = new ActiveLaunch(launch, State.CLAIMED, incarnation, 456);
            ProcessLifecycle.lockFree = false;
        }
        void claimAndConnect() { claim(); connect(); }
        void connect() {
            check(context.connection != null, "No control connection to validate");
            binder = new HostBinder();
            context.connection.onServiceConnected(new ComponentName("test.abs", "Control"), binder);
            Message request = binder.sent.get(binder.sent.size() - 1);
            check(request.what == ControlProtocol.HELLO, "Control did not HELLO before activity");
            inbox = request.replyTo;
        }
        Message hello() {
            Message m = Message.obtain(null, ControlProtocol.HELLO_REPLY);
            m.sendingUid = Process.myUid();
            m.getData().putString(ControlProtocol.SESSION, launch.sessionId);
            m.getData().putString(ControlProtocol.INCARNATION, incarnation);
            m.getData().putInt(ControlProtocol.PID, 456);
            return m;
        }
        void reply(Message message) throws Exception { inbox.send(message); }
        Intent last() { return context.starts.get(context.starts.size() - 1); }
        String marker() {
            try { return (String) field("pendingFreshActivitySession").get(coordinator); }
            catch (Exception e) { throw new AssertionError(e); }
        }
        void setMarker(String value) {
            try { field("pendingFreshActivitySession").set(coordinator, value); }
            catch (Exception e) { throw new AssertionError(e); }
        }
    }

    private static final class HostBinder implements IBinder {
        final List<Message> sent = new ArrayList<>();
        @Override public void linkToDeath(DeathRecipient d, int flags) { }
        @Override public void send(Message message) { sent.add(message); }
    }

    private static final class HostContext extends Context implements BrowserProcessOwner {
        final List<Intent> attempts = new ArrayList<>();
        final List<Intent> starts = new ArrayList<>();
        ServiceConnection connection;
        boolean failStart;
        boolean supportWebApps = true;
        boolean expectPublication = true;
        int badEntry = -1;
        int extraFlags;
        Runnable duringStart;
        @Override public boolean bindService(Intent i, ServiceConnection c, int f) {
            check(!expectPublication || ProcessLifecycle.publicationHeld, "Open must bind inside the original publication hold");
            connection = c;
            return true;
        }
        @Override public void startActivity(Intent intent) {
            attempts.add(intent);
            if (duringStart != null) duringStart.run();
            if (failStart) throw new SecurityException("synthetic host dispatch failure");
            starts.add(intent);
        }
        @Override public Intent createBrowserActivityIntent() {
            Intent i = new Intent(this, HostContext.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP
                    | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | extraFlags);
            if (badEntry == 0) i.setComponent(null);
            if (badEntry == 1) i.setComponent(new ComponentName("other.uid", "No"));
            if (badEntry == 2) i.setData(new Object());
            if (badEntry == 3) i.setSelector(new Intent());
            if (badEntry == 4) i.setClipData(new Object());
            if (badEntry == 5) i.putExtra("extra", "unsafe");
            return i;
        }
        @Override public boolean supportsWebApps() { return supportWebApps; }
        @Override public LaunchSpec requireLaunch() { throw new AssertionError("Not a browser runtime"); }
        @Override public String incarnation() { throw new AssertionError("Not a browser runtime"); }
        @Override public void activateController() { throw new AssertionError("IPC only"); }
        @Override public void markDraining() { throw new AssertionError("IPC only"); }
        @Override public BrowserProcessRuntime existingControlRuntime() { throw new AssertionError("No Chromium in host test"); }
    }
}
