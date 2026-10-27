package com.ahoo.abs.android.browser;

import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.function.Consumer;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

/** Explicit local synthetic samples only; no result promotes the browser admission gate. */
final class StorageProbe {
    static final String HOST = "storage.abs-browser.invalid";
    static final String INDEX = "https://" + HOST + "/assets/storage-probe/index.html";
    private static final long DURATION_MILLIS = 120000;
    private static final Pattern SAMPLE = Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}");
    private static final Set<String> PATHS = new HashSet<>(Arrays.asList(
            "/assets/storage-probe/index.html", "/assets/storage-probe/probe.js", "/assets/storage-probe/probe.css"));
    private static final Set<String> STORES = new HashSet<>(Arrays.asList("cookie", "localStorage", "indexedDB"));
    private final Handler main = new Handler(Looper.getMainLooper());
    private final WebViewAssetLoader assets;
    private final Consumer<String> reportStatus;
    private volatile Session current;

    private static final class Session {
        final String challenge = UUID.randomUUID().toString();
        final String url = INDEX + "#challenge=" + challenge;
        final long expiresAt = SystemClock.elapsedRealtime() + DURATION_MILLIS;
        int reports;
    }

    StorageProbe(Context context, Consumer<String> reportStatus) {
        this.reportStatus = reportStatus;
        assets = new WebViewAssetLoader.Builder().setDomain(HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(context)).build();
    }

    void attach(WebView view) {
        WebViewCompat.addWebMessageListener(view, "AbsStorageResult", Collections.singleton("https://" + HOST),
                (source, message, origin, isMainFrame, reply) -> {
                    Session session = current;
                    String text = message.getData();
                    if (!isMainFrame || !validOrigin(origin) || !active(session)
                            || !session.url.equals(source.getUrl()) || text == null) return;
                    if (text.getBytes(StandardCharsets.UTF_8).length > 4096 || session.reports >= 64) {
                        cancel(view);
                        reportStatus.accept("存储样本报告超限，已停止本次诊断；没有扩大验证范围。");
                        return;
                    }
                    session.reports++;
                    try {
                        reportStatus.accept(format(text, session.challenge));
                    } catch (JSONException invalid) {
                        reportStatus.accept("存储样本报告无效；未接受结果，也未放开普通浏览。");
                    }
                });
    }

    void open(WebView view) {
        Session session = new Session();
        current = session;
        reportStatus.accept("合成存储验证：正在只读检索；本页面不会自动补写样本。普通浏览仍未开放。");
        main.postDelayed(() -> {
            if (current == session) {
                cancel(view);
                reportStatus.accept("本次合成存储验证已到期，请重新进入；未确认完整存储持久性。");
            }
        }, DURATION_MILLIS);
        try {
            view.stopLoading();
            view.loadUrl(session.url);
        } catch (RuntimeException failure) {
            revoke();
            throw failure;
        }
    }

    boolean isReserved(Uri uri) { return HOST.equals(uri.getHost()); }
    boolean isActive() { return active(current); }
    void revoke() { current = null; }

    void cancel(WebView view) {
        if (current == null) return;
        revoke();
        if (view != null) {
            view.stopLoading();
            view.loadUrl("about:blank");
        }
    }

    boolean allowsNavigation(WebResourceRequest request) {
        Session session = current;
        return active(session) && request.isForMainFrame() && "GET".equals(request.getMethod())
                && session.url.equals(request.getUrl().toString());
    }

    WebResourceResponse intercept(WebResourceRequest request) {
        Uri uri = request.getUrl();
        if (!active(current) || !validOrigin(uri) || !"GET".equals(request.getMethod())
                || uri.getQuery() != null || !PATHS.contains(uri.getEncodedPath())) return ProbeAssets.denied();
        WebResourceResponse response = assets.shouldInterceptRequest(uri);
        return response == null ? ProbeAssets.denied() : response;
    }

    private boolean active(Session session) {
        return session != null && current == session && SystemClock.elapsedRealtime() < session.expiresAt;
    }

    private static boolean validOrigin(Uri uri) {
        return "https".equals(uri.getScheme()) && HOST.equals(uri.getHost()) && uri.getUserInfo() == null
                && (uri.getPort() == -1 || uri.getPort() == 443);
    }

    private static boolean sample(Object value) {
        return value instanceof String && SAMPLE.matcher((String) value).matches();
    }

    private static String format(String text, String challenge) throws JSONException {
        JSONTokener tokener = new JSONTokener(text);
        Object parsed = tokener.nextValue();
        if (!(parsed instanceof JSONObject) || tokener.nextClean() != 0) throw new JSONException("INVALID_REPORT");
        JSONObject report = (JSONObject) parsed;
        if (report.length() != 6 || !Integer.valueOf(1).equals(report.opt("schemaVersion"))
                || !challenge.equals(report.opt("challenge"))) throw new JSONException("INVALID_REPORT");
        Object operation = report.opt("operation");
        if (!"read".equals(operation) && !"write".equals(operation)) throw new JSONException("INVALID_OPERATION");
        Object expected = report.opt("expected");
        if ("write".equals(operation) ? !sample(expected) : expected != JSONObject.NULL) throw new JSONException("INVALID_SAMPLE");
        JSONObject stores = report.getJSONObject("stores");
        JSONArray errors = report.getJSONArray("writeErrors");
        if (stores.length() != 3 || errors.length() > 3 || ("read".equals(operation) && errors.length() != 0)) {
            throw new JSONException("INVALID_STORES");
        }
        Set<String> failed = new HashSet<>();
        for (int index = 0; index < errors.length(); index++) {
            Object name = errors.get(index);
            if (!(name instanceof String) || !STORES.contains(name) || !failed.add((String) name)) throw new JSONException("INVALID_ERROR");
        }
        StringBuilder result = new StringBuilder("合成存储样本 · ").append(operation).append("（不代表完整持久性通过）");
        if ("write".equals(operation)) result.append("\n本次样本：").append(expected);
        for (String name : Arrays.asList("cookie", "localStorage", "indexedDB")) {
            JSONObject value = stores.getJSONObject(name);
            Object state = value.opt("state"), stored = value.opt("value");
            if (value.length() != 2 || !(state instanceof String)
                    || !Arrays.asList("present", "missing", "invalid", "error", "unsupported").contains(state)
                    || ("present".equals(state) ? !sample(stored) : stored != JSONObject.NULL)) throw new JSONException("INVALID_VALUE");
            result.append("\n").append(name).append(": ").append(state);
            if ("present".equals(state)) result.append(" ").append(stored);
            if (failed.contains(name)) result.append(" · 写入失败");
        }
        return result.append("\n仅本地样本；Cache/SW、异常退出与真实登录态未验证。").toString();
    }
}
