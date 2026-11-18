package com.ahoo.abs.android.nativekernel;

import android.content.Context;
import android.os.Looper;
import android.util.AtomicFile;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicReference;
import org.chromium.base.Log;

/**
 * Executes the unmodified production Store and model with real local files/streams/fsync.
 * Only Android queue/storage boundaries are stubbed; no extracted algorithm or source
 * substring assertions. Blocking waits below belong solely to the host test driver.
 */
public final class BrowserHistoryStoreHostTest {
    private static int checks;
    private static int cases;

    private BrowserHistoryStoreHostTest() { }

    @FunctionalInterface
    private interface TestCase {
        void run() throws Exception;
    }

    private static final class ManualIo implements Executor {
        final Deque<Runnable> tasks = new ArrayDeque<>();
        int rejectNext;
        int maximumPending;

        @Override
        public void execute(Runnable command) {
            check(Looper.myLooper() == Looper.getMainLooper(), "I/O scheduling belongs to main");
            if (rejectNext > 0) {
                rejectNext--;
                throw new RejectedExecutionException("injected executor failure");
            }
            tasks.addLast(command);
            maximumPending = Math.max(maximumPending, tasks.size());
        }

        void runOne() throws Exception {
            check(!tasks.isEmpty(), "expected queued I/O");
            runOnWorker(tasks.removeFirst());
        }
    }

    private static final class HostContext extends Context {
        final Path root;
        int directoryCalls;
        boolean failDirectory;

        HostContext() throws IOException {
            root = Files.createTempDirectory("native-history-store-fixture-").toRealPath();
            AtomicFile.registerFixtureRoot(root);
        }

        @Override
        public Context getApplicationContext() {
            return this;
        }

        @Override
        public File getNoBackupFilesDir() {
            check(Looper.myLooper() != Looper.getMainLooper(), "directory lookup never on main");
            directoryCalls++;
            if (failDirectory) throw new IllegalStateException("injected private-directory failure");
            return root.toFile();
        }
    }

    private static final class Results implements BrowserHistoryStore.FlushCallback {
        final List<Boolean> values = new ArrayList<>();

        @Override
        public void onFlushed(boolean success) {
            check(Looper.myLooper() == Looper.getMainLooper(), "flush callback on main");
            values.add(success);
        }

        void none(String label) {
            equal(values, List.of(), label);
        }

        void one(boolean expected, String label) {
            equal(values, List.of(expected), label);
        }
    }

    private static final class Fixture {
        final String profile;
        final HostContext context;
        final File file;
        final ManualIo io;
        final BrowserHistoryStore store;

        Fixture(String profile, String stored) throws IOException {
            this.profile = profile;
            context = new HostContext();
            file = file(context, profile);
            if (stored != null) Files.writeString(file.toPath(), stored, StandardCharsets.UTF_8);
            io = new ManualIo();
            store = new BrowserHistoryStore(context, profile, io);
            check(context.directoryCalls == 0, "constructor performs no directory/disk access");
        }

        void load() throws Exception {
            check(!store.isLoaded(), "initialization asynchronous");
            io.runOne();
            check(!store.isLoaded(), "worker cannot mutate live UI model");
            Looper.idleMain();
            check(store.isLoaded(), "main publishes loaded model");
        }

        void pump() throws Exception {
            for (int turn = 0; turn < 100; turn++) {
                Looper.idleMain();
                if (io.tasks.isEmpty()) return;
                io.runOne();
            }
            throw new AssertionError("Store did not quiesce");
        }

        String disk() throws IOException {
            return Files.readString(file.toPath(), StandardCharsets.UTF_8);
        }

        BrowserHistory diskModel() throws IOException {
            return BrowserHistory.deserialize(disk(), profile);
        }

        void finish() throws Exception {
            store.flush();
            pump();
            check(io.tasks.isEmpty(), "no extra I/O left");
            check(Looper.taskCount() == 0, "no debounce/callback work left");
        }
    }

    public static void main(String[] args) throws Exception {
        Looper.getMainLooper();
        boolean assertions = false;
        assert assertions = true;
        check(assertions, "assertions enabled");
        runCase("async load and application context", BrowserHistoryStoreHostTest::asyncLoad);
        runCase("pre-load edits and captured visit merge", BrowserHistoryStoreHostTest::preloadEdits);
        runCase("pre-load clear/remove/title ordering", BrowserHistoryStoreHostTest::preloadClear);
        runCase("immutable ordered coalesced snapshots", BrowserHistoryStoreHostTest::orderedWrites);
        runCase("debounce while write in flight", BrowserHistoryStoreHostTest::debounce);
        runCase("flush initialization and in-flight fences", BrowserHistoryStoreHostTest::flushFences);
        runCase("direct flush callback reentry stays asynchronous", BrowserHistoryStoreHostTest::flushCallbackReentry);
        runCase("partial write failure and dirty retry", BrowserHistoryStoreHostTest::partialWriteFailure);
        runCase("nonthrowing commit rejection and readback failure", BrowserHistoryStoreHostTest::commitFailures);
        runCase("failed old write versus newer flush fence", BrowserHistoryStoreHostTest::newerFenceAfterFailure);
        runCase("initialization/executor failures stay usable", BrowserHistoryStoreHostTest::initializationFailure);
        runCase("unknown baseline recovery merges retained journal", BrowserHistoryStoreHostTest::baselineRecovery);
        runCase("clear during failed recovery is an ordered reset", BrowserHistoryStoreHostTest::clearDuringRecovery);
        runCase("profile filename and exact-key isolation", BrowserHistoryStoreHostTest::isolation);
        runCase("atomic backup recovery", BrowserHistoryStoreHostTest::atomicRecovery);
        runCase("corrupt/oversize/growing load bounds and site cap", BrowserHistoryStoreHostTest::loadBounds);
        runCase("clean size-cap errors retry reads without spin", BrowserHistoryStoreHostTest::cleanErrorReadRetry);
        runCase("listener cancellation and generation", BrowserHistoryStoreHostTest::listenerCancellation);
        runCase("throwing callbacks remain independent", BrowserHistoryStoreHostTest::throwingCallbacks);
        runCase("all public model access is main-owned", BrowserHistoryStoreHostTest::mainOwnership);
        runCase("bounded journal titles and safe compaction", BrowserHistoryStoreHostTest::boundedTitleJournal);
        runCase("production shared executor thread", BrowserHistoryStoreHostTest::productionExecutor);
        System.out.println("BrowserHistoryStoreHostTest: " + cases + " cases, " + checks + " checks; PASS");
        System.out.println("Boundary: host Android stubs, not device/StrictMode/power-loss/performance acceptance.");
    }

