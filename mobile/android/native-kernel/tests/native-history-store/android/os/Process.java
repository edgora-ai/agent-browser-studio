package android.os;

/** Records the production worker's priority request without changing the host process. */
public final class Process {
    public static final int THREAD_PRIORITY_BACKGROUND = 10;
    public static volatile String backgroundThread;

    private Process() { }

    public static void setThreadPriority(int priority) {
        if (priority != THREAD_PRIORITY_BACKGROUND) throw new AssertionError("Unexpected worker priority");
        backgroundThread = Thread.currentThread().getName();
    }
}
