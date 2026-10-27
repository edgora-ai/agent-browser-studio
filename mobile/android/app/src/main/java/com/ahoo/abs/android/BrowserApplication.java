package com.ahoo.abs.android;

import android.app.Application;
import android.content.Context;
import android.content.res.Configuration;
import android.os.LocaleList;
import android.webkit.WebView;
import com.ahoo.abs.android.data.BootstrapStore;
import com.ahoo.abs.android.process.ProcessLifecycle;
import com.ahoo.abs.core.LaunchSpec;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;

/** No WebKit/provider work is permitted in a constructor or static initializer. */
public final class BrowserApplication extends Application {
    private ProcessLifecycle.Hold browserLifetime;
    private LaunchSpec launch;
    private String incarnation;
    private String startupFailure;
    private boolean draining;
    private boolean controllerActivated;
    private com.ahoo.abs.android.browser.BrowserRuntime browserRuntime;

    @Override
    protected void attachBaseContext(Context base) {
        String processName = Application.getProcessName();
        if (!processName.equals(base.getPackageName() + ":browser")) {
            super.attachBaseContext(base);
            WebView.disableWebView();
            return;
        }
        incarnation = UUID.randomUUID().toString();
        Context configured = base;
        try {
            browserLifetime = ProcessLifecycle.holdBrowser(base);
            try (BootstrapStore bootstrap = new BootstrapStore(base)) {
                launch = bootstrap.claim(incarnation);
                launch.validateAt(System.currentTimeMillis());
                WebView.setDataDirectorySuffix(launch.directorySuffix());
                TimeZone.setDefault(TimeZone.getTimeZone(java.time.ZoneId.of(launch.profile.timeZoneId)));
                List<Locale> locales = new ArrayList<>();
                for (String tag : launch.profile.languageTags) locales.add(Locale.forLanguageTag(tag));
                LocaleList localeList = new LocaleList(locales.toArray(new Locale[0]));
                Locale.setDefault(locales.get(0));
                LocaleList.setDefault(localeList);
                Configuration override = new Configuration(base.getResources().getConfiguration());
                override.setLocales(localeList);
                configured = base.createConfigurationContext(override);
                bootstrap.noteRuntime(launch.sessionId, incarnation, android.os.Process.myPid(), null,
                        BootstrapStore.RuntimePhase.DIRECTORY_BOUND);
            }
        } catch (IOException | RuntimeException failure) {
            startupFailure = "BOOTSTRAP_" + failure.getClass().getSimpleName();
            try {
                WebView.disableWebView();
            } catch (IllegalStateException initializedTooEarly) {
                // An already initialized provider cannot be made safe by changing defaults.
                android.os.Process.killProcess(android.os.Process.myPid());
                throw initializedTooEarly;
            }
        }
        super.attachBaseContext(configured);
    }

    public LaunchSpec requireLaunch() {
        if (startupFailure != null || launch == null || browserLifetime == null) {
            throw new IllegalStateException("BROWSER_BOOTSTRAP_REJECTED");
        }
        return launch;
    }

    public synchronized com.ahoo.abs.android.browser.BrowserRuntime browserRuntime() {
        requireBrowserActivation();
        if (browserRuntime == null) browserRuntime = new com.ahoo.abs.android.browser.BrowserRuntime(this);
        return browserRuntime;
    }

    public synchronized com.ahoo.abs.android.browser.BrowserRuntime existingBrowserRuntime() {
        return browserRuntime;
    }

    public void activateController() {
        requireLaunch();
        if (draining) throw new IllegalStateException("BROWSER_DRAINING");
        controllerActivated = true;
    }

    public void requireBrowserActivation() {
        requireLaunch();
        if (!controllerActivated || draining) throw new IllegalStateException("COORDINATOR_ACTIVATION_REQUIRED");
        try (BootstrapStore bootstrap = new BootstrapStore(this)) {
            BootstrapStore.ActiveLaunch active = bootstrap.findLaunch(launch.sessionId);
            if (active == null || active.state != BootstrapStore.State.CLAIMED
                    || active.pid != android.os.Process.myPid() || !incarnation.equals(active.incarnationId)) {
                throw new IllegalStateException("COORDINATOR_ACTIVATION_REVOKED");
            }
        }
    }

    public void markDraining() {
        requireLaunch();
        draining = true;
        controllerActivated = false;
    }

    public boolean isDraining() {
        return draining;
    }

    public String incarnation() {
        return incarnation;
    }

    public String startupFailure() {
        return startupFailure;
    }
}
