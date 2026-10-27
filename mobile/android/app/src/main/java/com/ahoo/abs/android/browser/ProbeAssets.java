package com.ahoo.abs.android.browser;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceResponse;
import androidx.webkit.WebViewAssetLoader;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;

/** Reserved HTTPS origins never fall through to the public network. */
final class ProbeAssets {
    static final String MAIN_HOST = "appassets.androidplatform.net";
    static final String FRAME_HOST = "frames.abs-browser.invalid";
    static final String INDEX = "https://" + MAIN_HOST + "/assets/identity-probe/index.html";
    private final WebViewAssetLoader main;
    private final WebViewAssetLoader frame;

    ProbeAssets(Context context) {
        WebViewAssetLoader.AssetsPathHandler assets = new WebViewAssetLoader.AssetsPathHandler(context);
        main = new WebViewAssetLoader.Builder().setDomain(MAIN_HOST)
                .addPathHandler("/assets/", assets).build();
        frame = new WebViewAssetLoader.Builder().setDomain(FRAME_HOST)
                .addPathHandler("/assets/", assets).build();
    }

    boolean isReserved(Uri uri) {
        return MAIN_HOST.equals(uri.getHost()) || FRAME_HOST.equals(uri.getHost());
    }

    WebResourceResponse intercept(Uri uri) {
        if (!"https".equals(uri.getScheme()) || uri.getUserInfo() != null
                || (uri.getPort() != -1 && uri.getPort() != 443) || !isReserved(uri)) {
            return denied();
        }
        String path = uri.getPath();
        if (path == null || path.length() > 2048 || !path.startsWith("/assets/identity-probe/")) {
            return denied();
        }
        for (String component : path.split("/", -1)) {
            if (component.equals("..") || component.equals(".") || component.indexOf('\\') >= 0) {
                return denied();
            }
        }
        WebResourceResponse response = (MAIN_HOST.equals(uri.getHost()) ? main : frame).shouldInterceptRequest(uri);
        return response == null ? denied() : response;
    }

    static WebResourceResponse denied() {
        byte[] text = "ABS_CAPABILITY_GATE_BLOCKED".getBytes(StandardCharsets.UTF_8);
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked",
                Collections.singletonMap("Cache-Control", "no-store"), new ByteArrayInputStream(text));
    }
}