    private static void runCase(String name, TestCase test) throws Exception {
        Looper.resetForTest();
        test.run();
        check(Looper.taskCount() == 0, name + ": no main-queue leak");
        cases++;
        System.out.println("PASS " + name);
    }

    private static void asyncLoad() throws Exception {
        HostContext application = new HostContext();
        File file = file(application, "app");
        Files.writeString(file.toPath(), row("app", "https://old.com/private?q=secret", "Old", 100, 2));
        Context activity = new Context() {
            @Override
            public Context getApplicationContext() {
                return application;
            }

            @Override
            public File getNoBackupFilesDir() {
                throw new AssertionError("Activity context retained for disk access");
            }
        };
        ManualIo io = new ManualIo();
        BrowserHistoryStore store = new BrowserHistoryStore(activity, "app", io);
        check(!store.isLoaded() && store.size() == 0, "immediate usable empty UI model");
        check(application.directoryCalls == 0, "no constructor storage getter");
        int[] loads = {0};
        store.addLoadListener(() -> {
            check(Looper.myLooper() == Looper.getMainLooper(), "load callback on main");
            check(store.isLoaded() && store.size() == 1, "listener sees fully merged model");
            equal(store.ranked().get(0).origin, "https://old.com", "loaded origin privacy");
            loads[0]++;
        });
        io.runOne();
        check(loads[0] == 0 && !store.isLoaded(), "no worker-side publication/callback");
        check(Looper.runOneMain(), "load publication queued");
        check(store.isLoaded() && loads[0] == 0, "listener is separately queued, not reentrant");
        Looper.idleMain();
        check(loads[0] == 1, "load completion once");
        Results clean = new Results();
        store.flush(clean);
        clean.none("clean flush callback asynchronous");
        check(io.tasks.isEmpty(), "clean flush does not write");
        Looper.idleMain();
        clean.one(true, "loaded clean baseline fence");
        for (String event : AtomicFile.events(file)) check(event.endsWith("|host-history-io"), "all storage on worker");
    }

    private static void preloadEdits() throws Exception {
        Fixture f = new Fixture("pending", "ABSHISTv1\tpending\n"
                + "t\t0\t4\thttps://known.com\tOld\n"
                + "t\t8\t2\thttps://title.com\tTitleOld\n"
                + "t\t9\t3\thttps://remove.com\tRemove\n");
        f.io.runOne(); // Disk has already been parsed, but main publication is delayed.
        f.store.recordVisit("https://KNOWN.com:443/private?secret", "Navigated");
        f.store.recordVisit("https://known.com/second", "Final");
        f.store.updateTitle("https://title.com/path", "TitleNew");
        check(!f.store.removeSite("https://remove.com"), "unseen removal returns visible result only");
        BrowserHistory.SiteVisit pending = visit(f.store, "https://known.com");
        long captured = pending.lastVisitMillis;
        check(pending.visitCount == 1, "pending duplicate navigation merged");
        Results result = new Results();
        f.store.flush(result);
        result.none("flush waits for delayed publication");
        Looper.idleMain();
        check(f.store.isLoaded() && f.store.size() == 2, "disk baseline + replay, removal not resurrected");
        BrowserHistory.SiteVisit merged = visit(f.store, "https://known.com");
        check(merged.lastVisitMillis == captured && merged.visitCount == 5, "event time preserved, old visit count merged once");
        equal(merged.title, "Final", "newer pending navigation title survives load");
        equal(visit(f.store, "https://title.com").title, "TitleNew", "title edit applies to unseen stored site");
        result.none("loaded is not yet persisted");
        f.io.runOne();
        result.none("worker save alone cannot deliver callback");
        Looper.idleMain();
        result.one(true, "merged state durable");
        check(!f.disk().contains("secret") && !f.disk().contains("private"), "disk remains origin-only");
        check(f.diskModel().ranked().get(0).lastVisitMillis == captured, "persisted original navigation time");
        f.finish();

        Fixture stale = new Fixture("stale", row("stale", "https://clock.com", "Old", Long.MAX_VALUE, 7));
        stale.store.recordVisit("https://clock.com", "Current title");
        stale.load();
        BrowserHistory.SiteVisit clock = visit(stale.store, "https://clock.com");
        check(clock.lastVisitMillis == Long.MAX_VALUE && clock.visitCount == 7, "stale clock cannot inflate/regress loaded history");
        equal(clock.title, "Current title", "pending title still refreshes under clock rollback");
        stale.finish();
    }

    private static void preloadClear() throws Exception {
        Fixture f = new Fixture("clear", row("clear", "https://old.com", "Stored", 50, 9));
        f.store.recordVisit("https://before.com", "Before clear");
        f.store.clear();
        f.store.updateTitle("https://old.com", "Must not resurrect");
        f.store.recordVisit("https://after.com", "After clear");
        f.store.removeSite("https://after.com");
        f.store.recordVisit("https://final.com", "Final");
        f.load();
        check(f.store.size() == 1, "clear erases disk and earlier pending edits");
        equal(f.store.ranked().get(0).origin, "https://final.com", "later operations keep exact order");
        f.finish();
        equal(f.diskModel().ranked().get(0).origin, "https://final.com", "clear order persisted");

        Fixture empty = new Fixture("clear-empty", row("clear-empty", "https://old.com", "Old", 10, 1));
        empty.store.clear();
        empty.load();
        check(empty.store.size() == 0, "clear pending-empty model still masks stored records");
        empty.finish();
        check(empty.diskModel().size() == 0, "empty clear reaches disk");
    }

