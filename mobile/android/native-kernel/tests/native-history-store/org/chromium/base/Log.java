package org.chromium.base;

import java.util.ArrayList;
import java.util.List;

/** Capture expected failure paths; never intercept assertion failures in the harness. */
public final class Log {
    private static final List<String> WARNINGS = new ArrayList<>();

    private Log() { }

    public static synchronized void w(String tag, String message, Throwable failure) {
        WARNINGS.add(tag + ":" + message + ":" + failure.getClass().getSimpleName());
    }

    public static synchronized int warningCount() {
        return WARNINGS.size();
    }
}
