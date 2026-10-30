package com.ahoo.abs.android.nativekernel;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.ahoo.abs.android.MainActivity;
import com.ahoo.abs.android.Ui;
import com.ahoo.abs.android.browser.ControlProtocol;
import com.ahoo.abs.core.LaunchSpec;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.chromium.base.library_loader.LibraryLoader;
import org.chromium.base.library_loader.LibraryProcessType;
import org.chromium.build.annotations.Nullable;
import org.chromium.content_public.browser.BrowserStartupController;
import org.chromium.content_public.browser.BrowserStartupController.StartupMetrics;
import org.chromium.content_public.browser.DeviceUtils;
import org.chromium.content_public.browser.Visibility;
import org.chromium.content_public.browser.WebContents;
import org.chromium.content_shell.Shell;
import org.chromium.content_shell.ShellManager;
import org.chromium.ui.base.ActivityWindowAndroid;
import org.chromium.ui.base.IntentRequestTracker;
import org.json.JSONObject;

/** Non-exported product view. It never inherits the shell's Intent navigation or saved-URL restoration. */
public final class NativeBrowserActivity extends Activity {
    private final Handler main = new Handler(Looper.getMainLooper());
    private NativeBrowserApplication application;
    private NativeBrowserRuntime runtime;
    private LinearLayout root;
    private TextView status;
    private ShellManager manager;
    private ActivityWindowAndroid window;
    private IntentRequestTracker intents;
    private long generation;
    private long probeGeneration;
    private boolean closed;
    private boolean cleanupComplete;

    @Override
    protected void onCreate(Bundle savedState) {
        super.onCreate(savedState);
        root = Ui.root(this);
        status = Ui.text(this, "核对原生产品启动授权", 14);
        root.addView(status);
        root.addView(Ui.button(this, "返回环境列表（环境仍在运行）", view -> returnToList()));
        try {
            application = (NativeBrowserApplication) getApplication();
            validateIntent(getIntent());
            LaunchSpec launch = application.requireLaunch();
            if (savedState != null && !launch.sessionId.equals(savedState.getString(ControlProtocol.SESSION))) {
                throw new IllegalStateException("STALE_SAVED_STATE");
            }
            root.addView(Ui.text(this, launch.profile.name + " · 可控原生内核能力验证", 20), 0);
            root.addView(Ui.button(this, "重新采集原生时区（不是完整浏览验收）", view -> beginPreflight()));
            runtime = application.browserRuntime();
            generation = runtime.attach(this);
            DeviceUtils.updateDeviceSpecificUserAgentSwitch(this);
            application.verifyFrozenCommandLine();
            LibraryLoader.getInstance().ensureInitialized();
            manager = new ShellManager(this, null);
            manager.setVisibility(View.INVISIBLE);
            intents = IntentRequestTracker.createFromActivity(this);
            window = new ActivityWindowAndroid(this, true, intents, null, true);
            manager.setWindow(window);
            window.setAnimationPlaceholderView(manager.getContentViewRenderView().getSurfaceView());
            root.addView(manager, new LinearLayout.LayoutParams(-1, 0, 1));
            BrowserStartupController.getInstance().startBrowserProcessesAsync(
                    LibraryProcessType.PROCESS_BROWSER, true, false, false,
                    new BrowserStartupController.StartupCallback() {
                        @Override public void onSuccess(@Nullable StartupMetrics metrics) {
                            if (!current()) return;
                            try {
                                application.requireBrowserActivation();
                                manager.launchShell("about:blank");
                                restrictShellControls();
                                manager.setVisibility(View.VISIBLE);
                                beginPreflight();
                            } catch (RuntimeException failure) {
                                startupFailed("NATIVE_VIEW_INITIALIZATION_FAILED");
                            }
                        }
                        @Override public void onFailure() { startupFailed("NATIVE_BROWSER_STARTUP_FAILED"); }
                    });
        } catch (RuntimeException failure) {
            startupFailed("NATIVE_STARTUP_REJECTED");
        }
    }

    private void validateIntent(Intent intent) {
        application.requireBrowserActivation();
        LaunchSpec launch = application.requireLaunch();
        Bundle extras = intent == null ? null : intent.getExtras();
        if (intent == null || intent.getData() != null || intent.getSelector() != null
                || intent.getClipData() != null || extras == null || extras.size() != 2
                || extras.containsKey("commandLineArgs")
                || !launch.sessionId.equals(extras.getString(ControlProtocol.SESSION))
                || !launch.nonce.equals(extras.getString(ControlProtocol.NONCE))) {
            throw new IllegalStateException("STALE_OR_UNSAFE_NATIVE_ACTIVITY_INTENT");
        }
    }

    private void restrictShellControls() {
        Shell shell = manager.getActiveShell();
        if (shell == null) throw new IllegalStateException("NATIVE_SHELL_MISSING");
        View toolbar = shell.findViewById(org.chromium.content_shell.R.id.toolbar);
        View url = shell.findViewById(org.chromium.content_shell.R.id.url);
        if (toolbar == null || url == null) throw new IllegalStateException("NATIVE_SHELL_CONTROLS_MISSING");
        url.setEnabled(false);
        toolbar.setVisibility(View.GONE);
    }

    private void beginPreflight() {
        if (!current()) return;
        long probe = ++probeGeneration;
        awaitBlank(probe, SystemClock.elapsedRealtime() + 15000);
    }

