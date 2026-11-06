package com.ahoo.abs.android.process;

/** Existing-process drain control; a Cookie outcome is not complete web-storage durability. */
public interface BrowserProcessRuntime {
    interface DrainCallback { void onDrained(String cookieFlush); }

    void beginDrain(DrainCallback callback);
}