    private static void orderedWrites() throws Exception {
        Fixture f = new Fixture("ordered", null);
        f.load();
        f.store.recordVisit("https://a.com", "A1");
        Results first = new Results();
        f.store.flush(first);
        f.store.updateTitle("https://a.com", "A2");
        Results second = new Results();
        f.store.flush(second);
        f.store.updateTitle("https://a.com", "A3");
        Results third = new Results();
        f.store.flush(third);
        check(f.io.tasks.size() == 1, "one in-flight snapshot, no queue of stale copies");
        List<BrowserHistory.SiteVisit> detached = f.store.ranked();
        detached.get(0).title = "external corruption";
        detached.get(0).visitCount = 9000;
        equal(visit(f.store, "https://a.com").title, "A3", "returned rows do not alias UI model");
        f.io.runOne();
        equal(f.diskModel().ranked().get(0).title, "A1", "queued snapshot deep-copied before subsequent UI edits");
        first.none("first fence waits for main completion");
        check(Looper.runOneMain(), "first write completion");
        check(f.io.tasks.size() == 1, "newer requests coalesced to one latest snapshot");
        first.none("callback asynchronously delivered");
        Looper.idleMain();
        first.one(true, "first snapshot fence satisfied");
        second.none("newer edit not acknowledged by older write");
        third.none("latest edit not acknowledged by older write");
        f.io.runOne();
        equal(f.diskModel().ranked().get(0).title, "A3", "latest snapshot wins without intermediate stale A2 write");
        Looper.idleMain();
        second.one(true, "intermediate fence covered by latest snapshot");
        third.one(true, "latest fence covered by latest snapshot");
        check(f.io.maximumPending == 1 && AtomicFile.count(f.file, "startWrite") == 2, "bounded ordered write pipeline");
        check(f.diskModel().ranked().get(0).visitCount == 1, "external rows cannot corrupt persistence");
        f.finish();
    }

    private static void debounce() throws Exception {
        Fixture f = new Fixture("debounce", null);
        f.load();
        f.store.recordVisit("https://a.com", "A");
        Looper.advanceBy(1999);
        check(f.io.tasks.isEmpty(), "no early write");
        f.store.updateTitle("https://a.com", "B");
        Looper.advanceBy(1999);
        check(f.io.tasks.isEmpty(), "edit restarts debounce");
        Looper.advanceBy(1);
        check(f.io.tasks.size() == 1, "debounce queues nonblocking save");
        f.store.recordVisit("https://b.com", "B");
        Looper.advanceBy(2000);
        check(f.io.tasks.size() == 1, "debounce during in-flight save only requests latest");
        f.io.runOne();
        check(f.diskModel().size() == 1, "first snapshot does not include later site");
        Looper.idleMain();
        check(f.io.tasks.size() == 1, "expired newer debounce triggers one follow-up");
        f.io.runOne();
        Looper.idleMain();
        check(f.diskModel().size() == 2, "newer debounced changes persisted");
        f.finish();
    }

    private static void flushFences() throws Exception {
        Fixture f = new Fixture("fence", null);
        Results beforeEdit = new Results();
        Results edited = new Results();
        f.store.flush(beforeEdit);
        f.store.recordVisit("https://a.com", "A");
        f.store.flush(edited);
        beforeEdit.none("clean pre-init flush still waits for load");
        edited.none("dirty pre-init flush waits for load");
        f.load();
        beforeEdit.none("init completion does not acknowledge queued write");
        edited.none("init completion not a durability fence");
        check(f.io.tasks.size() == 1, "one write queued after initialization");
        Results duringFlight = new Results();
        f.store.flush(duringFlight);
        f.io.runOne();
        duringFlight.none("inflight fence waits for main result");
        Looper.idleMain();
        beforeEdit.one(true, "initial clean flush resolved after init/write");
        edited.one(true, "pre-init edit flushed");
        duringFlight.one(true, "same-revision in-flight fence fulfilled once");
        Results clean = new Results();
        f.store.flush(clean);
        clean.none("already-durable fence still async");
        check(f.io.tasks.isEmpty(), "durable flush does no redundant I/O");
        Looper.idleMain();
        clean.one(true, "already durable callback");
        f.finish();
    }

    private static void flushCallbackReentry() throws Exception {
        Fixture f = new Fixture("callback-reentry", null);
        f.load();
        Results first = new Results();
        Results titled = new Results();
        Results cleared = new Results();
        Results clean = new Results();
        List<String> order = new ArrayList<>();
        int[] depth = {0};
        BrowserHistoryStore.FlushCallback afterClean = success -> {
            check(depth[0] == 0, "clean nested fence never executes inside its caller");
            clean.onFlushed(success);
            order.add("clean");
        };
        BrowserHistoryStore.FlushCallback afterClear = success -> {
            check(depth[0] == 0, "clear nested fence never executes inside its caller");
            depth[0]++;
            try {
                cleared.onFlushed(success);
                order.add("clear");
                f.store.flush(afterClean);
                clean.none("already-durable nested flush callback is posted, not inline");
                check(f.io.tasks.isEmpty(), "nested already-durable flush needs no extra write");
            } finally {
                depth[0]--;
            }
        };
        BrowserHistoryStore.FlushCallback afterTitle = success -> {
            check(depth[0] == 0, "title nested fence never executes inside its caller");
            depth[0]++;
            try {
                titled.onFlushed(success);
                order.add("title");
                f.store.clear();
                f.store.flush(afterClear);
                cleared.none("clear nested flush waits beyond title callback");
                check(f.io.tasks.size() == 1, "clear callback reentry queues one newer snapshot");
            } finally {
                depth[0]--;
            }
        };
        f.store.recordVisit("https://reentry.com", "First revision");
        f.store.flush(success -> {
            check(depth[0] == 0, "first flush callback starts outside another callback");
            depth[0]++;
            try {
                first.onFlushed(success);
                order.add("first");
                f.store.updateTitle("https://reentry.com", "Callback title revision");
                f.store.flush(afterTitle);
                titled.none("title nested flush waits beyond first callback");
                check(f.io.tasks.size() == 1, "title callback reentry queues one newer snapshot");
            } finally {
                depth[0]--;
            }
        });
        first.none("initial dirty flush is asynchronous");
        f.io.runOne();
        equal(f.diskModel().ranked().get(0).title, "First revision", "first snapshot written before callback title edit");
        check(Looper.runOneMain(), "first write main completion");
        first.none("first callback is posted after write completion");
        check(Looper.runOneMain(), "first callback directly mutates and flushes");
        first.one(true, "first reentry chain callback once");
        titled.none("first callback cannot acknowledge its newly queued title write");
        equal(order, List.of("first"), "title callback not nested into first callback");
        equal(f.diskModel().ranked().get(0).title, "First revision", "callback mutation does not write on main");
        f.io.runOne();
        equal(f.diskModel().ranked().get(0).title, "Callback title revision", "reentrant title snapshot persists new revision");
        check(f.diskModel().ranked().get(0).visitCount == 1, "reentrant title change does not add navigation");
        check(Looper.runOneMain(), "title write main completion");
        titled.none("title callback remains asynchronous after write completion");
        check(Looper.runOneMain(), "title callback directly clears and flushes");
        titled.one(true, "title reentry chain callback once");
        cleared.none("title callback cannot acknowledge its newly queued clear");
        equal(order, List.of("first", "title"), "clear callback not nested into title callback");
        check(f.store.size() == 0 && f.diskModel().size() == 1, "clear reentry changes model but waits for worker persistence");
        f.io.runOne();
        check(f.diskModel().size() == 0, "newest reentrant clear revision reaches disk");
        check(Looper.runOneMain(), "clear write main completion");
        cleared.none("clear callback is posted after write completion");
        check(Looper.runOneMain(), "clear callback directly flushes already-durable revision");
        cleared.one(true, "clear reentry chain callback once");
        clean.none("even clean nested callback requires a distinct main task");
        equal(order, List.of("first", "title", "clear"), "clean callback not nested into clear callback");
        check(Looper.runOneMain(), "clean reentrant flush callback");
        clean.one(true, "already-durable reentry callback once");
        equal(order, List.of("first", "title", "clear", "clean"), "callbacks follow persisted revision order");
        check(depth[0] == 0 && f.io.maximumPending == 1, "callback reentry leaves no recursion or stale write queue");
        check(AtomicFile.count(f.file, "startWrite") == 3, "only initial/title/clear snapshots written");
        Looper.advanceBy(10000);
        f.finish();
        first.one(true, "first callback never redelivered after nested requests");
        titled.one(true, "title callback never redelivered after nested requests");
        cleared.one(true, "clear callback never redelivered after nested requests");
        clean.one(true, "clean callback never redelivered after nested requests");
        check(f.diskModel().size() == 0 && AtomicFile.count(f.file, "startWrite") == 3,
                "no stale title snapshot resurrects rows after final clear fence");
    }

