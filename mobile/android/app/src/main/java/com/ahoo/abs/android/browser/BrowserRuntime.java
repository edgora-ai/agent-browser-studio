package com.ahoo.abs.android.browser;

import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.HttpAuthHandler;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.ProxyConfig;
import androidx.webkit.ProxyController;
import androidx.webkit.ServiceWorkerClientCompat;
import androidx.webkit.ServiceWorkerControllerCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.ahoo.abs.android.BrowserApplication;
import com.ahoo.abs.android.R;
import com.ahoo.abs.android.data.BootstrapStore;
import com.ahoo.abs.core.AdmissionGate;
import com.ahoo.abs.core.Ping0ObservationPolicy;
import com.ahoo.abs.core.LaunchSpec;
import com.ahoo.abs.core.NavigationPolicy;
import com.ahoo.abs.core.ProfileSpec;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

/** One immutable profile and one WebView for this process incarnation. */
public final class BrowserRuntime {
    public interface Listener { void onStatus(String status); }
    public interface DrainCallback { void onDrained(String cookieFlush); }
    private enum Proof { UNVERIFIED, VERIFIED, UNSUPPORTED }
    private static final class Observation {
        final Ping0ObservationPolicy.Grant grant;
        final Ping0ObservationPolicy.BlockedDependencies blocked = new Ping0ObservationPolicy.BlockedDependencies();
        final AtomicBoolean updatePending = new AtomicBoolean();
        Observation(Ping0ObservationPolicy.Grant grant) { this.grant = grant; }
    }
    private final BrowserApplication application;
    public final LaunchSpec launch;
    private final String launchHash;
    private volatile Observation observation;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService storage = Executors.newSingleThreadExecutor();
    private final BootstrapStore store;
    private final ProbeAssets assets;
    private final StorageProbe storageProbe;
    private final Proof networkConfinement = Proof.UNSUPPORTED;
    private final Proof proxyAuthentication = Proof.UNSUPPORTED;
    private final Proof storageLifecycle = Proof.UNVERIFIED;
    private volatile boolean proxyConfigured;
    private boolean proxyConfigurationExpired;
    private volatile boolean draining;
    private String provider;
    private volatile String challenge;
    private volatile String probeUrl;
    private long probeDeadline;
    private WebView webView;
    private android.content.MutableContextWrapper viewContext;
    private Listener listener;
    private volatile IdentityReport.Result identity;
    private String status = "等待内核能力验证";

    public BrowserRuntime(BrowserApplication application) {
        application.requireBrowserActivation();
        this.application = application;
        launch = application.requireLaunch();
        launchHash = launch.configHash();
        store = new BootstrapStore(application);
        assets = new ProbeAssets(application);
        storageProbe = new StorageProbe(application, this::update);
    }

    public static BrowserRuntime get(BrowserApplication application) {
        return application.browserRuntime();
    }

    public static BrowserRuntime existing(BrowserApplication application) {
        return application.existingBrowserRuntime();
    }

    public boolean isDraining() { return draining; }

    public WebView acquireView(android.app.Activity activity) {
        requireMain();
        if (draining) throw new IllegalStateException("RUNTIME_DRAINING");
        if (webView == null) {
            viewContext = new android.content.MutableContextWrapper(activity);
            return new WebView(viewContext);
        }
        if (webView.getParent() instanceof android.view.ViewGroup) {
            ((android.view.ViewGroup) webView.getParent()).removeView(webView);
        }
        viewContext.setBaseContext(activity);
        return webView;
    }

