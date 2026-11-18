package android.os;

/** API subset used by the actual production Store. */
public final class Handler {
    public Handler(Looper looper) {
        if (looper != Looper.getMainLooper()) throw new AssertionError("Unexpected host Handler looper");
    }

    public boolean post(Runnable runnable) {
        Looper.post(this, runnable, 0);
        return true;
    }

    public boolean postDelayed(Runnable runnable, long delayMillis) {
        Looper.post(this, runnable, delayMillis);
        return true;
    }

    public void removeCallbacks(Runnable runnable) {
        Looper.remove(this, runnable);
    }
}