    private static void partialWriteFailure() throws Exception {
        Fixture f = new Fixture("failure", row("failure", "https://a.com", "Old", 50, 3));
        f.load();
        String old = f.disk();
        f.store.updateTitle("https://a.com", "New");
        AtomicFile.Faults faults = AtomicFile.faults(f.file);
        faults.failWrites = 1;
        faults.failRollbacks = 1; // Even rollback reporting failure must not drop dirty state.
        Results failed = new Results();
        f.store.flush(failed);
        f.pump();
        failed.one(false, "partial write failure explicitly reported");
        equal(f.disk(), old, "partial write never replaces old complete file");
        equal(visit(f.store, "https://a.com").title, "New", "failed write preserves usable UI edit");
        check(f.io.tasks.isEmpty(), "failed revision is not busy-retried");
        check(AtomicFile.count(f.file, "failWrite") == 1, "failed transaction rolled back");
        Results retry = new Results();
        f.store.flush(retry);
        f.pump();
        retry.one(true, "same dirty revision retry succeeds");
        equal(f.diskModel().ranked().get(0).title, "New", "retry saves earlier failed edit");
        f.store.updateTitle("https://a.com", "Newest");
        faults.failStarts = 1;
        Results startFailed = new Results();
        f.store.flush(startFailed);
        f.pump();
        startFailed.one(false, "startWrite failure reported");
        f.store.updateTitle("https://a.com", "Debounced retry");
        Looper.advanceBy(2000);
        f.pump();
        equal(f.diskModel().ranked().get(0).title, "Debounced retry", "later mutation also retries dirty data");
        f.finish();
    }

    private static void commitFailures() throws Exception {
        Fixture f = new Fixture("commit", row("commit", "https://a.com", "Old", 50, 1));
        f.load();
        String old = f.disk();
        AtomicFile.Faults faults = AtomicFile.faults(f.file);
        f.store.updateTitle("https://a.com", "New"); // Same encoded length as Old.
        faults.rejectFinishes = 1;
        Results rejected = new Results();
        f.store.flush(rejected);
        f.pump();
        rejected.one(false, "nonthrowing finish rejection cannot acknowledge old bytes");
        equal(f.disk(), old, "silently rejected replacement leaves old same-length file");
        Results retry = new Results();
        f.store.flush(retry);
        f.pump();
        retry.one(true, "silent failure remains dirty and retries");
        equal(f.diskModel().ranked().get(0).title, "New", "verified retry committed new bytes");
        f.store.updateTitle("https://a.com", "Readback failed");
        faults.failReads = 1;
        Results readback = new Results();
        f.store.flush(readback);
        f.pump();
        readback.one(false, "unverifiable committed file is not acknowledged");
        Results verified = new Results();
        f.store.flush(verified);
        f.pump();
        verified.one(true, "readback failure retains dirty data");
        f.store.updateTitle("https://a.com", "Finish throws");
        faults.throwFinishes = 1;
        Results throwing = new Results();
        f.store.flush(throwing);
        f.pump();
        throwing.one(false, "throwing finish failure reported");
        f.finish();
        equal(f.diskModel().ranked().get(0).title, "Finish throws", "throwing finish stays retryable");
    }

    private static void newerFenceAfterFailure() throws Exception {
        Fixture f = new Fixture("newer-fence", null);
        f.load();
        f.store.recordVisit("https://a.com", "First");
        AtomicFile.faults(f.file).failWrites = 1;
        Results old = new Results();
        Results same = new Results();
        f.store.flush(old);
        f.store.flush(same);
        f.store.updateTitle("https://a.com", "Second");
        Results newer = new Results();
        f.store.flush(newer);
        f.io.runOne();
        Looper.idleMain();
        old.one(false, "failed old revision gets failure");
        same.one(false, "same-revision fence fails once without a retry loop");
        newer.none("newer revision not falsely acknowledged/failed by unattempted old snapshot");
        check(f.io.tasks.size() == 1, "newer explicit request attempts newer snapshot once");
        f.io.runOne();
        Looper.idleMain();
        newer.one(true, "newer fence resolves after its actual successful write");
        equal(f.diskModel().ranked().get(0).title, "Second", "failure cannot reorder newer write");
        f.finish();
    }

