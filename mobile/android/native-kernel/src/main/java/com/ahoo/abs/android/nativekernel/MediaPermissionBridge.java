package com.ahoo.abs.android.nativekernel;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.os.Looper;
import org.chromium.base.annotations.CalledByNative;
import org.chromium.base.annotations.NativeMethods;
import java.lang.ref.WeakReference;
import java.util.ArrayList;

/**
 * Android runtime-permission round trip for web media capture (microphone and
 * camera). One in-flight system dialog at a time: the native side serializes
 * concurrent web requests, and a request that races a finishing host fails
 * closed. The bridge never stores per-origin decisions; each web request pays
 * one Android runtime round trip, and the OS dialog stays the single prompt
 * surface the user sees.
 */
public final class MediaPermissionBridge {
    private static final int REQUEST_CODE = 0x4D50; // 'MP'
    private static final Object LOCK = new Object();
    private static WeakReference<Activity> sHost;
    private static PendingRequest sPending;

    private static final class PendingRequest {
        final long callbackId;
        final boolean audio;
        final boolean video;

        PendingRequest(long callbackId, boolean audio, boolean video) {
            this.callbackId = callbackId;
            this.audio = audio;
            this.video = video;
        }
    }

    private MediaPermissionBridge() {}

    /** The resumed browser activity; native-side requests need it for the system dialog. */
    static void setHost(Activity activity) {
        synchronized (LOCK) { sHost = new WeakReference<>(activity); }
    }

    static void clearHost(Activity activity) {
        synchronized (LOCK) {
            if (sHost != null && sHost.get() == activity) sHost = null;
        }
    }

    /** Called from native on the browser UI thread (the Android main thread). */
    @CalledByNative
    public static void request(long callbackId, boolean audio, boolean video) {
        new Handler(Looper.getMainLooper()).post(() -> dispatch(callbackId, audio, video));
    }

    private static void dispatch(long callbackId, boolean audio, boolean video) {
        Activity activity;
        synchronized (LOCK) {
            if (sPending != null) {
                MediaPermissionBridgeJni.get().onPermissionResult(callbackId, false, false);
                return;
            }
            activity = sHost == null ? null : sHost.get();
        }
        if (activity == null || activity.isFinishing()) {
            MediaPermissionBridgeJni.get().onPermissionResult(callbackId, false, false);
            return;
        }
        boolean audioGranted = !audio || activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
        boolean videoGranted = !video || activity.checkSelfPermission(Manifest.permission.CAMERA)
                == PackageManager.PERMISSION_GRANTED;
        ArrayList<String> needed = new ArrayList<>();
        if (audio && !audioGranted) needed.add(Manifest.permission.RECORD_AUDIO);
        if (video && !videoGranted) needed.add(Manifest.permission.CAMERA);
        if (needed.isEmpty()) {
            MediaPermissionBridgeJni.get().onPermissionResult(callbackId, audioGranted, videoGranted);
            return;
        }
        synchronized (LOCK) { sPending = new PendingRequest(callbackId, audio, video); }
        activity.requestPermissions(needed.toArray(new String[0]), REQUEST_CODE);
    }

    /** Forwarded by the host activity from onRequestPermissionsResult. */
    static void onHostResult(String[] permissions, int[] results) {
        PendingRequest pending;
        synchronized (LOCK) {
            pending = sPending;
            sPending = null;
        }
        if (pending == null) return;
        boolean audioGranted = pending.audio;
        boolean videoGranted = pending.video;
        for (int i = 0; i < permissions.length && i < results.length; i++) {
            if (Manifest.permission.RECORD_AUDIO.equals(permissions[i])) {
                audioGranted = results[i] == PackageManager.PERMISSION_GRANTED;
            } else if (Manifest.permission.CAMERA.equals(permissions[i])) {
                videoGranted = results[i] == PackageManager.PERMISSION_GRANTED;
            }
        }
        MediaPermissionBridgeJni.get().onPermissionResult(pending.callbackId, audioGranted, videoGranted);
    }

    /** Calls into the browser-side permission bridge; callback ids are opaque. */
    interface Natives {
        @NativeMethods
        void onPermissionResult(long callbackId, boolean audioGranted, boolean videoGranted);
    }
}
