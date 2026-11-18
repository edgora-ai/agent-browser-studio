package android.os;

import java.util.ArrayList;
import java.util.List;

/** Deterministic main queue. Worker tasks run on real, separate host threads. */
public final class Looper {
    private static final Looper MAIN = new Looper(Thread.currentThread());
    private static final List<Task> TASKS = new ArrayList<>();
    private static long now;
    private static long sequence;
    private final Thread owner;

    private static final class Task {
        final Handler handler;
        final Runnable runnable;
        final long at;
        final long order;

        Task(Handler handler, Runnable runnable, long at, long order) {
            this.handler = handler;
            this.runnable = runnable;
            this.at = at;
            this.order = order;
        }
    }

    private Looper(Thread owner) {
        this.owner = owner;
    }

    public static Looper getMainLooper() {
        return MAIN;
    }

    public static Looper myLooper() {
        return Thread.currentThread() == MAIN.owner ? MAIN : null;
    }

    static synchronized void post(Handler handler, Runnable runnable, long delay) {
        TASKS.add(new Task(handler, runnable, now + delay, sequence++));
        Looper.class.notifyAll();
    }

    static synchronized void remove(Handler handler, Runnable runnable) {
        TASKS.removeIf(task -> task.handler == handler && task.runnable == runnable);
    }

    public static boolean runOneMain() {
        if (myLooper() != MAIN) throw new AssertionError("Host main queue run off main");
        Task next = null;
        synchronized (Looper.class) {
            for (Task task : TASKS) {
                if (task.at <= now && (next == null || task.at < next.at
                        || (task.at == next.at && task.order < next.order))) next = task;
            }
            if (next == null) return false;
            TASKS.remove(next);
        }
        next.runnable.run();
        return true;
    }

    public static void idleMain() {
        int count = 0;
        while (runOneMain()) {
            if (++count > 10000) throw new AssertionError("Unbounded host main queue");
        }
    }

    public static void advanceBy(long millis) {
        synchronized (Looper.class) {
            now += millis;
        }
        idleMain();
    }

    public static synchronized int taskCount() {
        return TASKS.size();
    }

    public static synchronized void resetForTest() {
        if (!TASKS.isEmpty()) throw new AssertionError("Previous test left scheduled main work");
        now = 0;
    }

    public static synchronized void awaitPostedTask(long timeoutMillis) throws InterruptedException {
        long deadline = System.nanoTime() + timeoutMillis * 1_000_000L;
        while (TASKS.isEmpty()) {
            long remaining = deadline - System.nanoTime();
            if (remaining <= 0) throw new AssertionError("Production worker never posted completion");
            Looper.class.wait(Math.max(1L, remaining / 1_000_000L));
        }
    }
}