    private void awaitBlank(long probe, long deadline) {
        if (!current() || probe != probeGeneration) return;
        if (SystemClock.elapsedRealtime() >= deadline) {
            runtime.failed(this, generation, "NATIVE_PREFLIGHT_DEADLINE");
            return;
        }
        try {
            application.requireBrowserActivation();
            WebContents contents = contents();
            if (contents == null || !"about:blank".equals(contents.getLastCommittedUrl().getSpec())) {
                main.postDelayed(() -> awaitBlank(probe, deadline), 100);
                return;
            }
            String script = readPreflightAsset();
            contents.evaluateJavaScript(script, ignored -> pollPreflight(probe, deadline));
        } catch (IOException | RuntimeException failure) {
            runtime.failed(this, generation, "NATIVE_PREFLIGHT_INITIALIZATION_FAILED");
        }
    }

    private String readPreflightAsset() throws IOException {
        try (InputStream input = getAssets().open("native_preflight.js")) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[1024];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (bytes.size() + count > 16384) throw new IOException("NATIVE_PREFLIGHT_ASSET_TOO_LARGE");
                bytes.write(buffer, 0, count);
            }
            return new String(bytes.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private void pollPreflight(long probe, long deadline) {
        if (!current() || probe != probeGeneration) return;
        if (SystemClock.elapsedRealtime() >= deadline) {
            runtime.failed(this, generation, "NATIVE_PREFLIGHT_DEADLINE");
            return;
        }
        WebContents contents = contents();
        if (contents == null || !"about:blank".equals(contents.getLastCommittedUrl().getSpec())) {
            runtime.failed(this, generation, "NATIVE_PREFLIGHT_DOCUMENT_CHANGED");
            return;
        }
        contents.evaluateJavaScript("window.__absNativePreflightV1 || null", json -> {
            if (!current() || probe != probeGeneration) return;
            if (SystemClock.elapsedRealtime() >= deadline) {
                runtime.failed(this, generation, "NATIVE_PREFLIGHT_DEADLINE");
                return;
            }
            try {
                application.requireBrowserActivation();
                if (contents() != contents || !"about:blank".equals(contents.getLastCommittedUrl().getSpec())) {
                    throw new IllegalStateException("NATIVE_PREFLIGHT_DOCUMENT_CHANGED");
                }
                if (json == null || json.getBytes(StandardCharsets.UTF_8).length > 65536) {
                    throw new IllegalStateException("NATIVE_PREFLIGHT_REPORT_LIMIT");
                }
                if ("null".equals(json)) {
                    main.postDelayed(() -> pollPreflight(probe, deadline), 100);
                    return;
                }
                JSONObject report = new JSONObject(json);
                Object state = report.get("state");
                if ("RUNNING".equals(state)) {
                    main.postDelayed(() -> pollPreflight(probe, deadline), 100);
                } else if ("COMPLETE".equals(state)) {
                    runtime.acceptPreflight(this, generation, report);
                } else {
                    runtime.failed(this, generation, "NATIVE_PREFLIGHT_REALM_FAILED");
                }
            } catch (Exception failure) {
                runtime.failed(this, generation, "NATIVE_PREFLIGHT_REPORT_REJECTED");
            }
        });
    }

    private boolean current() {
        return !closed && !isFinishing() && !isDestroyed() && runtime != null && runtime.isCurrent(this, generation);
    }

    private WebContents contents() {
        Shell shell = manager == null ? null : manager.getActiveShell();
        return shell == null ? null : shell.getWebContents();
    }

    void onStatus(String text) { status.setText(text); }

    private void startupFailed(String code) {
        if (!closed) status.setText("原生启动/自检未完成：" + code + "；未开放普通浏览。");
    }

    void closeNativeView() {
        if (cleanupComplete) return;
        closed = true;
        probeGeneration++;
        main.removeCallbacksAndMessages(null);
        RuntimeException failure = null;
        try {
            WebContents contents = contents();
            if (contents != null) contents.stop();
        } catch (RuntimeException stopFailure) { failure = stopFailure; }
        try {
            Shell shell = manager == null ? null : manager.getActiveShell();
            if (shell != null && !shell.isDestroyed()) shell.close();
        } catch (RuntimeException shellFailure) {
            if (failure == null) failure = shellFailure;
            else failure.addSuppressed(shellFailure);
        }
        try {
            if (manager != null) manager.destroy();
            manager = null;
        } catch (RuntimeException managerFailure) {
            if (failure == null) failure = managerFailure;
            else failure.addSuppressed(managerFailure);
        }
        try {
            if (window != null) window.destroy();
            window = null;
        } catch (RuntimeException windowFailure) {
            if (failure == null) failure = windowFailure;
            else failure.addSuppressed(windowFailure);
        }
        if (failure != null) throw new IllegalStateException("NATIVE_VIEW_CLOSE_UNCONFIRMED", failure);
        cleanupComplete = true;
    }

    private void returnToList() {
        Intent home = new Intent(this, MainActivity.class);
        home.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(home);
        finish();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        try { validateIntent(intent); }
        catch (RuntimeException rejected) { startupFailed("NATIVE_NEW_INTENT_REJECTED"); }
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        if (application != null) {
            try { state.putString(ControlProtocol.SESSION, application.requireLaunch().sessionId); }
            catch (IllegalStateException rejected) { state.putString(ControlProtocol.SESSION, "rejected"); }
        }
        super.onSaveInstanceState(state);
    }

    @Override
    protected void onStart() {
        super.onStart();
        WebContents contents = contents();
        if (contents != null) contents.updateWebContentsVisibility(Visibility.VISIBLE);
    }

    @Override
    protected void onStop() {
        WebContents contents = contents();
        if (contents != null) contents.updateWebContentsVisibility(Visibility.HIDDEN);
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        try { closeNativeView(); }
        finally {
            if (runtime != null) runtime.detach(this);
            super.onDestroy();
        }
    }
}