    private static void initializationFailure() throws Exception {
        Fixture f = new Fixture("unavailable", null);
        f.context.failDirectory = true;
        Results initial = new Results();
        f.store.flush(initial);
        f.load();
        initial.one(false, "failed initialization is not a successful clean fence");
        check(f.store.size() == 0, "failed load leaves usable in-memory model");
        f.store.recordVisit("https://a.com", "Usable");
        Results denied = new Results();
        f.store.flush(denied);
        f.pump();
        denied.one(false, "no UI fallback when background storage unavailable");
        f.context.failDirectory = false;
        Results recovered = new Results();
        f.store.flush(recovered);
        f.pump();
        recovered.one(true, "storage can recover without recreating model");
        equal(f.diskModel().ranked().get(0).title, "Usable", "in-memory edits persisted after init failure");
        f.finish();

        HostContext context = new HostContext();
        ManualIo io = new ManualIo();
        io.rejectNext = 1;
        BrowserHistoryStore rejected = new BrowserHistoryStore(context, "rejected", io);
        Results baseline = new Results();
        rejected.flush(baseline);
        Looper.idleMain();
        check(rejected.isLoaded(), "rejected init executor still completes load state");
        baseline.one(false, "rejected load reported to flush");
        rejected.recordVisit("https://a.com", "Retained");
        io.rejectNext = 1;
        Results write = new Results();
        rejected.flush(write);
        write.none("executor rejection callback still deferred");
        Looper.idleMain();
        write.one(false, "rejected save reported");
        Results retry = new Results();
        rejected.flush(retry);
        io.runOne(); // Recover unknown baseline before any save may run.
        Looper.idleMain();
        retry.none("successful baseline recovery alone is not durable edit completion");
        io.runOne();
        Looper.idleMain();
        retry.one(true, "executor rejection does not lose dirty revision");
    }

    private static void baselineRecovery() throws Exception {
        Fixture f = new Fixture("recover-baseline", "ABSHISTv1\trecover-baseline\n"
                + "t\t10\t3\thttps://old.com\tOld\n"
                + "t\t20\t4\thttps://edit.com\tEditOld\n"
                + "t\t30\t5\thttps://remove.com\tRemove\n");
        String original = f.disk();
        AtomicFile.faults(f.file).failReads = 2;
        List<Boolean> publications = new ArrayList<>();
        f.store.addLoadListener(() -> publications.add(f.store.hasLoadError()));
        f.load();
        check(f.store.hasLoadError() && f.store.size() == 0, "failed initial read publishes interactive error model");
        equal(publications, List.of(true), "initial failure listener publication");
        f.store.recordVisit("https://new.com", "New");
        long captured = visit(f.store, "https://new.com").lastVisitMillis;
        f.store.updateTitle("https://edit.com", "Edited while unavailable");
        check(!f.store.removeSite("https://remove.com"), "unknown baseline removal tombstone accepted");
        Results failedReread = new Results();
        f.store.flush(failedReread);
        check(f.store.isLoaded() && f.store.hasLoadError(), "recovery keeps UI model readable and marks error until publication");
        f.store.recordVisit("https://second.com", "Second");
        f.io.runOne();
        check(AtomicFile.count(f.file, "startWrite") == 0, "failed reread must not attempt a destructive partial-baseline write");
        Looper.idleMain();
        failedReread.one(false, "failed recovery explicitly fails fence");
        equal(f.disk(), original, "unknown baseline bytes unchanged after mutations and failed reread");
        equal(publications, List.of(true, true), "persistent listener once per failed recovery publication");
        check(f.io.tasks.isEmpty(), "failed recovery does not loop/retry without request");
        Results durable = new Results();
        f.store.flush(durable);
        f.io.runOne(); // Actual old rows read; main publication deliberately delayed.
        f.store.updateTitle("https://new.com", "Latest pending title");
        int[] generationCalls = {0};
        BrowserHistoryStore.LoadListener generation = () -> generationCalls[0]++;
        f.store.addLoadListener(generation);
        f.store.removeLoadListener(generation);
        f.store.addLoadListener(generation);
        Looper.idleMain();
        check(!f.store.hasLoadError() && f.store.size() == 4, "successful reread merges all journal edits and unrelated old rows");
        equal(visit(f.store, "https://old.com").title, "Old", "unrelated unknown disk history preserved");
        equal(visit(f.store, "https://edit.com").title, "Edited while unavailable", "unseen title intent survives multiple read failures");
        equal(visit(f.store, "https://new.com").title, "Latest pending title", "edit between read and publication preserved");
        check(visit(f.store, "https://new.com").lastVisitMillis == captured, "original visit timestamp survives failed recovery");
        check(f.store.ranked().stream().noneMatch(visit -> visit.origin.equals("https://remove.com")), "unseen remove never resurrected on recovery");
        equal(publications, List.of(true, true, false), "successful recovery delivered to persistent listener");
        check(generationCalls[0] == 1, "remove/readd cancels old publication and delivers latest recovery only once");
        durable.none("recovery merge is not yet a durability fence");
        equal(f.disk(), original, "successful reread still does not overwrite until queued save executes");
        f.io.runOne();
        Looper.idleMain();
        durable.one(true, "retained edits plus recovered baseline durably saved");
        check(f.diskModel().size() == 4, "recovered and pending rows persist together");
        f.finish();
    }

    private static void clearDuringRecovery() throws Exception {
        Fixture f = new Fixture("recover-clear", row("recover-clear", "https://old.com", "Old", 10, 1));
        AtomicFile.faults(f.file).failReads = 2;
        f.load();
        f.store.recordVisit("https://before.com", "Before");
        Results fence = new Results();
        f.store.flush(fence); // A recovery read is now in flight.
        f.store.clear();
        f.store.recordVisit("https://after.com", "After");
        f.store.updateTitle("https://old.com", "Must not resurrect");
        f.io.runOne(); // This read fails too, but explicit clear resets the unknown baseline.
        Looper.idleMain();
        check(!f.store.hasLoadError() && f.store.size() == 1, "explicit clear establishes known empty baseline despite read failure");
        equal(f.store.ranked().get(0).origin, "https://after.com", "clear journal masks old and earlier pending rows");
        fence.none("clear during recovery still waits for actual save");
        f.io.runOne();
        Looper.idleMain();
        fence.one(true, "newer authorized clear snapshot satisfies earlier fence");
        equal(f.diskModel().ranked().get(0).origin, "https://after.com", "only post-clear history persisted");
        f.finish();

        Fixture readSucceeded = new Fixture("recover-clear-read", row("recover-clear-read", "https://old.com", "Old", 10, 1));
        AtomicFile.faults(readSucceeded.file).failReads = 1;
        readSucceeded.load();
        readSucceeded.store.recordVisit("https://before.com", "Before");
        readSucceeded.store.flush();
        readSucceeded.io.runOne(); // Parsed old model waits for main publication.
        readSucceeded.store.clear();
        readSucceeded.store.recordVisit("https://after.com", "After");
        readSucceeded.pump();
        equal(readSucceeded.store.ranked().get(0).origin, "https://after.com", "late successful recovery cannot revive cleared old rows");
        check(readSucceeded.store.size() == 1, "late successful recovery preserves clear order");
        readSucceeded.finish();
    }

