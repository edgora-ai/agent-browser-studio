package com.ahoo.abs.android.data;

import android.os.Process;

/** Process-local claim proof. A reused PID after process death cannot restore this binding. */
final class ProcessBinding {
    static final Object CLAIM_LOCK = new Object();
    private static volatile ProcessBinding current;

    final String path;
    final String storeId;
    final String sessionId;
    final String incarnationId;
    final int pid;

    private ProcessBinding(String path, String storeId, String sessionId, String incarnationId) {
        this.path = path;
        this.storeId = storeId;
        this.sessionId = sessionId;
        this.incarnationId = incarnationId;
        pid = Process.myPid();
    }

    static void requireUnbound() {
        if (current != null) mismatch();
    }

    /** Call under CLAIM_LOCK, only after the claim transaction has actually committed. */
    static void install(String path, String storeId, String sessionId, String incarnationId) {
        requireUnbound();
        current = new ProcessBinding(path, storeId, sessionId, incarnationId);
    }

    static ProcessBinding require(String path, String storeId, String sessionId,
                                  String incarnationId, int pid) {
        ProcessBinding binding = current;
        if (binding == null || !binding.path.equals(path) || !binding.storeId.equals(storeId)
                || !binding.sessionId.equals(sessionId)
                || !binding.incarnationId.equals(incarnationId)
                || binding.pid != pid || pid != Process.myPid()) mismatch();
        return binding;
    }

    static boolean isCurrentRuntime(String path, String sessionId) {
        ProcessBinding binding = current;
        return binding != null && binding.path.equals(path) && binding.sessionId.equals(sessionId);
    }

    private static void mismatch() {
        throw new StorageException(StorageException.Code.RUNTIME_IDENTITY_MISMATCH);
    }
}
