package com.ahoo.abs.android.nativekernel;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.drawable.InsetDrawable;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.PixelCopy;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.PopupWindow;
import android.widget.TextView;
import android.widget.Toast;
import com.ahoo.abs.android.MainActivity;
import com.ahoo.abs.android.Ui;
import com.ahoo.abs.android.browser.ControlProtocol;
import com.ahoo.abs.core.LaunchSpec;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import org.chromium.base.Log;
import org.chromium.base.library_loader.LibraryLoader;
import org.chromium.base.library_loader.LibraryProcessType;
import org.chromium.build.annotations.Nullable;
import org.chromium.components.embedder_support.view.ContentViewRenderView;
import org.chromium.content_public.browser.BrowserStartupController;
import org.chromium.content_public.browser.BrowserStartupController.StartupMetrics;
import org.chromium.content_public.browser.DeviceUtils;
import org.chromium.content_public.browser.LoadUrlParams;
import org.chromium.content_public.browser.NavigationController;
import org.chromium.content_public.browser.NavigationHandle;
import org.chromium.content_public.browser.RenderWidgetHostView;
import org.chromium.content_public.browser.WebContentsObserver;
import org.chromium.content_public.browser.Visibility;
import org.chromium.content_public.browser.WebContents;
import org.chromium.content_shell.Shell;
import org.chromium.content_shell.ShellManager;
import org.chromium.ui.base.ActivityWindowAndroid;
import org.chromium.ui.base.IntentRequestTracker;
import org.chromium.url.GURL;

/** Non-exported browser: compact omnibox, full-screen retained-tab overview and native history. */
public final class NativeBrowserActivity extends Activity {
    private static final String TAG = "AbsNativeUi";
    private static final int MAX_TABS = 10;
    private static final int MAX_PREVIEW_RETRIES = 2;
    // Palette resolved from the current night mode in resolvePalette(); the browser surfaces
    // below read these statics (and the C_* holders) instead of hardcoding light values.
    private static int INK;
    private static int MUTED;
    private static int ACCENT;
    private static int SURFACE;
    private static int PILL;
    private static int DIVIDER;
    private static int CANVAS;
    // Shared holders for the other browser surfaces (same package).
    static int C_CANVAS;
    static int C_SURFACE;
    static int C_INK;
    static int C_INK_SOFT;
    static int C_MUTED;
    static int C_ACCENT;
    static int C_ACCENT_DEEP;
    static int C_ACCENT_SOFT;
    static int C_PILL;
    static int C_DIVIDER;
    static int C_STROKE;
    static int C_SUCCESS;
    static int C_WARNING;
    static int C_DANGER;
    static int C_TILE_TOP;
    static int C_TILE_BOTTOM;
    static int C_RIPPLE;
    static boolean C_DARK;

    static void resolvePalette(android.app.Activity activity) {
        int mask = activity.getResources().getConfiguration().uiMode
                & android.content.res.Configuration.UI_MODE_NIGHT_MASK;
        C_DARK = mask == android.content.res.Configuration.UI_MODE_NIGHT_YES;
        Ui.initPalette(activity);
        C_CANVAS = Ui.BG; C_SURFACE = Ui.WHITE; C_INK = Ui.INK; C_INK_SOFT = Ui.INK_SOFT;
        // 辅助文字需在画布和输入底色上可读，不直接沿用仅适合弱化装饰的灰色。
        C_MUTED = C_DARK ? 0xFFADADAD : 0xFF6A6A6A;
        C_ACCENT = Ui.ACCENT; C_ACCENT_DEEP = Ui.ACCENT_DEEP; C_ACCENT_SOFT = Ui.ACCENT_SOFT;
        C_PILL = Ui.SURFACE_SOFT; C_DIVIDER = Ui.STROKE; C_STROKE = Ui.STROKE;
        C_SUCCESS = Ui.SUCCESS; C_WARNING = Ui.WARNING; C_DANGER = Ui.DANGER;
        C_TILE_TOP = C_CANVAS; C_TILE_BOTTOM = C_CANVAS;
        C_RIPPLE = C_DARK ? 0x1AFFFFFF : 0x14000000;
        INK = C_INK; MUTED = C_MUTED; ACCENT = C_ACCENT;
        SURFACE = C_SURFACE; PILL = C_PILL; DIVIDER = C_DIVIDER; CANVAS = C_CANVAS;
    }

    /** Owned-view color bindings; never traverse or restyle the Chromium view hierarchy. */
    static final class PaletteBindings {
        private final List<Runnable> bindings = new ArrayList<>();

        void add(Runnable binding) {
            bindings.add(binding);
            binding.run();
        }

        void apply() {
            for (Runnable binding : bindings) binding.run();
        }

        void clear() {
            bindings.clear();
        }
    }

    /** Original-SP roles, reapplied by the framework (including nonlinear font scaling). */
    static final class FontBindings {
        private final List<Runnable> bindings = new ArrayList<>();

        void bind(TextView view, float originalSp) {
            Runnable binding = () -> view.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, originalSp);
            bindings.add(binding);
            binding.run();
        }

        void apply() {
            for (Runnable binding : bindings) binding.run();
        }

