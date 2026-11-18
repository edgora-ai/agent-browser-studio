package com.ahoo.abs.android.nativekernel;

import android.os.Build;
import android.os.Looper;
import android.os.Handler;
import org.chromium.base.Log;
import org.chromium.base.library_loader.LibraryLoader;
import org.chromium.content_public.browser.BrowserStartupController;
import org.chromium.content_shell.ShellManager;
import com.ahoo.abs.android.process.BrowserProcessRuntime;
import com.ahoo.abs.core.AdmissionGate;
import com.ahoo.abs.core.LaunchSpec;
import com.ahoo.abs.core.ProfileSpec;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Owned native view and read-only timezone preflight; configuration flags are not network or storage proof. */
public final class NativeBrowserRuntime implements BrowserProcessRuntime {
    private static final String TAG = "AbsNativeRuntime";
    private enum Proof { UNVERIFIED, VERIFIED, UNSUPPORTED }
    private final NativeBrowserApplication application;
    final LaunchSpec launch;
    private final Proof proxyConfiguration = Proof.UNVERIFIED;
    private final Proof proxyAuthentication = Proof.UNSUPPORTED;
    private final Proof completeIdentity = Proof.UNVERIFIED;
    private final Proof networkConfinement = Proof.UNVERIFIED;
    private final Proof storageLifecycle = Proof.UNVERIFIED;
    private NativeBrowserActivity view;
    private BrowserHistoryStore historyStore;
    private long generation;
    private boolean draining;
    private boolean drainReturned;
    private Runnable drainTimeout;
    private final Handler main = new Handler(Looper.getMainLooper());
    private static final long DRAIN_TIMEOUT_MS = 5000;
    private String status;

    NativeBrowserRuntime(NativeBrowserApplication application) {
        requireMain();
        application.requireBrowserActivation();
        this.application = application;
        launch = application.requireLaunch();
        status = launch.profile.isDirect()
                ? "原生独立环境；不使用代理（直连），网站可见设备网络出口，DNS 使用正常解析；不提供代理保护。完整身份和存储能力需实测验收。"
                : "原生独立环境；固定代理与独立资料目录已配置，完整身份和存储能力需实测验收。";
        if (launch.profile.hasProxyCredentials() || launch.profile.deviceMode != ProfileSpec.DeviceMode.NATIVE
                || !Build.MODEL.equals(launch.profile.deviceModel)) {
            throw new IllegalStateException("NATIVE_PROFILE_CAPABILITY_UNSUPPORTED");
        }
    }

    long attach(NativeBrowserActivity activity) {
        requireMain();
        application.requireBrowserActivation();
        if (draining) throw new IllegalStateException("RUNTIME_DRAINING");
        if (view != null && view != activity) throw new IllegalStateException("RUNTIME_VIEW_BUSY");
        view = activity;
        activity.onStatus(status);
        return ++generation;
    }

    boolean isCurrent(NativeBrowserActivity activity, long expectedGeneration) {
        requireMain();
        return !draining && !application.isDraining() && view == activity && generation == expectedGeneration;
    }

    void acceptPreflight(NativeBrowserActivity activity, long expectedGeneration, JSONObject report) throws JSONException {
        requireMain();
        if (!isCurrent(activity, expectedGeneration)) return;
        application.requireBrowserActivation();
        if (!(report.get("schemaVersion") instanceof Integer) || report.getInt("schemaVersion") != 1
                || !"COMPLETE".equals(report.get("state"))) throw new JSONException("NATIVE_PREFLIGHT_SCHEMA");
        JSONArray workers = report.getJSONArray("workers");
        if (workers.length() != 2) throw new JSONException("NATIVE_PREFLIGHT_WORKER_COUNT");
        String window = sample(report.getJSONObject("window"));
        String first = sample(workers.getJSONObject(0));
        String second = sample(workers.getJSONObject(1));
        update("已采集真实原生时区子集：\nWindow " + window + "\nDedicated Worker 1 " + first
                + "\nDedicated Worker 2 " + second
                + "\n已按顺序调用 Worker terminate/recreate；这不是线程退出、完整身份或 Ping0 通过证明。"
                + "\n以上仅为时区子集；不代表网络隔离、代理认证或完整存储持久性通过。");
    }

    private static String sample(JSONObject sample) throws JSONException {
        Object zone = sample.get("timeZone");
        Object offset = sample.get("offsetMinutes");
        if (!(zone instanceof String) || ((String) zone).isEmpty() || ((String) zone).length() > 128
                || !((String) zone).matches("[A-Za-z0-9/_+\\-]+") || !(offset instanceof Integer)
                || (Integer) offset < -1440 || (Integer) offset > 1440) {
            throw new JSONException("NATIVE_PREFLIGHT_SAMPLE");
        }
        return zone + " · offset=" + offset;
    }

