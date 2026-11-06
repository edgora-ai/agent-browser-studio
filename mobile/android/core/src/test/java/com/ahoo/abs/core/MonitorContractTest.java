package com.ahoo.abs.core;

import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.locks.LockSupport;

/** Pure-JDK regression for the original public-method monitor and complete atomic scopes. */
public final class MonitorContractTest {
    private static final String SESSION = "22345678-1234-4234-8234-123456789abc";
    private static final long NOW = 100000;
    private static int checks;

    private MonitorContractTest() {}

    public static void main(String[] args) throws Exception {
        boolean enabled = false;
        assert enabled = true;
        check(enabled, "Assertions must be enabled");
        sameMonitorsBeforeValidation();
        replayConsumptionIsAtomic();
        pidRecordingIsAtomic();
        observationsAreAtomicAndBounded();
        System.out.println("MonitorContractTest: " + checks + " checks passed");
    }

    private static LaunchSpec launch() {
        ProfileSpec profile = new ProfileSpec("12345678-1234-4234-8234-123456789abc",
                "32345678-1234-4234-8234-123456789abc", "Synthetic monitor fixture",
                new ProxySpec(ProxySpec.Scheme.HTTP, "proxy.invalid", 8080, false),
                "US", "UTC", Arrays.asList("en-US"), ProfileSpec.DeviceMode.NATIVE, "", "");
        return new LaunchSpec(profile, SESSION, "42345678-1234-4234-8234-123456789abc", NOW, NOW + 1000);
    }

    private static void sameMonitorsBeforeValidation() throws Exception {
        LaunchReplayGuard guard = new LaunchReplayGuard(32);
        blockedOn(guard, () -> rejects("INVALID_LAUNCH", () -> guard.consume(null, NOW)));
        RuntimeStateMachine machine = new RuntimeStateMachine(launch(), guard, NOW);
        blockedOn(machine, machine::state);
        blockedOn(machine, machine::recordedPid);
        blockedOn(machine, () -> rejects("SESSION_MISMATCH", () -> machine.recordPid("wrong", 42)));
        blockedOn(machine, () -> rejects("SESSION_MISMATCH", () -> machine.bootstrapped("wrong")));
        blockedOn(machine, () -> rejects("SESSION_MISMATCH", () -> machine.beginProbing("wrong")));
        blockedOn(machine, () -> rejects("SESSION_MISMATCH", () -> machine.applyAdmission("wrong", null)));
        blockedOn(machine, () -> rejects("SESSION_MISMATCH", () -> machine.requestDrain("wrong")));
        blockedOn(machine, () -> rejects("SESSION_MISMATCH", () -> machine.drainComplete("wrong")));
        blockedOn(machine, () -> rejects("SESSION_MISMATCH", () -> machine.finishReported("wrong")));
        blockedOn(machine, () -> rejects("SESSION_MISMATCH", () -> machine.exitTimedOut("wrong")));
        blockedOn(machine, () -> rejects("SESSION_MISMATCH", () -> machine.observeBinderDeath("wrong", true, true)));
        blockedOn(machine, () -> rejects("SESSION_MISMATCH", () -> machine.observePidCheck("wrong", 42, 3, true)));
        Ping0ObservationPolicy.BlockedDependencies observations = new Ping0ObservationPolicy.BlockedDependencies();
        blockedOn(observations, () -> observations.record("https://blocked.invalid/private?discarded=1"));
        blockedOn(observations, observations::snapshot);
        check(machine.state() == RuntimeStateMachine.State.STARTING, "Rejected messages changed state");
        check(machine.recordedPid() == 0, "Rejected messages changed PID");
    }

    private static void replayConsumptionIsAtomic() throws Exception {
        for (int iteration = 0; iteration < 16; iteration++) {
            LaunchReplayGuard guard = new LaunchReplayGuard(32);
            AtomicInteger accepted = new AtomicInteger();
            AtomicInteger replayed = new AtomicInteger();
            LaunchSpec envelope = launch();
            race(24, () -> {
                try {
                    guard.consume(envelope, NOW);
                    accepted.incrementAndGet();
                } catch (ValidationException failure) {
                    check("LAUNCH_REPLAY".equals(failure.code), "Unexpected replay rejection");
                    replayed.incrementAndGet();
                }
            });
            check(accepted.get() == 1 && replayed.get() == 23, "Duplicate replay consumption accepted");
        }
    }