        void clear() {
            bindings.clear();
        }
    }

    private final FontBindings chromeFonts = new FontBindings();
    private final FontBindings overflowFonts = new FontBindings();
    private final FontBindings suggestionFonts = new FontBindings();
    private float appliedFontScale;
    private Runnable overflowResize;

    private final Handler main = new Handler(Looper.getMainLooper());
    // PixelCopy owns its destination until its result callback. Never cancel this handler:
    // shutdown must still deliver the callback that releases an unpublished bitmap.
    private final Handler previewResults = new Handler(Looper.getMainLooper());
    private NativeBrowserApplication application;
    private NativeBrowserRuntime runtime;
    private LinearLayout root;
    private FrameLayout browserFrame;
    private android.graphics.drawable.ColorDrawable windowBackground;
    private ShellManager manager;
    private ActivityWindowAndroid window;
    private IntentRequestTracker intents;
    private TextView tabCounter;
    private TabSwitcherView tabSwitcher;
    private String profileName;
    private List<TabSwitcherView.TabItem> shownTabs = new ArrayList<>();
    private final java.util.HashMap<Shell, Bitmap> tabPreviews = new java.util.HashMap<>();
    private final java.util.HashMap<Shell, String> previewUrls = new java.util.HashMap<>();
    private boolean previewInFlight;
    private boolean previewRequested;
    // One next-frame task per dirty batch; callbacks/lifecycle events rearm blocked sources.
    private boolean previewCapturePosted;
    private int previewRetries;
    private long previewEpoch;
    private ContentViewRenderView renderView;
    private SurfaceHolder.Callback previewSurfaceObserver;
    private final Runnable previewCapture = this::captureActivePreview;
    private EditText address;
    private View back;
    private View menuButton;
    private LinearLayout chromeBar;
    private View chromeDivider;
    private LinearLayout splash;
    private TextView splashStatus;
    private TextView splashTitle;
    private android.widget.ProgressBar splashSpinner;
    private TextView restoreRetry;
    private Shell loadingShell;
    private String clipboardRaw;
    private View progressBar;
    private LinearLayout urlSuggest;
    private long generation;
    private boolean closed;
    private boolean quiescing;
    private boolean resumed;
    private boolean chromeRefreshPosted;
    private boolean restoreSplashShown;
    private boolean restoreInterrupted;
    private int restoreEpoch;
    private Shell restoreShell;
    private WebContents restoreContents;
    private String restoreUrl;
    private long restoreGeneration;
    private Runnable restoreTimeout;
    private Shell chromeShell;
    private WebContents chromeContents;
    private PopupWindow overflowMenu;
    private final PaletteBindings overflowPalette = new PaletteBindings();
    private final PaletteBindings suggestionPalette = new PaletteBindings();
    private boolean cleanupComplete;
    private boolean uiBuilt;
    private final java.util.HashMap<Shell, ShellHistoryObserver> historyObservers = new java.util.HashMap<>();
    private final java.util.HashMap<Shell, String> newTabUrls = new java.util.HashMap<>();
    private boolean ntpRenderDirty;
    private FrameLayout pageContainer;
    private BrowserHistoryStore historyStore;
    private final BrowserHistoryStore.LoadListener historyLoaded = this::onHistoryLoaded;
    private long lastBackExitHint;
    private NewTabPage newTab;
    private HistoryPanel historyPanel;
    // Only an explicit address submission may own this one-shot, neutral-root handoff.
    private Shell pendingFocusShell;
    private WebContents pendingFocusContents;
    private long pendingFocusGeneration;
    private long navigationFocusEpoch;

    private final Runnable chromeRefresh = () -> {
        chromeRefreshPosted = false;
        if (!current() || cleanupComplete) {
            cancelNavigationFocus();
            return;
        }
        if (resumed && uiBuilt) {
            refreshChrome();
            // Never run on the Shell.init/content insertion stack or a synchronous refresh.
            completeNavigationFocus();
        } else {
            cancelNavigationFocus();
            syncWebContentsVisibility();
        }
    };

    /** Coalesce actual native/view events, rather than polling the UI on a perpetual timer. */
    private void requestChromeRefresh() {
        if (closed || quiescing || cleanupComplete || chromeRefreshPosted) return;
        chromeRefreshPosted = true;
        main.post(chromeRefresh);
    }

    @Override
    protected void onCreate(Bundle savedState) {
        super.onCreate(savedState);
        appliedFontScale = getResources().getConfiguration().fontScale;
        resolvePalette(this);
        applySystemBarPalette();
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        // Give clearFocus() a neutral target. Otherwise Android can immediately refocus the
        // only EditText when a Shell disappears, freezing the displayed URL on the closed tab.
        root.setFocusableInTouchMode(true);
        root.setOnFocusChangeListener((view, focused) -> {
            if (!focused) cancelNavigationFocus();
        });
        root.setBackgroundColor(CANVAS);
        browserFrame = createBrowserFrame();
        browserFrame.setBackgroundColor(CANVAS);
        browserFrame.setFitsSystemWindows(true);
        browserFrame.addView(root, new FrameLayout.LayoutParams(-1, -1));
        setContentView(browserFrame);
        buildSplash();
        boolean runtimeAttached = false;
        try {
            application = (NativeBrowserApplication) getApplication();
            Log.i(TAG, "LIFECYCLE_ON_CREATE_INTENT_VALIDATE");
            validateIntent(getIntent());
            LaunchSpec launch = application.requireLaunch();
            Log.i(TAG, "LIFECYCLE_ON_CREATE_SAVED_STATE_SESSION_CHECK");
            if (savedState != null && !launch.sessionId.equals(savedState.getString(ControlProtocol.SESSION))) {
                throw new IllegalStateException("STALE_SAVED_STATE");
            }
            Log.i(TAG, "LIFECYCLE_ON_CREATE_RUNTIME_ATTACH");
            runtime = application.browserRuntime();
            generation = runtime.attach(this);
            runtimeAttached = true;
            Log.i(TAG, "LIFECYCLE_ON_CREATE_RUNTIME_ATTACHED");
            DeviceUtils.updateDeviceSpecificUserAgentSwitch(this);
            application.verifyFrozenCommandLine();
            LibraryLoader.getInstance().ensureInitialized();
            manager = new ShellManager(this, null);
            intents = IntentRequestTracker.createFromActivity(this);
            window = new ActivityWindowAndroid(this, true, intents, null, true);
            manager.setWindow(window);
            // Keep the shared compositor Surface attached while retained Shells change.
            // Product mode also owns the stock Shell toolbar, including fullscreen exits.
            manager.usePersistentTabContentViewHost();
            installShellObserverHooks();
            renderView = manager.getContentViewRenderView();
            installPreviewSurfaceHooks();
            window.setAnimationPlaceholderView(renderView.getSurfaceView());
            buildChrome();
            pageContainer = new FrameLayout(this);
            root.addView(pageContainer, new LinearLayout.LayoutParams(-1, 0, 1));
            attachHistorySurfaces(launch);
            attachTabSwitcher(launch);
            BrowserStartupController.getInstance().startBrowserProcessesAsync(
                    LibraryProcessType.PROCESS_BROWSER, true, false, false,
                    new BrowserStartupController.StartupCallback() {
                        @Override public void onSuccess(@Nullable StartupMetrics metrics) {
                            if (!current() || uiBuilt) return;
                            try {
                                // Keep the renderer off-window until Chrome_UIThread is registered.
                                // Native startup may create a Shell; insert below native overlays.
                                pageContainer.addView(manager, 0, new FrameLayout.LayoutParams(-1, -1));
                                initializeBrowserUi();
                            } catch (RuntimeException failure) {
                                if (!current()) return;
                                Log.w(TAG, "LIFECYCLE_ASYNC_VIEW_INITIALIZATION_FAILURE");
                                startupFailed("NATIVE_VIEW_INITIALIZATION_FAILED");
                            }
                        }
                        @Override public void onFailure() {
                            if (!current()) return;
                            Log.w(TAG, "LIFECYCLE_ASYNC_STARTUP_FAILURE");
                            startupFailed("NATIVE_BROWSER_STARTUP_FAILED");
                        }
                    });
        } catch (RuntimeException failure) {
            Log.w(TAG, "LIFECYCLE_ON_CREATE_REJECTED");
            startupFailed("NATIVE_STARTUP_REJECTED");
            // This newly rejected record owns no attached runtime or native Shells.
            // Return to the manager first. Post-attach/async/reuse failures must retain
            // their Activity until the normal native drain closes its owned views.
            if (!runtimeAttached && !closed && !quiescing) finish();
        }
    }

    private FrameLayout createBrowserFrame() {
        return new FrameLayout(this) {
            @Override
            public WindowInsets onApplyWindowInsets(WindowInsets insets) {
                // Capture before the existing fits owner changes padding/range. Palette
                // pre-draw can already have finished before this later inset traversal.
                if (tabSwitcher != null) tabSwitcher.retainInsetsAnchor();
                return super.onApplyWindowInsets(insets);
            }
        };
    }

    private int dp(float value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
    }

    /** 启动遮罩持续拦截输入，直到原有异步启动流程完成。 */
    private void buildSplash() {
        splash = new LinearLayout(this);
        splash.setOrientation(LinearLayout.VERTICAL);
        splash.setGravity(Gravity.CENTER);
        splash.setBackgroundColor(CANVAS);
        // Cover the (not yet built) content so pre-startup taps cannot reach it.
        splash.setClickable(true);
        splash.setFocusable(true);
        splash.setPadding(dp(24), dp(24), dp(24), dp(24));
        TextView title = new TextView(this);
        splashTitle = title;
        title.setMaxLines(3);
        title.setEllipsize(android.text.TextUtils.TruncateAt.END);
        title.setGravity(Gravity.CENTER);
        title.setText("ABS Browser");
        chromeFonts.bind(title, 19);
        title.setTextColor(INK);
        title.setTypeface(android.graphics.Typeface.create("sans-serif-medium",
                android.graphics.Typeface.NORMAL));
        LinearLayout.LayoutParams titleLp = new LinearLayout.LayoutParams(-2, -2);
        titleLp.topMargin = dp(16);
        splash.addView(title, titleLp);
        splashStatus = new TextView(this);
        splashStatus.setText("正在准备独立环境…");
        splashStatus.setGravity(Gravity.CENTER);
        splashStatus.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        chromeFonts.bind(splashStatus, 13);
        splashStatus.setTextColor(MUTED);
        LinearLayout.LayoutParams statusLp = new LinearLayout.LayoutParams(-2, -2);
        statusLp.topMargin = dp(8);
        splash.addView(splashStatus, statusLp);
        android.widget.ProgressBar spinner = new android.widget.ProgressBar(this);
        splashSpinner = spinner;
        spinner.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(ACCENT));
        LinearLayout.LayoutParams spinnerLp = new LinearLayout.LayoutParams(dp(26), dp(26));
        spinnerLp.topMargin = dp(18);
        splash.addView(spinner, spinnerLp);
        restoreRetry = new TextView(this);
        restoreRetry.setText("重新加载");
        restoreRetry.setGravity(Gravity.CENTER);
        restoreRetry.setMinimumWidth(dp(112));
        restoreRetry.setMinimumHeight(dp(48));
        restoreRetry.setPadding(dp(18), dp(10), dp(18), dp(10));
        chromeFonts.bind(restoreRetry, 14);
        restoreRetry.setOnClickListener(view -> retryPageRestoring());
        restoreRetry.setVisibility(View.GONE);
        LinearLayout.LayoutParams retryLp = new LinearLayout.LayoutParams(-2, -2);
        retryLp.topMargin = dp(18);
        splash.addView(restoreRetry, retryLp);
        applyRestoreActionPalette();
        browserFrame.addView(splash, new FrameLayout.LayoutParams(-1, -1));
    }

    private void hideSplash() {
        if (splash != null && splash.getVisibility() != View.GONE) splash.setVisibility(View.GONE);
    }

    private boolean isPageReady(Shell shell) {
        WebContents contents = shell == null || shell.isDestroyed() ? null : shell.getWebContents();
        RenderWidgetHostView view = contents == null ? null : contents.getRenderWidgetHostView();
        return view != null && view.isReady();
    }

    /** A known renderer loss is not ordinary unreadiness: a saved old frame may still be ready.
     *  The observer owns that interruption even while its tab or Activity is not foreground. */
    private ShellHistoryObserver pageInterruption(Shell shell) {
        ShellHistoryObserver observer = historyObservers.get(shell);
        if (observer == null) return null;
        // A pending URL or navigation start is not proof that the dead document was replaced.
        if (!observer.ownsContents()) {
            observer.clearInterruption();
        }
        return observer.interruptedUrl == null ? null : observer;
    }

    private void showPageRestoring(Shell shell) {
        beginPageRestoring(shell, false);
    }

    /** Ordinary unready pages get a bounded wait; a dead page waits for an explicit user action. */
    private void beginPageRestoring(Shell shell, boolean reloading) {
        ShellHistoryObserver interrupted = pageInterruption(shell);
        // Rebinding a pending/redirected URL is not foreground reentry: keep its original budget.
        long priorDeadline = interrupted != null && restoreInterrupted && restoreShell == shell
                && restoreContents == interrupted.contents ? interrupted.retryDeadline : 0;
        hidePageRestoring();
        if (!uiBuilt || splash == null || !interactive() || !validTab(shell)) return;
        WebContents contents = shell.getWebContents();
        if (contents == null || contents.isDestroyed()
                || (interrupted == null && isBlankPage(shell, visibleUrl(shell)))
                || (!reloading && interrupted == null && isPageReady(shell))) return;
        if (interrupted != null && interrupted.retryBusy && priorDeadline > 0) {
            interrupted.retryDeadline = priorDeadline;
        }
        restoreShell = shell;
        restoreContents = contents;
        restoreUrl = visibleUrl(shell);
        restoreGeneration = generation;
        restoreSplashShown = true;
        restoreInterrupted = interrupted != null;
        splashTitle.setText(tabTitle(shell));
        splash.setVisibility(View.VISIBLE);
        long now = android.os.SystemClock.elapsedRealtime();
        if (interrupted != null && interrupted.retryBusy && interrupted.retryDeadline == 0) {
            interrupted.retryDeadline = now + 8000;
        }
        long remaining = interrupted == null ? 8000 : interrupted.retryDeadline - now;
        if (interrupted != null && remaining <= 0) {
            interrupted.retryBusy = false;
            interrupted.retryDeadline = 0;
            splashStatus.setText(interrupted.retryRequested
                    ? "页面恢复时间较长，可重新加载或切换标签页"
                    : "页面已中断，可重新加载或切换标签页");
            splashSpinner.setVisibility(View.GONE);
            restoreRetry.setVisibility(View.VISIBLE);
            return;
        }
        splashStatus.setText(reloading || interrupted != null ? "正在重新加载页面…" : "正在恢复页面…");
        splashSpinner.setVisibility(View.VISIBLE);
        restoreRetry.setVisibility(View.GONE);
        int epoch = ++restoreEpoch;
        restoreTimeout = () -> {
            if (restoreEpoch != epoch || !ownsPageRestoring(shell, contents)) return;
            restoreTimeout = null;
            if (pageInterruption(shell) == null && isPageReady(shell)) {
                hidePageRestoring();
                return;
            }
            ShellHistoryObserver owner = pageInterruption(shell);
            if (owner != null) {
                owner.retryBusy = false;
                owner.retryDeadline = 0;
            }
            splashSpinner.setVisibility(View.GONE);
            splashStatus.setText("页面恢复时间较长，可重新加载或切换标签页");
            restoreRetry.setVisibility(View.VISIBLE);
        };
        browserFrame.postOnAnimationDelayed(restoreTimeout, remaining);
    }

    private boolean ownsPageRestoring(Shell shell, WebContents contents) {
        return restoreSplashShown && interactive() && restoreGeneration == generation
                && validTab(shell) && manager.getActiveShell() == shell
                && restoreShell == shell && restoreContents == contents
                && shell.getWebContents() == contents && !contents.isDestroyed()
                && restoreUrl.equals(visibleUrl(shell));
    }

    private void hidePageRestoring() {
        if (restoreTimeout != null && browserFrame != null) browserFrame.removeCallbacks(restoreTimeout);
        restoreTimeout = null;
        restoreEpoch++;
        ShellHistoryObserver interrupted = historyObservers.get(restoreShell);
        if (restoreInterrupted && interrupted != null) interrupted.retryDeadline = 0;
        restoreShell = null;
        restoreContents = null;
        restoreUrl = null;
        restoreInterrupted = false;
        if (!restoreSplashShown) return;
        restoreSplashShown = false;
        hideSplash();
    }

    private void retryPageRestoring() {
        Shell shell = restoreShell;
        WebContents contents = restoreContents;
        if (!ownsPageRestoring(shell, contents) || restoreRetry.getVisibility() != View.VISIBLE) return;
        reloadPage(shell);
    }

    /** Both recovery and menu refresh use this gate; never automatically replay a dead document. */
    private void reloadPage(Shell shell) {
        if (!interactive() || !validTab(shell)) return;
        WebContents contents = shell.getWebContents();
        if (contents == null || contents.isDestroyed() || contents.getNavigationController() == null) return;
        ShellHistoryObserver interrupted = pageInterruption(shell);
        if (interrupted != null) {
            if (interrupted.retryBusy) return;
            interrupted.retryBusy = true;
            interrupted.retryRequested = true;
            interrupted.retryCommitted = false;
            interrupted.retryNavigation = null;
            interrupted.retryDeadline = 0;
        } else if (ownsPageRestoring(shell, contents) && restoreRetry.getVisibility() != View.VISIBLE) {
            return;
        }
        // Establish busy feedback and its deadline before reload, including ready-old-frame races.
        beginPageRestoring(shell, true);
        if (ownsPageRestoring(shell, contents) || (interrupted == null && isBlankPage(shell, visibleUrl(shell)))) {
            contents.getNavigationController().reload(true);
        }
    }

    /** Reconcile loss even without a Shell/WebContents transition. Ordinary refreshes never renew
     *  a stalled page's deadline. Only actual screen reentry rearms the foreground wait budget. */
    private void reconcilePageRestoring() {
        Shell active = manager == null ? null : manager.getActiveShell();
        WebContents contents = active == null || active.isDestroyed() ? null : active.getWebContents();
        boolean changed = active != chromeShell || contents != chromeContents;
        chromeShell = active;
        chromeContents = contents;
        boolean interrupted = pageInterruption(active) != null;
        boolean stale = restoreSplashShown && (!ownsPageRestoring(active, contents)
                || restoreInterrupted != interrupted);
        if (restoreSplashShown && !interrupted && isPageReady(active)) hidePageRestoring();
        if ((changed || stale || (interrupted && !restoreSplashShown))
                && interactive() && validTab(active)) showPageRestoring(active);
        else if (stale) hidePageRestoring();
    }

    private void completePageRestoring(Shell shell, WebContents contents) {
        if (pageInterruption(shell) == null && ownsPageRestoring(shell, contents)
                && isPageReady(shell)) hidePageRestoring();
    }

    private void applyRestoreActionPalette() {
        if (restoreRetry == null) return;
        restoreRetry.setTextColor(INK);
        restoreRetry.setBackground(new android.graphics.drawable.RippleDrawable(
                android.content.res.ColorStateList.valueOf(C_RIPPLE), rounded(PILL, 12), null));
    }

    /** The startup splash covers the whole window; after startup it becomes the page-area
     *  restore cover so the address bar and menu remain reachable. */
    private void reparentSplashToPageArea() {
        if (splash == null || pageContainer == null || splash.getParent() != browserFrame) return;
        browserFrame.removeView(splash);
        pageContainer.addView(splash, Math.min(1, pageContainer.getChildCount()),
                new FrameLayout.LayoutParams(-1, -1));
    }

    private void initializeBrowserUi() {
        application.requireBrowserActivation();
        prepareInitialTab();
        uiBuilt = true;
        hideSplash();
        reparentSplashToPageArea();
        refreshChrome();
        requestActivePreview(manager.getActiveShell());
    }

    private GradientDrawable rounded(int color, float radiusDp) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(radiusDp));
        return drawable;
    }

    private FrameLayout chromeButton(Ui.Glyph glyph, String description) {
        FrameLayout button = new FrameLayout(this);
        button.setMinimumWidth(dp(48));
        button.setMinimumHeight(dp(48));
        button.setLayoutParams(new LinearLayout.LayoutParams(dp(48), dp(48)));
        Ui.IconView icon = Ui.icon(this, glyph, INK, 22);
        icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        button.addView(icon, new FrameLayout.LayoutParams(dp(22), dp(22), Gravity.CENTER));
        button.setContentDescription(description);
        button.setFocusable(true);
        return button;
    }

    private void applyChromeButtonPalette(View button) {
        android.graphics.drawable.RippleDrawable ripple;
        if (button.getBackground() instanceof android.graphics.drawable.RippleDrawable) {
            ripple = (android.graphics.drawable.RippleDrawable) button.getBackground();
        } else {
            ripple = new android.graphics.drawable.RippleDrawable(
                    android.content.res.ColorStateList.valueOf(C_RIPPLE), null, rounded(SURFACE, 14));
            button.setBackground(ripple);
        }
        ripple.setColor(android.content.res.ColorStateList.valueOf(C_RIPPLE));
        ((GradientDrawable) ripple.findDrawableByLayerId(android.R.id.mask)).setColor(SURFACE);
        ((Ui.IconView) ((FrameLayout) button).getChildAt(0)).setColor(INK);
    }

    private void applyTabCounterPalette() {
        // 外层始终为48dp触达区，22dp轮廓与计数居中，不将小徽标当成点击范围。
        android.graphics.drawable.RippleDrawable ripple;
        GradientDrawable outline;
        if (tabCounter.getBackground() instanceof android.graphics.drawable.RippleDrawable) {
            ripple = (android.graphics.drawable.RippleDrawable) tabCounter.getBackground();
            outline = (GradientDrawable) ((InsetDrawable) ripple.getDrawable(0)).getDrawable();
        } else {
            outline = rounded(Color.TRANSPARENT, 5);
            InsetDrawable icon = new InsetDrawable(outline, dp(13));
            ripple = new android.graphics.drawable.RippleDrawable(
                    android.content.res.ColorStateList.valueOf(C_RIPPLE), icon, rounded(SURFACE, 14));
            tabCounter.setBackground(ripple);
        }
        outline.setStroke(dp(1.75f), INK);
        ripple.setColor(android.content.res.ColorStateList.valueOf(C_RIPPLE));
        ((GradientDrawable) ripple.findDrawableByLayerId(android.R.id.mask)).setColor(SURFACE);
        tabCounter.setTextColor(INK);
    }

    private void buildChrome() {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.VERTICAL);
        chromeBar = bar;
        bar.setBackgroundColor(SURFACE);

        LinearLayout urlRow = new LinearLayout(this);
        urlRow.setOrientation(LinearLayout.HORIZONTAL);
        urlRow.setGravity(Gravity.CENTER_VERTICAL);
        urlRow.setPadding(dp(4), dp(4), dp(4), dp(4));
        urlRow.setMinimumHeight(dp(56));
        back = chromeButton(Ui.Glyph.BACK, "后退");
        applyChromeButtonPalette(back);
        tabCounter = new TextView(this);
        tabCounter.setText("1");
        chromeFonts.bind(tabCounter, 12);
        tabCounter.setMinimumWidth(dp(48));
        tabCounter.setMinimumHeight(dp(48));
        tabCounter.setFocusable(true);
        tabCounter.setContentDescription("标签页：1 个，打开标签页总览");
        tabCounter.setTypeface(android.graphics.Typeface.create("sans-serif-medium",
                android.graphics.Typeface.NORMAL));
        tabCounter.setGravity(Gravity.CENTER);
        tabCounter.setPadding(0, 0, 0, 0);
        applyTabCounterPalette();
        tabCounter.setOnClickListener(view -> {
            view.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP);
            showTabSwitcher();
        });
        address = new EditText(this);
        address.setSingleLine(true);
        address.setSelectAllOnFocus(true);
        address.setImeOptions(EditorInfo.IME_ACTION_GO);
        chromeFonts.bind(address, 16);
        address.setMinHeight(dp(48));
        address.setContentDescription("搜索或输入网址");
        address.setTextColor(INK);
        address.setHintTextColor(MUTED);
        address.setHint("搜索");
        address.setBackground(rounded(PILL, 22));
        address.setPadding(dp(16), dp(7), dp(16), dp(7));
        address.setInputType(android.text.InputType.TYPE_CLASS_TEXT
                | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        address.setOnEditorActionListener((view, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_GO
                    || (event != null && event.getKeyCode() == android.view.KeyEvent.KEYCODE_ENTER)) {
                navigate(address.getText().toString());
                return true;
            }
            return false;
        });
        FrameLayout menu = chromeButton(Ui.Glyph.MENU, "更多操作");
        menuButton = menu;
        applyChromeButtonPalette(menu);
        back.setOnClickListener(view -> {
            if (!interactive()) return;
            view.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP);
            cancelNavigationFocus();
            WebContents contents = contents();
            NavigationController navigation = contents == null ? null : contents.getNavigationController();
            if (navigation != null && navigation.canGoBack()) navigation.goBack();
        });
        menu.setOnClickListener(view -> {
            view.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP);
            showMenu(view);
        });
        urlRow.addView(back);
        LinearLayout.LayoutParams addressLp = new LinearLayout.LayoutParams(0, -2, 1);
        addressLp.setMarginStart(dp(4));
        urlRow.addView(address, addressLp);
        LinearLayout.LayoutParams counterLp = new LinearLayout.LayoutParams(dp(48), -2);
        counterLp.setMarginStart(dp(4));
        urlRow.addView(tabCounter, counterLp);
        urlRow.addView(menu);
        bar.addView(urlRow, new LinearLayout.LayoutParams(-1, -2));

        View divider = new View(this);
        chromeDivider = divider;
        divider.setBackgroundColor(DIVIDER);
        bar.addView(divider, new LinearLayout.LayoutParams(-1, 1));
        // Reserve the same thin load-feedback slot while idle: GONE/VISIBLE would resize
        // the shared renderer surface on every navigation. INVISIBLE also stops its animation.
        // Navigation ownership/first paint still decide whether feedback is actually visible.
        android.widget.ProgressBar loadBar = new android.widget.ProgressBar(this, null,
                android.R.attr.progressBarStyleHorizontal);
        loadBar.setIndeterminate(true);
        loadBar.getIndeterminateDrawable().setColorFilter(ACCENT, android.graphics.PorterDuff.Mode.SRC_IN);
        loadBar.setVisibility(View.INVISIBLE);
        progressBar = loadBar;
        bar.addView(progressBar, new LinearLayout.LayoutParams(-1, dp(3)));
        // URL suggestions (history-ranked) plus paste-and-go; pushes the page down while open.
        urlSuggest = new LinearLayout(this);
        urlSuggest.setOrientation(LinearLayout.VERTICAL);
        urlSuggest.setBackgroundColor(SURFACE);
        urlSuggest.setElevation(dp(4));
        urlSuggest.setVisibility(View.GONE);
        root.addView(bar, new LinearLayout.LayoutParams(-1, -2));
        root.addView(urlSuggest, new LinearLayout.LayoutParams(-1, -2));
        address.setOnFocusChangeListener((view, hasFocus) -> refreshUrlSuggestions());
        address.addTextChangedListener(new android.text.TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) { }
            @Override public void afterTextChanged(android.text.Editable value) { refreshUrlSuggestions(); }
        });
        bar.setAlpha(0f);
        bar.setTranslationY(-dp(6));
        bar.animate().alpha(1f).translationY(0f).setDuration(220).start();
    }

    private void showMenu(View anchor) {
        if (!interactive()) return;
        cancelNavigationFocus();
        dismissAddressEditor();
        if (overflowMenu != null) overflowMenu.dismiss();
        // Own the drawable/view bindings: a platform PopupMenu cannot retheme its live list
        // through public APIs. Keep this one scrollable popup alive across palette changes.
        android.widget.ScrollView scroll = new android.widget.ScrollView(this);
        LinearLayout menu = new LinearLayout(this);
        menu.setOrientation(LinearLayout.VERTICAL);
        menu.setPadding(0, dp(6), 0, dp(6));
        scroll.addView(menu, new FrameLayout.LayoutParams(-1, -2));
        int width = Math.min(dp(288), getResources().getDisplayMetrics().widthPixels - dp(24));
        PopupWindow popup = new PopupWindow(scroll, width, -2, true);
        GradientDrawable background = rounded(SURFACE, 18);
        popup.setBackgroundDrawable(background);
        popup.setElevation(dp(8));
        popup.setOutsideTouchable(true);
        popup.setInputMethodMode(PopupWindow.INPUT_METHOD_NOT_NEEDED);
        popup.setClippingEnabled(true);
        overflowMenu = popup;
        overflowPalette.add(() -> background.setColor(SURFACE));
        Runnable resize = () -> resizeOverflowMenu(popup, scroll, anchor);
        overflowResize = resize;
        // Font growth can move the anchor on the following real layout. No posted retries.
        View.OnLayoutChangeListener anchorLayout = (view, l, t, r, b, ol, ot, or, ob) -> resize.run();
        anchor.addOnLayoutChangeListener(anchorLayout);
        popup.setOnDismissListener(() -> {
            anchor.removeOnLayoutChangeListener(anchorLayout);
            if (overflowMenu == popup) {
                overflowMenu = null;
                overflowResize = null;
                overflowPalette.clear();
                overflowFonts.clear();
            }
        });
        for (String title : new String[]{"新建标签页", "标签页总览", "历史记录", "前进", "刷新",
                "关闭当前标签页", "返回环境列表（保留运行）", "退出当前环境"}) {
            android.widget.Button action = new android.widget.Button(this);
            action.setText(title);
            overflowFonts.bind(action, 14);
            action.setAllCaps(false);
            action.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
            action.setMinimumHeight(dp(48));
            action.setMinHeight(dp(48));
            action.setPadding(dp(18), dp(10), dp(18), dp(10));
            action.setStateListAnimator(null);
            android.graphics.drawable.RippleDrawable ripple = new android.graphics.drawable.RippleDrawable(
                    android.content.res.ColorStateList.valueOf(C_RIPPLE), null, null);
            action.setBackground(ripple);
            overflowPalette.add(() -> {
                action.setTextColor("退出当前环境".equals(title) ? C_DANGER : INK);
                ripple.setColor(android.content.res.ColorStateList.valueOf(C_RIPPLE));
            });
            action.setOnClickListener(view -> {
                if (overflowMenu != popup || !interactive()) return;
                view.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP);
                popup.dismiss();
                performMenuAction(title);
            });
            menu.addView(action, new LinearLayout.LayoutParams(-1, -2));
        }
        int maxHeight = Math.max(dp(48), popup.getMaxAvailableHeight(anchor, dp(6)));
        scroll.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(maxHeight, View.MeasureSpec.AT_MOST));
        popup.setHeight(scroll.getMeasuredHeight());
        popup.showAsDropDown(anchor, 0, dp(6), Gravity.END);
    }

    /** Remeasure the same live popup after font/layout changes, within its actual anchor bounds. */
    private void resizeOverflowMenu(PopupWindow popup, android.widget.ScrollView scroll, View anchor) {
        if (overflowMenu != popup || !popup.isShowing()) return;
        int width = Math.min(dp(288), getResources().getDisplayMetrics().widthPixels - dp(24));
        int available = Math.max(dp(48), popup.getMaxAvailableHeight(anchor, dp(6)));
        scroll.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(available, View.MeasureSpec.AT_MOST));
        popup.update(width, scroll.getMeasuredHeight());
    }

    private void performMenuAction(String title) {
        if (!interactive()) return;
        if ("新建标签页".equals(title)) {
            if (manager.getShells().size() < MAX_TABS) createBlankTab();
            else Toast.makeText(this, "最多保留 " + MAX_TABS + " 个标签页", Toast.LENGTH_SHORT).show();
        } else if ("标签页总览".equals(title)) {
            showTabSwitcher();
        } else if ("前进".equals(title)) {
            WebContents contents = contents();
            NavigationController navigation = contents == null ? null : contents.getNavigationController();
            if (navigation != null && navigation.canGoForward()) navigation.goForward();
        } else if ("历史记录".equals(title)) {
            showHistoryPanel();
        } else if ("刷新".equals(title)) {
            reloadPage(manager.getActiveShell());
        } else if ("关闭当前标签页".equals(title)) {
            Shell active = manager.getActiveShell();
            if (active != null) closeTab(active);
        } else if ("返回环境列表（保留运行）".equals(title)) {
            returnToList();
            return;
        } else if ("退出当前环境".equals(title)) {
            requestEnvironmentExit();
            return;
        }
        refreshChrome();
    }

    private void navigate(String raw) {
        cancelNavigationFocus();
        if (!interactive() || !hasWindowFocus()) return;
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) return;
        String resolved = BrowserHistory.resolveInput(value);
        if (resolved == null) {
            Toast.makeText(this, "暂不支持打开该类型的链接", Toast.LENGTH_SHORT).show();
            return;
        }
        Shell target = manager.getActiveShell();
        if (!validTab(target)) return;
        WebContents contents = target.getWebContents();
        if (contents == null || contents.isDestroyed()) return;
        long targetGeneration = generation;
        long focusEpoch = navigationFocusEpoch;
        if (!loadResolvedUrlInternal(resolved, false)) return;
        // Native loading/dismissal callbacks may have invalidated and restored the same state.
        if (navigationFocusEpoch != focusEpoch || !interactive() || !hasWindowFocus()
                || generation != targetGeneration
                || !validTab(target) || manager.getActiveShell() != target
                || target.getWebContents() != contents || contents.isDestroyed()) return;
        address.clearFocus();
        root.requestFocus();
        android.view.inputmethod.InputMethodManager keyboard =
                (android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (keyboard != null) keyboard.hideSoftInputFromWindow(address.getWindowToken(), 0);
        if (navigationFocusEpoch != focusEpoch || !interactive() || !hasWindowFocus()
                || !root.isFocused()) return;
        pendingFocusShell = target;
        pendingFocusContents = contents;
        pendingFocusGeneration = targetGeneration;
        requestChromeRefresh();
    }

    private void cancelNavigationFocus() {
        navigationFocusEpoch++;
        pendingFocusShell = null;
        pendingFocusContents = null;
    }

    /** History-ranked URL suggestions plus paste-and-go while the address field is focused. */
    private void refreshUrlSuggestions() {
        if (urlSuggest == null) return;
        if (!interactive() || historyStore == null || !address.hasFocus()) { hideUrlSuggestions(); return; }
        String query = address.getText().toString().trim();
        suggestionPalette.clear();
        suggestionFonts.clear();
        urlSuggest.removeAllViews();
        int added = 0;
        if (query.isEmpty()) {
            String clipboard = clipboardUrl();
            if (clipboard != null) {
                // Show the user their own text; the resolved target is revealed on tap.
                urlSuggest.addView(suggestRow("粘贴并前往：" + clipboardRaw, clipboard, clipboard));
                added++;
            }
            for (BrowserHistory.SiteVisit site : historyStore.ranked()) {
                if (added >= 6) break;
                urlSuggest.addView(suggestRow(displayTitle(site), site.origin, site.origin));
                added++;
            }
        } else {
            String needle = query.toLowerCase(java.util.Locale.ROOT);
            for (BrowserHistory.SiteVisit site : historyStore.ranked()) {
                if (added >= 6) break;
                boolean originMatch = site.origin.toLowerCase(java.util.Locale.ROOT).contains(needle);
                boolean titleMatch = site.title != null
                        && site.title.toLowerCase(java.util.Locale.ROOT).contains(needle);
                if (!originMatch && !titleMatch) continue;
                urlSuggest.addView(suggestRow(displayTitle(site), site.origin, site.origin));
                added++;
            }
        }
        urlSuggest.setVisibility(added > 0 ? View.VISIBLE : View.GONE);
    }

    private static String displayTitle(BrowserHistory.SiteVisit site) {
        return site.title == null || site.title.trim().isEmpty() ? site.origin : site.title.trim();
    }

    private void hideUrlSuggestions() {
        if (urlSuggest != null && urlSuggest.getVisibility() != View.GONE) urlSuggest.setVisibility(View.GONE);
    }

    /** One dismiss path for the address editor (suggestions + focus + keyboard) before overlays. */
    private void dismissAddressEditor() {
        hideUrlSuggestions();
        address.clearFocus();
        root.requestFocus();
        android.view.inputmethod.InputMethodManager keyboard =
                (android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (keyboard != null) keyboard.hideSoftInputFromWindow(address.getWindowToken(), 0);
    }

    /** A pasteable http(s) URL from the clipboard, or null; resolveInput decides reachability. */
    private String clipboardUrl() {
        android.content.ClipboardManager clipboard =
                (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        if (clipboard == null || !clipboard.hasPrimaryClip() || clipboard.getPrimaryClip() == null
                || clipboard.getPrimaryClip().getItemCount() == 0) return null;
        CharSequence text = clipboard.getPrimaryClip().getItemAt(0).coerceToText(this);
        if (text == null) return null;
        String value = text.toString().trim();
        if (value.isEmpty() || value.length() > 2048 || value.contains("\n")) return null;
        String resolved = BrowserHistory.resolveInput(value);
        if (resolved == null) return null;
        clipboardRaw = value;
        return resolved;
    }

    private View suggestRow(String title, String origin, String target) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.VERTICAL);
        android.graphics.drawable.ColorDrawable background =
                new android.graphics.drawable.ColorDrawable(SURFACE);
        android.graphics.drawable.RippleDrawable ripple = new android.graphics.drawable.RippleDrawable(
                android.content.res.ColorStateList.valueOf(C_RIPPLE), background, null);
        row.setBackground(ripple);
        int padH = dp(14);
        row.setPadding(padH, dp(10), padH, dp(10));
        TextView titleView = new TextView(this);
        titleView.setText(title);
        suggestionFonts.bind(titleView, 14.5f);
        titleView.setTextColor(INK);
        titleView.setSingleLine(true);
        titleView.setEllipsize(android.text.TextUtils.TruncateAt.END);
        row.addView(titleView);
        TextView originView = new TextView(this);
        originView.setText(origin);
        suggestionFonts.bind(originView, 12);
        originView.setTextColor(MUTED);
        originView.setSingleLine(true);
        originView.setEllipsize(android.text.TextUtils.TruncateAt.END);
        row.addView(originView);
        suggestionPalette.add(() -> {
            background.setColor(SURFACE);
            ripple.setColor(android.content.res.ColorStateList.valueOf(C_RIPPLE));
            titleView.setTextColor(INK);
            originView.setTextColor(MUTED);
        });
        row.setOnClickListener(view -> {
            view.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP);
            hideUrlSuggestions();
            address.clearFocus();
            root.requestFocus();
            android.view.inputmethod.InputMethodManager keyboard =
                    (android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
            if (keyboard != null) keyboard.hideSoftInputFromWindow(address.getWindowToken(), 0);
            navigate(target);
        });
        return row;
    }

    /** Runs only from the existing posted chrome refresh, after native overlays/visibility sync. */
    private void completeNavigationFocus() {
        Shell target = pendingFocusShell;
        if (target == null) return;
        WebContents contents = pendingFocusContents;
        if (!interactive() || cleanupComplete || !hasWindowFocus()
                || generation != pendingFocusGeneration || !validTab(target)
                || manager.getActiveShell() != target || contents == null
                || target.getWebContents() != contents || contents.isDestroyed()
                || !root.isFocused() || address.hasFocus() || overflowMenu != null
                || (tabSwitcher != null && tabSwitcher.isShowing())
                || (historyPanel != null && historyPanel.getVisibility() == View.VISIBLE)) {
            cancelNavigationFocus();
            return;
        }
        // NTP can outlive loadUrl until Chromium exposes the new visible URL. Wait for an
        // existing native/view event; do not poll, hide it prematurely, or focus underneath it.
        if (newTab != null && newTab.getVisibility() != View.GONE) return;
        // Shell.getContentView dereferences mWebContents: keep the identity/liveness checks above.
        View content = target.getContentView();
        if (content == null || !content.isAttachedToWindow() || !content.isShown()
                || contents.getVisibility() != Visibility.VISIBLE) return;
        cancelNavigationFocus();
        // Consume before this call: reentrancy or a refused request must never cause a retry.
        content.requestFocus();
    }

    private void refreshChrome() {
        if (!current() || manager == null || tabCounter == null) return;
        List<Shell> shells = manager.getShells();
        Shell active = manager.getActiveShell();
        // Native/script window.close removes the active Shell without selecting a survivor.
        // Recover only after controlled startup, and only to an already initialized live tab.
        if (uiBuilt && active == null && !shells.isEmpty()) {
            Shell survivor = shells.get(shells.size() - 1);
            if (!survivor.isDestroyed() && survivor.getWebContents() != null) {
                manager.selectShell(survivor);
                active = manager.getActiveShell();
            }
        }
        tabPreviews.keySet().retainAll(shells);
        previewUrls.keySet().retainAll(shells);
        setTextIfChanged(tabCounter, Integer.toString(shells.size()));
        tabCounter.setContentDescription("标签页：" + shells.size() + " 个，打开标签总览");
        for (Shell shell : shells) hideShellToolbar(shell);
        if (active != null) {
            WebContents contents = active.getWebContents();
            if (contents != null && !address.hasFocus()) {
                String url = contents.getVisibleUrl().getSpec();
                if (url != null && !url.isEmpty() && !isBlankPage(active, url)) {
                    setTextIfChanged(address, url);
                } else if (isBlankPage(active, url)) {
                    setTextIfChanged(address, "");
                }
            }
            NavigationController navigation = contents == null ? null : contents.getNavigationController();
            tint(back, navigation != null && navigation.canGoBack());
        }
        if (historyStore != null) {
            trackHistory();
            updateNtpVisibility();
        }
        // Reconcile the load bar with the now-active shell so it can never stick after a switch.
        Shell barOwner = loadingShell;
        setLoadFeedbackVisible(barOwner != null && !barOwner.isDestroyed() && barOwner == active);
        reconcilePageRestoring();
        refreshTabSwitcher(false);
        syncWebContentsVisibility();
    }

    private void setLoadFeedbackVisible(boolean loading) {
        if (progressBar == null) return;
        int visibility = loading ? View.VISIBLE : View.INVISIBLE;
        if (progressBar.getVisibility() != visibility) progressBar.setVisibility(visibility);
    }

    /** Only the selected, actually foreground web page may be visible to Chromium. */
    private void syncWebContentsVisibility() {
        if (manager == null) return;
        Shell active = manager.getActiveShell();
        // The tab switcher deliberately keeps the active page visible: its cards need a real
        // PixelCopy preview, and pausing/resuming the renderer on every open made switching
        // feel like a freeze. The overlay is opaque, so the page stays out of the user's view.
        boolean pageForeground = resumed && current()
                && (historyPanel == null || historyPanel.getVisibility() != View.VISIBLE)
                && (newTab == null || newTab.getVisibility() != View.VISIBLE);
        for (Shell shell : manager.getShells()) {
            if (shell.isDestroyed()) continue;
            WebContents contents = shell.getWebContents();
            if (contents == null) continue;
            int visibility = pageForeground && shell == active ? Visibility.VISIBLE : Visibility.HIDDEN;
            if (contents.getVisibility() != visibility) contents.updateWebContentsVisibility(visibility);
        }
    }

    private boolean interactive() {
        return resumed && uiBuilt && current() && manager != null;
    }

    private void hideShellToolbar(Shell shell) {
        View toolbar = shell.findViewById(org.chromium.content_shell.R.id.toolbar);
        if (toolbar != null) toolbar.setVisibility(View.GONE);
    }

    private static void setTextIfChanged(TextView view, String text) {
        String value = text == null ? "" : text;
        if (!value.contentEquals(view.getText())) view.setText(value);
    }

    private void tint(View view, boolean enabled) {
        float alpha = enabled ? 1f : 0.3f;
        if (view.getAlpha() != alpha) view.setAlpha(alpha);
    }

    private void attachTabSwitcher(LaunchSpec launch) {
        profileName = launch.profile.name;
        createTabSwitcher();
    }

    /** One switcher instance owns its bindings and survives retained configuration changes. */
    private void createTabSwitcher() {
        if (browserFrame == null) return;
        tabSwitcher = new TabSwitcherView(this, profileName, tabSwitcherListener);
        browserFrame.addView(tabSwitcher, new FrameLayout.LayoutParams(-1, -1));
    }

    private final TabSwitcherView.Listener tabSwitcherListener = new TabSwitcherView.Listener() {
        @Override public void onSelect(Shell shell) {
            if (!interactive() || !validTab(shell)) return;
            manager.selectShell(shell);
            dismissTabSwitcher();
            refreshChrome();
            requestActivePreview(shell);
        }
        @Override public void onClose(Shell shell) {
            if (!interactive() || !validTab(shell)) return;
            closeTab(shell);
            refreshChrome();
        }
        @Override public void onNewTab() {
            if (!interactive()) return;
            if (manager.getShells().size() >= MAX_TABS) {
                Toast.makeText(NativeBrowserActivity.this,
                        "最多保留 " + MAX_TABS + " 个标签页", Toast.LENGTH_SHORT).show();
                return;
            }
            dismissTabSwitcher();
            createBlankTab();
            refreshChrome();
        }
        @Override public void onDismiss() {
            if (!interactive()) return;
            dismissTabSwitcher();
            syncWebContentsVisibility();
        }
    };

    private boolean validTab(Shell shell) {
        return current() && manager != null && shell != null && !shell.isDestroyed()
                && manager.getShells().contains(shell);
    }

    private void showTabSwitcher() {
        if (!interactive() || tabSwitcher == null || tabSwitcher.isShowing()) return;
        cancelNavigationFocus();
        if (historyPanel != null) historyPanel.dismiss();
        address.clearFocus();
        root.requestFocus();
        android.view.inputmethod.InputMethodManager keyboard =
                (android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (keyboard != null) keyboard.hideSoftInputFromWindow(address.getWindowToken(), 0);
        requestActivePreview(manager.getActiveShell());
        shownTabs = tabItems();
        tabSwitcher.show(shownTabs);
        root.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        tabSwitcher.bringToFront();
        syncWebContentsVisibility();
    }

    private void dismissTabSwitcher() {
        if (tabSwitcher != null) tabSwitcher.dismiss();
        if (root != null) root.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO);
        shownTabs = new ArrayList<>();
    }

    private List<TabSwitcherView.TabItem> tabItems() {
        List<TabSwitcherView.TabItem> items = new ArrayList<>();
        if (manager == null) return items;
        Shell active = manager.getActiveShell();
        for (Shell shell : manager.getShells()) {
            if (shell.isDestroyed()) continue;
            String url = visibleUrl(shell);
            String origin = BrowserHistory.canonicalOrigin(url);
            String label = origin == null ? "" : origin;
            Bitmap preview = url.equals(previewUrls.get(shell)) ? tabPreviews.get(shell) : null;
            items.add(new TabSwitcherView.TabItem(shell, tabTitle(shell), label, shell == active, preview));
        }
        return items;
    }

    private String visibleUrl(Shell shell) {
        WebContents contents = shell == null || shell.isDestroyed() ? null : shell.getWebContents();
        return contents == null ? "" : contents.getVisibleUrl().getSpec();
    }

    /** Do not rebuild a scrolling grid on a native event if nothing actually changed. */
    private void refreshTabSwitcher(boolean force) {
        if (tabSwitcher == null || !tabSwitcher.isShowing()) return;
        List<TabSwitcherView.TabItem> items = tabItems();
        boolean changed = force || shownTabs.size() != items.size();
        for (int i = 0; !changed && i < items.size(); i++) {
            TabSwitcherView.TabItem before = shownTabs.get(i);
            TabSwitcherView.TabItem after = items.get(i);
            changed = before.shell != after.shell || before.active != after.active
                    || before.preview != after.preview || !before.title.equals(after.title)
                    || !before.displayUrl.equals(after.displayUrl);
        }
        if (changed) {
            shownTabs = items;
            tabSwitcher.refresh(items);
        }
    }

    /** The renderer is shared by all retained Shells; never search an inactive Shell subtree. */
    private void installPreviewSurfaceHooks() {
        previewSurfaceObserver = new SurfaceHolder.Callback() {
            @Override public void surfaceCreated(SurfaceHolder holder) {
                previewEpoch++;
                requestActivePreview(manager == null ? null : manager.getActiveShell());
            }
            @Override public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
                previewEpoch++;
                requestActivePreview(manager == null ? null : manager.getActiveShell());
            }
            @Override public void surfaceDestroyed(SurfaceHolder holder) {
                previewEpoch++;
                browserFrame.removeCallbacks(previewCapture);
                previewCapturePosted = false;
            }
        };
        renderView.getSurfaceView().getHolder().addCallback(previewSurfaceObserver);
    }

    private void requestActivePreview(Shell shell) {
        if (!resumed || !validTab(shell) || manager.getActiveShell() != shell) return;
        if (!previewRequested) previewRetries = 0;
        previewRequested = true;
        schedulePreviewCapture();
    }

    private void schedulePreviewCapture() {
        if (!previewRequested || previewInFlight || previewCapturePosted || !resumed || !current()) return;
        previewCapturePosted = true;
        // Let the real view/surface lifecycle draw; this does not alter the renderer's cadence.
        browserFrame.postOnAnimation(previewCapture);
    }

    /** Memory-only real pixels; never fake a page preview, capture an API, or write it to disk. */
    private void captureActivePreview() {
        previewCapturePosted = false;
        Shell shell = manager == null ? null : manager.getActiveShell();
        if (!previewRequested || !resumed || !validTab(shell) || previewInFlight) return;
        // Copy only the renderer SurfaceView (or the NTP subtree), never the Window. A native
        // switcher sibling cannot enter those pixels; its opening request may settle behind it.
        if (historyPanel != null && historyPanel.getVisibility() == View.VISIBLE) return;
        WebContents contents = shell.getWebContents();
        if (contents == null) return;
        String url = visibleUrl(shell);
        long epoch = previewEpoch;
        boolean nativeHome = newTab != null && newTab.getVisibility() == View.VISIBLE;
        ShellHistoryObserver observer = historyObservers.get(shell);
        if (!nativeHome && observer != null && observer.awaitingPaint) return;
        SurfaceView surface = renderView == null ? null : renderView.getSurfaceView();
        View source = nativeHome ? newTab : surface;
        if (source == null || !source.isAttachedToWindow() || !source.isShown()
                || source.getWidth() <= 0 || source.getHeight() <= 0) return;
        if (!nativeHome) {
            RenderWidgetHostView renderer = contents.getRenderWidgetHostView();
            if (renderer == null || !renderer.isReady()
                    || !surface.getHolder().getSurface().isValid()) return;
        }
        final Bitmap bitmap;
        try {
            int width = Math.min(270, source.getWidth());
            int height = Math.max(1, Math.min(600,
                    Math.round((float) source.getHeight() * width / source.getWidth())));
            bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        } catch (RuntimeException | OutOfMemoryError unavailable) { return; }
        previewRequested = false;
        if (nativeHome) {
            try {
                Canvas canvas = new Canvas(bitmap);
                canvas.scale((float) bitmap.getWidth() / source.getWidth(),
                        (float) bitmap.getHeight() / source.getHeight());
                source.draw(canvas);
            } catch (RuntimeException unavailable) {
                bitmap.recycle();
                return;
            }
            tabPreviews.put(shell, bitmap);
            previewUrls.put(shell, url);
            refreshTabSwitcher(true);
            return;
        }
        previewInFlight = true;
        try {
            PixelCopy.request(surface, bitmap, result -> {
                previewInFlight = false;
                boolean samePage = resumed && validTab(shell) && previewEpoch == epoch
                        && manager.getActiveShell() == shell && shell.getWebContents() == contents
                        && url.equals(visibleUrl(shell));
                if (result == PixelCopy.SUCCESS && samePage) {
                    // Published bitmaps may be referenced by ImageView/display lists. Let GC
                    // release replaced snapshots; only unpublished destinations are recycled.
                    tabPreviews.put(shell, bitmap);
                    previewUrls.put(shell, url);
                    refreshTabSwitcher(true);
                } else {
                    bitmap.recycle();
                    if (result == PixelCopy.ERROR_SOURCE_NO_DATA) {
                        Log.d(TAG, "Preview copy no data");
                    } else if (result == PixelCopy.ERROR_SOURCE_INVALID) {
                        Log.d(TAG, "Preview copy source invalid");
                    } else if (result == PixelCopy.ERROR_DESTINATION_INVALID) {
                        Log.d(TAG, "Preview copy destination invalid");
                    } else {
                        Log.d(TAG, "Preview copy rejected");
                    }
                    boolean retryable = result == PixelCopy.ERROR_SOURCE_NO_DATA
                            || result == PixelCopy.ERROR_TIMEOUT;
                    if (samePage && retryable && previewRetries < MAX_PREVIEW_RETRIES) {
                        previewRetries++;
                        previewRequested = true;
                    }
                }
                schedulePreviewCapture();
            }, previewResults);
        } catch (RuntimeException unavailable) {
            previewInFlight = false;
            bitmap.recycle();
            Log.w(TAG, "Preview copy unavailable");
        }
    }

    /** Native startup may pre-create one plain blank Shell before its success callback. */
    private void prepareInitialTab() {
        List<Shell> shells = manager.getShells();
        if (shells.isEmpty()) {
            createBlankTab();
            return;
        }
        if (shells.size() != 1) return;
        Shell shell = manager.getActiveShell();
        WebContents contents = shell == null ? null : shell.getWebContents();
        String currentUrl = contents == null ? null : contents.getVisibleUrl().getSpec();
        // This is only called once during controlled startup, never for web-created popups.
        if (currentUrl != null && (currentUrl.isEmpty() || "about:blank".equals(currentUrl))) {
            String url = newBlankUrl();
            newTabUrls.put(shell, url);
            LoadUrlParams params = new LoadUrlParams(url);
            params.setShouldReplaceCurrentEntry(true);
            contents.getNavigationController().loadUrl(params);
        }
    }

    private static String newBlankUrl() {
        return "about:blank#abs-new-tab-" + java.util.UUID.randomUUID();
    }

    private void createBlankTab() {
        if (!current() || manager == null) return;
        java.util.HashSet<Shell> existing = new java.util.HashSet<>(manager.getShells());
        // Keep the original native new-tab history entry distinct from web-created blanks.
        String url = newBlankUrl();
        manager.launchShellInNewTab(url);
        Shell created = manager.getActiveShell();
        if (created != null && !existing.contains(created)) newTabUrls.put(created, url);
        requestChromeRefresh();
    }

    private void closeTab(Shell shell) {
        if (!interactive() || !validTab(shell)) return;
        // Content Shell treats closing its final window as browser shutdown. Materialize the
        // owned replacement first: a user closing the last card must remain in this profile.
        if (manager.getShells().size() == 1 && manager.getShells().contains(shell)) {
            createBlankTab();
            if (manager.getShells().size() <= 1) return;
        }
        manager.closeShell(shell);
        tabPreviews.remove(shell);
        previewUrls.remove(shell);
        if (manager.getShells().isEmpty()) createBlankTab();
        requestActivePreview(manager.getActiveShell());
    }

    private boolean isBlankPage(Shell shell, String url) {
        return "about:blank".equals(url) || (url != null && url.equals(newTabUrls.get(shell)));
    }

    private String tabTitle(Shell shell) {
        WebContents contents = shell == null ? null : shell.getWebContents();
        if (contents != null) {
            String visibleUrl = contents.getVisibleUrl().getSpec();
            if (visibleUrl != null && visibleUrl.equals(newTabUrls.get(shell))) return "新标签页";
            String title = contents.getTitle();
            if (title != null && !title.trim().isEmpty()) return title.trim();
            String url = contents.getVisibleUrl().getSpec();
            if (url != null && !url.isEmpty() && !isBlankPage(shell, url)) {
                try {
                    String host = new java.net.URI(url).getHost();
                    if (host != null && !host.isEmpty()) return host;
                } catch (Exception ignored) { }
                return url;
            }
        }
        return "新标签页";
    }

    // ------------------------------------------------------------- history surfaces

    /** Runtime owns persistence across Activity recreation; these views own removable listeners. */
    private void attachHistorySurfaces(LaunchSpec launch) {
        profileName = launch.profile.name;
        historyStore = runtime.historyStore();
        createHistorySurfaces();
        historyStore.addLoadListener(historyLoaded);
    }

    private void onHistoryLoaded() {
        if (!current() || cleanupComplete) return;
        ntpRenderDirty = true;
        if (newTab != null && newTab.getVisibility() == View.VISIBLE) {
            newTab.refresh();
            ntpRenderDirty = false;
            requestActivePreview(manager == null ? null : manager.getActiveShell());
        }
        if (historyPanel != null) historyPanel.refreshIfVisible();
        if (address != null && address.hasFocus()) refreshUrlSuggestions();
    }

    private void createHistorySurfaces() {
        if (pageContainer == null || historyStore == null) return;
        newTab = new NewTabPage(this, historyStore, profileName, newTabListener);
        pageContainer.addView(newTab, new FrameLayout.LayoutParams(-1, -1));
        attachNewTabPreviewLayout();
        historyPanel = new HistoryPanel(this, historyStore, historyListener);
        // History is a full native destination with its own header. Overlay the browser chrome
        // rather than resizing/reparenting the shared renderer surface on entry and exit.
        browserFrame.addView(historyPanel, new FrameLayout.LayoutParams(-1, -1));
    }

    private void attachNewTabPreviewLayout() {
        if (newTab == null) return;
        newTab.addOnLayoutChangeListener((view, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom) -> {
            if (right - left > 0 && bottom - top > 0
                    && (right - left != oldRight - oldLeft || bottom - top != oldBottom - oldTop)) {
                requestActivePreview(manager == null ? null : manager.getActiveShell());
            }
        });
    }

    private final NewTabPage.Listener newTabListener = new NewTabPage.Listener() {
        @Override public void onNtpNavigate(String url) { loadResolvedUrl(url, false); }
        @Override public void onNtpOpenHistory() { showHistoryPanel(); }
    };

    private final HistoryPanel.Listener historyListener = new HistoryPanel.Listener() {
        @Override public void onOpenHistoryUrl(String url, boolean newTabRequested) {
            loadResolvedUrl(url, newTabRequested);
        }
        @Override public void onHistoryChanged() {
            if (!quiescing && !closed && newTab != null) newTab.refresh();
        }
        @Override public void onHistoryDismissed() {
            if (root != null) root.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO);
            if (quiescing || closed) return;
            syncWebContentsVisibility();
            if (interactive()) requestActivePreview(manager.getActiveShell());
        }
    };

    /** Other native navigation paths cancel, but never create, address-focus ownership. */
    private boolean loadResolvedUrl(String url, boolean newTabRequested) {
        cancelNavigationFocus();
        if (!interactive()) return false;
        return loadResolvedUrlInternal(url, newTabRequested);
    }

    /** Returns true only after a resolved URL has actually been submitted to a live Shell. */
    private boolean loadResolvedUrlInternal(String url, boolean newTabRequested) {
        if (!interactive() || url == null || url.isEmpty()) return false;
        trackHistory();
        hideUrlSuggestions();
        if (historyPanel != null) historyPanel.dismiss();
        if (!interactive()) return false;
        if (newTabRequested) {
            if (manager.getShells().size() >= MAX_TABS) {
                Toast.makeText(this, "最多保留 " + MAX_TABS + " 个标签页", Toast.LENGTH_SHORT).show();
                return false;
            }
            manager.launchShellInNewTab(url);
        } else {
            Shell active = manager.getActiveShell();
            if (!validTab(active)) return false;
            WebContents contents = active.getWebContents();
            if (contents == null || contents.isDestroyed()) return false;
            active.loadUrl(url);
        }
        refreshChrome();
        return true;
    }

    private void showHistoryPanel() {
        if (!interactive() || historyPanel == null) return;
        cancelNavigationFocus();
        dismissAddressEditor();
        historyPanel.show();
        root.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        historyPanel.bringToFront();
        syncWebContentsVisibility();
    }

    /** Attach observers; rendering the chrome never creates visits or increments counts. */
    private void trackHistory() {
        if (historyStore == null || manager == null) return;
        List<Shell> shells = manager.getShells();
        newTabUrls.keySet().retainAll(shells);
        Iterator<java.util.Map.Entry<Shell, ShellHistoryObserver>> old = historyObservers.entrySet().iterator();
        while (old.hasNext()) {
            java.util.Map.Entry<Shell, ShellHistoryObserver> entry = old.next();
            if (!shells.contains(entry.getKey()) || entry.getKey().isDestroyed()) {
                entry.getValue().retire();
                old.remove();
            }
        }
        for (Shell shell : shells) observeShell(shell);
    }

    /**
     * ShellManager adds a Shell before native initFromNativeTabContents adds its ContentView.
     * Observe that synchronous insertion: mWebContents is assigned immediately before it,
     * so popup/target=_blank tabs are observed before native navigation can commit.
     */
    private void installShellObserverHooks() {
        manager.setOnHierarchyChangeListener(new ViewGroup.OnHierarchyChangeListener() {
            @Override public void onChildViewAdded(View parent, View child) {
                if (!(child instanceof Shell)) return;
                cancelNavigationFocus();
                previewEpoch++;
                requestChromeRefresh();
                Shell shell = (Shell) child;
                View holder = shell.findViewById(org.chromium.content_shell.R.id.contentview_holder);
                if (holder instanceof ViewGroup) {
                    ((ViewGroup) holder).setOnHierarchyChangeListener(new ViewGroup.OnHierarchyChangeListener() {
                        @Override public void onChildViewAdded(View contentParent, View content) { observeShell(shell); }
                        @Override public void onChildViewRemoved(View contentParent, View content) { }
                    });
                }
                observeShell(shell);
            }
            @Override public void onChildViewRemoved(View parent, View child) {
                if (child instanceof Shell) {
                    cancelNavigationFocus();
                    previewEpoch++;
                    requestChromeRefresh();
                }
            }
        });
    }

    private void observeShell(Shell shell) {
        if (!current() || historyStore == null) return;
        WebContents contents = shell.isDestroyed() ? null : shell.getWebContents();
        ShellHistoryObserver prior = historyObservers.get(shell);
        if (contents == null || contents.isDestroyed()) {
            if (prior != null) {
                historyObservers.remove(shell);
                prior.retire();
            }
            return;
        }
        if (prior == null || prior.getWebContents() != contents || prior.ownerGeneration != generation) {
            if (prior != null) prior.retire();
            historyObservers.put(shell, new ShellHistoryObserver(shell, contents));
            requestChromeRefresh();
            requestActivePreview(shell);
        }
    }

    private final class ShellHistoryObserver extends WebContentsObserver {
        private final Shell shell;
        private final WebContents contents;
        private final long ownerGeneration = generation;
        private String committedUrl;
        private boolean awaitingPaint;
        private long navigationSerial;
        private String interruptedUrl;
        private long interruptedNavigation;
        private long retryDeadline;
        private boolean retryRequested;
        private boolean retryBusy;
        private boolean retryCommitted;
        private NavigationHandle retryNavigation;

        ShellHistoryObserver(Shell shell, WebContents contents) {
            super(contents);
            this.shell = shell;
            this.contents = contents;
        }

        private boolean ownsContents() {
            return current() && ownerGeneration == generation && validTab(shell)
                    && historyObservers.get(shell) == this && getWebContents() == contents
                    && shell.getWebContents() == contents && !contents.isDestroyed();
        }

        private void clearInterruption() {
            interruptedUrl = null;
            retryNavigation = null;
            retryRequested = false;
            retryBusy = false;
            retryCommitted = false;
            retryDeadline = 0;
        }

        private void retire() {
            clearInterruption();
            observe(null);
        }

        @Override public void primaryMainFrameRenderProcessGone(int terminationStatus) {
            if (!ownsContents()) return;
            String deadDocumentUrl = contents.getLastCommittedUrl().getSpec();
            clearInterruption();
            if (visibleUrl(shell).equals(newTabUrls.get(shell))
                    && deadDocumentUrl.equals(newTabUrls.get(shell))) {
                // A pending back-to-NTP URL cannot exempt a still-committed dead web document.
                // Only the actually committed owned native NTP is renderer-independent.
                requestChromeRefresh();
                return;
            }
            interruptedUrl = deadDocumentUrl.isEmpty() ? visibleUrl(shell) : deadDocumentUrl;
            interruptedNavigation = ++navigationSerial;
            awaitingPaint = true;
            tabPreviews.remove(shell);
            previewUrls.remove(shell);
            if (loadingShell == shell) loadingShell = null;
            if (manager.getActiveShell() == shell) {
                previewEpoch++;
                previewRequested = false;
                browserFrame.removeCallbacks(previewCapture);
                previewCapturePosted = false;
                // No automatic reload/POST replay, and no same-Shell identity-change dependency.
                showPageRestoring(shell);
            }
            requestChromeRefresh();
        }

        @Override public void didStartNavigationInPrimaryMainFrame(NavigationHandle navigation) {
            if (!ownsContents() || !navigation.isInPrimaryMainFrame()) return;
            if (!navigation.isSameDocument()) {
                navigationSerial++;
                if (interruptedUrl != null) {
                    // Address/history navigation can replace the dead document too, but a start,
                    // pending URL, abort, error page, or same-document change cannot prove it did.
                    retryCommitted = false;
                    retryNavigation = navigation;
                    interruptedNavigation = navigationSerial;
                }
            }
            tabPreviews.remove(shell);
            previewUrls.remove(shell);
            if (!navigation.isSameDocument()) awaitingPaint = true;
            if (manager.getActiveShell() == shell) {
                previewEpoch++;
                previewRequested = false;
                browserFrame.removeCallbacks(previewCapture);
                previewCapturePosted = false;
                if (!navigation.isSameDocument()) loadingShell = shell;
            }
            requestChromeRefresh();
        }

        /** isReady may describe a saved dead frame. Only a fresh, committed replacement navigation
         *  followed by its URL-correct paint/valid load-stop can retire a known interruption. */
        private boolean finishInterruptedPage(String url) {
            if (interruptedUrl == null) return true;
            if (!retryCommitted || interruptedNavigation != navigationSerial
                    || !interruptedUrl.equals(url) || !url.equals(visibleUrl(shell))
                    || !isPageReady(shell)) return false;
            clearInterruption();
            return true;
        }

        @Override public void didFirstVisuallyNonEmptyPaint() {
            if (!ownsContents() || !finishInterruptedPage(visibleUrl(shell))) return;
            awaitingPaint = false;
            if (loadingShell == shell) loadingShell = null;
            completePageRestoring(shell, contents);
            requestActivePreview(shell);
            requestChromeRefresh();
        }

        @Override public void didStopLoading(GURL url, boolean isKnownValid) {
            if (!ownsContents() || (interruptedUrl != null
                    && (!isKnownValid || !finishInterruptedPage(url.getSpec())))) return;
            awaitingPaint = false;
            if (loadingShell == shell) loadingShell = null;
            completePageRestoring(shell, contents);
            requestActivePreview(shell);
            requestChromeRefresh();
        }

        @Override public void navigationEntriesChanged() {
            if (ownsContents()) requestChromeRefresh();
        }
        @Override public void onVisibilityChanged(int visibility) {
            if (ownsContents()) requestChromeRefresh();
        }
        @Override public void webContentsDestroyed() {
            retire();
            if (historyObservers.get(shell) != this) return;
            historyObservers.remove(shell);
            if (restoreShell == shell && restoreContents == contents) hidePageRestoring();
            if (loadingShell == shell) loadingShell = null;
            requestChromeRefresh();
        }

        @Override public void didFinishNavigationInPrimaryMainFrame(NavigationHandle navigation) {
            if (!ownsContents() || !navigation.isInPrimaryMainFrame()) return;
            if (retryNavigation == navigation) {
                retryNavigation = null; // Chromium requires releasing the handle at finish.
                retryCommitted = navigation.hasCommitted() && !navigation.isSameDocument()
                        && !navigation.isErrorPage() && interruptedNavigation == navigationSerial;
                if (retryCommitted) interruptedUrl = navigation.getUrl().getSpec();
                else {
                    retryBusy = false;
                    retryDeadline = 0;
                    if (manager.getActiveShell() == shell) showPageRestoring(shell);
                }
                requestChromeRefresh();
            }
            if (!navigation.hasCommitted()) return;
            requestChromeRefresh();
            if (navigation.isSameDocument()) requestActivePreview(shell);
            String url = navigation.getUrl().getSpec();
            if (navigation.isSameDocument() && interruptedUrl != null && retryCommitted
                    && interruptedNavigation == navigationSerial && !navigation.isErrorPage()
                    && url.equals(visibleUrl(shell))) {
                // A router may change a fresh replacement's URL before its first paint/stop.
                // Same-document navigation follows existing proof; it can never create it.
                interruptedUrl = url;
            }
            if (navigation.isErrorPage() || !BrowserHistory.isTrackable(url)) {
                committedUrl = null;
                return;
            }
            committedUrl = url;
            if (navigation.isSameDocument()) historyStore.updateTitle(url, contents.getTitle());
            else historyStore.recordVisit(url, contents.getTitle());
            ntpRenderDirty = true;
        }

        @Override public void titleWasSet(String title) {
            if (!ownsContents()) return;
            if (committedUrl != null) {
                historyStore.updateTitle(committedUrl, title);
                ntpRenderDirty = true;
            }
            requestChromeRefresh();
        }
    }

    /** Only the original, explicitly browser-created blank entry receives the native overlay. */
    private void updateNtpVisibility() {
        if (newTab == null) return;
        Shell active = manager.getActiveShell();
        String url = null;
        if (active != null && !active.isDestroyed()) {
            WebContents contents = active.getWebContents();
            url = contents == null ? null : contents.getVisibleUrl().getSpec();
        }
        boolean show = active != null && url != null && url.equals(newTabUrls.get(active));
        boolean visible = newTab.getVisibility() == View.VISIBLE;
        if (show && !visible) {
            newTab.onShown();
            requestActivePreview(active);
        }
        else if (!show && visible) newTab.setVisibility(View.GONE);
        if (show && visible && ntpRenderDirty) newTab.refresh();
        ntpRenderDirty = false;
    }

    private void validateIntent(Intent intent) {
        application.requireBrowserActivation();
        LaunchSpec launch = application.requireLaunch();
        Bundle extras = intent == null ? null : intent.getExtras();
        if (intent == null || intent.getData() != null || intent.getSelector() != null
                || intent.getClipData() != null || extras == null || extras.size() != 2
                || extras.containsKey("commandLineArgs")
                || !launch.sessionId.equals(extras.getString(ControlProtocol.SESSION))
                || !launch.nonce.equals(extras.getString(ControlProtocol.NONCE))) {
            throw new IllegalStateException("STALE_OR_UNSAFE_NATIVE_ACTIVITY_INTENT");
        }
    }

    private boolean current() {
        return !closed && !quiescing && !isFinishing() && !isDestroyed()
                && runtime != null && runtime.isCurrent(this, generation);
    }

    private WebContents contents() {
        Shell shell = manager == null ? null : manager.getActiveShell();
        return shell == null ? null : shell.getWebContents();
    }

    // Status hook stays a trivial no-op: the runtime may call it before ownership is published,
    // so nothing here may throw or touch views (pinned by NativeBrowserUiSourceContractTest).
    void onStatus(String text) { }

    private void startupFailed(String code) {
        if (!closed && !quiescing && !isFinishing() && !isDestroyed()) {
            Toast.makeText(this, "内核启动失败：" + code, Toast.LENGTH_LONG).show();
            returnToList();
        }
    }

    private void cancelUiWork() {
        cancelNavigationFocus();
        main.removeCallbacks(chromeRefresh);
        chromeRefreshPosted = false;
        previewRequested = false;
        hidePageRestoring();
        // Pause only retires visible work. A runtime/Activity exit also retires durable loss state.
        if (!current()) {
            for (ShellHistoryObserver observer : historyObservers.values()) observer.clearInterruption();
        }
        chromeShell = null;
        chromeContents = null;
        hideUrlSuggestions();
        setLoadFeedbackVisible(false);
        if (browserFrame != null) browserFrame.removeCallbacks(previewCapture);
        previewCapturePosted = false;
        // Do not cancel previewResults: PixelCopy still owns any in-flight destination.
    }

    /**
     * Runtime calls this BEFORE its asynchronous native storage flush. This is a one-way
     * input/navigation barrier, not a worker fence or a storage-completion acknowledgment.
     * Shells and their WebContents must remain alive until the native callback acknowledges.
     */
    void quiesceForShutdown() {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            throw new IllegalStateException("NATIVE_QUIESCE_WRONG_THREAD");
        }
        if (quiescing || cleanupComplete) return;
        quiescing = true;
        resumed = false;
        previewEpoch++;
        cancelUiWork();
        if (overflowMenu != null) overflowMenu.dismiss();
        dismissTabSwitcher();
        if (historyPanel != null) historyPanel.quiesce();
        if (newTab != null) newTab.quiesce();
        if (root != null) {
            root.setDescendantFocusability(ViewGroup.FOCUS_BLOCK_DESCENDANTS);
            root.clearFocus();
        }
        android.view.inputmethod.InputMethodManager keyboard =
                (android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (keyboard != null && address != null) {
            keyboard.hideSoftInputFromWindow(address.getWindowToken(), 0);
        }
        RuntimeException failure = null;
        if (manager != null) {
            for (Shell shell : manager.getShells()) {
                if (shell.isDestroyed()) continue;
                WebContents contents = shell.getWebContents();
                if (contents == null) continue;
                try { contents.stop(); }
                catch (RuntimeException stopFailure) {
                    if (failure == null) failure = stopFailure; else failure.addSuppressed(stopFailure);
                }
                try { contents.updateWebContentsVisibility(Visibility.HIDDEN); }
                catch (RuntimeException hideFailure) {
                    if (failure == null) failure = hideFailure; else failure.addSuppressed(hideFailure);
                }
            }
        }
        if (historyStore != null) historyStore.flush();
        if (failure != null) throw new IllegalStateException("NATIVE_VIEW_QUIESCE_UNCONFIRMED", failure);
    }

    void closeNativeView() {
        if (cleanupComplete) return;
        RuntimeException failure = null;
        try { quiesceForShutdown(); }
        catch (RuntimeException quiesceFailure) { failure = quiesceFailure; }
        closed = true;
        cancelUiWork();
        if (historyStore != null) {
            historyStore.removeLoadListener(historyLoaded);
            try { historyStore.flush(); } catch (RuntimeException ignored) { }
        }
        for (ShellHistoryObserver observer : historyObservers.values()) observer.retire();
        historyObservers.clear();
        newTabUrls.clear();
        tabPreviews.clear();
        previewUrls.clear();
        dismissTabSwitcher();
        if (tabSwitcher != null) tabSwitcher.release();
        if (renderView != null && previewSurfaceObserver != null) {
            renderView.getSurfaceView().getHolder().removeCallback(previewSurfaceObserver);
            previewSurfaceObserver = null;
        }
        renderView = null;
        try {
            if (manager != null) {
                for (Shell shell : new ArrayList<>(manager.getShells())) {
                    try { if (!shell.isDestroyed()) shell.close(); }
                    catch (RuntimeException shellFailure) {
                        if (failure == null) failure = shellFailure; else failure.addSuppressed(shellFailure);
                    }
                }
                manager.destroy();
                manager = null;
            }
        } catch (RuntimeException managerFailure) {
            if (failure == null) failure = managerFailure; else failure.addSuppressed(managerFailure);
        }
        try {
            if (window != null) window.destroy();
            window = null;
        } catch (RuntimeException windowFailure) {
            if (failure == null) failure = windowFailure; else failure.addSuppressed(windowFailure);
        }
        if (failure != null) throw new IllegalStateException("NATIVE_VIEW_CLOSE_UNCONFIRMED", failure);
        cleanupComplete = true;
    }

    private void requestEnvironmentExit() {
        if (!interactive()) return;
        // The manager owns the cross-process drain/exit protocol. Never just finish this
        // Activity: doing so would leave the environment lock and browser process alive.
        com.ahoo.abs.core.LaunchSpec launch = application.requireLaunch();
        Intent home = new Intent(this, MainActivity.class);
        home.setAction(MainActivity.ACTION_REQUEST_ENVIRONMENT_EXIT);
        home.putExtra(ControlProtocol.SESSION, launch.sessionId);
        home.putExtra(ControlProtocol.NONCE, launch.nonce);
        home.addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(home);
    }

    private void returnToList() {
        if (quiescing || closed) return;
        // Returning to the manager is not profile exit: preserve this Activity and every tab.
        Intent home = new Intent(this, MainActivity.class);
        home.addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(home);
    }

    @Override
    public boolean dispatchTouchEvent(MotionEvent event) {
        if (event.getActionMasked() == MotionEvent.ACTION_DOWN) cancelNavigationFocus();
        return quiescing || closed || super.dispatchTouchEvent(event);
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        // ENTER key-up belongs to the submission that just created the pending handoff.
        if (event.getAction() == KeyEvent.ACTION_DOWN) cancelNavigationFocus();
        return quiescing || closed || super.dispatchKeyEvent(event);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        if (!hasFocus) cancelNavigationFocus();
        super.onWindowFocusChanged(hasFocus);
    }

    private void applySystemBarPalette() {
        // Capture before any Window/DecorView mutation, not after its scroll range can clamp.
        if (tabSwitcher != null) tabSwitcher.retainPaletteAnchor();
        Window windowFrame = getWindow();
        // Android 15+ may enforce transparent bars. Install the underlay once and avoid
        // potentially re-entering background/inset work by replacing it for a color-only
        // repaint. Retain drawable identity while any system-bar/inset work settles.
        if (windowBackground == null) {
            windowBackground = new android.graphics.drawable.ColorDrawable(CANVAS);
            windowFrame.setBackgroundDrawable(windowBackground);
        } else {
            windowBackground.setColor(CANVAS);
        }
        if (browserFrame != null) browserFrame.setBackgroundColor(CANVAS);
        applySystemBarAppearance(windowFrame);
    }

    static void applySystemBarAppearance(Window windowFrame) {
        if (windowFrame == null) return;
        windowFrame.setStatusBarColor(C_CANVAS);
        windowFrame.setNavigationBarColor(C_CANVAS);
        int lightFlags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        View decor = windowFrame.getDecorView();
        // Keep the existing fitsSystemWindows owner on stable system-bar geometry. A
        // transient navigation-bar visibility change must not enlarge a ScrollView and
        // irreversibly clamp its position after the palette's first pre-draw has finished.
        // Preserve all other flags; this changes neither bar visibility nor IME layout.
        int layoutFlags = decor.getSystemUiVisibility() | View.SYSTEM_UI_FLAG_LAYOUT_STABLE;
        decor.setSystemUiVisibility(C_DARK ? layoutFlags & ~lightFlags : layoutFlags | lightFlags);
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
            android.view.WindowInsetsController controller = windowFrame.getInsetsController();
            if (controller != null) {
                int mask = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                controller.setSystemBarsAppearance(C_DARK ? 0 : mask, mask);
            }
        }
    }

    private void applyChromePalette() {
        applySystemBarPalette();
        if (root != null) root.setBackgroundColor(CANVAS);
        if (splash != null) {
            splash.setBackgroundColor(CANVAS);
            splashTitle.setTextColor(INK);
            splashStatus.setTextColor(MUTED);
            splashSpinner.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(ACCENT));
            applyRestoreActionPalette();
        }
        if (chromeBar == null) return;
        chromeBar.setBackgroundColor(SURFACE);
        chromeDivider.setBackgroundColor(DIVIDER);
        address.setTextColor(INK);
        address.setHintTextColor(MUTED);
        ((GradientDrawable) address.getBackground()).setColor(PILL);
        applyChromeButtonPalette(back);
        applyChromeButtonPalette(menuButton);
        applyTabCounterPalette();
        ((android.widget.ProgressBar) progressBar).getIndeterminateDrawable()
                .setColorFilter(ACCENT, android.graphics.PorterDuff.Mode.SRC_IN);
        urlSuggest.setBackgroundColor(SURFACE);
        suggestionPalette.apply();
        overflowPalette.apply();
        // Overlay owners recolor their own semantic bindings, never the renderer view tree.
    }

    /** Repaint even paused/startup surfaces without changing drafts, focus, scroll or visibility. */
    private void applySurfacePalette() {
        if (closed || quiescing || cleanupComplete) return;
        if (newTab != null) newTab.applyPalette();
        if (historyPanel != null) historyPanel.applyPalette();
        if (tabSwitcher != null) tabSwitcher.applyPalette();
    }

    /** Update only owned native text; keep drafts, focus, windows and native owners intact. */
    private void applySurfaceFonts() {
        if (closed || quiescing || cleanupComplete) return;
        chromeFonts.apply();
        suggestionFonts.apply();
        overflowFonts.apply();
        if (newTab != null) newTab.applyFontScale();
        if (historyPanel != null) historyPanel.applyFontScale();
        if (tabSwitcher != null) tabSwitcher.applyFontScale();
        if (overflowResize != null) overflowResize.run();
    }

    @Override
    public void onConfigurationChanged(android.content.res.Configuration newConfig) {
        // Super can dispatch configuration to the Window before our palette repaint begins.
        if (tabSwitcher != null) tabSwitcher.retainPaletteAnchor();
        super.onConfigurationChanged(newConfig);
        boolean wasDark = C_DARK;
        resolvePalette(this);
        if (wasDark != C_DARK) {
            applyChromePalette();
            applySurfacePalette();
        }
        // Resources may already expose newConfig on entry: compare our last applied value.
        if (Float.compare(appliedFontScale, newConfig.fontScale) != 0) {
            appliedFontScale = newConfig.fontScale;
            applySurfaceFonts();
        }
        requestChromeRefresh();
    }

    @Override
    public void onBackPressed() {
        // A dead startup screen must keep a working Back path (the activity is retained on purpose).
        if (!interactive()) {
            if (!closed && !quiescing && !isFinishing() && !isDestroyed()) returnToList();
            return;
        }
        cancelNavigationFocus();
        if ((address != null && address.hasFocus())
                || (urlSuggest != null && urlSuggest.getVisibility() == View.VISIBLE)) {
            dismissAddressEditor();
            return;
        }
        if (tabSwitcher != null && tabSwitcher.isShowing()) {
            dismissTabSwitcher();
            syncWebContentsVisibility();
            return;
        }
        if (historyPanel != null && historyPanel.getVisibility() == View.VISIBLE) {
            historyPanel.dismiss();
            return;
        }
        if (newTab != null && newTab.getVisibility() == View.VISIBLE) {
            Shell blank = manager == null ? null : manager.getActiveShell();
            if (blank != null && manager.getShells().size() > 1) {
                closeTab(blank);
                refreshChrome();
            } else returnToList();
            return;
        }
        Shell active = manager == null ? null : manager.getActiveShell();
        WebContents contents = active == null ? null : active.getWebContents();
        if (contents != null) {
            NavigationController navigation = contents.getNavigationController();
            if (navigation != null && navigation.canGoBack()) { navigation.goBack(); return; }
        }
        if (manager != null && manager.getShells().size() > 1 && active != null) {
            closeTab(active);
            refreshChrome();
            return;
        }
        // Last tab, nowhere to go back: the first press explains, the second confirms. The
        // environment process keeps running either way ("返回环境列表不等于结束浏览器进程").
        long now = android.os.SystemClock.elapsedRealtime();
        if (now - lastBackExitHint < 2000) { returnToList(); return; }
        lastBackExitHint = now;
        Toast.makeText(this, "再按一次返回环境列表（环境仍在后台运行）", Toast.LENGTH_SHORT).show();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        try {
            validateIntent(intent);
            application.verifyFrozenCommandLine();
            if (!current()) throw new IllegalStateException("NATIVE_REUSE_NOT_CURRENT");
            // A valid Continue reuses the frozen runtime/manager. Never attach, rebuild, or
            // recreate the startup blank tab from a new Intent.
            setIntent(intent);
            requestChromeRefresh();
        } catch (RuntimeException rejected) {
            Log.w(TAG, "LIFECYCLE_ON_NEW_INTENT_REJECTED");
            startupFailed("NATIVE_NEW_INTENT_REJECTED");
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        if (application != null) {
            try { state.putString(ControlProtocol.SESSION, application.requireLaunch().sessionId); }
            catch (IllegalStateException rejected) { state.putString(ControlProtocol.SESSION, "rejected"); }
        }
        super.onSaveInstanceState(state);
    }

    @Override
    protected void onResume() {
        super.onResume();
        MediaPermissionBridge.setHost(this);
        if (closed || quiescing) return;
        resumed = true;
        lastBackExitHint = 0;
        requestChromeRefresh();
        requestActivePreview(manager == null ? null : manager.getActiveShell());
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        MediaPermissionBridge.onHostResult(permissions, grantResults);
    }

    @Override
    protected void onStop() {
        resumed = false;
        cancelUiWork();
        syncWebContentsVisibility();
        super.onStop();
    }

    @Override
    protected void onPause() {
        resumed = false;
        previewEpoch++;
        if (overflowMenu != null) overflowMenu.dismiss();
        dismissTabSwitcher();
        if (historyPanel != null) historyPanel.dismiss();
        if (newTab != null) newTab.dismissDialogs();
        cancelUiWork();
        syncWebContentsVisibility();
        if (historyStore != null) {
            try { historyStore.flush(); } catch (RuntimeException ignored) { }
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        MediaPermissionBridge.clearHost(this);
        try { closeNativeView(); }
        finally {
            if (runtime != null) runtime.detach(this);
            super.onDestroy();
        }
    }
}