    private static void isolation() throws Exception {
        HostContext context = new HostContext();
        Files.writeString(file(context, "one").toPath(), row("one", "https://one.com", "One", 10, 1));
        Files.writeString(file(context, "two").toPath(), row("two", "https://two.com", "Two", 20, 2));
        ManualIo io = new ManualIo();
        BrowserHistoryStore one = new BrowserHistoryStore(context, "one", io);
        BrowserHistoryStore two = new BrowserHistoryStore(context, "two", io);
        io.runOne();
        io.runOne();
        Looper.idleMain();
        equal(one.ranked().get(0).origin, "https://one.com", "first profile load isolated");
        equal(two.ranked().get(0).origin, "https://two.com", "second profile load isolated");
        one.clear();
        one.flush();
        io.runOne();
        Looper.idleMain();
        check(BrowserHistory.deserialize(Files.readString(file(context, "two").toPath()), "two").size() == 1,
                "first profile clear never touches second file");
        File collision = file(context, "p/a");
        equal(collision.getName(), "native_history_p_a.v1.log", "legacy sanitized filename retained");
        Files.writeString(collision.toPath(), row("p/a", "https://private.com", "Private", 1, 1));
        BrowserHistoryStore wrongKey = new BrowserHistoryStore(context, "p?a", io);
        io.runOne();
        Looper.idleMain();
        check(wrongKey.size() == 0, "filename collision cannot load another exact profile key");
        BrowserHistoryStore owner = new BrowserHistoryStore(context, "p/a", io);
        io.runOne();
        Looper.idleMain();
        check(owner.size() == 1, "matching exact key can read collision-compatible filename");
        equal(file(context, null).getName(), "native_history_unknown.v1.log", "null filename compatibility");
        equal(file(context, "").getName(), "native_history_unknown.v1.log", "empty filename compatibility");
    }

    private static void atomicRecovery() throws Exception {
        Fixture f = new Fixture("backup", "incomplete base");
        Path backup = Path.of(f.file + ".bak");
        check(backup.toAbsolutePath().normalize().startsWith(f.context.root), "backup fixture path owned");
        Files.writeString(backup, row("backup", "https://restored.com", "Restored", 10, 5));
        f.load();
        equal(f.store.ranked().get(0).origin, "https://restored.com", "surviving AtomicFile backup recovered off main");
        check(AtomicFile.count(f.file, "recoverBackup") == 1, "recovery exercised storage boundary");
        f.store.updateTitle("https://restored.com", "Changed");
        AtomicFile.faults(f.file).failWrites = 1;
        Results failed = new Results();
        f.store.flush(failed);
        f.pump();
        failed.one(false, "recovered base survives later failed transaction");
        equal(f.diskModel().ranked().get(0).title, "Restored", "old recovered complete file still readable");
        f.finish();
    }

    private static void loadBounds() throws Exception {
        Fixture corrupt = new Fixture("corrupt", "ABSHISTv1\tcorrupt\n"
                + "bad row\nt\t-1\t1\thttps://bad.com\tBad\n"
                + "t\t10\t1\thttps://good.com/private\tGood\n");
        corrupt.load();
        check(corrupt.store.size() == 1, "corrupt rows skipped without losing good rows");
        equal(corrupt.store.ranked().get(0).origin, "https://good.com", "loaded privacy normalization preserved");
        corrupt.finish();
        Fixture oversized = new Fixture("oversized", "x".repeat(1024 * 1024 + 1));
        Results over = new Results();
        oversized.store.flush(over);
        oversized.load();
        check(oversized.store.size() == 0, "oversized file not loaded");
        over.one(false, "size-capped failed baseline not acknowledged durable");
        check(AtomicFile.count(oversized.file, "read") == 0, "oversized file rejected before reading body");
        oversized.store.recordVisit("https://recover.com", "Recover");
        oversized.finish();
        check(oversized.diskModel().size() == 1, "oversize load failure remains usable/retryable");
        Fixture growing = new Fixture("growing", row("growing", "https://old.com", "Old", 1, 1));
        AtomicFile.faults(growing.file).growOnReadBytes = 1024 * 1024 + 1;
        growing.load();
        check(growing.store.size() == 0, "growing file rejected by streaming size cap");
        Results grew = new Results();
        growing.store.flush(grew);
        grew.none("clean streaming-cap flush retries read asynchronously");
        growing.pump();
        grew.one(false, "streaming cap retry failure not silently durable");
        growing.store.clear();
        growing.finish();
        Fixture cap = new Fixture("cap", row("cap", "https://ancient.com", "Ancient", 0, 1));
        for (int i = 0; i < BrowserHistory.MAX_SITES + 25; i++) {
            cap.store.recordVisit("https://s" + i + ".com/private", "S" + i);
        }
        cap.load();
        check(cap.store.size() == BrowserHistory.MAX_SITES, "pre-load replay respects site cap");
        check(cap.store.ranked().stream().noneMatch(visit -> visit.origin.equals("https://ancient.com")), "new sites evict ancient disk data");
        cap.finish();
        check(cap.diskModel().size() == BrowserHistory.MAX_SITES, "persisted snapshot stays capped");
    }

