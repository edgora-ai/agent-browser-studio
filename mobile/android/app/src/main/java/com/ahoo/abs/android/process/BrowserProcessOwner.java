package com.ahoo.abs.android.process;

import android.content.Intent;
import com.ahoo.abs.core.LaunchSpec;

/** Browser-process ownership used by same-UID control, independent of its rendering engine. */
public interface BrowserProcessOwner {
    LaunchSpec requireLaunch();
    String incarnation();
    void activateController();
    void markDraining();
    BrowserProcessRuntime existingControlRuntime();
    /** Returns an explicit internal intent without creating a runtime or consuming a launch. */
    Intent createBrowserActivityIntent();
}