    void failed(NativeBrowserActivity activity, long expectedGeneration, String code) {
        requireMain();
        if (isCurrent(activity, expectedGeneration)) update("原生自检未完成：" + code + "；该结果不代表网络隔离或存储持久性通过。");
    }

    public AdmissionGate.Decision decision() {
        return AdmissionGate.evaluate(launch.profile, new AdmissionGate.Evidence(
                proxyConfiguration == Proof.VERIFIED, proxyAuthentication == Proof.VERIFIED,
                completeIdentity == Proof.VERIFIED, networkConfinement == Proof.VERIFIED,
                storageLifecycle == Proof.VERIFIED));
    }

    /** One UI-owned model/worker pipeline survives Activity recreation within this launch. */
    BrowserHistoryStore historyStore() {
        requireMain();
        if (draining) throw new IllegalStateException("HISTORY_RUNTIME_DRAINING");
        if (historyStore == null) historyStore = new BrowserHistoryStore(application, launch.profile.id);
        return historyStore;
    }

    void detach(NativeBrowserActivity activity) {
        requireMain();
        if (view == activity) {
            view = null;
            generation++;
        }
    }

    @Override
    public void beginDrain(DrainCallback callback) {
        requireMain();
        if (draining) throw new IllegalStateException("DRAIN_ALREADY_STARTED");
        draining = true;
        final long drainGeneration = ++generation;
        final NativeBrowserActivity current = view;
        view = null;
        drainTimeout = () -> finishDrain(drainGeneration, current, callback, "TIMED_OUT");
        main.postDelayed(drainTimeout, DRAIN_TIMEOUT_MS);
        // Neither an enqueued history save nor a native-only acknowledgment permits exit.
        // Keep independent completions local to this drain; the existing timeout bounds both.
        final class StorageBarrier {
            Boolean historyConfirmed;
            String nativeOutcome;
            boolean quiesced = true;

            void completeIfReady() {
                if (historyConfirmed == null || nativeOutcome == null) return;
                finishDrain(drainGeneration, current, callback,
                        quiesced && Boolean.TRUE.equals(historyConfirmed) ? nativeOutcome : "FAILED");
            }
        }
        StorageBarrier barrier = new StorageBarrier();
        try {
            // Revoke interaction and hide/stop live pages, keeping Shells/BrowserContext
            // alive until both storage attempts reply (or the bounded timeout expires).
            if (current != null) current.quiesceForShutdown();
        } catch (RuntimeException | LinkageError failure) {
            barrier.quiesced = false;
        }
        try {
            if (historyStore == null) {
                barrier.historyConfirmed = true; // This runtime never opened or edited history.
            } else {
                historyStore.flush(confirmed -> {
                    barrier.historyConfirmed = confirmed;
                    barrier.completeIfReady();
                });
            }
        } catch (RuntimeException | LinkageError failure) {
            barrier.historyConfirmed = false;
        }
        try {
            // A loaded library does not imply that BrowserThread/UI and the native
            // task runner exist. Startup can fail after load but before ContentMain.
            if (!LibraryLoader.getInstance().isInitialized()
                    || !BrowserStartupController.getInstance().isFullBrowserStarted()) {
                barrier.nativeOutcome = "NOT_ATTEMPTED";
            } else {
                ShellManager.flushPersistentStorageForShutdown(confirmed -> {
                    barrier.nativeOutcome = Boolean.TRUE.equals(confirmed)
                            ? "LOCAL_STORAGE_CONFIRMED_COOKIE_ACK" : "FAILED";
                    barrier.completeIfReady();
                });
            }
        } catch (RuntimeException | LinkageError failure) {
            barrier.nativeOutcome = "FAILED";
        }
        barrier.completeIfReady();
    }

    private void finishDrain(long expectedGeneration, NativeBrowserActivity current,
            DrainCallback callback, String outcome) {
        requireMain();
        if (!draining || drainReturned || generation != expectedGeneration) return;
        drainReturned = true;
        if (drainTimeout != null) main.removeCallbacks(drainTimeout);
        drainTimeout = null;
        String result = outcome;
        try {
            if (current != null) {
                current.closeNativeView();
                Log.i(TAG, "DRAIN_NATIVE_VIEW_CLOSED");
                // Remove only this Activity record after native teardown returns. finish()
                // is neither process death nor an additional storage-durability receipt.
                current.finish();
                Log.i(TAG, "DRAIN_ACTIVITY_FINISH_REQUESTED");
            }
        } catch (RuntimeException | LinkageError failure) {
            result = "FAILED";
            Log.w(TAG, "DRAIN_VIEW_TEARDOWN_FAILED");
        }
        final String delivered = result;
        // One Android main-loop turn lets already posted teardown work run before
        // the controller can request self-exit. This is not a teardown/fsync proof.
        main.post(() -> callback.onDrained(delivered));
    }

    private void update(String value) {
        status = value;
        if (view != null) view.onStatus(value);
    }

    private static void requireMain() {
        if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("NATIVE_RUNTIME_WRONG_THREAD");
    }
}
