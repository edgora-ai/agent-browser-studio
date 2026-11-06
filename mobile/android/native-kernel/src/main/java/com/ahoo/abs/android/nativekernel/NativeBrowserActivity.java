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
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.TextView;
import android.widget.Toast;
import com.ahoo.abs.android.MainActivity;
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
    private static int ACCENT_SOFT;
    private static int SURFACE;
    private static int PILL;
    private static int DIVIDER;
    private static int CANVAS;
    // Shared holders for the other browser surfaces (same package).
    static int C_CANVAS, C_SURFACE, C_INK, C_INK_SOFT, C_MUTED, C_ACCENT, C_ACCENT_DEEP, C_ACCENT_SOFT,
            C_PILL, C_DIVIDER, C_STROKE, C_SUCCESS, C_WARNING, C_DANGER, C_TILE_TOP, C_TILE_BOTTOM,
            C_RIPPLE;
    static boolean C_DARK;

    static void resolvePalette(android.app.Activity activity) {
        int mask = activity.getResources().getConfiguration().uiMode
                & android.content.res.Configuration.UI_MODE_NIGHT_MASK;
        C_DARK = mask == android.content.res.Configuration.UI_MODE_NIGHT_YES;
        if (C_DARK) {
            C_CANVAS = 0xFF0E1016; C_SURFACE = 0xFF171B26; C_INK = 0xFFE6E9F2; C_INK_SOFT = 0xFFC3C9D6;
            C_MUTED = 0xFF8B94A7; C_ACCENT = 0xFF818CF8; C_ACCENT_DEEP = 0xFFA5B4FC; C_ACCENT_SOFT = 0xFF23264A;
            C_PILL = 0xFF232838; C_DIVIDER = 0xFF232838; C_STROKE = 0xFF232838;
            C_SUCCESS = 0xFF34D399; C_WARNING = 0xFFFBBF24; C_DANGER = 0xFFF87171;
            C_TILE_TOP = 0xFF1B2030; C_TILE_BOTTOM = 0xFF12151F; C_RIPPLE = 0x1AFFFFFF;
        } else {
            C_CANVAS = 0xFFF4F5F9; C_SURFACE = 0xFFFFFFFF; C_INK = 0xFF0F172A; C_INK_SOFT = 0xFF334155;
            C_MUTED = 0xFF64748B; C_ACCENT = 0xFF4F46E5; C_ACCENT_DEEP = 0xFF4338CA; C_ACCENT_SOFT = 0xFFEDEFFF;
            C_PILL = 0xFFF2F4F8; C_DIVIDER = 0xFFEDEFF4; C_STROKE = 0xFFE7E9F0;
            C_SUCCESS = 0xFF059669; C_WARNING = 0xFFD97706; C_DANGER = 0xFFDC2626;
            C_TILE_TOP = 0xFFFBFBFD; C_TILE_BOTTOM = 0xFFF1F3F8; C_RIPPLE = 0x1A0F172A;
        }
        INK = C_INK; MUTED = C_MUTED; ACCENT = C_ACCENT; ACCENT_SOFT = C_ACCENT_SOFT;
        SURFACE = C_SURFACE; PILL = C_PILL; DIVIDER = C_DIVIDER; CANVAS = C_CANVAS;
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    // PixelCopy owns its destination until its result callback. Never cancel this handler:
    // shutdown must still deliver the callback that releases an unpublished bitmap.
    private final Handler previewResults = new Handler(Looper.getMainLooper());
    private NativeBrowserApplication application;
    private NativeBrowserRuntime runtime;
    private LinearLayout root;
    private FrameLayout browserFrame;
    private ShellManager manager;
    private ActivityWindowAndroid window;
    private IntentRequestTracker intents;
    private TextView tabCounter;
    private TabSwitcherView tabSwitcher;
    private List<TabSwitcherView.TabItem> shownTabs = new ArrayList<>();
    private final java.util.HashMap<Shell, Bitmap> tabPreviews = new java.util.HashMap<>();
    private final java.util.HashMap<Shell, String> previewUrls = new java.util.HashMap<>();
    private boolean previewInFlight;
    private boolean previewRequested;
    private int previewRetries;
    private long previewEpoch;
    private ContentViewRenderView renderView;
    private SurfaceHolder.Callback previewSurfaceObserver;
    private final Runnable previewCapture = this::captureActivePreview;
    private EditText address;
    private TextView back;
    private LinearLayout splash;
    private TextView splashStatus;
    private Shell loadingShell;
    private String clipboardRaw;
    private View progressBar;
    private LinearLayout urlSuggest;
    private long generation;
    private boolean closed;
    private boolean quiescing;
    private boolean resumed;
    private boolean chromeRefreshPosted;
    private PopupMenu overflowMenu;
    private boolean cleanupComplete;
    private boolean uiBuilt;
    private final java.util.HashMap<Shell, ShellHistoryObserver> historyObservers = new java.util.HashMap<>();
    private final java.util.HashMap<Shell, String> newTabUrls = new java.util.HashMap<>();
    private boolean ntpRenderDirty;
    private FrameLayout pageContainer;
    private BrowserHistoryStore historyStore;
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
        resolvePalette(this);
        Window windowFrame = getWindow();
        windowFrame.setStatusBarColor(CANVAS);
        windowFrame.setNavigationBarColor(CANVAS);
        int lightFlags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        windowFrame.getDecorView().setSystemUiVisibility(C_DARK
                ? windowFrame.getDecorView().getSystemUiVisibility() & ~lightFlags
                : windowFrame.getDecorView().getSystemUiVisibility() | lightFlags);
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        // Give clearFocus() a neutral target. Otherwise Android can immediately refocus the
        // only EditText when a Shell disappears, freezing the displayed URL on the closed tab.
        root.setFocusableInTouchMode(true);
        root.setOnFocusChangeListener((view, focused) -> {
            if (!focused) cancelNavigationFocus();
        });
        root.setBackgroundColor(CANVAS);
        browserFrame = new FrameLayout(this);
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
            installShellObserverHooks();
            renderView = manager.getContentViewRenderView();
            installPreviewSurfaceHooks();
            window.setAnimationPlaceholderView(renderView.getSurfaceView());
            buildChrome();
            pageContainer = new FrameLayout(this);
            pageContainer.addView(manager, new FrameLayout.LayoutParams(-1, -1));
            root.addView(pageContainer, new LinearLayout.LayoutParams(-1, 0, 1));
            attachHistorySurfaces(launch);
            attachTabSwitcher(launch);
            BrowserStartupController.getInstance().startBrowserProcessesAsync(
                    LibraryProcessType.PROCESS_BROWSER, true, false, false,
                    new BrowserStartupController.StartupCallback() {
                        @Override public void onSuccess(@Nullable StartupMetrics metrics) {
                            if (!current() || uiBuilt) return;
                            try {
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

    private int dp(float value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
    }

    /** Branded launch cover shown until the async startup callback finishes building the UI. */
    private void buildSplash() {
        splash = new LinearLayout(this);
        splash.setOrientation(LinearLayout.VERTICAL);
        splash.setGravity(Gravity.CENTER);
        splash.setBackgroundColor(CANVAS);
        // Cover the (not yet built) content so pre-startup taps cannot reach it.
        splash.setClickable(true);
        splash.setFocusable(true);
        LinearLayout mark = new LinearLayout(this);
        mark.setGravity(Gravity.CENTER);
        GradientDrawable markBackground = new GradientDrawable(GradientDrawable.Orientation.TL_BR,
                new int[]{ACCENT, 0xFF7C3AED});
        markBackground.setCornerRadius(dp(16));
        mark.setBackground(markBackground);
        mark.setElevation(dp(3));
        TextView initial = new TextView(this);
        initial.setText("A");
        initial.setTextColor(0xFFFFFFFF);
        initial.setTextSize(22);
        initial.setTypeface(android.graphics.Typeface.create("sans-serif-medium",
                android.graphics.Typeface.NORMAL));
        mark.addView(initial);
        LinearLayout markWrap = new LinearLayout(this);
        markWrap.setGravity(Gravity.CENTER);
        markWrap.addView(mark, new LinearLayout.LayoutParams(dp(46), dp(46)));
        splash.addView(markWrap, new LinearLayout.LayoutParams(-2, -2));
        TextView title = new TextView(this);
        title.setText("ABS Browser");
        title.setTextSize(19);
        title.setTextColor(INK);
        title.setTypeface(android.graphics.Typeface.create("sans-serif-medium",
                android.graphics.Typeface.NORMAL));
        LinearLayout.LayoutParams titleLp = new LinearLayout.LayoutParams(-2, -2);
        titleLp.topMargin = dp(16);
        splash.addView(title, titleLp);
        splashStatus = new TextView(this);
        splashStatus.setText("正在准备独立环境…");
        splashStatus.setTextSize(13);
        splashStatus.setTextColor(MUTED);
        LinearLayout.LayoutParams statusLp = new LinearLayout.LayoutParams(-2, -2);
        statusLp.topMargin = dp(8);
        splash.addView(splashStatus, statusLp);
        android.widget.ProgressBar spinner = new android.widget.ProgressBar(this);
        LinearLayout.LayoutParams spinnerLp = new LinearLayout.LayoutParams(dp(26), dp(26));
        spinnerLp.topMargin = dp(18);
        splash.addView(spinner, spinnerLp);
        browserFrame.addView(splash, new FrameLayout.LayoutParams(-1, -1));
    }

    private void hideSplash() {
        if (splash != null && splash.getVisibility() != View.GONE) splash.setVisibility(View.GONE);
    }

    private void initializeBrowserUi() {
        application.requireBrowserActivation();
        prepareInitialTab();
        uiBuilt = true;
        hideSplash();
        refreshChrome();
        requestActivePreview(manager.getActiveShell());
    }

    private GradientDrawable rounded(int color, float radiusDp) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(radiusDp));
        return drawable;
    }

    private TextView glyph(String text, float sizeSp, int color) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextSize(sizeSp);
        view.setTextColor(color);
        view.setGravity(Gravity.CENTER);
        view.setLayoutParams(new LinearLayout.LayoutParams(dp(48), dp(48)));
        return view;
    }

    private void buildChrome() {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.VERTICAL);
        bar.setBackgroundColor(SURFACE);
        bar.setElevation(dp(2));

        LinearLayout urlRow = new LinearLayout(this);
        urlRow.setOrientation(LinearLayout.HORIZONTAL);
        urlRow.setGravity(Gravity.CENTER_VERTICAL);
        urlRow.setPadding(dp(6), dp(5), dp(6), dp(5));
        back = glyph("\u2039", 26, INK);
        back.setContentDescription("后退");
        back.setBackground(new android.graphics.drawable.RippleDrawable(
                android.content.res.ColorStateList.valueOf(C_RIPPLE), null,
                rounded(SURFACE, 22)));
        back.setLayoutParams(new LinearLayout.LayoutParams(dp(48), dp(48)));
        tabCounter = glyph("1", 12, ACCENT);
        tabCounter.setTypeface(android.graphics.Typeface.create("sans-serif-medium",
                android.graphics.Typeface.NORMAL));
        tabCounter.setGravity(Gravity.CENTER);
        tabCounter.setBackground(rounded(ACCENT_SOFT, 10));
        tabCounter.setPadding(dp(9), 0, dp(9), 0);
        tabCounter.setMinWidth(0);
        tabCounter.setMinimumWidth(0);
        tabCounter.setOnClickListener(view -> {
            view.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP);
            showTabSwitcher();
        });
        address = new EditText(this);
        address.setSingleLine(true);
        address.setSelectAllOnFocus(true);
        address.setImeOptions(EditorInfo.IME_ACTION_GO);
        address.setTextSize(14.5f);
        address.setTextColor(INK);
        address.setHintTextColor(MUTED);
        address.setHint("搜索或输入网址");
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
        TextView menu = glyph("\u22ee", 22, MUTED);
        menu.setBackground(new android.graphics.drawable.RippleDrawable(
                android.content.res.ColorStateList.valueOf(C_RIPPLE), null,
                rounded(SURFACE, 22)));
        menu.setLayoutParams(new LinearLayout.LayoutParams(dp(48), dp(48)));
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
        LinearLayout.LayoutParams addressLp = new LinearLayout.LayoutParams(0, dp(46), 1);
        addressLp.leftMargin = dp(6);
        urlRow.addView(address, addressLp);
        LinearLayout.LayoutParams counterLp = new LinearLayout.LayoutParams(-2, dp(28));
        counterLp.leftMargin = dp(4);
        counterLp.rightMargin = dp(6);
        urlRow.addView(tabCounter, counterLp);
        urlRow.addView(menu);
        bar.addView(urlRow, new LinearLayout.LayoutParams(-1, dp(62)));

        View divider = new View(this);
        divider.setBackgroundColor(DIVIDER);
        bar.addView(divider, new LinearLayout.LayoutParams(-1, 1));
        // Thin determinate-free load bar under the URL row; driven by navigation observers.
        android.widget.ProgressBar loadBar = new android.widget.ProgressBar(this, null,
                android.R.attr.progressBarStyleHorizontal);
        loadBar.setIndeterminate(true);
        loadBar.getIndeterminateDrawable().setColorFilter(ACCENT, android.graphics.PorterDuff.Mode.SRC_IN);
        loadBar.setVisibility(View.GONE);
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
        PopupMenu popup = new PopupMenu(this, anchor);
        overflowMenu = popup;
        popup.setOnDismissListener(menu -> {
            if (overflowMenu == menu) overflowMenu = null;
        });
        popup.getMenu().add("新建标签页");
        popup.getMenu().add("标签页总览");
        popup.getMenu().add("历史记录");
        popup.getMenu().add("前进");
        popup.getMenu().add("刷新");
        popup.getMenu().add("关闭当前标签页");
        popup.getMenu().add("返回环境列表");
        popup.setOnMenuItemClickListener(item -> {
            if (!interactive()) return true;
            String title = String.valueOf(item.getTitle());
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
                WebContents contents = contents();
                if (contents != null) contents.getNavigationController().reload(true);
            } else if ("关闭当前标签页".equals(title)) {
                Shell active = manager.getActiveShell();
                if (active != null) closeTab(active);
            } else if ("返回环境列表".equals(title)) {
                returnToList();
                return true;
            }
            refreshChrome();
            return true;
        });
        popup.show();
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
        row.setBackground(new android.graphics.drawable.RippleDrawable(
                android.content.res.ColorStateList.valueOf(C_RIPPLE),
                new android.graphics.drawable.ColorDrawable(SURFACE), null));
        int padH = dp(14);
        row.setPadding(padH, dp(10), padH, dp(10));
        TextView titleView = new TextView(this);
        titleView.setText(title);
        titleView.setTextSize(14.5f);
        titleView.setTextColor(INK);
        titleView.setSingleLine(true);
        titleView.setEllipsize(android.text.TextUtils.TruncateAt.END);
        row.addView(titleView);
        TextView originView = new TextView(this);
        originView.setText(origin);
        originView.setTextSize(12);
        originView.setTextColor(MUTED);
        originView.setSingleLine(true);
        originView.setEllipsize(android.text.TextUtils.TruncateAt.END);
        row.addView(originView);
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
        if (progressBar != null) {
            Shell barOwner = loadingShell;
            boolean show = barOwner != null && !barOwner.isDestroyed() && barOwner == active;
            progressBar.setVisibility(show ? View.VISIBLE : View.GONE);
        }
        refreshTabSwitcher(false);
        syncWebContentsVisibility();
    }

    /** Only the selected, actually foreground web page may be visible to Chromium. */
    private void syncWebContentsVisibility() {
        if (manager == null) return;
        Shell active = manager.getActiveShell();
        boolean pageForeground = resumed && current()
                && (tabSwitcher == null || !tabSwitcher.isShowing())
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

    private void tint(TextView view, boolean enabled) {
        float alpha = enabled ? 1f : 0.3f;
        if (view.getAlpha() != alpha) view.setAlpha(alpha);
    }

    private void attachTabSwitcher(LaunchSpec launch) {
        tabSwitcher = new TabSwitcherView(this, launch.profile.name, new TabSwitcherView.Listener() {
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
                requestActivePreview(manager.getActiveShell());
            }
        });
        browserFrame.addView(tabSwitcher, new FrameLayout.LayoutParams(-1, -1));
    }

    private boolean validTab(Shell shell) {
        return current() && manager != null && shell != null && !shell.isDestroyed()
                && manager.getShells().contains(shell);
    }

    private void showTabSwitcher() {
        if (!interactive() || tabSwitcher == null) return;
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
            }
        };
        renderView.getSurfaceView().getHolder().addCallback(previewSurfaceObserver);
    }

    private void requestActivePreview(Shell shell) {
        if (!resumed || !validTab(shell) || manager.getActiveShell() != shell) return;
        previewRequested = true;
        previewRetries = 0;
        schedulePreviewCapture();
    }

    private void schedulePreviewCapture() {
        if (!previewRequested || previewInFlight || !resumed || !current()) return;
        browserFrame.removeCallbacks(previewCapture);
        // Let the real view/surface lifecycle draw; this does not alter the renderer's cadence.
        browserFrame.postOnAnimation(previewCapture);
    }

    /** Memory-only real pixels; never fake a page preview, capture an API, or write it to disk. */
    private void captureActivePreview() {
        Shell shell = manager == null ? null : manager.getActiveShell();
        if (!previewRequested || !resumed || !validTab(shell) || previewInFlight) return;
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
                    if (samePage && result == PixelCopy.ERROR_SOURCE_NO_DATA
                            && previewRetries < MAX_PREVIEW_RETRIES) {
                        previewRetries++;
                        previewRequested = true;
                    }
                    Log.d(TAG, "Preview copy rejected");
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

    /** Owns the per-profile store and the two overlays; key is the immutable launch profile id. */
    private void attachHistorySurfaces(LaunchSpec launch) {
        historyStore = new BrowserHistoryStore(this, launch.profile.id);
        newTab = new NewTabPage(this, historyStore, launch.profile.name, new NewTabPage.Listener() {
            @Override public void onNtpNavigate(String url) { loadResolvedUrl(url, false); }
            @Override public void onNtpOpenHistory() { showHistoryPanel(); }
        });
        pageContainer.addView(newTab, new FrameLayout.LayoutParams(-1, -1));
        newTab.addOnLayoutChangeListener((view, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom) -> {
            if (right - left > 0 && bottom - top > 0
                    && (right - left != oldRight - oldLeft || bottom - top != oldBottom - oldTop)) {
                requestActivePreview(manager == null ? null : manager.getActiveShell());
            }
        });
        historyPanel = new HistoryPanel(this, historyStore, new HistoryPanel.Listener() {
            @Override public void onOpenHistoryUrl(String url, boolean newTabRequested) {
                loadResolvedUrl(url, newTabRequested);
            }
            @Override public void onHistoryChanged() {
                if (!quiescing && !closed && newTab != null) newTab.refresh();
            }
            @Override public void onHistoryDismissed() {
                if (quiescing || closed) return;
                syncWebContentsVisibility();
                if (interactive()) requestActivePreview(manager.getActiveShell());
            }
        });
        pageContainer.addView(historyPanel, new FrameLayout.LayoutParams(-1, -1));
    }

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
        // Deliberately no address-editor dismissal: an in-flight navigation-focus handoff must
        // survive the panel (pinned by the focus host). Menu/URL paths dismiss instead.
        cancelNavigationFocus();
        historyPanel.show();
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
                entry.getValue().observe(null);
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
        if (!current() || historyStore == null || shell.isDestroyed()) return;
        WebContents contents = shell.getWebContents();
        if (contents == null) return;
        ShellHistoryObserver prior = historyObservers.get(shell);
        if (prior == null || prior.getWebContents() != contents) {
            if (prior != null) prior.observe(null);
            historyObservers.put(shell, new ShellHistoryObserver(shell, contents));
            requestChromeRefresh();
            requestActivePreview(shell);
        }
    }

    private final class ShellHistoryObserver extends WebContentsObserver {
        private final Shell shell;
        private final WebContents contents;
        private String committedUrl;
        private boolean awaitingPaint;

        ShellHistoryObserver(Shell shell, WebContents contents) {
            super(contents);
            this.shell = shell;
            this.contents = contents;
        }

        @Override public void didStartNavigationInPrimaryMainFrame(NavigationHandle navigation) {
            if (!current() || !navigation.isInPrimaryMainFrame()) return;
            tabPreviews.remove(shell);
            previewUrls.remove(shell);
            if (!navigation.isSameDocument()) awaitingPaint = true;
            if (manager.getActiveShell() == shell) {
                previewEpoch++;
                previewRequested = false;
                browserFrame.removeCallbacks(previewCapture);
                if (!navigation.isSameDocument()) loadingShell = shell;
            }
            requestChromeRefresh();
        }

        @Override public void didFirstVisuallyNonEmptyPaint() {
            if (!current()) return;
            awaitingPaint = false;
            if (loadingShell == shell) loadingShell = null;
            requestActivePreview(shell);
            requestChromeRefresh();
        }

        @Override public void didStopLoading(GURL url, boolean isKnownValid) {
            if (!current()) return;
            awaitingPaint = false;
            if (loadingShell == shell) loadingShell = null;
            requestActivePreview(shell);
            requestChromeRefresh();
        }

        @Override public void navigationEntriesChanged() { requestChromeRefresh(); }
        @Override public void onVisibilityChanged(int visibility) { requestChromeRefresh(); }
        @Override public void webContentsDestroyed() {
            if (loadingShell == shell) loadingShell = null;
            requestChromeRefresh();
        }

        @Override public void didFinishNavigationInPrimaryMainFrame(NavigationHandle navigation) {
            if (!current() || !navigation.isInPrimaryMainFrame() || !navigation.hasCommitted()) return;
            requestChromeRefresh();
            if (navigation.isSameDocument()) requestActivePreview(shell);
            String url = navigation.getUrl().getSpec();
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
            if (current() && committedUrl != null) {
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
        hideUrlSuggestions();
        if (progressBar != null) progressBar.setVisibility(View.GONE);
        if (browserFrame != null) browserFrame.removeCallbacks(previewCapture);
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
            try { historyStore.flush(); } catch (RuntimeException ignored) { }
        }
        for (ShellHistoryObserver observer : historyObservers.values()) observer.observe(null);
        historyObservers.clear();
        newTabUrls.clear();
        tabPreviews.clear();
        previewUrls.clear();
        dismissTabSwitcher();
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

    @Override
    public void onConfigurationChanged(android.content.res.Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // configChanges handles uiMode, so nothing recreates: re-resolve the palette and the
        // system bars at least. Already-built views keep their colors until they are rebuilt.
        resolvePalette(this);
        Window windowFrame = getWindow();
        windowFrame.setStatusBarColor(CANVAS);
        windowFrame.setNavigationBarColor(CANVAS);
        int lightFlags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        windowFrame.getDecorView().setSystemUiVisibility(C_DARK
                ? windowFrame.getDecorView().getSystemUiVisibility() & ~lightFlags
                : windowFrame.getDecorView().getSystemUiVisibility() | lightFlags);
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
        if (urlSuggest != null && urlSuggest.getVisibility() == View.VISIBLE) {
            hideUrlSuggestions();
            address.clearFocus();
            root.requestFocus();
            return;
        }
        if (tabSwitcher != null && tabSwitcher.isShowing()) {
            dismissTabSwitcher();
            syncWebContentsVisibility();
            requestActivePreview(manager.getActiveShell());
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
        if (closed || quiescing) return;
        resumed = true;
        lastBackExitHint = 0;
        requestChromeRefresh();
        requestActivePreview(manager == null ? null : manager.getActiveShell());
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
        try { closeNativeView(); }
        finally {
            if (runtime != null) runtime.detach(this);
            super.onDestroy();
        }
    }
}