    private static void pidRecordingIsAtomic() throws Exception {
        RuntimeStateMachine machine = new RuntimeStateMachine(launch(), new LaunchReplayGuard(32), NOW);
        AtomicInteger accepted = new AtomicInteger();
        AtomicInteger rejected = new AtomicInteger();
        race(24, () -> {
            try {
                machine.recordPid(SESSION, 42);
                accepted.incrementAndGet();
            } catch (ValidationException failure) {
                check("INVALID_TRANSITION".equals(failure.code), "Unexpected PID rejection");
                rejected.incrementAndGet();
            }
        });
        check(accepted.get() == 1 && rejected.get() == 23, "PID check/store is not atomic");
        check(machine.recordedPid() == 42, "Recorded PID was lost");
    }

    private static void observationsAreAtomicAndBounded() throws Exception {
        Ping0ObservationPolicy.BlockedDependencies observations = new Ping0ObservationPolicy.BlockedDependencies();
        AtomicInteger origin = new AtomicInteger();
        race(16, () -> {
            int id = origin.getAndIncrement();
            for (int i = 0; i < 500; i++) observations.record("https://h" + id + ".invalid/path?q=redacted#redacted");
        });
        Ping0ObservationPolicy.Snapshot snapshot = observations.snapshot();
        check(snapshot.blockedRequests == 8000, "Concurrent observation increments were lost");
        check(snapshot.origins.size() == Ping0ObservationPolicy.MAX_REPORTED_ORIGINS, "Origin bound changed");
        for (String value : snapshot.origins) check(!value.contains("path") && !value.contains("redacted"), "Observation retained private URL components");
        observations.record("https://late.invalid");
        check(snapshot.blockedRequests == 8000, "Snapshot was not independent");
        try {
            snapshot.origins.clear();
            throw new AssertionError("Snapshot must be immutable");
        } catch (UnsupportedOperationException expected) { checks++; }
        Field count = observations.getClass().getDeclaredField("count");
        count.setAccessible(true);
        count.setInt(observations, Integer.MAX_VALUE - 1);
        observations.record("https://synthetic.invalid");
        observations.record("https://synthetic.invalid");
        check(observations.snapshot().blockedRequests == Integer.MAX_VALUE, "Observation counter overflowed");
    }

    private static void blockedOn(Object monitor, Runnable action) throws Exception {
        CountDownLatch entered = new CountDownLatch(1);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread worker = new Thread(() -> {
            entered.countDown();
            try { action.run(); } catch (Throwable observed) { failure.set(observed); }
        }, "same-monitor-regression");
        worker.setDaemon(true);
        synchronized (monitor) {
            worker.start();
            check(entered.await(5, TimeUnit.SECONDS), "Worker did not enter");
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (worker.isAlive() && worker.getState() != Thread.State.BLOCKED && System.nanoTime() < deadline) {
                LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(1));
            }
            check(worker.getState() == Thread.State.BLOCKED, "Method no longer acquires its original monitor before validation");
        }
        worker.join(5000);
        check(!worker.isAlive(), "Worker did not leave monitor");
        if (failure.get() != null) throw new AssertionError("Worker failed", failure.get());
    }

    private static void race(int count, Runnable action) throws Exception {
        ExecutorService workers = Executors.newFixedThreadPool(count);
        CountDownLatch ready = new CountDownLatch(count);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<?>> results = new ArrayList<>();
        try {
            for (int i = 0; i < count; i++) results.add(workers.submit(() -> {
                ready.countDown();
                try { if (!start.await(5, TimeUnit.SECONDS)) throw new AssertionError("Start barrier timed out"); }
                catch (InterruptedException failure) { Thread.currentThread().interrupt(); throw new AssertionError(failure); }
                action.run();
            }));
            check(ready.await(5, TimeUnit.SECONDS), "Workers did not reach start barrier");
            start.countDown();
            for (Future<?> result : results) result.get(10, TimeUnit.SECONDS);
        } finally {
            start.countDown();
            workers.shutdownNow();
            check(workers.awaitTermination(5, TimeUnit.SECONDS), "Workers did not stop");
        }
    }

    private static void rejects(String code, Runnable action) {
        try { action.run(); throw new AssertionError("Expected validation failure"); }
        catch (ValidationException failure) { check(code.equals(failure.code), "Unexpected validation code"); }
    }

    private static synchronized void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
        checks++;
    }
}
