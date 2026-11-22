package com.ahoo.abs.android.nativekernel;

import org.chromium.base.ThreadUtils;
import org.chromium.build.annotations.NullMarked;
import org.chromium.build.annotations.Nullable;
import org.chromium.content_public.browser.WebContents;
import org.jni_zero.CalledByNative;
import org.jni_zero.JNINamespace;
import org.jni_zero.NativeMethods;

/** Browser-owned manifest and display-mode access for the ABS product. */
@JNINamespace("content")
@NullMarked
final class NativePwaBridge {
    private NativePwaBridge() {}

    @FunctionalInterface
    interface Callback {
        void onResult(@Nullable InstallManifest manifest);
    }

    /** Text-only install metadata; URLs and origin are canonical Chromium strings. */
    static final class InstallManifest {
        public final String id;
        public final String name;
        public final String startUrl;
        public final String scope;
        public final String origin;

        private InstallManifest(
                String id, String name, String startUrl, String scope, String origin) {
            this.id = id;
            this.name = name;
            this.startUrl = startUrl;
            this.scope = scope;
            this.origin = origin;
        }
    }

    /**
     * Requests the visible primary document's manifest; completes asynchronously on the UI thread.
     */
    static void requestManifest(WebContents contents, Callback callback) {
        ThreadUtils.assertOnUiThread();
        NativePwaBridgeJni.get().requestManifest(contents, callback);
    }

    /** Whether a normal, committed HTTPS document is safe to show without URL chrome. */
    static boolean isSecurePage(@Nullable WebContents contents) {
        ThreadUtils.assertOnUiThread();
        return contents != null
                && !contents.isDestroyed()
                && NativePwaBridgeJni.get().isSecurePage(contents);
    }

    /** Installs a scope once on a fresh Shell, or permanently revokes its role with null. */
    static boolean setStandaloneScope(WebContents contents, @Nullable String scope) {
        ThreadUtils.assertOnUiThread();
        return !contents.isDestroyed()
                && NativePwaBridgeJni.get().setStandaloneScope(contents, scope);
    }

    /** Whether this Shell still has its role and its committed primary page is eligible. */
    static boolean isStandalonePage(@Nullable WebContents contents) {
        ThreadUtils.assertOnUiThread();
        return contents != null
                && !contents.isDestroyed()
                && NativePwaBridgeJni.get().isStandalonePage(contents);
    }

    @CalledByNative
    static void onManifestResult(
            Callback callback,
            @Nullable String id,
            @Nullable String name,
            @Nullable String startUrl,
            @Nullable String scope,
            @Nullable String origin) {
        ThreadUtils.assertOnUiThread();
        callback.onResult(
                id == null || name == null || startUrl == null || scope == null || origin == null
                        ? null
                        : new InstallManifest(id, name, startUrl, scope, origin));
    }

    @NativeMethods
    interface Natives {
        void requestManifest(WebContents contents, Callback callback);

        boolean isSecurePage(WebContents contents);

        boolean setStandaloneScope(WebContents contents, @Nullable String scope);

        boolean isStandalonePage(WebContents contents);
    }
}
