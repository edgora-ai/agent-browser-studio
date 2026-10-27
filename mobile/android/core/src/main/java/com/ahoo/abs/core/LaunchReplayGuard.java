package com.ahoo.abs.core;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/**
 * Controller-lifetime replay ledger. Share one instance across all runtime machines.
 * This in-memory guard is not durable authentication or protection across controller restarts;
 * adapters must also bind launches to their trusted same-UID transport and persistent lifecycle lock.
 */
public final class LaunchReplayGuard {
    private final int capacity;
    private final Map<String, LaunchSpec> nonces = new HashMap<>();
    private final Map<String, LaunchSpec> sessions = new HashMap<>();
    private long lastObservedMillis = -1;

    public LaunchReplayGuard(int capacity) {
        if (capacity < 1) throw CoreValidation.error("INVALID_REPLAY_CAPACITY", "Replay capacity must be positive");
        this.capacity = capacity;
    }

    /** Atomically validates and consumes both identifiers, never evicting an unexpired envelope. */
    public synchronized void consume(LaunchSpec launch, long nowMillis) {
        if (launch == null) throw CoreValidation.error("INVALID_LAUNCH", "A launch envelope is required");
        launch.validateAt(nowMillis);
        if (nowMillis < lastObservedMillis) {
            throw CoreValidation.error("CLOCK_MOVED_BACKWARDS", "Replay observations must not move backwards");
        }
        lastObservedMillis = nowMillis;
        Iterator<Map.Entry<String, LaunchSpec>> iterator = nonces.entrySet().iterator();
        while (iterator.hasNext()) {
            LaunchSpec consumed = iterator.next().getValue();
            if (consumed.expiresAtMillis <= nowMillis) {
                sessions.remove(consumed.sessionId);
                iterator.remove();
            }
        }
        if (nonces.containsKey(launch.nonce) || sessions.containsKey(launch.sessionId)) {
            throw CoreValidation.error("LAUNCH_REPLAY", "A launch nonce or session has already been consumed");
        }
        if (nonces.size() >= capacity) {
            throw CoreValidation.error("REPLAY_CACHE_FULL", "All replay ledger entries are still live");
        }
        nonces.put(launch.nonce, launch);
        sessions.put(launch.sessionId, launch);
    }
}
