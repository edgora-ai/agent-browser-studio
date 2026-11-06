package com.ahoo.abs.android.nativekernel;

import android.app.Application;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.os.LocaleList;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import com.ahoo.abs.android.data.BootstrapStore;
import com.ahoo.abs.android.process.BrowserProcessOwner;
import com.ahoo.abs.android.process.BrowserProcessRuntime;
import com.ahoo.abs.android.process.ProcessLifecycle;
import com.ahoo.abs.core.LaunchSpec;
import com.ahoo.abs.core.NativeTimezoneLaunchConfig;
import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import org.chromium.base.ApplicationStatus;
import org.chromium.base.CommandLine;
import org.chromium.base.ContextUtils;
import org.chromium.base.Log;
import org.chromium.base.PathUtils;
import org.chromium.base.library_loader.LibraryLoader;
import org.chromium.base.library_loader.LibraryProcessType;
import org.chromium.net.NetworkChangeNotifier;
import org.chromium.ui.base.ResourceBundle;

/** Product bootstrap, not the fixed-asset timezone fixture and not a System WebView application. */
public final class NativeBrowserApplication extends Application implements BrowserProcessOwner {
    private ProcessLifecycle.Hold lifetime;
    private LaunchSpec launch;
    private String incarnation;
    private String startupFailure;
    private NativeTimezoneLaunchConfig frozen;
    private boolean browserProcess;
    private boolean draining;
    private boolean controllerActivated;
    private NativeBrowserRuntime runtime;

    @Override
    protected void attachBaseContext(Context base) {
        String process = Application.getProcessName();
        browserProcess = (base.getPackageName() + ":browser").equals(process);
        if (!browserProcess) {
            super.attachBaseContext(base);
            if (base.getPackageName().equals(process)) return;
            String prefix = base.getPackageName() + ":";
            if (!process.startsWith(prefix)
                    || !process.substring(prefix.length()).matches(
                            "(?:sandboxed_process|privileged_process)[0-9]+(?::[A-Za-z0-9_.$]+)*")) {
                throw new IllegalStateException("NATIVE_PROCESS_ROLE_REJECTED");
            }
            initializeChromiumProcess(false);
            return;
        }
        incarnation = UUID.randomUUID().toString();
        Context configured = base;
        try {
            lifetime = ProcessLifecycle.holdBrowser(base);
            try (BootstrapStore bootstrap = new BootstrapStore(base)) {
                launch = bootstrap.claim(incarnation);
                frozen = NativeTimezoneLaunchConfig.fromLaunch(launch, incarnation, System.currentTimeMillis());
                freezeCommandLine();
                List<Locale> locales = new ArrayList<>();
                for (String tag : launch.profile.languageTags) locales.add(Locale.forLanguageTag(tag));
                LocaleList list = new LocaleList(locales.toArray(new Locale[0]));
                Locale.setDefault(locales.get(0));
                LocaleList.setDefault(list);
                Configuration override = new Configuration(base.getResources().getConfiguration());
                override.setLocales(list);
                configured = base.createConfigurationContext(override);
            }
        } catch (IOException | RuntimeException failure) {
            startupFailure = "BOOTSTRAP_" + failure.getClass().getSimpleName();
            Log.e("AbsNativeBootstrap", "NATIVE_BOOTSTRAP_ATTACH_FAILED");
        }
        super.attachBaseContext(configured);
        if (startupFailure != null) return;
        try {
            verifyFrozenCommandLine();
            initializeChromiumProcess(true);
            bindNativeDirectories();
            ApplicationStatus.initialize(this);
            try (BootstrapStore bootstrap = new BootstrapStore(this)) {
                bootstrap.noteRuntime(launch.sessionId, incarnation, android.os.Process.myPid(), null,
                        BootstrapStore.RuntimePhase.DIRECTORY_BOUND);
            }
        } catch (IOException | RuntimeException failure) {
            startupFailure = "BOOTSTRAP_" + failure.getClass().getSimpleName();
            Log.e("AbsNativeBootstrap", "NATIVE_BOOTSTRAP_AFTER_ATTACH_FAILED");
        }
    }

    private void bindNativeDirectories() throws IOException {
        File base = getNoBackupFilesDir();
        File profile = new File(base, "native_" + launch.directorySuffix());
        try {
            StructStat parent = Os.lstat(base.getAbsolutePath());
            // Android 16/OEM no_backup dirs can be 0771 (traverse-only other bit);
            // the profile subdirectory below is still required to be 0700.
            if (parent.st_uid != android.os.Process.myUid() || (parent.st_mode & 0170000) != 0040000
                    || (parent.st_mode & 0006) != 0) throw new IOException("UNSAFE_NATIVE_PROFILE_PARENT");
            try { Os.mkdir(profile.getAbsolutePath(), 0700); }
            catch (ErrnoException exists) {
                if (exists.errno != OsConstants.EEXIST) throw exists;
            }
            StructStat directory = Os.lstat(profile.getAbsolutePath());
            if (directory.st_uid != android.os.Process.myUid() || (directory.st_mode & 0170000) != 0040000
                    || (directory.st_mode & 0077) != 0) throw new IOException("UNSAFE_NATIVE_PROFILE_DIRECTORY");
            PathUtils.setPrivateDirectoryPath(profile.getAbsolutePath(), null, "data",
                    "native_" + launch.directorySuffix());
        } catch (ErrnoException failure) {
            throw new IOException("NATIVE_PROFILE_DIRECTORY_IO", failure);
        }
    }

