package com.ahoo.abs.android.nativekernel;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.os.Looper;
import org.jni_zero.CalledByNative;
import java.lang.ref.WeakReference;
import java.util.ArrayList;

/**
 * Android runtime-permission surface for web media capture (microphone and
 * camera). The native permission path synchronously reads the OS grant state
 * and, when not yet granted, fires the system dialog once. The OS permission
 * store is the single source of truth: no per-origin decisions are kept, and
 * a web request that races the dialog is retried by its caller.
 */
public final class MediaPermissionBridge {
    private static final int REQUEST_CODE = 0x4D50; // 'MP'
    private static final Object LOCK = new Object();
    private static WeakReference<Activity> sHost;

    private MediaPermissionBridge() {}

    /** The resumed browser activity; the system dialog needs it. */
    static void setHost(Activity activity) {
        synchronized (LOCK) { sHost = new WeakReference<>(activity); }
    }

    static void clearHost(Activity activity) {
        synchronized (LOCK) {
            if (sHost != null && sHost.get() == activity) sHost = null;
        }
    }

    private static boolean osGranted(Activity activity, String permission) {
        return activity.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    /** Native synchronous check: are the requested capture devices OS-granted? */
    @CalledByNative
    public static boolean isCaptureGranted(boolean audio, boolean video) {
        Activity activity;
        synchronized (LOCK) { activity = sHost == null ? null : sHost.get(); }
        if (activity == null) return false;
        boolean granted = true;
        if (audio) granted &= osGranted(activity, Manifest.permission.RECORD_AUDIO);
        if (video) granted &= osGranted(activity, Manifest.permission.CAMERA);
        return granted;
    }

    /** Native fire-and-forget: surface the system dialog for missing grants. */
    @CalledByNative
    public static void firePermissionDialog(final boolean audio, final boolean video) {
        new Handler(Looper.getMainLooper()).post(new Runnable() {
            @Override
            public void run() {
                Activity activity;
                synchronized (LOCK) { activity = sHost == null ? null : sHost.get(); }
                if (activity == null || activity.isFinishing()) return;
                ArrayList<String> needed = new ArrayList<>();
                if (audio && !osGranted(activity, Manifest.permission.RECORD_AUDIO)) {
                    needed.add(Manifest.permission.RECORD_AUDIO);
                }
                if (video && !osGranted(activity, Manifest.permission.CAMERA)) {
                    needed.add(Manifest.permission.CAMERA);
                }
                if (!needed.isEmpty()) {
                    activity.requestPermissions(needed.toArray(new String[0]), REQUEST_CODE);
                }
            }
        });
    }

    /** Forwarded by the host activity from onRequestPermissionsResult. */
    static void onHostResult(String[] permissions, int[] results) {
        // The OS permission store is re-read per poll; per-request routing is
        // not needed, so the result is intentionally not forwarded anywhere.
    }
}