    private static void cleanErrorReadRetry() throws Exception {
        for (boolean growsDuringRead : new boolean[] {false, true}) {
            String key = growsDuringRead ? "retry-growing" : "retry-oversized";
            Fixture f = new Fixture(key, growsDuringRead
                    ? row(key, "https://before.com", "Before", 10, 3)
                    : "x".repeat(1024 * 1024 + 1));
            if (growsDuringRead) AtomicFile.faults(f.file).growOnReadBytes = 1024 * 1024 + 1;
            List<Boolean> errors = new ArrayList<>();
            f.store.addLoadListener(() -> errors.add(f.store.hasLoadError()));
            f.load();
            check(f.store.hasLoadError() && f.store.size() == 0, "clean size-cap error initially visible");
            check(AtomicFile.count(f.file, "openRead") == 1, "initial failure does not retry itself");
            String unmodified = f.disk();
            for (int attempt = 0; attempt < 3; attempt++) {
                int before = AtomicFile.count(f.file, "openRead");
                Results first = new Results();
                Results coalesced = new Results();
                f.store.flush(first);
                f.store.flush(coalesced);
                first.none("clean-error flush is asynchronous");
                coalesced.none("coalesced clean-error fence waits for reread");
                check(f.io.tasks.size() == 1, "one explicit clean-error retry queued");
                f.pump();
                first.one(false, "repeated size-cap failure completes first fence once");
                coalesced.one(false, "repeated size-cap failure completes coalesced fence once");
                check(AtomicFile.count(f.file, "openRead") == before + 1, "failed clean retry reads exactly once, never spins");
                check(AtomicFile.count(f.file, "startWrite") == 0, "clean retry does not replace oversized unknown bytes");
                check(f.io.tasks.isEmpty() && Looper.taskCount() == 0, "failed clean retry fully quiescent");
                Looper.advanceBy(4000);
                check(f.io.tasks.isEmpty(), "no retry timer after a failed clean reread");
                equal(f.disk(), unmodified, "failed rereads preserve original fixture bytes");
                check(errors.size() == attempt + 2 && errors.stream().allMatch(Boolean::booleanValue),
                        "persistent listener once per initial/retry error publication");
            }
            String repaired = row(key, "https://repaired.com/private?secret", "Repaired", 50, 7);
            Files.writeString(f.file.toPath(), repaired, StandardCharsets.UTF_8);
            Results recovered = new Results();
            f.store.flush(recovered);
            check(f.io.tasks.size() == 1 && f.store.hasLoadError(), "repair still waits for background reread/publication");
            f.io.runOne();
            recovered.none("successful worker reread still waits for main publication");
            check(f.store.hasLoadError() && f.store.size() == 0, "worker cannot publish repaired rows off main");
            Looper.idleMain();
            recovered.one(true, "clean repaired baseline fence succeeds after reread");
            check(!f.store.hasLoadError() && f.store.size() == 1, "successful repair clears error and publishes original rows");
            equal(visit(f.store, "https://repaired.com").title, "Repaired", "repaired row content retained");
            check(visit(f.store, "https://repaired.com").visitCount == 7, "repair does not recount existing visits");
            equal(errors, List.of(true, true, true, true, false), "single recovery publication after repeated failures");
            equal(f.disk(), repaired, "clean recovery only reads, never rewrites repaired file");
            check(AtomicFile.count(f.file, "startWrite") == 0, "clean successful recovery has no unnecessary save");
            int reads = AtomicFile.count(f.file, "openRead");
            Results clean = new Results();
            f.store.flush(clean);
            clean.none("now-healthy clean fence remains asynchronous");
            Looper.idleMain();
            clean.one(true, "subsequent clean fence uses known healthy baseline");
            check(AtomicFile.count(f.file, "openRead") == reads && f.io.tasks.isEmpty(), "healthy clean flush does not poll/reread");
            f.finish();
        }

        Fixture pending = new Fixture("retry-pending", "x".repeat(1024 * 1024 + 1));
        pending.load();
        String repaired = row("retry-pending", "https://old.com", "Old", 10, 2);
        Files.writeString(pending.file.toPath(), repaired, StandardCharsets.UTF_8);
        Results fence = new Results();
        pending.store.flush(fence);
        pending.io.runOne(); // Successful clean retry parsed old rows; publication remains queued.
        pending.store.recordVisit("https://new.com", "New");
        pending.store.updateTitle("https://old.com", "Updated while rereading");
        Looper.idleMain();
        check(pending.store.size() == 2 && !pending.store.hasLoadError(), "new edits during clean retry merge with repaired rows");
        equal(visit(pending.store, "https://old.com").title, "Updated while rereading", "unseen pending title survives repaired baseline publication");
        fence.none("clean-target fence waits when newer dirty replay requires a write");
        pending.io.runOne();
        Looper.idleMain();
        fence.one(true, "repaired baseline plus queued edits reach successful durability fence");
        check(pending.diskModel().size() == 2, "repair and pending navigation both persisted");
        pending.finish();

        Fixture stillOversized = new Fixture("retry-dirty", "x".repeat(1024 * 1024 + 1));
        stillOversized.load();
        Results dirtyFence = new Results();
        stillOversized.store.flush(dirtyFence);
        stillOversized.store.recordVisit("https://new.com", "New during failed clean retry");
        stillOversized.io.runOne();
        Looper.idleMain();
        check(stillOversized.io.tasks.size() == 1, "dirty known-empty baseline saves after clean reread is still oversized");
        dirtyFence.none("failed clean read plus later edit is not acknowledged before save");
        stillOversized.io.runOne();
        Looper.idleMain();
        dirtyFence.one(true, "dirty known-empty policy survives clean retry hardening");
        equal(stillOversized.diskModel().ranked().get(0).origin, "https://new.com", "newer dirty snapshot persists under established size-cap policy");
        stillOversized.finish();
    }

    private static void listenerCancellation() throws Exception {
        Fixture f = new Fixture("listeners", null);
        int[] calls = {0};
        BrowserHistoryStore.LoadListener listener = () -> calls[0]++;
        f.store.addLoadListener(listener);
        f.store.removeLoadListener(listener);
        f.load();
        check(calls[0] == 0, "removal before load cancels completion");
        f.store.addLoadListener(listener);
        f.store.removeLoadListener(listener);
        f.store.addLoadListener(listener);
        f.store.addLoadListener(listener);
        check(calls[0] == 0, "already-loaded listener callback never inline");
        Looper.idleMain();
        check(calls[0] == 1, "old generation cancelled, new registration delivered exactly once");
        f.store.addLoadListener(listener);
        Looper.idleMain();
        check(calls[0] == 1, "duplicate registration does not redeliver");
        f.store.removeLoadListener(listener);
        f.store.addLoadListener(listener);
        f.store.removeLoadListener(listener);
        Looper.idleMain();
        check(calls[0] == 1, "cancel already-posted callback");
        f.finish();

        Fixture g = new Fixture("listeners-queued", null);
        int[] second = {0};
        BrowserHistoryStore.LoadListener victim = () -> second[0]++;
        g.store.addLoadListener(() -> g.store.removeLoadListener(victim));
        g.store.addLoadListener(victim);
        g.io.runOne();
        check(Looper.runOneMain(), "publish load and queue listeners");
        Looper.idleMain();
        check(second[0] == 0, "earlier listener can cancel later queued lifecycle callback");
        g.finish();
    }

    private static void throwingCallbacks() throws Exception {
        Fixture f = new Fixture("callbacks", null);
        int warningBefore = Log.warningCount();
        int[] load = {0};
        f.store.addLoadListener(() -> { throw new IllegalStateException("listener destroyed"); });
        f.store.addLoadListener(() -> load[0]++);
        f.load();
        check(load[0] == 1, "throwing load listener cannot suppress other registrations");
        f.store.recordVisit("https://a.com", "A");
        f.store.flush(success -> { throw new IllegalStateException("callback destroyed"); });
        Results independent = new Results();
        f.store.flush(independent);
        f.pump();
        independent.one(true, "throwing flush callback cannot suppress other fences");
        check(Log.warningCount() >= warningBefore + 2, "callback exceptions logged");
        f.finish();
    }