    private void initializeChromiumProcess(boolean browser) {
        ContextUtils.initApplicationContext(this);
        ResourceBundle.setNoAvailableLocalePaks();
        LibraryLoader.getInstance().setLibraryProcessType(browser
                ? LibraryProcessType.PROCESS_BROWSER : LibraryProcessType.PROCESS_CHILD);
    }

    private void freezeCommandLine() {
        if (CommandLine.isInitialized()) throw new IllegalStateException("NATIVE_COMMAND_LINE_ALREADY_INITIALIZED");
        String[] timezone = frozen.commandLine();
        // Route A: ordinary browsing is enabled; the preflight-only switch is no longer forced.
        String[] arguments = new String[]{timezone[0], timezone[1], timezone[2],
                "--agent-browser-product-profile",
                "--proxy-server=" + launch.profile.proxy.proxyRule(), "--proxy-bypass-list=<-loopback>",
                "--disable-quic", "--use-mobile-user-agent",
                "--disable-features=ReduceAcceptLanguage,ReduceAcceptLanguageHTTP",
                "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
                "--lang=" + launch.profile.languageTags.get(0),
                "--accept-lang=" + String.join(",", launch.profile.languageTags)};
        CommandLine.init(arguments);
        verifyFrozenCommandLine();
        Log.i("AbsNativeBootstrap", "ABS_ANDROID_TIMEZONE_V1 frozen=1 input_sha256="
                + frozen.inputSha256() + " pid=" + android.os.Process.myPid());
    }

    public void verifyFrozenCommandLine() {
        if (frozen == null || !CommandLine.isInitialized()) {
            throw new IllegalStateException("NATIVE_FROZEN_CONFIG_MISSING");
        }
        CommandLine command = CommandLine.getInstance();
        if (!command.hasSwitch("agent-browser-product-profile")
                || command.hasSwitch("agent-browser-product-preflight")
                || !command.hasSwitch(NativeTimezoneLaunchConfig.REQUIRED_SWITCH)
                || !frozen.encoded().equals(command.getSwitchValue(NativeTimezoneLaunchConfig.CONFIG_SWITCH))
                || !launch.profile.proxy.proxyRule().equals(command.getSwitchValue("proxy-server"))
                || !"<-loopback>".equals(command.getSwitchValue("proxy-bypass-list"))
                || !command.hasSwitch("disable-quic")
                || !command.hasSwitch("use-mobile-user-agent")
                || !"ReduceAcceptLanguage,ReduceAcceptLanguageHTTP".equals(command.getSwitchValue("disable-features"))
                || !"disable_non_proxied_udp".equals(command.getSwitchValue("force-webrtc-ip-handling-policy"))
                || !launch.profile.languageTags.get(0).equals(command.getSwitchValue("lang"))
                || !String.join(",", launch.profile.languageTags).equals(command.getSwitchValue("accept-lang"))) {
            throw new IllegalStateException("NATIVE_FROZEN_CONFIG_CHANGED");
        }
        for (String forbidden : new String[]{"roxy-fingerprint-config", "js-flags", "user-data-dir",
                "content-shell-user-data-dir", "no-sandbox", "disable-web-security", "ignore-certificate-errors",
                "run-web-tests", "remote-debugging-port", "remote-debugging-pipe", "remote-debugging-socket-name"}) {
            if (command.hasSwitch(forbidden)) throw new IllegalStateException("NATIVE_UNSAFE_COMMAND_LINE");
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        if (browserProcess && startupFailure == null) {
            verifyFrozenCommandLine();
            NetworkChangeNotifier.init();
            NetworkChangeNotifier.setAutoDetectConnectivityState(true);
        }
    }

    @Override
    public LaunchSpec requireLaunch() {
        if (startupFailure != null || launch == null || lifetime == null || frozen == null) {
            throw new IllegalStateException("BROWSER_BOOTSTRAP_REJECTED");
        }
        return launch;
    }

    @Override
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
        verifyFrozenCommandLine();
    }

    @SuppressWarnings("NoSynchronizedThisCheck")
    public NativeBrowserRuntime browserRuntime() {
        synchronized (this) {
            requireBrowserActivation();
            if (runtime == null) runtime = new NativeBrowserRuntime(this);
            return runtime;
        }
    }

    @Override
    @SuppressWarnings("NoSynchronizedThisCheck")
    public BrowserProcessRuntime existingControlRuntime() {
        synchronized (this) { return runtime; }
    }

    @Override
    public Intent createBrowserActivityIntent() {
        return new Intent(this, NativeBrowserActivity.class).addFlags(
                Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    }

    @Override
    public void markDraining() {
        requireLaunch();
        draining = true;
        controllerActivated = false;
    }

    public boolean isDraining() { return draining; }
    @Override public String incarnation() { return incarnation; }
    public String startupFailure() { return startupFailure; }
}
