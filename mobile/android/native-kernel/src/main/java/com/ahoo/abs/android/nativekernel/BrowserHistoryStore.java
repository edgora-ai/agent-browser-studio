package com.ahoo.abs.android.nativekernel;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.AtomicFile;
import org.chromium.base.Log;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * Main-thread persistence for one profile's {@link BrowserHistory}. Records live in the
 * app's no-backup private directory in a file keyed by the immutable launch profile id, so
 * histories are never shared across profiles and survive process exit and app updates.
 * Writes are debounced and atomic via {@link AtomicFile}: a failed write is rolled back to
 * the previous complete file and never lands partially. Loads are size-capped, and a failed
 * load or save degrades to in-memory history instead of breaking browsing.
 */
final class BrowserHistoryStore {
    private static final String TAG = "AbsNativeHistory";
    private static final long SAVE_DELAY_MILLIS = 2000;
    private static final int MAX_LOAD_BYTES = 1024 * 1024;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final File file;
    private final AtomicFile atomic;
    private final String isolationKey;
    private final Runnable saveRunnable = this::flush;
    private BrowserHistory history = new BrowserHistory();
    private boolean dirty;

    BrowserHistoryStore(Context context, String profileId) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            throw new IllegalStateException("HISTORY_STORE_WRONG_THREAD");
        }
        isolationKey = profileId == null ? "" : profileId;
        file = new File(context.getNoBackupFilesDir(),
                "native_history_" + fileName(profileId) + ".v1.log");
        atomic = new AtomicFile(file);
        load();
    }

    private static String fileName(String profileId) {
        String safe = profileId == null ? "" : profileId.replaceAll("[^A-Za-z0-9_-]", "_");
        return safe.isEmpty() ? "unknown" : safe;
    }

    private void load() {
        String text = null;
        try (FileInputStream input = atomic.openRead()) {
            if (input.getChannel().size() > MAX_LOAD_BYTES) throw new IOException("History file exceeds size cap");
            java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                if (bytes.size() + read > MAX_LOAD_BYTES) throw new IOException("History file grew past size cap");
                bytes.write(buffer, 0, read);
            }
            text = new String(bytes.toByteArray(), StandardCharsets.UTF_8);
        } catch (java.io.FileNotFoundException absent) {
            // Normal on first use. AtomicFile.openRead also restores a surviving backup.
        } catch (IOException | RuntimeException unreadable) {
            Log.w(TAG, "NATIVE_HISTORY_LOAD_FAILED", unreadable);
        }
        // deserialize() returns an empty model unless the isolation key matches exactly.
        history = BrowserHistory.deserialize(text, isolationKey);
    }

    /** Records one committed page navigation; the visit count respects the merge window. */
    public void recordVisit(String url, String title) {
        if (history.recordVisit(url, title, System.currentTimeMillis())) scheduleSave();
    }

    /** Refreshes a known page's title without incrementing its visit count. */
    public void updateTitle(String url, String title) {
        if (history.updateTitle(url, title)) scheduleSave();
    }

    /** Removes one site from history; returns true when something was removed. */
    public boolean removeSite(String origin) {
        boolean removed = history.removeSite(origin);
        if (removed) scheduleSave();
        return removed;
    }

    /** Clears all history (records only; never touches site cookies or storage). */
    public void clear() {
        history.clear();
        scheduleSave();
    }

    public List<BrowserHistory.SiteVisit> ranked() {
        return history.ranked();
    }

    public int size() {
        return history.size();
    }

    private void scheduleSave() {
        dirty = true;
        main.removeCallbacks(saveRunnable);
        main.postDelayed(saveRunnable, SAVE_DELAY_MILLIS);
    }

    /**
     * Cancels the pending debounced write and flushes to disk when dirty. Main thread only.
     * AtomicFile guarantees the previous complete file survives a failed write; on failure
     * the store stays dirty for the next scheduled or lifecycle flush.
     */
    public void flush() {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            throw new IllegalStateException("HISTORY_STORE_WRONG_THREAD");
        }
        main.removeCallbacks(saveRunnable);
        if (!dirty) return;
        dirty = false;
        FileOutputStream output = null;
        try {
            byte[] bytes = history.serialize(isolationKey).getBytes(StandardCharsets.UTF_8);
            output = atomic.startWrite();
            output.write(bytes);
            output.getFD().sync();
            atomic.finishWrite(output);
        } catch (IOException | RuntimeException unwritable) {
            dirty = true;
            try { if (output != null) atomic.failWrite(output); }
            catch (RuntimeException recoveryFailure) { unwritable.addSuppressed(recoveryFailure); }
            Log.w(TAG, "NATIVE_HISTORY_SAVE_FAILED", unwritable);
        }
    }
}