    private static void mainOwnership() throws Exception {
        Fixture f = new Fixture("ownership", null);
        f.load();
        List<Runnable> operations = List.of(
                () -> f.store.recordVisit("https://a.com", "A"),
                () -> f.store.updateTitle("https://a.com", "A"),
                () -> f.store.removeSite("https://a.com"),
                f.store::clear, f.store::ranked, f.store::size, f.store::isLoaded, f.store::hasLoadError,
                () -> f.store.addLoadListener(() -> { }),
                () -> f.store.removeLoadListener(null), f.store::flush,
                () -> f.store.flush(success -> { }),
                () -> new BrowserHistoryStore(f.context, "worker", f.io));
        for (Runnable operation : operations) {
            runOnWorker(() -> {
                try {
                    operation.run();
                    throw new AssertionError("Off-main access accepted");
                } catch (IllegalStateException expected) {
                    equal(expected.getMessage(), "HISTORY_STORE_WRONG_THREAD", "explicit main ownership failure");
                }
            });
        }
        check(f.store.size() == 0, "rejected off-main edits do not touch model");
        f.finish();
    }

    private static void boundedTitleJournal() throws Exception {
        Fixture f = new Fixture("title-payload", row("title-payload", "https://title.com", "Old", 10, 7));
        AtomicFile.faults(f.file).failReads = 1;
        String hugeVisit = " \u0001" + "\ud83d\ude00".repeat(250000) + "end";
        String hugeTitle = "\t" + "T".repeat(500000) + "end";
        f.store.recordVisit("https://huge.com/private", hugeVisit);
        f.store.updateTitle("https://title.com", hugeTitle);
        for (int i = 0; i < 2000; i++) {
            f.store.updateTitle("https://title.com", "Round " + i);
        }
        f.store.updateTitle("https://title.com", hugeTitle);
        java.lang.reflect.Field journalField = BrowserHistoryStore.class.getDeclaredField("beforeLoad");
        journalField.setAccessible(true);
        List<?> journal = (List<?>) journalField.get(f.store);
        check(journal.size() == 2, "adjacent title churn compacts without dropping the preceding navigation");
        checkRetainedTitles(journal, hugeVisit, hugeTitle);
        f.load();
        check(f.store.hasLoadError() && journal.size() == 2, "bounded journal survives initial failed read");
        f.store.removeSite("https://title.com");
        f.store.updateTitle("https://title.com", "No resurrection");
        f.store.recordVisit("https://title.com", "Back");
        f.store.updateTitle("https://title.com", hugeTitle);
        f.store.updateTitle("https://title.com", hugeTitle);
        check(journal.size() == 6, "compaction does not cross remove or navigation boundaries");
        checkRetainedTitles(journal, hugeVisit, hugeTitle);
        Results durable = new Results();
        f.store.flush(durable);
        f.pump();
        durable.one(true, "large bounded title journal recovers and persists");
        equal(visit(f.store, "https://huge.com").title, "\ud83d\ude00".repeat(100), "code-point-safe 200-unit visit title retained");
        equal(visit(f.store, "https://title.com").title, "T".repeat(200), "bounded normalized title update retained");
        check(visit(f.store, "https://title.com").visitCount == 1, "remove/visit order preserved despite title compaction");
        check(f.disk().length() < 1500, "giant page titles not serialized or retained as giant payloads");
        check(journal.isEmpty(), "successful recovery releases mutation captures");
        f.finish();
    }

    private static void checkRetainedTitles(List<?> journal, String... rawTitles) throws Exception {
        for (Object mutation : journal) {
            for (java.lang.reflect.Field field : mutation.getClass().getDeclaredFields()) {
                field.setAccessible(true);
                Object captured = field.get(mutation);
                if (!(captured instanceof String)) continue;
                String text = (String) captured;
                for (String raw : rawTitles) check(text != raw, "journal does not retain the original giant title object");
                check(text.length() <= 200, "test-origin and captured title payloads bounded to 200 units");
            }
        }
    }

    private static void productionExecutor() throws Exception {
        HostContext context = new HostContext();
        BrowserHistoryStore store = new BrowserHistoryStore(context, "production");
        check(!store.isLoaded(), "default production constructor never synchronously loads");
        Looper.awaitPostedTask(5000);
        Looper.idleMain();
        check(store.isLoaded(), "shared production executor posts initialization");
        equal(android.os.Process.backgroundThread, "AbsNativeHistory-IO", "production worker explicitly named/background-priority");
        store.recordVisit("https://a.com", "Production");
        Results result = new Results();
        store.flush(result);
        Looper.awaitPostedTask(5000);
        Looper.idleMain();
        result.one(true, "real default executor durability callback");
        for (String event : AtomicFile.events(file(context, "production"))) {
            check(event.endsWith("|AbsNativeHistory-IO"), "default executor owns every storage operation");
        }
    }

    private static BrowserHistory.SiteVisit visit(BrowserHistoryStore store, String origin) {
        return store.ranked().stream().filter(visit -> visit.origin.equals(origin)).findFirst()
                .orElseThrow(() -> new AssertionError("Missing site: " + origin));
    }

    private static String row(String key, String origin, String title, long time, int count) {
        return "ABSHISTv1\t" + key + "\nt\t" + time + "\t" + count + "\t" + origin + "\t" + title + "\n";
    }

    private static File file(HostContext context, String key) {
        String safe = key == null ? "" : key.replaceAll("[^A-Za-z0-9_-]", "_");
        if (safe.isEmpty()) safe = "unknown";
        return context.root.resolve("native_history_" + safe + ".v1.log").toFile();
    }

    private static void runOnWorker(Runnable command) throws Exception {
        AtomicReference<Throwable> thrown = new AtomicReference<>();
        Thread thread = new Thread(() -> {
            try {
                command.run();
            } catch (Throwable failure) {
                thrown.set(failure);
            }
        }, "host-history-io");
        thread.setDaemon(true);
        thread.start();
        thread.join(5000);
        check(!thread.isAlive(), "host worker completed without blocking production code");
        Throwable failure = thrown.get();
        if (failure != null) throw new AssertionError("Production worker failed", failure);
    }

    private static void equal(Object actual, Object expected, String label) {
        check(Objects.equals(actual, expected), label + ": expected=" + expected + " actual=" + actual);
    }

    private static void check(boolean condition, String label) {
        checks++;
        if (!condition) throw new AssertionError(label);
    }
}