    public void attach(WebView view, Listener listener) {
        requireMain();
        if (draining) throw new IllegalStateException("RUNTIME_DRAINING");
        this.listener = listener;
        if (webView == view) {
            update(status);
            return;
        }
        if (webView != null) throw new IllegalStateException("RUNTIME_VIEW_BUSY");
        webView = view;
        WebView.setWebContentsDebuggingEnabled(false);
        if (launch.profile.proxy.hasCredentials) {
            update("已阻止：公开 WebView 认证回调不能安全绑定代理身份，未发送凭据。");
            return;
        }
        if (launch.profile.deviceMode != ProfileSpec.DeviceMode.NATIVE
                || !launch.profile.deviceModel.equals(Build.MODEL)) {
            update("已阻止：该设备预设没有真实硬件校准，未降级为本机身份。");
            return;
        }
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
            update("已阻止：当前系统 WebView 缺少代理覆盖能力。");
            return;
        }
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            update("已阻止：当前系统 WebView 缺少安全消息桥能力。");
            return;
        }
        PackageInfo info = WebView.getCurrentWebViewPackage();
        if (info == null || info.versionName == null) {
            update("已阻止：无法确认实际 WebView provider 版本。");
            return;
        }
        provider = info.packageName + "@" + info.versionName;
        phase(BootstrapStore.RuntimePhase.PROVIDER_VERIFIED);
        configureView(view);
        configureServiceWorkers();
        storageProbe.attach(view);
        Set<String> origins = new HashSet<>(Arrays.asList("https://" + ProbeAssets.MAIN_HOST));
        WebViewCompat.addWebMessageListener(view, "AbsProbe", origins,
                (source, message, origin, isMainFrame, reply) -> {
                    String text = message.getData();
                    if (!isMainFrame || !"https".equals(origin.getScheme())
                            || !ProbeAssets.MAIN_HOST.equals(origin.getHost())
                            || origin.getUserInfo() != null || (origin.getPort() != -1 && origin.getPort() != 443)
                            || draining || observation != null || challenge == null || probeUrl == null
                            || !probeUrl.equals(source.getUrl()) || text == null) return;
                    acceptReport(text);
                });
        ProxyConfig config = new ProxyConfig.Builder()
                .addProxyRule(launch.profile.proxy.proxyRule()).removeImplicitRules().build();
        phase(BootstrapStore.RuntimePhase.PROXY_PENDING);
        update("正在配置代理；尚未开放普通网页。");
        long proxyDeadline = android.os.SystemClock.elapsedRealtime() + 10000;
        main.postDelayed(() -> {
            if (!draining && !proxyConfigured) {
                proxyConfigurationExpired = true;
                update("代理配置回调超时；未加载页面，没有转直连或接受迟到成功。");
            }
        }, 10000);
        ProxyController.getInstance().setProxyOverride(config, application.getMainExecutor(), () -> {
            if (draining || proxyConfigurationExpired) return;
            if (android.os.SystemClock.elapsedRealtime() >= proxyDeadline) {
                proxyConfigurationExpired = true;
                update("代理配置完成回执已过期，未加载网页。");
                return;
            }
            try {
                BootstrapStore.ActiveLaunch active = store.findLaunch(launch.sessionId);
                if (active == null || active.state != BootstrapStore.State.CLAIMED
                        || active.pid != android.os.Process.myPid()
                        || !application.incarnation().equals(active.incarnationId)) return;
                proxyConfigured = true;
                phase(BootstrapStore.RuntimePhase.PROXY_READY);
                phase(BootstrapStore.RuntimePhase.WEBVIEW_CREATED);
                startProbe();
            } catch (RuntimeException failure) {
                proxyConfigured = false;
                update("代理/运行态配置未提交，未开放浏览：" + com.ahoo.abs.android.Ui.errorCode(failure));
            }
        });
    }

    private void configureView(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSafeBrowsingEnabled(true);
        view.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                return interceptRequest(request);
            }
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (draining) return true;
                if (storageProbe.isActive()) return !storageProbe.allowsNavigation(request);
                Observation observed = observation;
                if (observed != null) {
                    if (allowsObservation(observed, request)) return false;
                    recordBlockedDependency(observed, uri.toString());
                    update(application.getString(R.string.ping0_observation_navigation_blocked));
                    return true;
                }
                if (probeUrl != null && probeUrl.equals(uri.toString())) return false;
                if (decision().status != AdmissionGate.Status.VERIFIED) {
                    update("普通浏览未开放：网络约束及存储生命周期尚未通过验证。");
                    return true;
                }
                try {
                    NavigationPolicy.normalize(uri.toString());
                    return !"https".equals(uri.getScheme());
                } catch (IllegalArgumentException invalid) {
                    update("已阻止不支持的导航协议。");
                    return true;
                }
            }
            @Override public void onReceivedSslError(WebView v, SslErrorHandler handler, android.net.http.SslError error) {
                handler.cancel();
                update("TLS 验证失败，已取消连接；没有忽略证书错误。");
            }
            @Override public void onReceivedHttpAuthRequest(WebView v, HttpAuthHandler handler, String host, String realm) {
                handler.cancel();
                update("已取消无法安全区分网站/代理身份的 HTTP 认证请求。");
            }
        });
        view.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean gesture, android.os.Message result) {
                update(application.getString(R.string.ping0_observation_window_blocked));
                return false;
            }
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
            @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                callback.invoke(origin, false, false);
            }
        });
    }

    private void configureServiceWorkers() {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE)) {
            ServiceWorkerControllerCompat.getInstance().setServiceWorkerClient(new ServiceWorkerClientCompat() {
                @Override public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                    return interceptRequest(request);
                }
            });
        }
    }

    /** WEB and SW deliberately share this scope check; it is not transport confinement. */
    private WebResourceResponse interceptRequest(WebResourceRequest request) {
        if (storageProbe.isReserved(request.getUrl())) return draining ? ProbeAssets.denied() : storageProbe.intercept(request);
        if (storageProbe.isActive()) return ProbeAssets.denied();
        Observation observed = observation;
        if (observed != null) {
            if (allowsObservation(observed, request)) return null;
            recordBlockedDependency(observed, request.getUrl().toString());
            return ProbeAssets.denied();
        }
        if (assets.isReserved(request.getUrl())) return assets.intercept(request.getUrl());
        return !draining && decision().status == AdmissionGate.Status.VERIFIED ? null : ProbeAssets.denied();
    }

    private boolean observationActive(Observation observed) {
        return !draining && observation == observed && observed.grant.isActive(launch.sessionId, launchHash,
                application.incarnation(), android.os.SystemClock.elapsedRealtime());
    }

    private boolean allowsObservation(Observation observed, WebResourceRequest request) {
        return !draining && observation == observed && observed.grant.allowsRequest(launch.sessionId, launchHash,
                application.incarnation(), android.os.SystemClock.elapsedRealtime(), request.getUrl().toString(),
                request.isForMainFrame(), request.getMethod());
    }

    private void recordBlockedDependency(Observation observed, String url) {
        if (!observationActive(observed)) return;
        observed.blocked.record(url);
        if (observed.updatePending.compareAndSet(false, true)) {
            main.post(() -> {
                observed.updatePending.set(false);
                if (observationActive(observed)) showObservation(observed);
            });
        }
    }

    private String dependencySummary(Observation observed) {
        Ping0ObservationPolicy.Snapshot snapshot = observed.blocked.snapshot();
        return snapshot.blockedRequests == 0 ? application.getString(R.string.ping0_observation_no_blocked)
                : application.getString(R.string.ping0_observation_partial, snapshot.blockedRequests,
                        Ping0ObservationPolicy.MAX_REPORTED_ORIGINS, String.join(", ", snapshot.origins));
    }

    private void showObservation(Observation observed) {
        if (observation != observed) return;
        update(application.getString(R.string.ping0_observation_active, Ping0ObservationPolicy.DURATION_MILLIS / 1000));
    }

    private void startProbe() {
        storageProbe.revoke();
        revokeObservation(R.string.ping0_observation_self_test, false);
        challenge = UUID.randomUUID().toString();
        probeDeadline = android.os.SystemClock.elapsedRealtime() + 15000;
        probeUrl = ProbeAssets.INDEX + "#challenge=" + challenge;
        update("代理配置回调已返回；正在采集六个执行环境的真实值。网络无泄漏仍未证明。");
        webView.loadUrl(probeUrl);
        String currentChallenge = challenge;
        main.postDelayed(() -> {
            if (!draining && currentChallenge.equals(challenge) && identity == null) {
                update("身份自检未完成：超过采集截止时间。未开放普通浏览。");
            }
        }, 15000);
    }

    private void acceptReport(String text) {
        requireMain();
        if (draining || observation != null || challenge == null || probeUrl == null || identity != null) return;
        if (android.os.SystemClock.elapsedRealtime() >= probeDeadline
                || text.getBytes(StandardCharsets.UTF_8).length > 65536) {
            update("身份报告超时或超限，未扩大验证范围。");
            return;
        }
        try {
            JSONTokener tokener = new JSONTokener(text);
            Object value = tokener.nextValue();
            if (!(value instanceof JSONObject) || tokener.nextClean() != 0) throw new JSONException("INVALID_REPORT");
            JSONObject report = (JSONObject) value;
            if (!challenge.equals(report.opt("challenge"))) return;
            identity = IdentityReport.evaluate(launch.profile, challenge, report);
            update((identity.identityVerified ? "已采集到一致的时区/语言子集。" : "身份自检不满足配置：" + String.join(", ", identity.reasons))
                    + "\n普通浏览仍未开放：DNS/WebRTC/UDP 等网络约束及正常切换的存储持久性未验证。"
                    + "\nPing0：未运行。硬件模拟：未实现。");
        } catch (JSONException malformed) {
            update("身份报告格式错误，未开放普通浏览。");
        }
    }

    public AdmissionGate.Decision decision() {
        IdentityReport.Result observed = identity;
        return AdmissionGate.evaluate(launch.profile, new AdmissionGate.Evidence(proxyConfigured,
                proxyAuthentication == Proof.VERIFIED, observed != null && observed.identityVerified,
                networkConfinement == Proof.VERIFIED, storageLifecycle == Proof.VERIFIED));
    }

    public void openStorageProbe(Listener owner) {
        requireMain();
        if (owner == null || listener != owner) throw new IllegalStateException("STORAGE_PROBE_STALE_VIEW");
        application.requireBrowserActivation();
        if (draining || webView == null || !proxyConfigured || proxyConfigurationExpired) {
            throw new IllegalStateException("STORAGE_PROBE_NOT_READY");
        }
        revokeObservation(R.string.ping0_observation_leave, false);
        challenge = null;
        probeUrl = null;
        storageProbe.open(webView);
    }

    public void cancelStorageProbe(Listener owner) {
        requireMain();
        if (listener != owner) return;
        try {
            storageProbe.cancel(webView);
        } catch (RuntimeException failure) {
            update("存储诊断许可已撤销，但页面卸载未确认：" + com.ahoo.abs.android.Ui.errorCode(failure));
        }
    }

    /** No URL argument: only a native-confirmed, fixed-target observation can enter this path. */
    public void openPing0Observation(Listener owner) {
        requireMain();
        if (owner == null || listener != owner) throw new IllegalStateException("PING0_OBSERVATION_STALE_VIEW");
        storageProbe.revoke();
        revokeObservation(R.string.ping0_observation_leave, true);
        application.requireBrowserActivation();
        if (draining || webView == null || !proxyConfigured || proxyConfigurationExpired
                || launch.profile.proxy.hasCredentials || launch.profile.deviceMode != ProfileSpec.DeviceMode.NATIVE
                || !launch.profile.deviceModel.equals(Build.MODEL)) {
            throw new IllegalStateException("PING0_OBSERVATION_NOT_READY");
        }
        // Invalidate both the local bridge provenance and its outstanding deadline before leaving.
        challenge = null;
        probeUrl = null;
        webView.stopLoading();
        Observation observed = new Observation(Ping0ObservationPolicy.issue(launch.sessionId, launchHash,
                application.incarnation(), android.os.SystemClock.elapsedRealtime()));
        observation = observed;
        showObservation(observed);
        main.postDelayed(() -> {
            if (observation == observed) revokeObservation(R.string.ping0_observation_expired, true);
        }, Math.max(0, observed.grant.expiresAtMillis - android.os.SystemClock.elapsedRealtime()));
        try {
            webView.loadUrl(Ping0ObservationPolicy.TARGET);
        } catch (RuntimeException failure) {
            revokeObservation(R.string.ping0_observation_leave, true);
            throw failure;
        }
    }

    public void cancelPing0Observation(Listener owner) {
        requireMain();
        if (listener == owner) revokeObservation(R.string.ping0_observation_leave, true);
    }

    private void revokeObservation(int reason, boolean unloadDocument) {
        Observation previous = observation;
        if (previous == null) return;
        previous.grant.revoke();
        observation = null;
        challenge = null;
        probeUrl = null;
        String unloadFailure = "";
        if (unloadDocument && webView != null) {
            try {
                webView.stopLoading();
                webView.loadUrl("about:blank");
            } catch (RuntimeException failure) {
                unloadFailure = "\n" + application.getString(R.string.ping0_observation_unload_failed,
                        com.ahoo.abs.android.Ui.errorCode(failure));
            }
        }
        update(application.getString(R.string.ping0_observation_banner) + "\n"
                + application.getString(R.string.ping0_observation_revoked, application.getString(reason))
                + "\n" + dependencySummary(previous) + unloadFailure);
    }

    public void navigate(String value) {
        requireMain();
        if (draining || decision().status != AdmissionGate.Status.VERIFIED) {
            update("已阻止导航：" + String.join(", ", decision().reasons));
            return;
        }
        java.net.URI uri = NavigationPolicy.normalize(value);
        if (!"https".equals(uri.getScheme())) {
            update("此开发候选不开放明文 HTTP 页面。");
            return;
        }
        webView.loadUrl(uri.toString());
    }

    public void reload() {
        requireMain();
        revokeObservation(R.string.ping0_observation_self_test, false);
        if (!draining && proxyConfigured && webView != null) {
            identity = null;
            startProbe();
        }
    }

    public void detach(Listener current) {
        if (listener == current) {
            listener = null;
            if (webView != null && webView.getParent() instanceof android.view.ViewGroup) {
                ((android.view.ViewGroup) webView.getParent()).removeView(webView);
            }
            if (viewContext != null) viewContext.setBaseContext(application);
        }
    }

    public void beginDrain(DrainCallback callback) {
        requireMain();
        if (draining) throw new IllegalStateException("DRAIN_ALREADY_STARTED");
        draining = true;
        storageProbe.revoke();
        revokeObservation(R.string.ping0_observation_stop, false);
        challenge = null;
        probeUrl = null;
        update("正在退出：Cookie 提交与进程退出分别核实，网页存储完整性未证明。");
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        AtomicBoolean replied = new AtomicBoolean();
        main.postDelayed(() -> {
            if (replied.compareAndSet(false, true)) callback.onDrained("TIMED_OUT");
        }, 8000);
        storage.execute(() -> {
            String outcome;
            try {
                CookieManager.getInstance().flush();
                outcome = "RETURNED";
            } catch (RuntimeException failure) {
                outcome = "FAILED";
            }
            String receipt = outcome;
            main.post(() -> {
                if (replied.compareAndSet(false, true)) callback.onDrained(receipt);
            });
        });
    }

    private void phase(BootstrapStore.RuntimePhase phase) {
        store.noteRuntime(launch.sessionId, application.incarnation(), android.os.Process.myPid(), provider, phase);
    }

    private void update(String value) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            main.post(() -> update(value));
            return;
        }
        Observation observed = observation;
        String banner = application.getString(R.string.ping0_observation_banner);
        status = observed == null ? value : (value.startsWith(banner) ? value : banner + "\n" + value)
                + "\n" + dependencySummary(observed);
        if (listener != null) listener.onStatus(status);
    }

    public String status() { return status; }

    private static void requireMain() {
        if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("WEBVIEW_WRONG_THREAD");
    }
}
