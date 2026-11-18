package com.ahoo.abs.android.nativekernel;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.util.AtomicFile;
import org.chromium.base.Log;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;

/**
 * Main-thread model with ordered background persistence for one immutable launch profile.
 * Directory lookup, AtomicFile recovery, reading/parsing, serialization, writing and fsync
 * all run on one serial I/O worker. The UI owns the live model and only makes bounded deep
 * copies for that worker. A runtime must retain one store per launch, not one per Activity.
 *
 * Loading never blocks browsing: edits made before it completes are replayed, in order,
 * over the loaded model. Read/write failures leave a usable in-memory model; failed writes
 * remain dirty for a later edit or explicit flush. The filename and ABSHISTv1 format remain
 * compatible with earlier versions, including exact profile-key isolation.
 */
final class BrowserHistoryStore {
    private static final String TAG = "AbsNativeHistory";
    private static final long SAVE_DELAY_MILLIS = 2000;
    private static final int MAX_LOAD_BYTES = 1024 * 1024;
    private static final Executor IO = Executors.newSingleThreadExecutor(command -> {
        Thread thread = new Thread(() -> {
            Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND);
            command.run();
        }, "AbsNativeHistory-IO");
        thread.setDaemon(true);
        return thread;
    });

    /** On main after each load/recovery publication, with pending edits already merged. */
    public interface LoadListener {
        void onHistoryLoaded();
    }

    /** On main, after this flush's earlier edits are durable, or a definite failure. */
    public interface FlushCallback {
        void onFlushed(boolean success);
    }

    private interface Mutation {
        void apply(BrowserHistory model);
    }

    private static final class TitleMutation implements Mutation {
        final String origin;
        final String title;

        TitleMutation(String origin, String title) {
            this.origin = origin;
            this.title = title;
        }

        @Override
        public void apply(BrowserHistory model) {
            model.updateTitle(origin, title);
        }
    }

    private static final class LoadRegistration {
        final LoadListener listener;
        long deliveredPublication;

        LoadRegistration(LoadListener listener) {
            this.listener = listener;
        }
    }

    private static final class HistoryTooLargeException extends IOException {
        private static final long serialVersionUID = 1L;

        HistoryTooLargeException(String message) {
            super(message);
        }
    }

    private static final class FlushRequest {
        final long revision;
        final FlushCallback callback;

        FlushRequest(long revision, FlushCallback callback) {
            this.revision = revision;
            this.callback = callback;
        }
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Context context;
    private final String isolationKey;
    private final Executor io;
    private final Runnable saveRunnable = this::requestWrite;
    private final List<Mutation> beforeLoad = new ArrayList<>();
    private final LinkedHashMap<LoadListener, LoadRegistration> loadListeners = new LinkedHashMap<>();
    private final List<FlushRequest> flushRequests = new ArrayList<>();

    // Main-thread-owned state. Revision zero is the loaded baseline, not a queued write.
    private BrowserHistory history = new BrowserHistory();
    private boolean loaded;
    private boolean loading = true;
    private boolean loadError;
    private boolean baselineAvailable;
    private boolean discardUnknownBaseline;
    private long loadPublication;
    private long revision;
    private long persistedRevision;
    private boolean writing;
    private boolean writeRequested;

    // Worker-owned, lazily initialized: Context.getNoBackupFilesDir() can itself do I/O.
    private AtomicFile atomic;
    private File file;

    BrowserHistoryStore(Context context, String profileId) {
        this(context, profileId, IO);
    }

    /** Host-test seam. The supplied executor must serialize tasks off the main thread. */
    BrowserHistoryStore(Context context, String profileId, Executor io) {
        requireMainThread();
        Context application = context.getApplicationContext();
        this.context = application == null ? context : application;
        this.isolationKey = profileId == null ? "" : profileId;
        this.io = io;
        try {
            io.execute(this::loadOnWorker);
        } catch (RuntimeException unavailable) {
            Log.w(TAG, "NATIVE_HISTORY_LOAD_FAILED", unavailable);
            main.post(() -> onLoaded(new BrowserHistory(), false, true));
        }
    }

    private static void requireMainThread() {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            throw new IllegalStateException("HISTORY_STORE_WRONG_THREAD");
        }
    }

    private static void requireWorkerThread() {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            throw new IllegalStateException("HISTORY_STORE_IO_ON_MAIN");
        }
    }

    private static String fileName(String profileId) {
        String safe = profileId == null ? "" : profileId.replaceAll("[^A-Za-z0-9_-]", "_");
        return safe.isEmpty() ? "unknown" : safe;
    }

    private AtomicFile atomicOnWorker() {
        requireWorkerThread();
        if (atomic == null) {
            file = new File(context.getNoBackupFilesDir(),
                    "native_history_" + fileName(isolationKey) + ".v1.log");
            atomic = new AtomicFile(file);
        }
        return atomic;
    }

    private byte[] readOnWorker() throws IOException {
        try (FileInputStream input = atomicOnWorker().openRead()) {
            if (input.getChannel().size() > MAX_LOAD_BYTES) {
                throw new HistoryTooLargeException("History file exceeds size cap");
            }
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                if (bytes.size() + read > MAX_LOAD_BYTES) {
                    throw new HistoryTooLargeException("History file grew past size cap");
                }
                bytes.write(buffer, 0, read);
            }
            return bytes.toByteArray();
        }
    }

    private void loadOnWorker() {
        BrowserHistory model = new BrowserHistory();
        boolean available = true;
        boolean failed = false;
        try {
            requireWorkerThread();
            String text = new String(readOnWorker(), StandardCharsets.UTF_8);
            model = BrowserHistory.deserialize(text, isolationKey);
        } catch (java.io.FileNotFoundException absent) {
            // FileNotFoundException can also mean permission denied on an existing file.
            // Only a genuinely absent base/backup in a readable directory is first use.
            available = file != null && !file.exists()
                    && !new File(file.getPath() + ".bak").exists()
                    && file.getParentFile().isDirectory() && file.getParentFile().canRead();
            failed = !available;
            if (failed) Log.w(TAG, "NATIVE_HISTORY_LOAD_FAILED", absent);
        } catch (HistoryTooLargeException oversized) {
            // Preserve the previous explicit corrupt/oversize => empty-model policy.
            failed = true;
            Log.w(TAG, "NATIVE_HISTORY_LOAD_FAILED", oversized);
        } catch (IOException | RuntimeException unreadable) {
            available = false;
            failed = true;
            Log.w(TAG, "NATIVE_HISTORY_LOAD_FAILED", unreadable);
        }
        BrowserHistory result = model;
        boolean succeeded = available;
        boolean error = failed;
        main.post(() -> onLoaded(result, succeeded, error));
    }

    private void onLoaded(BrowserHistory model, boolean available, boolean failed) {
        requireMainThread();
        loading = false;
        boolean discarded = discardUnknownBaseline;
        if (available || discarded) {
            for (Mutation mutation : beforeLoad) mutation.apply(model);
            beforeLoad.clear();
            history = model;
            baselineAvailable = true;
            discardUnknownBaseline = false;
        } else {
            // Keep both the pending-only UI model and its journal. A later flush must
            // reread+merge successfully, never overwrite unknown history with just edits.
            baselineAvailable = false;
        }
        loadError = failed && !discarded;
        loaded = true;
        publishLoadState();
        if (!baselineAvailable || (loadError && revision <= persistedRevision)) {
            // A failed clean reread completes this request; it never retries itself.
            // New dirty edits on a known size-capped baseline may still save normally.
            writeRequested = false;
            completeFlushes(revision, false);
        } else if (writeRequested || !flushRequests.isEmpty()) {
            requestWrite();
        }
    }

    private void publishLoadState() {
        loadPublication++;
        for (LoadRegistration registration : new ArrayList<>(loadListeners.values())) {
            postLoadCompletion(registration, loadPublication);
        }
    }

    public boolean isLoaded() {
        requireMainThread();
        return loaded;
    }

    /** Initial I/O attempt finished with an error; recovery keeps the model interactive. */
    public boolean hasLoadError() {
        requireMainThread();
        return loaded && loadError;
    }

    /** Already-loaded registration still posts rather than calling back reentrantly. */
    public void addLoadListener(LoadListener listener) {
        requireMainThread();
        if (listener == null || loadListeners.containsKey(listener)) return;
        LoadRegistration registration = new LoadRegistration(listener);
        loadListeners.put(listener, registration);
        if (loaded) postLoadCompletion(registration, loadPublication);
    }

    /** Cancels even a completion already posted for this registration. */
    public void removeLoadListener(LoadListener listener) {
        requireMainThread();
        loadListeners.remove(listener);
    }

    private void postLoadCompletion(LoadRegistration registration, long publication) {
        main.post(() -> {
            if (loadListeners.get(registration.listener) != registration
                    || publication != loadPublication
                    || registration.deliveredPublication >= publication) return;
            registration.deliveredPublication = publication;
            try {
                registration.listener.onHistoryLoaded();
            } catch (RuntimeException callbackFailure) {
                Log.w(TAG, "NATIVE_HISTORY_LOAD_CALLBACK_FAILED", callbackFailure);
            }
        });
    }

    /** Records one committed navigation, preserving the time it happened during load. */
    public void recordVisit(String url, String title) {
        requireMainThread();
        String origin = BrowserHistory.canonicalOrigin(url);
        if (origin == null) return;
        String cleanTitle = BrowserHistory.cleanTitle(title);
        long now = System.currentTimeMillis();
        boolean changed = history.recordVisit(origin, cleanTitle, now);
        boolean journal = loading || !baselineAvailable;
        if (journal) beforeLoad.add(model -> model.recordVisit(origin, cleanTitle, now));
        if (changed || journal) changed();
    }

    /** A pre-load title refresh also applies to a row not yet visible in the pending model. */
    public void updateTitle(String url, String title) {
        requireMainThread();
        String origin = BrowserHistory.canonicalOrigin(url);
        if (origin == null) return;
        String cleanTitle = BrowserHistory.cleanTitle(title);
        if (cleanTitle.isEmpty()) return;
        boolean changed = history.updateTitle(origin, cleanTitle);
        boolean journal = loading || !baselineAvailable;
        if (journal) {
            int last = beforeLoad.size() - 1;
            TitleMutation mutation = new TitleMutation(origin, cleanTitle);
            if (last >= 0 && beforeLoad.get(last) instanceof TitleMutation
                    && ((TitleMutation) beforeLoad.get(last)).origin.equals(origin)) {
                // No intervening navigation/remove/clear: only the last title can matter.
                beforeLoad.set(last, mutation);
            } else {
                beforeLoad.add(mutation);
            }
        }
        if (changed || journal) changed();
    }

    /** Returns whether a visible row was removed; an unseen pre-load row is removed too. */
    public boolean removeSite(String origin) {
        requireMainThread();
        String canonical = BrowserHistory.canonicalOrigin(origin);
        if (canonical == null) return false;
        boolean removed = history.removeSite(canonical);
        boolean journal = loading || !baselineAvailable;
        if (journal) beforeLoad.add(model -> model.removeSite(canonical));
        if (removed || journal) changed();
        return removed;
    }

    /** Clears records only, never cookies/storage; also masks any still-pending disk load. */
    public void clear() {
        requireMainThread();
        history.clear();
        if (loading || !baselineAvailable) {
            beforeLoad.clear();
            beforeLoad.add(BrowserHistory::clear);
            discardUnknownBaseline = true;
            if (loaded && !loading) {
                // Explicit clear authorizes dropping even an unreadable old baseline.
                beforeLoad.clear();
                discardUnknownBaseline = false;
                baselineAvailable = true;
                loadError = false;
            }
        }
        changed();
    }

    /** Returns detached rows: callers cannot mutate the live UI model or a worker snapshot. */
    public List<BrowserHistory.SiteVisit> ranked() {
        requireMainThread();
        return history.copy().ranked();
    }

    public int size() {
        requireMainThread();
        return history.size();
    }

    private void changed() {
        revision++;
        main.removeCallbacks(saveRunnable);
        main.postDelayed(saveRunnable, SAVE_DELAY_MILLIS);
    }

    /** Nonblocking lifecycle request; use the callback overload for a durability fence. */
    public void flush() {
        flush(null);
    }

    /**
     * Captures all earlier edits, waits through initialization and any earlier in-flight
     * write, and completes once a target-or-newer snapshot is durably written. Failures
     * report false exactly once and retain dirty data for a subsequent flush/edit retry.
     * There is no UI-thread disk fallback, blocking wait, or promise of process survival
     * until a successful callback has actually been delivered.
     */
    public void flush(FlushCallback callback) {
        requireMainThread();
        main.removeCallbacks(saveRunnable);
        if (callback != null) flushRequests.add(new FlushRequest(revision, callback));
        requestWrite();
    }

    private void requestWrite() {
        requireMainThread();
        writeRequested = true;
        if (!loaded || loading || writing) return;
        if (!baselineAvailable || (loadError && revision <= persistedRevision)) {
            loading = true;
            try {
                io.execute(this::loadOnWorker);
            } catch (RuntimeException unavailable) {
                Log.w(TAG, "NATIVE_HISTORY_LOAD_FAILED", unavailable);
                onLoaded(new BrowserHistory(), false, true);
            }
            return;
        }
        if (revision <= persistedRevision) {
            writeRequested = false;
            completeFlushes(persistedRevision, !loadError);
            return;
        }
        BrowserHistory snapshot = history.copy();
        long savingRevision = revision;
        writing = true;
        writeRequested = false;
        try {
            io.execute(() -> saveOnWorker(snapshot, savingRevision));
        } catch (RuntimeException unavailable) {
            Log.w(TAG, "NATIVE_HISTORY_SAVE_FAILED", unavailable);
            onWritten(savingRevision, false);
        }
    }

    private void saveOnWorker(BrowserHistory snapshot, long savingRevision) {
        boolean success = false;
        FileOutputStream output = null;
        try {
            requireWorkerThread();
            byte[] bytes = snapshot.serialize(isolationKey).getBytes(StandardCharsets.UTF_8);
            output = atomicOnWorker().startWrite();
            output.write(bytes);
            output.getFD().sync();
            atomicOnWorker().finishWrite(output);
            output = null;
            // Android AtomicFile can only log some rename/finish errors. Read back on the
            // same worker so a silently failed replacement is never a successful fence.
            if (!Arrays.equals(bytes, readOnWorker())) {
                throw new IOException("History atomic replacement verification failed");
            }
            success = true;
        } catch (IOException | RuntimeException unwritable) {
            try {
                if (output != null) atomicOnWorker().failWrite(output);
            } catch (RuntimeException recoveryFailure) {
                unwritable.addSuppressed(recoveryFailure);
            }
            Log.w(TAG, "NATIVE_HISTORY_SAVE_FAILED", unwritable);
        }
        boolean succeeded = success;
        main.post(() -> onWritten(savingRevision, succeeded));
    }

    private void onWritten(long savedRevision, boolean success) {
        requireMainThread();
        writing = false;
        if (success) {
            persistedRevision = savedRevision;
            baselineAvailable = true;
            if (loadError) {
                loadError = false;
                publishLoadState();
            }
            completeFlushes(persistedRevision, true);
        } else {
            completeFlushes(savedRevision, false);
        }
        // Coalesce requests received during this write into at most one newer snapshot.
        // Never busy-retry the same failed revision; a later flush/edit may retry it.
        boolean newerRequested = writeRequested && revision > savedRevision;
        writeRequested = false;
        if (newerRequested) requestWrite();
    }

    private void completeFlushes(long throughRevision, boolean success) {
        List<FlushCallback> completed = new ArrayList<>();
        for (Iterator<FlushRequest> iterator = flushRequests.iterator(); iterator.hasNext();) {
            FlushRequest request = iterator.next();
            if (request.revision <= throughRevision) {
                iterator.remove();
                completed.add(request.callback);
            }
        }
        for (FlushCallback callback : completed) {
            main.post(() -> {
                try {
                    callback.onFlushed(success);
                } catch (RuntimeException callbackFailure) {
                    Log.w(TAG, "NATIVE_HISTORY_FLUSH_CALLBACK_FAILED", callbackFailure);
                }
            });
        }
    }
}
