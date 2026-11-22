import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.LambdaExpressionTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.NewClassTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.VariableTree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.TreeScanner;
import java.lang.reflect.InvocationTargetException;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import javax.tools.JavaCompiler;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;

/**
 * Executes source-extracted Activity recovery, preview, fullscreen and web-app control flow.
 * Android UI, Chromium callbacks, PixelCopy and persistence/shortcut ports are deterministic fakes.
 * This proves callback/state behavior, not Android compilation, real renderer recovery, actual
 * pixel content, device lifecycle timing, layout/accessibility, or visual acceptance.
 */
public final class NativeBrowserRecoveryHostTest {
    private static final List<String> FIELD_NAMES = List.of(
            "MAX_PREVIEW_RETRIES", "restoreSplashShown", "restoreInterrupted", "restoreEpoch", "restoreShell",
            "restoreContents", "restoreUrl", "restoreGeneration", "restoreTimeout", "chromeShell",
            "chromeContents", "previewInFlight", "previewRequested", "previewCapturePosted", "previewRetries", "previewEpoch",
            "previewCapture", "tabPreviews", "previewUrls", "newTabUrls", "historyObservers", "lastBackExitHint",
            "fullscreenOwner", "fullscreenSignal", "browserFullscreenRequest", "browserFullscreen",
            "fullscreenExits", "fullscreenRefreshPosted", "fullscreenPriorUiFlags", "fullscreenPriorBarsBehavior",
            "fullscreenUsesInsetsController", "webAppInstall", "fullscreenRefresh", "chromeRefresh",
            "webAppOffer", "WEB_APP_CHECK_TIMEOUT_MS", "webAppShells", "browserBack");
    private static final List<String> METHOD_NAMES = List.of(
            "showPageRestoring", "beginPageRestoring", "pageInterruption", "reloadPage",
            "ownsPageRestoring", "hidePageRestoring", "retryPageRestoring",
            "reconcilePageRestoring", "completePageRestoring", "requestActivePreview",
            "schedulePreviewCapture", "captureActivePreview", "current", "interactive", "validTab",
            "visibleUrl", "isBlankPage", "tabTitle", "isPageReady", "hideSplash", "cancelUiWork", "setLoadFeedbackVisible",
            "onPause", "onStop", "onResume", "syncWebContentsVisibility", "installShellObserverHooks",
            "installPreviewSurfaceHooks", "observeShell", "trackHistory", "contents",
            "performMenuAction", "showTabSwitcher", "dismissTabSwitcher", "dismissFromSwitcherListener",
            "onBackPressed", "ShellHistoryObserver", "selectedFullscreenObserver", "ownsUncoveredPage",
            "canPresentFullscreen", "requestBrowserFullscreen", "wakePendingFullscreen", "requestFullscreenRefresh",
            "requestFullscreenExit", "revokeCoveredFullscreen", "reconcilePageFullscreen",
            "exitRequestedFullscreen", "exitNativeFullscreen", "exitSelectedFullscreen", "clearPageFullscreen",
            "setFullscreenOwner", "updateBrowserChromeVisibility", "applyPageFullscreenWindow", "withoutPageSystemBars",
            "onWindowFocusChanged", "quiesceForShutdown", "closeNativeView", "onDestroy", "createBrowserFrame",
            "applyPageFullscreenInsets", "requestChromeRefresh", "clickOverflowAction", "dismissOverflowFromListener", "showHistoryPanel",
            "WebAppPage", "WebAppOffer", "WebAppInstall", "setWebAppOfferVisible", "canShowWebAppOffer",
            "useWebAppOffer", "refreshWebAppOffer", "receiveWebAppOffer", "ownsWebAppPage",
            "requestWebAppInstall", "beginWebAppInstall", "ownsWebAppInstallPage", "ownsWebAppInstall",
            "cancelWebAppInstall", "armWebAppInstallTimeout", "expireWebAppInstall", "onWebAppInstallWindowFocusChanged",
            "receiveWebAppInstallManifest", "eligibleManifest", "showWebAppConsent", "completeWebAppInstall",
            "WebAppShell", "webAppShell", "showSelectedWebAppInBrowser", "closeWebApp", "backFromWebApp",
            "urlOrigin", "webAppOriginInstalled",
            "setTextIfChanged", "registerBrowserBack", "unregisterBrowserBack");

    private NativeBrowserRecoveryHostTest() { }

    public static void main(String[] args) throws Exception {
        if (args.length != 2) throw new IllegalArgumentException("Usage: NativeBrowserRecoveryHostTest ROOT OUTPUT");
        Path root = Path.of(args[0]).toAbsolutePath();
        Path output = Path.of(args[1]).toAbsolutePath().resolve("recovery-host");
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        if (javac == null) throw new AssertionError("A full JDK17 is required");
        Path activity = root.resolve("mobile/android/native-kernel/src/main/java/com/ahoo/abs/android/nativekernel/NativeBrowserActivity.java");
        HostCompiler compiler = new HostCompiler(javac,
                root.resolve("mobile/android/app/src/main/java/com/ahoo/abs/android/webapp/WebApp.java"));
        Map<String, String> methods = new HashMap<>();
        Map<String, String> fields = new HashMap<>();
        try (StandardJavaFileManager files = javac.getStandardFileManager(null, null, StandardCharsets.UTF_8)) {
            JavacTask task = (JavacTask) javac.getTask(null, files, null,
                    List.of("-proc:none", "--release", "17"), null, files.getJavaFileObjects(activity));
            for (CompilationUnitTree unit : task.parse()) {
                for (Tree top : unit.getTypeDecls()) {
                    if (!(top instanceof ClassTree type)) continue;
                    for (Tree member : type.getMembers()) {
                        if (member instanceof MethodTree method) {
                            String name = method.getName().toString();
                            if (methods.put(name, method.toString()) != null && METHOD_NAMES.contains(name)) {
                                throw new AssertionError("Ambiguous production method: " + name);
                            }
                            if (name.equals("showMenu")) extractOverflowAction(method, methods);
                        }
                        if (member instanceof VariableTree field) {
                            fields.put(field.getName().toString(), field + ";\n");
                            if (field.getName().contentEquals("tabSwitcherListener")
                                    && field.getInitializer() instanceof NewClassTree listener) {
                                for (Tree callback : listener.getClassBody().getMembers()) {
                                    if (callback instanceof MethodTree method
                                            && method.getName().contentEquals("onDismiss")) {
                                        // Execute the production callback body, not a handwritten equivalent.
                                        methods.put("dismissFromSwitcherListener",
                                                "private void dismissFromSwitcherListener() " + method.getBody());
                                    }
                                }
                            }
                        }
                        if (member instanceof ClassTree nested && METHOD_NAMES.contains(nested.getSimpleName().toString())) {
                            methods.put(nested.getSimpleName().toString(), nested.toString());
                        }
                    }
                }
            }
        }
        int checks = execute(compiler, output.resolve("positive"), members(fields, methods));
        int rejected = 0;
        rejected += rejects(compiler, output, fields, methods, "load-feedback-removes-slot",
                "setLoadFeedbackVisible", "View.INVISIBLE", "View.GONE",
                "unchanged load feedback retains its invisible slot without writes");
        rejected += rejects(compiler, output, fields, methods, "load-feedback-rewrites-unchanged",
                "setLoadFeedbackVisible", "progressBar.getVisibility() != visibility", "true",
                "unchanged load feedback retains its invisible slot without writes");
        rejected += rejects(compiler, output, fields, methods, "cancel-leaves-load-animation-visible",
                "cancelUiWork", "setLoadFeedbackVisible(false);", "",
                "UI cancellation stops loading feedback without removing its slot");
        rejected += rejects(compiler, output, fields, methods, "old-inverted-retry-gate",
                "retryPageRestoring", "restoreRetry.getVisibility() != View.VISIBLE",
                "restoreRetry.getVisibility() == View.VISIBLE", "retry reloads exactly once");
        rejected += rejects(compiler, output, fields, methods, "missing-restore-shell-identity",
                "ownsPageRestoring", "restoreShell == shell &&", "", "restore Shell identity rejects aliased contents");
        rejected += rejects(compiler, output, fields, methods, "missing-timeout-epoch",
                "beginPageRestoring", "restoreEpoch != epoch ||", "", "old deadline cannot expire renewed retry");
        rejected += rejects(compiler, output, fields, methods, "missing-preview-reschedule",
                "captureActivePreview", "schedulePreviewCapture();", "", "successful old copy schedules exactly one dirty follow-up");
        rejected += rejects(compiler, output, fields, methods, "missing-preview-posted-gate",
                "schedulePreviewCapture", "|| previewCapturePosted", "", "same-frame burst posts once without remove/repost churn");
        rejected += rejects(compiler, output, fields, methods, "missing-preview-posted-mark",
                "schedulePreviewCapture", "previewCapturePosted = true;", "", "same-frame burst posts once without remove/repost churn");
        rejected += rejects(compiler, output, fields, methods, "missing-preview-entry-clear",
                "captureActivePreview", "previewCapturePosted = false;", "", "frame entry retires the posted gate");
        rejected += rejects(compiler, output, fields, methods, "duplicate-dirty-request-resets-budget",
                "requestActivePreview", "!previewRequested", "true", "merged dirty requests preserve retry budget");
        rejected += rejects(compiler, output, fields, methods, "swallowed-inflight-dirty-demand",
                "requestActivePreview", "previewRequested = true;", "if (!previewInFlight) previewRequested = true;",
                "content demand while copy in flight remains dirty");
        rejected += rejects(compiler, output, fields, methods, "surface-cancel-keeps-posted-gate",
                "installPreviewSurfaceHooks", "previewCapturePosted = false;", "", "cancelled preview clears posted gate 0");
        rejected += rejects(compiler, output, fields, methods, "ui-cancel-keeps-posted-gate",
                "cancelUiWork", "previewCapturePosted = false;", "", "cancelled preview clears posted gate 3");
        rejected += rejects(compiler, output, fields, methods, "duplicate-activity-show",
                "showTabSwitcher", "|| tabSwitcher.isShowing()", "", "duplicate Activity show cannot repeat opening side effects");
        rejected += rejects(compiler, output, fields, methods, "listener-dismiss-captures-again",
                "dismissFromSwitcherListener", "syncWebContentsVisibility();",
                "syncWebContentsVisibility(); requestActivePreview(manager.getActiveShell());",
                "listener dismiss does not schedule another capture");
        rejected += rejects(compiler, output, fields, methods, "back-dismiss-captures-again",
                "onBackPressed", "if (tabSwitcher != null && tabSwitcher.isShowing()) {",
                "if (tabSwitcher != null && tabSwitcher.isShowing()) { requestActivePreview(manager.getActiveShell());",
                "back dismiss does not schedule another capture");
        rejected += rejects(compiler, output, fields, methods, "saved-ready-suppresses-death",
                "beginPageRestoring", "!reloading && interrupted == null && isPageReady(shell)",
                "!reloading && isPageReady(shell)",
                "real renderer loss immediately covers same ready Shell and WebContents");
        rejected += rejects(compiler, output, fields, methods, "missing-renderer-interruption",
                "ShellHistoryObserver", "interruptedUrl = deadDocumentUrl.isEmpty() ? visibleUrl(shell) : deadDocumentUrl;", "interruptedUrl = null;",
                "real renderer loss immediately covers same ready Shell and WebContents");
        rejected += rejects(compiler, output, fields, methods, "missing-fresh-retry-commit",
                "ShellHistoryObserver", "!retryCommitted ||", "",
                "old paint/load-stop and saved-ready frame cannot retire interruption");
        rejected += rejects(compiler, output, fields, methods, "missing-renderer-generation",
                "ShellHistoryObserver", "ownerGeneration == generation &&", "",
                "generation mismatch prunes marker before replacing observer");
        rejected += rejects(compiler, output, fields, methods, "pending-native-url-exempts-dead-web-document",
                "ShellHistoryObserver", "deadDocumentUrl.equals(newTabUrls.get(shell))", "true",
                "actual loss during pending owned-native URL retains committed web interruption");
        rejected += rejects(compiler, output, fields, methods, "fresh-router-url-not-followed",
                "ShellHistoryObserver", "interruptedUrl = url;", "interruptedUrl = \"https://mutation.invalid/stale-router\";",
                "fresh committed replacement proof follows its successful same-document router URL");
        rejected += rejects(compiler, output, fields, methods, "native-fullscreen-revoked-for-focus-loss",
                "canPresentFullscreen", "ownsUncoveredPage(observer) &&", "hasWindowFocus() && ownsUncoveredPage(observer) &&",
                "temporary focus loss never revokes granted native fullscreen");
        rejected += rejects(compiler, output, fields, methods, "browser-fullscreen-without-popup-page-epoch",
                "clickOverflowAction", " && popupOwner.webAppPageEpoch == popupPageEpoch", "",
                "stale popup cannot bind even a same-URL replacement");
        rejected += rejects(compiler, output, fields, methods, "pwa-offer-keeps-hidden-probe",
                "ShellHistoryObserver", "if (!webAppOffer.completed) webAppOffer = null;", "",
                "hide drops only the pending passive lookup");
        rejected += rejects(compiler, output, fields, methods, "pwa-confirm-keeps-reply-across-blur",
                "receiveWebAppInstallManifest", " || focusEpoch != install.focusEpoch", "",
                "even a completed consent blur/refocus interval retires the old reply");
        rejected += rejects(compiler, output, fields, methods, "pwa-install-without-activity-focus",
                "beginWebAppInstall", "if (!hasWindowFocus()) return;", "",
                "install waits for Activity focus without polling");
        rejected += rejects(compiler, output, fields, methods, "pwa-confirm-without-dialog-focus",
                "ownsWebAppInstall", " && consent.getDecorView().hasWindowFocus()", "",
                "unfocused consent cannot request confirmation");
        rejected += rejects(compiler, output, fields, methods, "pwa-confirm-edited-name",
                "completeWebAppInstall", " || !shown.name.equals(confirmed.name)", "",
                "changed manifest cannot register or request a pin after consent");
        rejected += rejects(compiler, output, fields, methods, "pwa-back-traverses-standalone-history",
                "onBackPressed", "if (backFromWebApp(active)) return;", "",
                "standalone framework Back closes the app and restores its exact previous tab without traversing app history");
        System.out.println(checks + " source-extracted recovery/preview/fullscreen/PWA fake-host checks, "
                + rejected + " behavioral mutation controls rejected, 0 failures");
        System.out.println("Host-only evidence: no Android build, device, real pixels, timing, or visual acceptance asserted.");
    }

    private static void extractOverflowAction(MethodTree method, Map<String, String> methods) {
        new TreeScanner<Void, Void>() {
            @Override public Void visitMethodInvocation(MethodInvocationTree call, Void unused) {
                if (call.getMethodSelect().toString().equals("action.setOnClickListener")
                        && call.getArguments().size() == 1
                        && call.getArguments().get(0) instanceof LambdaExpressionTree listener) {
                    // Run the actual popup click body without simulating its layout and styling.
                    methods.put("clickOverflowAction", "private void clickOverflowAction(PopupWindow popup, "
                            + "ShellHistoryObserver popupOwner, long popupPageEpoch, String title, View "
                            + listener.getParameters().get(0).getName() + ") " + listener.getBody());
                }
                if (call.getMethodSelect().toString().equals("popup.setOnDismissListener")
                        && call.getArguments().size() == 1
                        && call.getArguments().get(0) instanceof LambdaExpressionTree listener) {
                    methods.put("dismissOverflowFromListener", "private void dismissOverflowFromListener("
                            + "PopupWindow popup, View anchor, View.OnLayoutChangeListener anchorLayout) "
                            + listener.getBody());
                }
                return super.visitMethodInvocation(call, unused);
            }
        }.scan(method.getBody(), null);
    }

    private record HostCompiler(JavaCompiler javac, Path webApp) { }

    private static String required(Map<String, String> values, String name) {
        String value = values.get(name);
        if (value == null) throw new AssertionError("Missing production member: " + name);
        return value;
    }

    private static String members(Map<String, String> fields, Map<String, String> methods) {
        StringBuilder actual = new StringBuilder();
        for (String name : FIELD_NAMES) actual.append(required(fields, name)).append('\n');
        for (String name : METHOD_NAMES) actual.append(required(methods, name)).append('\n');
        return actual.toString();
    }

    private static int rejects(HostCompiler compiler, Path output, Map<String, String> fields,
            Map<String, String> methods, String label, String method, String before, String after,
            String expectedFailure) throws Exception {
        Map<String, String> changed = new HashMap<>(methods);
        String source = required(methods, method);
        int first = source.indexOf(before);
        if (first < 0 || source.indexOf(before, first + before.length()) >= 0) {
            throw new AssertionError("Mutation must replace one unambiguous expression: " + label);
        }
        changed.put(method, source.substring(0, first) + after + source.substring(first + before.length()));
        // Compilation errors are not evidence that a behavioral negative control was killed.
        try {
            execute(compiler, output.resolve(label), members(fields, changed));
        } catch (InvocationTargetException failure) {
            Throwable cause = failure.getCause();
            if (cause instanceof AssertionError && cause.getMessage() != null
                    && cause.getMessage().contains(expectedFailure)) {
                System.out.println("Rejected behavioral mutation " + label + ": " + cause.getMessage());
                return 1;
            }
            throw new AssertionError("Mutation failed for the wrong reason: " + label, cause);
        }
        throw new AssertionError("Behavioral mutation survived: " + label);
    }

    private static int execute(HostCompiler compiler, Path output, String actual) throws Exception {
        Files.createDirectories(output);
        Path host = output.resolve("RecoveryHost.java");
        Files.writeString(host, HOST.replace("@ACTUAL@", actual), StandardCharsets.UTF_8);
        Path ids = output.resolve("org/chromium/content_shell/R.java");
        Files.createDirectories(ids.getParent());
        Files.writeString(ids, "package org.chromium.content_shell; public final class R { public static final class id { public static final int contentview_holder = 1; } }", StandardCharsets.UTF_8);
        try (StandardJavaFileManager files = compiler.javac().getStandardFileManager(null, null, StandardCharsets.UTF_8)) {
            boolean compiled = compiler.javac().getTask(null, files, null,
                    List.of("--release", "17", "-Xlint:all", "-Werror", "-d", output.toString()),
                    null, files.getJavaFileObjects(host, ids, compiler.webApp())).call();
            if (!compiled) throw new AssertionError("Source-extracted recovery host did not compile: " + output);
        }
        try (URLClassLoader loader = new URLClassLoader(new URL[] {output.toUri().toURL()}, NativeBrowserRecoveryHostTest.class.getClassLoader())) {
            return (Integer) loader.loadClass("com.ahoo.abs.android.webapp.RecoveryHost").getMethod("run").invoke(null);
        }
    }

    private static final String HOST = String.join("", """
            package com.ahoo.abs.android.webapp;
            import java.util.*;
            public final class RecoveryHost {
                static int checks;
                static void check(boolean pass, String message) {
                    checks++;
                    if (!pass) throw new AssertionError(message);
                }
                static final class Handler {
                    private record Delayed(Runnable task, long deadline) { }
                    final ArrayDeque<Runnable> queue = new ArrayDeque<>();
                    final List<Delayed> delayed = new ArrayList<>();
                    void post(Runnable task) { queue.add(task); }
                    void postDelayed(Runnable task, long delay) {
                        delayed.add(new Delayed(task, android.os.SystemClock.elapsedRealtime() + delay));
                    }
                    void removeCallbacks(Runnable task) {
                        queue.removeIf(item -> item == task);
                        delayed.removeIf(item -> item.task() == task);
                    }
                    void advance(long millis) {
                        android.os.SystemClock.now += millis;
                        List<Delayed> due = delayed.stream()
                                .filter(item -> item.deadline() <= android.os.SystemClock.elapsedRealtime())
                                .sorted(java.util.Comparator.comparingLong(Delayed::deadline)).toList();
                        delayed.removeAll(due);
                        for (Delayed item : due) queue.add(item.task());
                        all();
                    }
                    void all() {
                        int delivered = 0;
                        while (!queue.isEmpty()) {
                            if (++delivered > 100) throw new AssertionError("unbounded handler loop");
                            queue.remove().run();
                        }
                    }
                }
                static final class ViewTreeObserver {
                    interface OnWindowFocusChangeListener { void onWindowFocusChanged(boolean focus); }
                    final List<OnWindowFocusChangeListener> focusListeners = new ArrayList<>();
                    boolean isAlive() { return true; }
                    void addOnWindowFocusChangeListener(OnWindowFocusChangeListener value) { focusListeners.add(value); }
                    void removeOnWindowFocusChangeListener(OnWindowFocusChangeListener value) { focusListeners.remove(value); }
                }
                static class View {
                    interface OnLayoutChangeListener { }
                    void removeOnLayoutChangeListener(OnLayoutChangeListener ignored) { }
                    static final int VISIBLE = 0, INVISIBLE = 4, GONE = 8;
                    static final int SYSTEM_UI_FLAG_LAYOUT_STABLE = 0x100, SYSTEM_UI_FLAG_LIGHT_STATUS_BAR = 0x2000,
                            SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR = 0x10, SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN = 0x400,
                            SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION = 0x200, SYSTEM_UI_FLAG_FULLSCREEN = 4,
                            SYSTEM_UI_FLAG_HIDE_NAVIGATION = 2, SYSTEM_UI_FLAG_IMMERSIVE_STICKY = 0x1000;
                    static final int TEXT_DIRECTION_LTR = 3;
                    boolean windowFocus = true;
                    final ViewTreeObserver tree = new ViewTreeObserver();
                    ViewTreeObserver getViewTreeObserver() { return tree; }
                    boolean hasWindowFocus() { return windowFocus; }
                    void dispatchWindowFocus(boolean focus) {
                        if (windowFocus == focus) return;
                        windowFocus = focus;
                        for (var listener : List.copyOf(tree.focusListeners)) listener.onWindowFocusChanged(focus);
                    }
                    void performHapticFeedback(int kind) { }
                    void bringToFront() { }
                    int flags;
                    int getSystemUiVisibility() { return flags; }
                    void setSystemUiVisibility(int value) { flags = value; }
                    static final int IMPORTANT_FOR_ACCESSIBILITY_AUTO = 0,
                            IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS = 4;
                    int visibility = VISIBLE, width = 1080, height = 1920, draws, visibilityWrites;
                    boolean attached = true, shown = true, focused;
                    void clearFocus() { focused = false; }
                    boolean hasFocus() { return focused; }
                    void requestFocus() { focused = true; }
                    Object getWindowToken() { return this; }
                    void setImportantForAccessibility(int value) { }
                    int getVisibility() { return visibility; }
                    void setVisibility(int value) { visibilityWrites++; visibility = value; }
                    boolean isAttachedToWindow() { return attached; }
                    boolean isShown() { return shown && visibility == VISIBLE; }
                    int getWidth() { return width; }
                    int getHeight() { return height; }
                    void draw(Canvas canvas) { draws++; canvas.bitmap.drawnFrom = this; }
                    View findViewById(int id) { return null; }
                }
                static class ViewGroup extends View {
                    interface OnHierarchyChangeListener {
                        void onChildViewAdded(View parent, View child);
                        void onChildViewRemoved(View parent, View child);
                    }
                    static final int FOCUS_BLOCK_DESCENDANTS = 0x60000;
                    void setDescendantFocusability(int value) { }
                    OnHierarchyChangeListener hierarchy;
                    void setOnHierarchyChangeListener(OnHierarchyChangeListener value) { hierarchy = value; }
                }
                static class FrameLayout extends ViewGroup {
                    FrameLayout(Activity activity) { }
                    Insets padding = Insets.NONE;
                    void setPadding(int l, int t, int r, int b) { padding = Insets.of(l, t, r, b); }
                    public WindowInsets onApplyWindowInsets(WindowInsets insets) {
                        padding = insets.getSystemWindowInsets();
                        return insets;
                    }
                    static final class Task {
                        final Runnable runnable;
                        final long due;
                        Task(Runnable runnable, long due) { this.runnable = runnable; this.due = due; }
                    }
                    final List<Task> tasks = new ArrayList<>();
                    long now;
                    int animationPosts, callbackRemovals, insetsRequests;
                    void requestApplyInsets() { insetsRequests++; }
                    void postOnAnimation(Runnable task) { animationPosts++; tasks.add(new Task(task, now + 16)); }
                    void postOnAnimationDelayed(Runnable task, long delay) { tasks.add(new Task(task, now + delay)); }
                    void removeCallbacks(Runnable task) { callbackRemovals++; tasks.removeIf(item -> item.runnable == task); }
                    int count(Runnable task) {
                        int count = 0;
                        for (Task item : tasks) if (item.runnable == task) count++;
                        return count;
                    }
                    long deadline(Runnable task) {
                        for (Task item : tasks) if (item.runnable == task) return item.due;
                        return -1;
                    }
                    boolean has(Runnable task) { return deadline(task) >= 0; }
                    void advance(long millis) {
                        now += millis;
                        android.os.SystemClock.now = now;
                        List<Task> due = new ArrayList<>();
                        for (Task item : tasks) if (item.due <= now) due.add(item);
                        tasks.removeAll(due);
                        for (Task item : due) item.runnable.run();
                    }
                    void frame() { advance(16); }
                }
                static final class TextView extends View {
                    String text = "";
                    int direction;
                    boolean selectable;
                    String getText() { return text; }
                    void setText(String value) { text = value; }
                    void setTextDirection(int value) { direction = value; }
                    void setTextIsSelectable(boolean value) { selectable = value; }
                }
                static final class NewTabPage extends View {
                    void dismissDialogs() { }
                    void quiesce() { }
                }
                static final class HistoryPanel extends View {
                    void show() { visibility = VISIBLE; }
                    void dismiss() { visibility = GONE; }
                    void quiesce() { dismiss(); }
                }
                static final class TabSwitcherView {
                    static final class TabItem { }
                    boolean showing;
                    int shows;
                    boolean isShowing() { return showing; }
                    void show(List<TabItem> items) { showing = true; shows++; }
                    void dismiss() { showing = false; }
                    void bringToFront() { }
                    void release() { }
                    void retainInsetsAnchor() { }
                }
                static final class PopupWindow {
                    int dismisses;
                    Runnable onDismiss = () -> { };
                    void dismiss() { dismisses++; onDismiss.run(); }
                }
                static final class Store {
                    int flushes, visits, titles;
                    void flush() { flushes++; }
                    void removeLoadListener(Runnable callback) { }
                    void recordVisit(String url, String title) { visits++; }
                    void updateTitle(String url, String title) { titles++; }
                }
                static final class BrowserHistory {
                    static boolean isTrackable(String url) { return url.startsWith("https://") || url.startsWith("http://"); }
                }
                // Monotonic Android clock and Chromium are host API fakes; the observer below is extracted.
                static final class android {
                    static final class view {
                        static final class HapticFeedbackConstants { static final int KEYBOARD_TAP = 3; }
                        static final class inputmethod {
                            static final class InputMethodManager {
                                void hideSoftInputFromWindow(Object token, int flags) { }
                            }
                        }
                    }
                    static final class window {
                        interface OnBackInvokedCallback { void onBackInvoked(); }
                        static final class OnBackInvokedDispatcher {
                            static final int PRIORITY_DEFAULT = 0;
                            OnBackInvokedCallback callback;
                            int priority;
                            void registerOnBackInvokedCallback(int value, OnBackInvokedCallback next) {
                                priority = value; callback = next;
                            }
                            void unregisterOnBackInvokedCallback(OnBackInvokedCallback old) {
                                if (callback == old) callback = null;
                            }
                        }
                    }
                    static final class os {
                        static final class Build {
                            static final class VERSION { static int SDK_INT = 29; }
                            static final class VERSION_CODES { static final int R = 30; }
                        }
                        static final class SystemClock {
                            static long now;
                            static long elapsedRealtime() { return now; }
                        }
                    }
                }
                static final class Looper {
                    static final Looper MAIN = new Looper();
                    static Looper myLooper() { return MAIN; }
                    static Looper getMainLooper() { return MAIN; }
                }
                static final class NavigationHandle {
                    String url;
                    boolean primary = true, sameDocument, committed = true, error;
                    NavigationHandle(String url) { this.url = url; }
                    boolean isInPrimaryMainFrame() { return primary; }
                    boolean isSameDocument() { return sameDocument; }
                    boolean hasCommitted() { return committed; }
                    boolean isErrorPage() { return error; }
                    GURL getUrl() { return new GURL(url); }
                }
                static class WebContentsObserver {
                    private WebContents observing;
                    WebContentsObserver(WebContents contents) { observe(contents); }
                    final WebContents getWebContents() { return observing; }
                    final void observe(WebContents contents) {
                        if (observing != null) observing.observers.remove(this);
                        observing = contents;
                        if (contents != null) contents.observers.add(this);
                    }
                    public void didToggleFullscreenModeForTab(boolean enteredFullscreen, boolean willCauseResize) { }
                    public void primaryMainFrameRenderProcessGone(int status) { }
                    public void didStartNavigationInPrimaryMainFrame(NavigationHandle navigation) { }
                    public void didRedirectNavigation(NavigationHandle navigation) { }
                    public void didChangeVisibleSecurityState() { }
                    public void didFinishNavigationInPrimaryMainFrame(NavigationHandle navigation) { }
                    public void didFirstVisuallyNonEmptyPaint() { }
                    public void didStopLoading(GURL url, boolean valid) { }
                    public void navigationEntriesChanged() { }
                    public void onVisibilityChanged(int visibility) { }
                    public void webContentsDestroyed() { }
                    public void titleWasSet(String title) { }
                }
                static final class Toast {
                    static final int LENGTH_SHORT = 0, LENGTH_LONG = 1;
                    static Toast makeText(Object context, String text, int length) {
                        if (context instanceof Activity host) host.toasts.add(text);
                        return new Toast();
                    }
                    void show() { }
                }
                static final class GURL {
                    final String value;
                    GURL(String value) { this.value = value; }
                    String getSpec() { return value; }
                }
                static final class NavigationController {
                    int reloads, backCalls;
                    boolean lastCheckForRepost, hasBack;
                    boolean canGoForward() { return false; }
                    boolean canGoBack() { return hasBack; }
                    void goForward() { }
                    void goBack() { backCalls++; }
                    Runnable onReload;
                    void reload(boolean checkForRepost) {
                        reloads++; lastCheckForRepost = checkForRepost;
                        if (onReload != null) onReload.run();
                    }
                }
                static final class RenderWidgetHostView {
                    boolean ready;
                    boolean isReady() { return ready; }
                }
                static final class Visibility { static final int VISIBLE = 0, HIDDEN = 1; }
                static final class WebContents {
                    String url, lastCommittedUrl, title;
                    boolean destroyed, nativeFullscreen, insideFullscreenObserver, loading;
                    int fullscreenExits, fullscreenQueries, stops;
                    int visibility = Visibility.VISIBLE;
                    final NavigationController navigation = new NavigationController();
                    final List<WebContentsObserver> observers = new ArrayList<>();
                    boolean securePage = true, standalonePage = true;
                    String standaloneScope;
                    final List<NativePwaBridge.Callback> manifests = new ArrayList<>();
                    boolean isDestroyed() { return destroyed; }
                    RenderWidgetHostView renderer = new RenderWidgetHostView();
                    WebContents(String url, boolean ready) {
                        this.url = url; lastCommittedUrl = url; title = url; renderer.ready = ready;
                    }
                    GURL getVisibleUrl() { return new GURL(url); }
                    GURL getLastCommittedUrl() { return new GURL(lastCommittedUrl); }
                    String getTitle() { return title; }
                    RenderWidgetHostView getRenderWidgetHostView() { return renderer; }
                    NavigationController getNavigationController() { return navigation; }
                    int getVisibility() { return visibility; }
                    boolean isLoading() { return loading; }
                    void updateWebContentsVisibility(int value) {
                        if (visibility == value) return;
                        visibility = value;
                        for (var observer : List.copyOf(observers)) observer.onVisibilityChanged(value);
                    }
                    boolean isFullscreenForCurrentTab() {
                        if (destroyed) throw new AssertionError("queried destroyed fullscreen contents");
                        fullscreenQueries++;
                        return nativeFullscreen;
                    }
                    void exitFullscreen() {
                        if (destroyed || insideFullscreenObserver || !nativeFullscreen) {
                            throw new AssertionError("unsafe exit JNI");
                        }
                        fullscreenExits++;
                        nativeFullscreen = false;
                        signalFullscreen(false, true);
                    }
                    void signalFullscreen(boolean entered, boolean willResize) {
                        insideFullscreenObserver = true;
                        try {
                            for (WebContentsObserver observer : List.copyOf(observers)) {
                                observer.didToggleFullscreenModeForTab(entered, willResize);
                            }
                        } finally { insideFullscreenObserver = false; }
                    }
                    void stop() { stops++; }
                }
                static final class Shell extends View {
                    WebContents contents;
                    boolean destroyed;
                    final ViewGroup holder = new ViewGroup();
                    Shell(String url, boolean ready) { contents = new WebContents(url, ready); }
                    boolean isDestroyed() { return destroyed; }
                    WebContents getWebContents() { return contents; }
                    @Override View findViewById(int id) { return holder; }
                    void close() { destroyed = true; contents.destroyed = true; }
                }
                static final class ShellManager extends ViewGroup {
                    final List<Shell> shells = new ArrayList<>();
                    Shell active;
                    Shell retain(String url, boolean ready) {
                        Shell shell = new Shell(url, ready); shells.add(shell);
                        if (active == null) active = shell;
                        return shell;
                    }
                    Shell getActiveShell() { return active; }
                    List<Shell> getShells() { return shells; }
                    void selectShell(Shell shell) {
                        Shell old = active;
                        if (old == shell) return;
                        // Pinned ShellManager nulls active before removing and assigns after adding.
                        active = null;
                        if (hierarchy != null && old != null) hierarchy.onChildViewRemoved(this, old);
                        if (hierarchy != null && shell != null) hierarchy.onChildViewAdded(this, shell);
                        active = shell;
                    }
                    void destroy() { shells.clear(); active = null; }
                    void closeShell(Shell shell) {
                        shells.remove(shell);
                        if (active == shell) active = shells.isEmpty() ? null : shells.get(0);
                        shell.destroyed = true;
                        if (hierarchy != null) hierarchy.onChildViewRemoved(this, shell);
                    }
                }
                static final class Runtime {
                    boolean valid = true;
                    long ownerGeneration = 7;
                    boolean isCurrent(Activity activity, long generation) { return valid && ownerGeneration == generation; }
                    void detach(Activity host) { valid = false; }
                }
                static final class Surface { boolean valid = true; boolean isValid() { return valid; } }
                static final class SurfaceHolder {
                    interface Callback {
                        void surfaceCreated(SurfaceHolder holder);
                        void surfaceChanged(SurfaceHolder holder, int format, int width, int height);
                        void surfaceDestroyed(SurfaceHolder holder);
                    }
                    final Surface surface = new Surface();
                    Callback callback;
                    Surface getSurface() { return surface; }
                    void addCallback(Callback value) { callback = value; }
                    void removeCallback(Callback value) { if (callback == value) callback = null; }
                    void destroy() { surface.valid = false; callback.surfaceDestroyed(this); }
                    void change() { callback.surfaceChanged(this, 0, 1080, 1920); }
                }
                static final class SurfaceView extends View {
                    final SurfaceHolder holder = new SurfaceHolder();
                    SurfaceHolder getHolder() { return holder; }
                }
                static final class ContentViewRenderView {
                    final SurfaceView surface = new SurfaceView();
                    SurfaceView getSurfaceView() { return surface; }
                }
                static final class Bitmap {
                    enum Config { ARGB_8888 }
                    final int width, height;
                    static int allocations;
                    boolean recycled;
                    View drawnFrom;
                    Bitmap(int width, int height) { this.width = width; this.height = height; }
                    static Bitmap createBitmap(int width, int height, Config config) {
                        allocations++;
                        return new Bitmap(width, height);
                    }
                    int getWidth() { return width; }
                    int getHeight() { return height; }
                    void recycle() {
                        if (recycled) throw new AssertionError("destination recycled twice");
                        recycled = true;
                    }
                }
                static final class Canvas {
                    final Bitmap bitmap;
                    Canvas(Bitmap bitmap) { this.bitmap = bitmap; }
                    void scale(float x, float y) {
                        if (x <= 0 || y <= 0) throw new AssertionError("invalid canvas scale");
                    }
                }
                static final class Window {
                    final View decor = new View();
                    final WindowInsetsController controller = new WindowInsetsController();
                    boolean controllerAvailable = true, fits = true;
                    int controllerReads;
                    View getDecorView() { return decor; }
                    WindowInsetsController getInsetsController() {
                        controllerReads++; return controllerAvailable ? controller : null;
                    }
                    void setDecorFitsSystemWindows(boolean value) { fits = value; }
                    void destroy() { }
                }
                static final class WindowInsetsController {
                    static final int BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE = 2;
                    int behavior = 1, hiddenTypes, hideCalls, showCalls;
                    void hide(int types) { hiddenTypes |= types; hideCalls++; }
                    void show(int types) { hiddenTypes &= ~types; showCalls++; }
                    int getSystemBarsBehavior() { return behavior; }
                    void setSystemBarsBehavior(int value) { behavior = value; }
                }
                static final class Insets {
                    static final Insets NONE = of(0, 0, 0, 0);
                    final int left, top, right, bottom;
                    private Insets(int l, int t, int r, int b) { left = l; top = t; right = r; bottom = b; }
                    static Insets of(int l, int t, int r, int b) { return new Insets(l, t, r, b); }
                    boolean empty() { return left == 0 && top == 0 && right == 0 && bottom == 0; }
                    Insets inset(int l, int t, int r, int b) {
                        return of(Math.max(0, left - l), Math.max(0, top - t),
                                Math.max(0, right - r), Math.max(0, bottom - b));
                    }
                }
                static final class WindowInsets {
                    static final class Type {
                        static int statusBars() { return 1; }
                        static int navigationBars() { return 2; }
                        static int ime() { return 4; }
                        static int displayCutout() { return 8; }
                        static int captionBar() { return 16; }
                    }
                    Insets current = Insets.of(0, 24, 35, 48), stable = current;
                    Insets ime = Insets.of(0, 0, 0, 250);
                    Insets cutout = Insets.of(17, 0, 0, 0);
                    Insets gesture = Insets.of(29, 0, 8, 0);
                    Insets getSystemWindowInsets() { return current; }
                    Insets getStableInsets() { return stable; }
                    Insets getInsets(int types) {
                        check(types == 20, "fullscreen fits only IME and caption bar on API30+");
                        return Insets.of(0, 0, 0, ime.bottom);
                    }
                    WindowInsets inset(int l, int t, int r, int b) {
                        WindowInsets copy = new WindowInsets();
                        copy.current = current.inset(l, t, r, b); copy.stable = stable.inset(l, t, r, b);
                        copy.ime = ime.inset(l, t, r, b); copy.cutout = cutout.inset(l, t, r, b);
                        copy.gesture = gesture.inset(l, t, r, b);
                        return copy;
                    }
                    static final class Builder {
                        final WindowInsets copy = new WindowInsets();
                        Builder(WindowInsets source) {
                            copy.current = source.current; copy.stable = source.stable;
                            copy.ime = source.ime; copy.cutout = source.cutout; copy.gesture = source.gesture;
                        }
                        Builder setStableInsets(Insets value) { copy.stable = value; return this; }
                        Builder setSystemWindowInsets(Insets value) { copy.current = value; return this; }
                        Builder setInsets(int types, Insets value) {
                            check(types == 11, "visible status, navigation and cutout geometry is overridden");
                            if ((types & Type.displayCutout()) != 0) copy.cutout = value;
                            return setSystemWindowInsets(value);
                        }
                        Builder setInsetsIgnoringVisibility(int types, Insets value) {
                            check(types == 11, "stable status, navigation and cutout geometry is overridden");
                            if ((types & Type.displayCutout()) != 0) copy.cutout = value;
                            return setStableInsets(value);
                        }
                        WindowInsets build() { return copy; }
                    }
                }
                interface CopyResult { void complete(int result); }
                static final class PixelCopy {
                    static final int SUCCESS = 0, ERROR_UNKNOWN = 1, ERROR_TIMEOUT = 2,
                            ERROR_SOURCE_NO_DATA = 3, ERROR_SOURCE_INVALID = 4, ERROR_DESTINATION_INVALID = 5;
                    static final class Request {
                        final SurfaceView source;
                        final Bitmap bitmap;
                        final CopyResult callback;
                        final Handler handler;
                        Request(SurfaceView source, Bitmap bitmap, CopyResult callback, Handler handler) {
                            this.source = source; this.bitmap = bitmap; this.callback = callback; this.handler = handler;
                        }
                    }
                    static final List<Request> submitted = new ArrayList<>();
                    static final ArrayDeque<Request> pending = new ArrayDeque<>();
                    static int windowRequests;
                    static void reset() { submitted.clear(); pending.clear(); windowRequests = 0; Bitmap.allocations = 0; }
                    static void request(SurfaceView source, Bitmap bitmap, CopyResult callback, Handler handler) {
                        if (bitmap.recycled) throw new AssertionError("copy submitted recycled destination");
                        Request request = new Request(source, bitmap, callback, handler);
                        submitted.add(request); pending.add(request);
                    }
                    static void request(Window window, Bitmap bitmap, CopyResult callback, Handler handler) {
                        windowRequests++;
                        request((SurfaceView) null, bitmap, callback, handler);
                    }
                    static Request finish(int result) {
                        Request request = pending.remove();
                        check(!request.bitmap.recycled, "PixelCopy retains its destination until callback delivery");
                        request.handler.post(() -> request.callback.complete(result));
                        return request;
                    }
                }
                static final class Log {
                    static void d(String tag, String text) { }
                    static void w(String tag, String text) { }
                }
                // PWA platform boundaries. Ownership, posting, eligibility, consent and recheck
                // use Activity/WebApp production code; the host chooses when each callback arrives.
                @java.lang.annotation.Target(java.lang.annotation.ElementType.TYPE_USE)
                @interface Nullable { }
                static final class NativePwaBridge {
                    @FunctionalInterface
                    interface Callback { void onResult(@Nullable InstallManifest manifest); }
                    static final class InstallManifest {
                        final String id, name, startUrl, scope, origin;
                        InstallManifest(String id, String name, String startUrl, String scope, String origin) {
                            this.id = id; this.name = name; this.startUrl = startUrl; this.scope = scope; this.origin = origin;
                        }
                    }
                    static boolean isSecurePage(@Nullable WebContents contents) {
                        return contents != null && !contents.isDestroyed() && contents.securePage;
                    }
                    static void requestManifest(WebContents contents, Callback callback) {
                        if (contents.destroyed || contents.nativeFullscreen || contents.insideFullscreenObserver
                                || contents.getVisibility() != Visibility.VISIBLE) {
                            throw new AssertionError("manifest read on an unpresentable page");
                        }
                        contents.manifests.add(callback);
                    }
                    static boolean isStandalonePage(WebContents contents) {
                        return contents != null && !contents.isDestroyed() && contents.standaloneScope != null && contents.standalonePage;
                    }
                    static boolean setStandaloneScope(WebContents contents, @Nullable String scope) {
                        if (contents.isDestroyed()) return false;
                        contents.standaloneScope = scope;
                        return true;
                    }
                }
                static final String APP_ID = "7d5f7fe5-2032-428b-b83a-f943d0f949b6";
                static final String PROFILE_ID = "75c9ee1a-2a71-434c-a8a6-fdafd7816b5c";
                static final class Application {
                    static final class Profile { final String id = PROFILE_ID; }
                    static final class Launch { final Profile profile = new Profile(); }
                    void requireBrowserActivation() { }
                    Launch requireLaunch() { return new Launch(); }
                }
                static final class WebAppRegistry implements AutoCloseable {
                    private final Activity host;
                    WebAppRegistry(Activity host) { this.host = host; }
                    WebApp register(String profile, String id, String name, String start, String scope, String origin) {
                        WebApp app = new WebApp(APP_ID, profile, id, name, start, scope, origin);
                        host.registered.add(app);
                        return app;
                    }
                    List<WebApp> list() { return new ArrayList<>(host.registered); }
                    @Override public void close() { }
                }
                static final class WebAppShortcuts {
                    static final class PinRequest {
                        final String message = "test pin request";
                    }
                    static PinRequest requestPin(Activity host, WebApp app) {
                        host.pinRequests.add(app);
                        return new PinRequest();
                    }
                }
                static final class Dialog {
                    final Window window = new Window();
                    boolean showing;
                    java.util.function.Consumer<Dialog> onDismiss;
                    Window getWindow() { return window; }
                    boolean isShowing() { return showing; }
                    void setOnDismissListener(java.util.function.Consumer<Dialog> listener) { onDismiss = listener; }
                    void dismiss() {
                        if (!showing) return;
                        showing = false;
                        window.decor.dispatchWindowFocus(false);
                        if (onDismiss != null) onDismiss.accept(this);
                    }
                }
                static final class Ui {
                    static TextView body(Activity host, String text) {
                        TextView view = new TextView(); view.setText(text); return view;
                    }
                    static final class Sheet {
                        final Activity host;
                        final Dialog dialog = new Dialog();
                        final List<String> lines = new ArrayList<>();
                        TextView origin;
                        Runnable cancel, confirm;
                        Sheet(Activity host) { this.host = host; }
                        static Sheet create(Activity host, String title, String subtitle) { return new Sheet(host); }
                        Sheet text(String value) { lines.add(value); return this; }
                        Sheet content(TextView view) { origin = view; return this; }
                        Dialog dialog() { return dialog; }
                        void actions(String cancelLabel, Runnable cancelAction, String confirmLabel, Runnable confirmAction) {
                            cancel = cancelAction; confirm = confirmAction;
                        }
                        void updateText(String text) { }
                        void show() { dialog.showing = true; host.consent = this; }
                    }
                }
                // Runtime permission routing is outside this recovery host's scope.
                static final class MediaPermissionBridge {
                    static void setHost(Object host) { }
                    static void clearHost(Object host) { }
                }
                static class BaseActivity {
                    boolean finishing, destroyed, windowFocus = true;
                    int pauses, stops;
                    final android.window.OnBackInvokedDispatcher backDispatcher = new android.window.OnBackInvokedDispatcher();
                    android.window.OnBackInvokedDispatcher getOnBackInvokedDispatcher() { return backDispatcher; }
                    boolean isFinishing() { return finishing; }
                    boolean isDestroyed() { return destroyed; }
                    protected void onPause() { pauses++; }
                    protected void onStop() { stops++; }
                    protected void onResume() { }
                    protected void onDestroy() { destroyed = true; }
                    public void onBackPressed() { }
                    public void onWindowFocusChanged(boolean focus) { windowFocus = focus; }
                    boolean hasWindowFocus() { return windowFocus; }
                }
                static final class Activity extends BaseActivity {
                    static final String TAG = "Host", INPUT_METHOD_SERVICE = "input_method";
                    static final int MAX_TABS = 10;
                    final Handler main = new Handler(), previewResults = new Handler();
                    final FrameLayout browserFrame = createBrowserFrame();
                    final View splash = new View(), splashSpinner = new View(), progressBar = new View();
                    final ViewGroup root = new ViewGroup();
                    final View address = new View(), urlSuggest = new View(), chromeBar = new View(), webAppBar = new View();
                    final TextView webAppTitle = new TextView();
                    final Application application = new Application();
                    final List<WebApp> registered = new ArrayList<>(), pinRequests = new ArrayList<>();
                    final List<String> toasts = new ArrayList<>();
                    View webAppOfferBar;
                    Ui.Sheet consent;
                    final TextView splashTitle = new TextView(), splashStatus = new TextView(), restoreRetry = new TextView();
                    final NewTabPage newTab = new NewTabPage();
                    final HistoryPanel historyPanel = new HistoryPanel();
                    final TabSwitcherView tabSwitcher = new TabSwitcherView();
                    List<TabSwitcherView.TabItem> shownTabs = new ArrayList<>();
                    final Store historyStore = new Store();
                    final Runtime runtime = new Runtime();
                    ContentViewRenderView renderView = new ContentViewRenderView();
                    final Window activityWindow = new Window();
                    Window window = new Window();
                    final Runnable historyLoaded = () -> { };
                    SurfaceHolder.Callback previewSurfaceObserver;
                    ShellManager manager = new ShellManager();
                    PopupWindow overflowMenu;
                    Runnable overflowResize;
                    final List<Object> overflowPalette = new ArrayList<>(), overflowFonts = new ArrayList<>();
                    long generation = 7;
                    boolean resumed = true, uiBuilt = true, closed, quiescing, cleanupComplete,
                            chromeRefreshPosted, ntpRenderDirty;
                    Shell loadingShell;
                    int switcherRefreshes, focusCancellations, returns;
                    Activity(boolean ready) {
                        android.os.SystemClock.now = 0;
                        splash.visibility = View.GONE; restoreRetry.visibility = View.GONE;
                        newTab.visibility = View.GONE; historyPanel.visibility = View.GONE; urlSuggest.visibility = View.GONE;
                        manager.retain("https://a.invalid/page", ready);
                        installShellObserverHooks(); installPreviewSurfaceHooks();
                        observeShell(manager.active);
                        // Start from settled bootstrap, with the real production observer installed.
                        previewRequested = false; previewCapturePosted = false; browserFrame.removeCallbacks(previewCapture);
                        browserFrame.animationPosts = 0; browserFrame.callbackRemovals = 0;
                        main.queue.clear(); chromeRefreshPosted = false;
                    }
                    void cancelNavigationFocus() { focusCancellations++; }
                    void hideUrlSuggestions() { urlSuggest.visibility = View.GONE; }
                    void dismissAddressEditor() { address.clearFocus(); urlSuggest.visibility = View.GONE; }
                    void refreshTabSwitcher(boolean force) { if (force) switcherRefreshes++; }
                    // Ticket consumption and navigation-focus handoff have separate source-extracted suites.
                    void openPendingWebApp() { }
                    void replacePendingWebAppTicket(String ticket) { }
                    void completeNavigationFocus() { }
                    // Rendering/card construction have dedicated suites; these destinations remain fake.
                    List<TabSwitcherView.TabItem> tabItems() { return List.of(); }
                    void createBlankTab() { manager.retain("about:blank", true); }
                    void closeTab(Shell shell) { manager.closeShell(shell); }
                    void returnToList() { returns++; }
                    void requestEnvironmentExit() { quiescing = true; cancelUiWork(); }
                    void refreshChrome() { trackHistory(); reconcilePageRestoring(); syncWebContentsVisibility(); }
                    Window getWindow() { return activityWindow; }
                    Object getSystemService(String service) { return null; }
                    @ACTUAL@
                }
            """, """
                static void covered(Activity a, Shell shell, String message) {
                    check(a.restoreSplashShown && a.splash.visibility == View.VISIBLE
                            && a.restoreShell == shell && a.restoreContents == shell.contents
                            && a.ownsPageRestoring(shell, shell.contents), message);
                }
                static void uncovered(Activity a, String message) {
                    check(!a.restoreSplashShown && a.splash.visibility == View.GONE
                            && a.restoreShell == null && a.restoreContents == null
                            && a.restoreUrl == null && a.restoreTimeout == null, message);
                }
                static void finish(Activity a, int result) {
                    PixelCopy.finish(result);
                    check(a.previewInFlight, "copy is still in flight before result-handler delivery");
                    a.previewResults.all();
                    check(!a.previewInFlight, "result delivery releases in-flight gate");
                }
                static void restorationDeadline() {
                    Activity a = new Activity(false);
                    Shell shell = a.manager.active;
                    shell.contents.title = "  Restored article  ";
                    a.reconcilePageRestoring();
                    covered(a, shell, "unready selected A is covered and owns recovery");
                    check(a.splashTitle.text.equals("Restored article"), "cover labels its actual owner");
                    check(a.restoreUrl.equals(shell.contents.url) && a.restoreGeneration == a.generation,
                            "recovery stores URL and runtime generation");
                    check(a.splashSpinner.visibility == View.VISIBLE && a.restoreRetry.visibility == View.GONE,
                            "initial recovery is busy with retry hidden");
                    Runnable timeout = a.restoreTimeout;
                    int epoch = a.restoreEpoch;
                    long deadline = a.browserFrame.deadline(timeout);
                    check(deadline == 8000, "recovery has an eight-second deadline on the fake clock");
                    a.browserFrame.advance(4500);
                    for (int i = 0; i < 5; i++) a.reconcilePageRestoring();
                    check(a.restoreTimeout == timeout && a.restoreEpoch == epoch
                            && a.browserFrame.deadline(timeout) == deadline, "ordinary refreshes do not renew deadline");
                    a.browserFrame.advance(3500);
                    covered(a, shell, "elapsed deadline never uncovers an unready renderer");
                    check(a.restoreTimeout == null && a.splashSpinner.visibility == View.GONE
                            && a.restoreRetry.visibility == View.VISIBLE, "deadline stops spinner and makes retry available");
                    check(a.splashStatus.text.equals("页面恢复时间较长，可重新加载或切换标签页")
                            && shell.contents.navigation.reloads == 0, "timeout reports slow recovery, not network failure or automatic reload");
                    for (int i = 0; i < 3; i++) a.reconcilePageRestoring();
                    check(a.restoreTimeout == null && a.restoreRetry.visibility == View.VISIBLE
                            && a.splashSpinner.visibility == View.GONE, "refresh after deadline does not restart busy recovery");
                    a.completePageRestoring(shell, shell.contents);
                    covered(a, shell, "load-complete without renderer readiness cannot uncover page");
                    shell.contents.renderer.ready = true;
                    a.completePageRestoring(shell, shell.contents);
                    uncovered(a, "ready owner completion removes cover");
                    timeout.run();
                    uncovered(a, "manually delivered completed deadline cannot resurrect cover");

                    Activity beforeDeadline = new Activity(false);
                    beforeDeadline.reconcilePageRestoring();
                    beforeDeadline.manager.active.contents.renderer.ready = true;
                    beforeDeadline.browserFrame.advance(8000);
                    uncovered(beforeDeadline, "deadline checks readiness rather than displaying a false timeout");

                    for (int mode = 0; mode < 4; mode++) {
                        Activity blank = new Activity(mode == 0);
                        Shell candidate = blank.manager.active;
                        if (mode == 1) candidate.contents.url = "about:blank";
                        if (mode == 2) {
                            candidate.contents.url = "about:blank#native-owned";
                            blank.newTabUrls.put(candidate, candidate.contents.url);
                        }
                        if (mode == 3) candidate.contents = null;
                        blank.reconcilePageRestoring();
                        uncovered(blank, "ready/blank/native-home/null contents never receive recovery cover " + mode);
                    }
                }
                static void restorationTransitions() {
                    for (boolean survivorReady : List.of(false, true)) {
                        Activity a = new Activity(false);
                        Shell old = a.manager.active;
                        Shell survivor = a.manager.retain("https://b.invalid/retained", survivorReady);
                        a.reconcilePageRestoring();
                        Runnable staleTimeout = a.restoreTimeout;
                        a.manager.closeShell(old); // Native removal, not the switcher onSelect path.
                        check(a.chromeRefreshPosted, "native close queues owner reconciliation");
                        a.main.all();
                        if (survivorReady) uncovered(a, "closing covered A onto ready B removes old cover");
                        else covered(a, survivor, "native automatic unready survivor B receives a new cover");
                        Runnable survivorTimeout = a.restoreTimeout;
                        staleTimeout.run();
                        old.contents.renderer.ready = true;
                        a.completePageRestoring(old, old.contents);
                        if (survivorReady) uncovered(a, "stale A callbacks cannot cover ready B");
                        else {
                            covered(a, survivor, "stale A timeout and completion cannot clear B");
                            check(a.restoreTimeout == survivorTimeout && a.restoreRetry.visibility == View.GONE,
                                    "stale A cannot expire B's new deadline");
                        }
                    }
                    Activity a = new Activity(false);
                    Shell old = a.manager.active;
                    a.reconcilePageRestoring();
                    Shell alias = a.manager.retain("https://b.invalid/alias", false);
                    alias.contents = old.contents;
                    a.manager.active = alias;
                    check(!a.ownsPageRestoring(alias, alias.contents), "restore Shell identity rejects aliased contents");
                    a.reconcilePageRestoring();
                    covered(a, alias, "new Shell receives distinct ownership even with aliased WebContents");
                }
                interface Invalidate { void apply(Activity activity, Shell shell); }
                static void restorationOwnership() {
                    List<Invalidate> changes = List.of(
                            (a, s) -> s.contents = new WebContents(s.contents.url, false),
                            (a, s) -> s.contents.url = "https://a.invalid/new-document",
                            (a, s) -> { a.generation++; a.runtime.ownerGeneration++; },
                            (a, s) -> a.runtime.valid = false,
                            (a, s) -> a.resumed = false,
                            (a, s) -> a.manager.shells.remove(s),
                            (a, s) -> s.destroyed = true,
                            (a, s) -> a.closed = true,
                            (a, s) -> a.quiescing = true,
                            (a, s) -> a.finishing = true,
                            (a, s) -> a.destroyed = true,
                            (a, s) -> a.uiBuilt = false,
                            (a, s) -> a.manager = null);
                    for (int i = 0; i < changes.size(); i++) {
                        Activity a = new Activity(false);
                        Shell shell = a.manager.active;
                        WebContents original = shell.contents;
                        a.reconcilePageRestoring();
                        Runnable timeout = a.restoreTimeout;
                        changes.get(i).apply(a, shell);
                        check(!a.ownsPageRestoring(shell, original), "invalidated recovery ownership " + i);
                        timeout.run();
                        check(a.restoreRetry.visibility == View.GONE && a.splashSpinner.visibility == View.VISIBLE,
                                "stale timeout cannot alter recovery feedback " + i);
                        a.retryPageRestoring();
                        check(original.navigation.reloads == 0, "invalid owner cannot reload " + i);
                        a.reconcilePageRestoring();
                        if (i <= 2) covered(a, shell, "replacement URL/contents/generation mints fresh owner " + i);
                        else uncovered(a, "noninteractive or removed owner is cleared " + i);
                    }
                    Activity replacement = new Activity(false);
                    Shell shell = replacement.manager.active;
                    WebContents original = shell.contents;
                    replacement.reconcilePageRestoring();
                    Runnable timeout = replacement.restoreTimeout;
                    shell.contents = new WebContents(original.url, false);
                    replacement.reconcilePageRestoring();
                    original.renderer.ready = true;
                    timeout.run();
                    replacement.completePageRestoring(shell, original);
                    covered(replacement, shell, "old WebContents callbacks cannot clear replacement owner");
                }
                static void restorationRetryAndCancellation() {
                    Activity a = new Activity(false);
                    Shell shell = a.manager.active;
                    a.reconcilePageRestoring();
                    Runnable oldTimeout = a.restoreTimeout;
                    a.browserFrame.advance(8000);
                    shell.contents.navigation.onReload = a::retryPageRestoring;
                    a.retryPageRestoring();
                    check(shell.contents.navigation.reloads == 1 && shell.contents.navigation.lastCheckForRepost,
                            "retry reloads exactly once with repost checking, including a reentrant tap");
                    covered(a, shell, "retry retains the exact current owner");
                    Runnable renewed = a.restoreTimeout;
                    check(renewed != null && renewed != oldTimeout && a.browserFrame.deadline(renewed) == 16000,
                            "retry renews the full recovery deadline");
                    check(a.restoreRetry.visibility == View.GONE && a.splashSpinner.visibility == View.VISIBLE,
                            "retry returns feedback to busy before calling reload");
                    a.retryPageRestoring(); a.retryPageRestoring();
                    check(shell.contents.navigation.reloads == 1, "immediately repeated retry taps submit only one reload");
                    oldTimeout.run();
                    check(a.restoreTimeout == renewed && a.splashSpinner.visibility == View.VISIBLE
                            && a.restoreRetry.visibility == View.GONE, "old deadline cannot expire renewed retry");
                    a.hidePageRestoring();
                    check(!a.browserFrame.has(renewed), "hide removes pending deadline from frame scheduler");
                    renewed.run();
                    uncovered(a, "hidden owner's manually fired deadline is inert");

                    Activity readyRace = new Activity(false);
                    readyRace.reconcilePageRestoring(); readyRace.browserFrame.advance(8000);
                    readyRace.manager.active.contents.renderer.ready = true;
                    readyRace.manager.active.contents.navigation.onReload = () -> check(
                            readyRace.restoreSplashShown && readyRace.restoreRetry.visibility == View.GONE,
                            "ordinary retry ready-before-click race still enters busy before reload");
                    readyRace.retryPageRestoring();
                    check(readyRace.manager.active.contents.navigation.reloads == 1,
                            "ordinary explicit retry is not silently skipped when readiness races the tap");

                    Activity busy = new Activity(false);
                    busy.reconcilePageRestoring(); busy.retryPageRestoring();
                    check(busy.manager.active.contents.navigation.reloads == 0, "busy recovery cannot be retried early");

                    Activity switched = new Activity(false);
                    Shell old = switched.manager.active;
                    Shell next = switched.manager.retain("https://b.invalid/retry", false);
                    switched.reconcilePageRestoring();
                    switched.browserFrame.advance(8000);
                    switched.manager.selectShell(next);
                    switched.retryPageRestoring();
                    check(old.contents.navigation.reloads == 0 && next.contents.navigation.reloads == 0,
                            "retry cannot act on old cover after native active-owner switch");
                    switched.main.all(); switched.browserFrame.advance(8000);
                    switched.retryPageRestoring();
                    check(old.contents.navigation.reloads == 0 && next.contents.navigation.reloads == 1,
                            "retry acts only on the now-current cover owner B");

                    Activity paused = new Activity(false);
                    Shell owner = paused.manager.active;
                    paused.reconcilePageRestoring();
                    Runnable cancelled = paused.restoreTimeout;
                    paused.requestChromeRefresh();
                    paused.onPause();
                    uncovered(paused, "actual onPause/cancelUiWork clears recovery cover and ownership");
                    check(!paused.browserFrame.has(cancelled) && paused.main.queue.isEmpty()
                            && paused.chromeShell == null && paused.chromeContents == null,
                            "actual cancellation removes deadlines/refresh and resets chrome ownership");
                    cancelled.run();
                    uncovered(paused, "cancelled deadline is inert even when forcibly delivered");
                    check(paused.pauses == 1 && paused.historyStore.flushes == 1
                            && owner.contents.visibility == Visibility.HIDDEN, "pause retains superclass/store/visibility work");
                    paused.resumed = true;
                    paused.reconcilePageRestoring();
                    covered(paused, owner, "resumed unready owner gets fresh cover after chrome owner reset");
                    Runnable resumedTimeout = paused.restoreTimeout;
                    cancelled.run();
                    check(paused.restoreTimeout == resumedTimeout, "pre-pause deadline cannot alter resumed recovery");
                    paused.onStop();
                    uncovered(paused, "actual onStop also cancels recovery");
                }
                static void previewRequestCoalescing() {
                    PixelCopy.reset();
                    Activity a = new Activity(true);
                    Shell shell = a.manager.active;
                    for (int i = 0; i < 20; i++) a.requestActivePreview(shell);
                    check(a.browserFrame.animationPosts == 1 && a.browserFrame.callbackRemovals == 0
                            && a.browserFrame.count(a.previewCapture) == 1 && a.previewCapturePosted,
                            "same-frame burst posts once without remove/repost churn");
                    check(Bitmap.allocations == 0 && PixelCopy.submitted.isEmpty(), "coalesced request does not allocate inline");
                    a.browserFrame.frame();
                    check(!a.previewCapturePosted && !a.browserFrame.has(a.previewCapture), "frame entry retires the posted gate");
                    check(a.previewInFlight && PixelCopy.submitted.size() == 1 && Bitmap.allocations == 1,
                            "same-frame burst allocates and submits one destination");
                    Activity.ShellHistoryObserver observer = a.historyObservers.get(shell);
                    for (int i = 0; i < 20; i++) {
                        if ((i & 1) == 0) observer.didFirstVisuallyNonEmptyPaint();
                        else observer.didStopLoading(new GURL(shell.contents.url), true);
                    }
                    check(a.previewRequested, "content demand while copy in flight remains dirty");
                    check(a.browserFrame.animationPosts == 1 && PixelCopy.submitted.size() == 1
                            && Bitmap.allocations == 1 && !a.previewCapturePosted,
                            "in-flight burst neither queues frames nor allocates another destination");
                    PixelCopy.Request first = PixelCopy.submitted.get(0);
                    finish(a, PixelCopy.SUCCESS);
                    check(a.browserFrame.animationPosts == 2 && a.browserFrame.count(a.previewCapture) == 1
                            && a.previewCapturePosted && a.tabPreviews.get(shell) == first.bitmap,
                            "successful old copy schedules exactly one dirty follow-up");
                    a.browserFrame.frame(); finish(a, PixelCopy.SUCCESS);
                    check(PixelCopy.submitted.size() == 2 && Bitmap.allocations == 2
                            && a.tabPreviews.get(shell) == PixelCopy.submitted.get(1).bitmap
                            && !first.bitmap.recycled && !a.previewRequested && !a.previewCapturePosted
                            && !a.browserFrame.has(a.previewCapture), "follow-up publishes fresh pixels once then becomes idle");

                    PixelCopy.reset();
                    Activity home = new Activity(false);
                    home.newTab.visibility = View.VISIBLE;
                    for (int i = 0; i < 20; i++) home.requestActivePreview(home.manager.active);
                    home.browserFrame.frame();
                    check(home.browserFrame.animationPosts == 1 && home.browserFrame.callbackRemovals == 0
                            && home.newTab.draws == 1 && Bitmap.allocations == 1 && PixelCopy.submitted.isEmpty()
                            && !home.previewCapturePosted && !home.previewRequested,
                            "same-frame native-home burst draws once and retires its posted gate");

                    PixelCopy.reset();
                    Activity retry = new Activity(true);
                    retry.requestActivePreview(retry.manager.active); retry.browserFrame.frame();
                    for (int failure = 1; failure <= Activity.MAX_PREVIEW_RETRIES; failure++) {
                        finish(retry, failure == 1 ? PixelCopy.ERROR_SOURCE_NO_DATA : PixelCopy.ERROR_TIMEOUT);
                        for (int i = 0; i < 20; i++) retry.requestActivePreview(retry.manager.active);
                        check(retry.previewRetries == failure, "merged dirty requests preserve retry budget " + failure);
                        check(retry.browserFrame.count(retry.previewCapture) == 1, "merged retry demand retains one scheduled task");
                        retry.browserFrame.frame();
                    }
                    finish(retry, PixelCopy.ERROR_SOURCE_NO_DATA);
                    check(PixelCopy.submitted.size() == 1 + Activity.MAX_PREVIEW_RETRIES && !retry.previewRequested
                            && !retry.previewCapturePosted && !retry.browserFrame.has(retry.previewCapture),
                            "duplicate requests within an already-dirty retry batch cannot renew its budget");
                    retry.requestActivePreview(retry.manager.active);
                    check(retry.previewRetries == 0 && retry.previewCapturePosted, "new dirty batch receives a new retry budget");
                    retry.browserFrame.frame(); finish(retry, PixelCopy.SUCCESS);
                }
                static void previewPostedCancellationAndRearm() {
                    List<Invalidate> cancellations = List.of(
                            (a, s) -> a.renderView.surface.holder.destroy(),
                            (a, s) -> a.historyObservers.get(s).didStartNavigationInPrimaryMainFrame(new NavigationHandle(s.contents.url)),
                            (a, s) -> a.historyObservers.get(s).primaryMainFrameRenderProcessGone(1),
                            (a, s) -> a.onPause(),
                            (a, s) -> a.onStop(),
                            (a, s) -> { a.quiescing = true; a.cancelUiWork(); },
                            (a, s) -> { a.closed = true; a.cancelUiWork(); });
                    for (int i = 0; i < cancellations.size(); i++) {
                        PixelCopy.reset();
                        Activity a = new Activity(true);
                        Shell shell = a.manager.active;
                        a.requestActivePreview(shell);
                        check(a.previewCapturePosted && a.browserFrame.has(a.previewCapture), "cancellation starts with one posted request " + i);
                        cancellations.get(i).apply(a, shell);
                        check(!a.previewCapturePosted && !a.browserFrame.has(a.previewCapture), "cancelled preview clears posted gate " + i);
                        for (int frame = 0; frame < 4; frame++) a.browserFrame.frame();
                        check(Bitmap.allocations == 0 && PixelCopy.submitted.isEmpty(), "cancelled task never allocates or submits " + i);
                    }
                    PixelCopy.reset();
                    Activity surface = new Activity(true);
                    surface.requestActivePreview(surface.manager.active); surface.renderView.surface.holder.destroy();
                    surface.renderView.surface.holder.surface.valid = true;
                    surface.renderView.surface.holder.change();
                    check(surface.previewCapturePosted && surface.browserFrame.count(surface.previewCapture) == 1,
                            "surface recreation rearms a previously cancelled posted gate");
                    surface.browserFrame.frame(); finish(surface, PixelCopy.SUCCESS);

                    PixelCopy.reset();
                    Activity navigation = new Activity(true);
                    Shell shell = navigation.manager.active;
                    navigation.requestActivePreview(shell);
                    Activity.ShellHistoryObserver observer = navigation.historyObservers.get(shell);
                    observer.didStartNavigationInPrimaryMainFrame(new NavigationHandle(shell.contents.url));
                    observer.didFirstVisuallyNonEmptyPaint();
                    check(navigation.previewCapturePosted, "fresh paint rearms navigation-cancelled preview");
                    navigation.browserFrame.frame(); finish(navigation, PixelCopy.SUCCESS);

                    PixelCopy.reset();
                    Activity paused = new Activity(true);
                    paused.requestActivePreview(paused.manager.active); paused.onPause(); paused.onResume();
                    check(paused.previewCapturePosted, "resume rearms a pause-cancelled preview");
                    paused.browserFrame.frame(); finish(paused, PixelCopy.SUCCESS);
                }
                static void previewBlockedFrameDoesNotSpin() {
                    List<Invalidate> blocks = List.of(
                            (a, s) -> a.historyPanel.visibility = View.VISIBLE,
                            (a, s) -> a.historyObservers.get(s).awaitingPaint = true,
                            (a, s) -> a.renderView.surface.attached = false,
                            (a, s) -> a.renderView.surface.shown = false,
                            (a, s) -> a.renderView.surface.width = 0,
                            (a, s) -> s.contents.renderer.ready = false,
                            (a, s) -> a.renderView.surface.holder.surface.valid = false);
                    List<Invalidate> unblock = List.of(
                            (a, s) -> a.historyPanel.visibility = View.GONE,
                            (a, s) -> a.historyObservers.get(s).didFirstVisuallyNonEmptyPaint(),
                            (a, s) -> a.renderView.surface.attached = true,
                            (a, s) -> a.renderView.surface.shown = true,
                            (a, s) -> a.renderView.surface.width = 1080,
                            (a, s) -> s.contents.renderer.ready = true,
                            (a, s) -> a.renderView.surface.holder.surface.valid = true);
                    for (int i = 0; i < blocks.size(); i++) {
                        PixelCopy.reset();
                        Activity a = new Activity(true);
                        Shell shell = a.manager.active;
                        blocks.get(i).apply(a, shell);
                        a.requestActivePreview(shell); a.browserFrame.frame();
                        check(a.previewRequested && !a.previewCapturePosted && !a.previewInFlight,
                                "blocked frame retires posted gate but retains dirty demand " + i);
                        for (int frame = 0; frame < 5; frame++) a.browserFrame.frame();
                        check(a.browserFrame.animationPosts == 1 && Bitmap.allocations == 0
                                && PixelCopy.submitted.isEmpty(), "blocked source never spins or allocates " + i);
                        unblock.get(i).apply(a, shell);
                        a.requestActivePreview(shell);
                        check(a.previewCapturePosted && a.browserFrame.count(a.previewCapture) == 1,
                                "a later ready event rearms exactly one frame " + i);
                        a.browserFrame.frame(); finish(a, PixelCopy.SUCCESS);
                        check(a.tabPreviews.containsKey(shell) && !a.previewCapturePosted, "unblocked source publishes once " + i);
                    }
                }
                static void previewSwitcherDismissAndReopen() {
                    PixelCopy.reset();
                    Activity a = new Activity(true);
                    Shell shell = a.manager.active;
                    String url = shell.contents.url;
                    int focus = a.focusCancellations;
                    for (int i = 0; i < 20; i++) a.showTabSwitcher();
                    check(a.tabSwitcher.shows == 1 && a.focusCancellations == focus + 1
                            && a.browserFrame.animationPosts == 1, "duplicate Activity show cannot repeat opening side effects");
                    a.browserFrame.frame(); finish(a, PixelCopy.SUCCESS);
                    Bitmap first = a.tabPreviews.get(shell);
                    a.dismissFromSwitcherListener();
                    check(!a.tabSwitcher.isShowing() && !a.previewRequested && !a.previewCapturePosted
                            && a.browserFrame.animationPosts == 1 && PixelCopy.submitted.size() == 1,
                            "listener dismiss does not schedule another capture");
                    a.showTabSwitcher(); a.browserFrame.frame(); finish(a, PixelCopy.SUCCESS);
                    check(url.equals(shell.contents.url) && PixelCopy.submitted.size() == 2
                            && a.tabPreviews.get(shell) != first && !first.recycled,
                            "reopening same URL explicitly captures fresh pixels");
                    a.onBackPressed();
                    check(!a.tabSwitcher.isShowing() && !a.previewRequested && !a.previewCapturePosted
                            && a.browserFrame.animationPosts == 2 && PixelCopy.submitted.size() == 2,
                            "back dismiss does not schedule another capture");
                    a.showTabSwitcher(); a.browserFrame.frame(); finish(a, PixelCopy.SUCCESS);
                    check(PixelCopy.submitted.size() == 3 && a.tabSwitcher.isShowing(), "reopening after Back still captures afresh");
                }
                static void previewNoDataAndBounds() {
                    PixelCopy.reset();
                    Activity a = new Activity(true);
                    Shell shell = a.manager.active;
                    a.requestActivePreview(shell);
                    check(PixelCopy.submitted.isEmpty() && a.browserFrame.has(a.previewCapture),
                            "preview submits on a later frame, not inline");
                    a.browserFrame.frame();
                    check(PixelCopy.submitted.size() == 1 && a.previewInFlight, "first preview submits one PixelCopy request");
                    PixelCopy.Request first = PixelCopy.submitted.get(0);
                    check(first.source == a.renderView.surface && PixelCopy.windowRequests == 0
                            && first.bitmap.width == 270 && first.bitmap.height == 480,
                            "preview copies scaled renderer SurfaceView, never browser Window");
                    finish(a, PixelCopy.ERROR_SOURCE_NO_DATA);
                    check(first.bitmap.recycled && a.tabPreviews.isEmpty(), "NO_DATA recycles unpublished destination");
                    check(a.browserFrame.has(a.previewCapture), "NO_DATA schedules next frame without a native event");
                    a.browserFrame.frame();
                    check(PixelCopy.submitted.size() == 2, "NO_DATA progresses to a second copy with no observer event");
                    PixelCopy.Request second = PixelCopy.submitted.get(1);
                    finish(a, PixelCopy.SUCCESS);
                    check(a.tabPreviews.get(shell) == second.bitmap && !second.bitmap.recycled
                            && shell.contents.url.equals(a.previewUrls.get(shell)), "successful retry publishes exact live-owner bitmap");
                    check(a.switcherRefreshes == 1 && !a.previewRequested && !a.browserFrame.has(a.previewCapture),
                            "successful retry refreshes cards once and stops retrying");
                    a.requestActivePreview(shell); a.browserFrame.frame();
                    PixelCopy.Request replacement = PixelCopy.submitted.get(2);
                    finish(a, PixelCopy.SUCCESS);
                    check(a.tabPreviews.get(shell) == replacement.bitmap && !second.bitmap.recycled,
                            "replaced published snapshots remain safe for ImageView/display-list references");

                    PixelCopy.reset();
                    Activity bounded = new Activity(true);
                    bounded.requestActivePreview(bounded.manager.active);
                    for (int attempt = 0; attempt <= Activity.MAX_PREVIEW_RETRIES; attempt++) {
                        bounded.browserFrame.frame();
                        check(PixelCopy.submitted.size() == attempt + 1, "one copy per bounded attempt " + attempt);
                        finish(bounded, PixelCopy.ERROR_SOURCE_NO_DATA);
                    }
                    for (int i = 0; i < 4; i++) bounded.browserFrame.frame();
                    check(PixelCopy.submitted.size() == 1 + Activity.MAX_PREVIEW_RETRIES
                            && PixelCopy.submitted.size() == 3 && PixelCopy.pending.isEmpty()
                            && !bounded.previewRequested && !bounded.browserFrame.has(bounded.previewCapture),
                            "repeated NO_DATA stops after initial plus MAX_PREVIEW_RETRIES");
                    for (PixelCopy.Request request : PixelCopy.submitted) {
                        check(request.bitmap.recycled, "all rejected destinations are recycled");
                    }
                    for (int result : List.of(PixelCopy.ERROR_SOURCE_INVALID, PixelCopy.ERROR_DESTINATION_INVALID, PixelCopy.ERROR_UNKNOWN)) {
                        PixelCopy.reset();
                        Activity invalid = new Activity(true);
                        invalid.requestActivePreview(invalid.manager.active); invalid.browserFrame.frame();
                        finish(invalid, result); invalid.browserFrame.frame();
                        check(PixelCopy.submitted.size() == 1 && !invalid.previewRequested
                                && !invalid.browserFrame.has(invalid.previewCapture), "nonretryable PixelCopy error does not retry " + result);
                        check(PixelCopy.submitted.get(0).bitmap.recycled && invalid.tabPreviews.isEmpty(),
                                "nonretryable failure cannot publish its destination " + result);
                    }
                    PixelCopy.reset();
                    Activity timed = new Activity(true);
                    timed.requestActivePreview(timed.manager.active); timed.browserFrame.frame();
                    finish(timed, PixelCopy.ERROR_TIMEOUT);
                    check(timed.browserFrame.has(timed.previewCapture), "PixelCopy timeout is retryable");
                    timed.browserFrame.frame(); finish(timed, PixelCopy.SUCCESS);
                    check(timed.tabPreviews.size() == 1 && PixelCopy.submitted.size() == 2, "timeout retry can recover successfully");
                }
                static void previewStaleResults() {
                    List<Invalidate> changes = List.of(
                            (a, s) -> a.manager.selectShell(a.manager.retain("https://b.invalid/switch", true)),
                            (a, s) -> { a.manager.retain("https://b.invalid/close", true); a.manager.closeShell(s); },
                            (a, s) -> a.onPause(),
                            (a, s) -> { a.onPause(); a.resumed = true; },
                            (a, s) -> a.runtime.ownerGeneration++,
                            (a, s) -> a.previewEpoch++,
                            (a, s) -> s.contents = new WebContents(s.contents.url, true),
                            (a, s) -> s.contents.url = "https://a.invalid/new-preview-document",
                            (a, s) -> {
                                Shell other = a.manager.retain("https://b.invalid/round-trip", true);
                                a.manager.selectShell(other); a.manager.selectShell(s);
                            },
                            (a, s) -> a.renderView.surface.holder.destroy(),
                            (a, s) -> a.renderView.surface.holder.change(),
                            (a, s) -> a.closed = true,
                            (a, s) -> a.quiescing = true,
                            (a, s) -> s.destroyed = true);
                    for (int i = 0; i < changes.size(); i++) {
                        PixelCopy.reset();
                        Activity a = new Activity(true);
                        Shell shell = a.manager.active;
                        a.requestActivePreview(shell); a.browserFrame.frame();
                        PixelCopy.Request request = PixelCopy.finish(PixelCopy.SUCCESS);
                        changes.get(i).apply(a, shell);
                        check(!request.bitmap.recycled && a.previewInFlight && !a.previewResults.queue.isEmpty(),
                                "invalidation preserves PixelCopy callback/destination ownership " + i);
                        a.previewResults.all();
                        check(request.bitmap.recycled && a.tabPreviews.isEmpty() && a.previewUrls.isEmpty()
                                && a.switcherRefreshes == 0 && !a.previewInFlight,
                                "stale switch/close/pause/generation/epoch/contents/URL result cannot publish " + i);
                    }
                    PixelCopy.reset();
                    Activity a = new Activity(true);
                    Shell old = a.manager.active;
                    Shell next = a.manager.retain("https://b.invalid/pending", true);
                    a.requestActivePreview(old); a.browserFrame.frame();
                    a.manager.selectShell(next);
                    for (int i = 0; i < 20; i++) a.requestActivePreview(next);
                    check(PixelCopy.submitted.size() == 1 && !a.previewCapturePosted
                            && !a.browserFrame.has(a.previewCapture), "new active request waits for old in-flight destination");
                    Bitmap oldDestination = PixelCopy.submitted.get(0).bitmap;
                    finish(a, PixelCopy.SUCCESS);
                    check(a.tabPreviews.isEmpty() && oldDestination.recycled && a.previewCapturePosted
                            && a.browserFrame.count(a.previewCapture) == 1,
                            "stale completion still schedules an already requested new owner");
                    a.browserFrame.frame(); finish(a, PixelCopy.SUCCESS);
                    check(a.tabPreviews.get(next) == PixelCopy.submitted.get(1).bitmap && !a.tabPreviews.containsKey(old)
                            && !a.previewCapturePosted && !a.browserFrame.has(a.previewCapture),
                            "new owner preview progresses after stale owner result");
                }
                static void previewSourceAndOverlays() {
                    PixelCopy.reset();
                    Activity overview = new Activity(true);
                    overview.tabSwitcher.showing = true;
                    overview.requestActivePreview(overview.manager.active); overview.browserFrame.frame();
                    check(PixelCopy.submitted.size() == 1 && PixelCopy.submitted.get(0).source == overview.renderView.surface,
                            "visible overview does not block capture from renderer SurfaceView sibling");
                    finish(overview, PixelCopy.SUCCESS);
                    check(overview.tabPreviews.size() == 1 && PixelCopy.windowRequests == 0,
                            "overview-visible capture publishes no Window/overlay pixels");

                    PixelCopy.reset();
                    Activity history = new Activity(true);
                    history.historyPanel.visibility = View.VISIBLE;
                    history.requestActivePreview(history.manager.active); history.browserFrame.frame();
                    check(PixelCopy.submitted.isEmpty() && history.previewRequested, "history panel blocks capture without consuming request");
                    history.historyPanel.visibility = View.GONE;
                    history.requestActivePreview(history.manager.active); history.browserFrame.frame(); finish(history, PixelCopy.SUCCESS);
                    check(history.tabPreviews.size() == 1, "capture resumes after history closes");

                    PixelCopy.reset();
                    Activity home = new Activity(false);
                    home.newTab.visibility = View.VISIBLE;
                    home.renderView.surface.holder.surface.valid = false;
                    home.requestActivePreview(home.manager.active); home.browserFrame.frame();
                    Bitmap bitmap = home.tabPreviews.get(home.manager.active);
                    check(PixelCopy.submitted.isEmpty() && bitmap != null && bitmap.drawnFrom == home.newTab
                            && home.newTab.draws == 1 && !bitmap.recycled, "native home draws its own subtree, not invalid renderer or Window");

                    List<Invalidate> unavailable = List.of(
                            (a, s) -> s.contents.renderer.ready = false,
                            (a, s) -> s.contents.renderer = null,
                            (a, s) -> a.renderView.surface.holder.surface.valid = false,
                            (a, s) -> a.renderView.surface.attached = false,
                            (a, s) -> a.renderView.surface.shown = false,
                            (a, s) -> a.renderView.surface.width = 0,
                            (a, s) -> {
                                Activity.ShellHistoryObserver observer = a.historyObservers.get(s);
                                observer.awaitingPaint = true;
                            });
                    for (int i = 0; i < unavailable.size(); i++) {
                        PixelCopy.reset();
                        Activity a = new Activity(true);
                        unavailable.get(i).apply(a, a.manager.active);
                        a.requestActivePreview(a.manager.active); a.browserFrame.frame();
                        check(PixelCopy.submitted.isEmpty() && !a.previewInFlight && a.tabPreviews.isEmpty(),
                                "unready/unavailable/awaiting-paint source cannot submit or publish " + i);
                    }
                }
            """, """
                static Activity.ShellHistoryObserver lose(Activity a, Shell shell) {
                    a.observeShell(shell);
                    Activity.ShellHistoryObserver observer = a.historyObservers.get(shell);
                    check(observer != null && observer.getWebContents() == shell.contents,
                            "real extracted observer is installed on exact contents");
                    observer.primaryMainFrameRenderProcessGone(1);
                    return observer;
                }
                static void rendererLossIsImmediate() {
                    Activity a = new Activity(true);
                    Shell shell = a.manager.active;
                    WebContents original = shell.contents;
                    a.reconcilePageRestoring();
                    uncovered(a, "ordinary ready page remains uncovered before renderer loss");
                    a.tabPreviews.put(shell, new Bitmap(10, 10)); a.previewUrls.put(shell, original.url);
                    Activity.ShellHistoryObserver observer = lose(a, shell);
                    covered(a, shell, "real renderer loss immediately covers same ready Shell and WebContents");
                    check(shell.contents == original && original.renderer.ready && a.pageInterruption(shell) == observer,
                            "saved-frame readiness does not suppress exact-owner interruption");
                    check(a.splashStatus.text.equals("页面已中断，可重新加载或切换标签页")
                            && a.splashSpinner.visibility == View.GONE && a.restoreRetry.visibility == View.VISIBLE
                            && a.restoreTimeout == null, "known loss is an honest interruption with one immediate reload action");
                    check(original.navigation.reloads == 0 && !a.tabPreviews.containsKey(shell)
                            && !a.previewUrls.containsKey(shell) && observer.awaitingPaint,
                            "death never replays requests or preserves a dead preview");
                    for (int i = 0; i < 5; i++) a.reconcilePageRestoring();
                    observer.didFirstVisuallyNonEmptyPaint();
                    observer.didStopLoading(new GURL(original.url), true);
                    a.completePageRestoring(shell, original);
                    covered(a, shell, "old paint/load-stop and saved-ready frame cannot retire interruption");
                    check(observer.awaitingPaint && original.navigation.reloads == 0,
                            "stale renderer events cannot unlock dead preview or replay a POST");
                    a.browserFrame.advance(12000);
                    covered(a, shell, "known-dead page does not fake automatic recovery after eight seconds");
                    check(a.restoreTimeout == null && original.navigation.reloads == 0,
                            "known-dead idle interruption has no recovery timer or automatic reload");
                }
                static void rendererLossRetainedOffscreen() {
                    Activity a = new Activity(true);
                    Shell first = a.manager.active;
                    Shell second = a.manager.retain("https://b.invalid/live", true);
                    a.manager.selectShell(second); a.main.all();
                    Activity.ShellHistoryObserver firstObserver = lose(a, first);
                    uncovered(a, "inactive A renderer loss does not cover active ready B");
                    check(a.pageInterruption(first) == firstObserver && second.contents.navigation.reloads == 0,
                            "inactive death retains only A interruption and never reloads B");
                    a.manager.selectShell(first); a.main.all();
                    covered(a, first, "selecting previously dead A exposes immediate interruption despite ready frame");
                    a.manager.selectShell(second); a.main.all();
                    uncovered(a, "switching back to B preserves usable page area");
                    Activity.ShellHistoryObserver secondObserver = lose(a, second);
                    covered(a, second, "B has its own independent interruption");
                    firstObserver.didFirstVisuallyNonEmptyPaint();
                    firstObserver.didStopLoading(new GURL(first.contents.url), true);
                    covered(a, second, "A stale callbacks cannot clear B interruption");
                    check(a.pageInterruption(first) == firstObserver && a.pageInterruption(second) == secondObserver,
                            "two tabs retain separate exact-owner interruption markers");
                    a.onPause();
                    uncovered(a, "background hides only visible recovery work");
                    a.browserFrame.advance(20000);
                    a.onResume(); a.main.all();
                    covered(a, second, "background/foreground retains dead B instead of trusting saved readiness");
                    check(second.contents.navigation.reloads == 0 && first.contents.navigation.reloads == 0,
                            "foregrounding never reloads either interrupted tab");

                    Activity background = new Activity(true);
                    Shell owner = background.manager.active;
                    background.onPause();
                    Activity.ShellHistoryObserver observer = lose(background, owner);
                    uncovered(background, "renderer death delivered while paused does not show foreground UI");
                    check(background.pageInterruption(owner) == observer, "paused death retains durable marker");
                    background.onResume(); background.main.all();
                    covered(background, owner, "loss first delivered in background is visible on resume");
                }
                static void rendererRetryAndFreshCompletion() {
                    Activity a = new Activity(true);
                    Shell shell = a.manager.active;
                    Activity.ShellHistoryObserver observer = lose(a, shell);
                    shell.contents.navigation.onReload = () -> {
                        check(a.splashSpinner.visibility == View.VISIBLE && a.restoreRetry.visibility == View.GONE
                                && a.restoreTimeout != null && observer.retryBusy,
                                "known-dead retry establishes busy state and timer before reload");
                        a.retryPageRestoring(); a.performMenuAction("刷新");
                    };
                    a.retryPageRestoring();
                    check(shell.contents.navigation.reloads == 1 && shell.contents.navigation.lastCheckForRepost,
                            "dead-page button and reentrant menu share one repost-checking reload gate");
                    a.performMenuAction("刷新"); a.retryPageRestoring(); a.reconcilePageRestoring();
                    covered(a, shell, "saved-ready frame does not prematurely finish explicit retry");
                    check(shell.contents.navigation.reloads == 1, "button/menu repeated taps cannot replay a busy retry");
                    observer.didFirstVisuallyNonEmptyPaint();
                    observer.didStopLoading(new GURL(shell.contents.url), true);
                    covered(a, shell, "pre-navigation callbacks cannot complete retry");
                    NavigationHandle navigation = new NavigationHandle(shell.contents.url);
                    observer.didStartNavigationInPrimaryMainFrame(navigation);
                    observer.didStopLoading(new GURL(shell.contents.url), true);
                    covered(a, shell, "pre-commit load-stop cannot complete retry");
                    observer.didFinishNavigationInPrimaryMainFrame(navigation);
                    a.reconcilePageRestoring();
                    covered(a, shell, "committed navigation plus old isReady alone is not completion");
                    check(observer.retryNavigation == null && observer.retryCommitted,
                            "finished retry releases native handle but retains fresh commit proof");
                    observer.didStopLoading(new GURL("https://stale.invalid/old"), true);
                    observer.didStopLoading(new GURL(shell.contents.url), false);
                    covered(a, shell, "wrong-URL or unknown-validity load-stop cannot complete interrupted owner");
                    observer.didStopLoading(new GURL(shell.contents.url), true);
                    uncovered(a, "fresh committed URL-correct known-valid stop completes exact owner");
                    check(a.pageInterruption(shell) == null && !observer.awaitingPaint,
                            "genuine recovery retires interruption and permits fresh previews");

                    // Ordinary menu refresh on a known-dead saved-ready page must use the same busy path.
                    Activity menu = new Activity(true);
                    Shell target = menu.manager.active;
                    Activity.ShellHistoryObserver menuObserver = lose(menu, target);
                    menu.performMenuAction("刷新");
                    check(target.contents.navigation.reloads == 1 && menuObserver.retryBusy
                            && menu.restoreTimeout != null && menu.restoreRetry.visibility == View.GONE,
                            "actual menu refresh of known-dead page establishes bounded busy recovery");
                    NavigationHandle redirected = new NavigationHandle(target.contents.url);
                    menuObserver.didStartNavigationInPrimaryMainFrame(redirected);
                    redirected.url = "https://redirect.invalid/fresh"; target.contents.url = redirected.url;
                    menu.reconcilePageRestoring();
                    covered(menu, target, "expected retry redirect preserves exact navigation ownership");
                    menuObserver.didFinishNavigationInPrimaryMainFrame(redirected);
                    target.contents.renderer.ready = false;
                    menuObserver.didFirstVisuallyNonEmptyPaint();
                    covered(menu, target, "fresh paint without renderer readiness still waits");
                    target.contents.renderer.ready = true;
                    menuObserver.didFirstVisuallyNonEmptyPaint();
                    uncovered(menu, "fresh post-commit paint can also retire exact redirected interruption");
                }
                static void rendererRetryForegroundBudget() {
                    Activity a = new Activity(true);
                    Shell shell = a.manager.active;
                    Activity.ShellHistoryObserver observer = lose(a, shell);
                    a.retryPageRestoring();
                    Runnable beforePause = a.restoreTimeout;
                    a.browserFrame.advance(3000);
                    a.onPause();
                    check(observer.retryBusy && observer.retryDeadline == 0 && a.pageInterruption(shell) == observer,
                            "pause preserves duplicate-request gate and interruption but cancels UI deadline");
                    a.browserFrame.advance(20000); beforePause.run();
                    uncovered(a, "background beyond eight seconds cannot run cancelled feedback");
                    a.onResume(); a.main.all();
                    covered(a, shell, "retry foregrounding restores busy feedback on saved-ready page");
                    Runnable resumedTimeout = a.restoreTimeout;
                    check(a.splashSpinner.visibility == View.VISIBLE && a.restoreRetry.visibility == View.GONE
                            && a.browserFrame.deadline(resumedTimeout) == a.browserFrame.now + 8000
                            && shell.contents.navigation.reloads == 1,
                            "resume rearms full foreground budget without reissuing reload");
                    beforePause.run(); a.performMenuAction("刷新"); a.retryPageRestoring();
                    check(a.restoreTimeout == resumedTimeout && shell.contents.navigation.reloads == 1,
                            "old deadline and resumed taps cannot expire feedback or duplicate reload");
                    for (int i = 0; i < 4; i++) a.reconcilePageRestoring();
                    a.browserFrame.advance(7999);
                    check(a.restoreRetry.visibility == View.GONE && observer.retryBusy,
                            "retry remains gated until complete visible foreground budget");
                    a.browserFrame.advance(1);
                    covered(a, shell, "foreground retry timeout cannot uncover ready old frame");
                    check(a.restoreRetry.visibility == View.VISIBLE && a.splashSpinner.visibility == View.GONE
                            && !observer.retryBusy && shell.contents.navigation.reloads == 1,
                            "foreground budget expires to one honest action with no extra request");
                    for (int i = 0; i < 3; i++) a.reconcilePageRestoring();
                    check(a.restoreTimeout == null && a.restoreRetry.visibility == View.VISIBLE,
                            "ordinary refresh cannot rearm interrupted timed-out recovery forever");

                    // A retained inactive retry has the same cancel/rearm policy, not a cross-tab timer.
                    a.retryPageRestoring();
                    Runnable beforeSwitch = a.restoreTimeout;
                    Shell other = a.manager.retain("https://b.invalid/alive", true);
                    a.manager.selectShell(other); a.main.all();
                    uncovered(a, "pending retry cover is absent from other ready tab");
                    a.browserFrame.advance(9000); beforeSwitch.run();
                    uncovered(a, "old A retry deadline cannot cover or expire active B");
                    a.manager.selectShell(shell); a.main.all();
                    covered(a, shell, "reselected interrupted retry resumes its own busy feedback");
                    check(observer.retryBusy && a.browserFrame.deadline(a.restoreTimeout) == a.browserFrame.now + 8000
                            && shell.contents.navigation.reloads == 2,
                            "tab reentry rearms only the visible wait and never reloads again");
                }
                static void rendererBackgroundCompletionAndFailedRetry() {
                    Activity a = new Activity(true);
                    Shell shell = a.manager.active;
                    Activity.ShellHistoryObserver observer = lose(a, shell);
                    a.retryPageRestoring();
                    NavigationHandle navigation = new NavigationHandle(shell.contents.url);
                    observer.didStartNavigationInPrimaryMainFrame(navigation);
                    a.onPause();
                    observer.didFinishNavigationInPrimaryMainFrame(navigation);
                    observer.didStopLoading(new GURL(shell.contents.url), true);
                    check(a.pageInterruption(shell) == null, "genuine exact-owner completion may retire loss while backgrounded");
                    a.onResume(); a.main.all();
                    uncovered(a, "genuinely completed background retry does not show stale error on resume");
                    check(shell.contents.navigation.reloads == 1, "background completion adds no request");

                    observer = lose(a, shell); a.retryPageRestoring();
                    NavigationHandle failed = new NavigationHandle(shell.contents.url);
                    observer.didStartNavigationInPrimaryMainFrame(failed);
                    failed.error = true;
                    observer.didFinishNavigationInPrimaryMainFrame(failed);
                    observer.didFirstVisuallyNonEmptyPaint();
                    observer.didStopLoading(new GURL(shell.contents.url), true);
                    covered(a, shell, "error-page commit and paint cannot pretend interrupted document recovered");
                    check(!observer.retryBusy && !observer.retryCommitted && observer.retryNavigation == null
                            && a.restoreRetry.visibility == View.VISIBLE,
                            "failed retry releases handle and returns to actionable interruption without replay");
                    a.retryPageRestoring();
                    NavigationHandle aborted = new NavigationHandle(shell.contents.url);
                    observer.didStartNavigationInPrimaryMainFrame(aborted);
                    aborted.committed = false;
                    observer.didFinishNavigationInPrimaryMainFrame(aborted);
                    observer.didStopLoading(new GURL(shell.contents.url), true);
                    covered(a, shell, "uncommitted retry cannot retire interruption");
                    check(observer.retryNavigation == null && a.restoreRetry.visibility == View.VISIBLE
                            && shell.contents.navigation.reloads == 3,
                            "aborted retry remains explicit-action-only and never self-reloads");
                }
                static void rendererRedirectFailureAndBlankOwnership() {
                    Activity late = new Activity(true);
                    Shell lateOwner = late.manager.active;
                    Activity.ShellHistoryObserver lateObserver = lose(late, lateOwner);
                    late.retryPageRestoring();
                    NavigationHandle lateRedirect = new NavigationHandle(lateOwner.contents.url);
                    lateObserver.didStartNavigationInPrimaryMainFrame(lateRedirect);
                    lateRedirect.url = "https://redirect.invalid/pending-late";
                    lateOwner.contents.url = lateRedirect.url;
                    late.browserFrame.advance(9000); // Old-URL timeout is stale before chrome can rebind.
                    late.reconcilePageRestoring();
                    check(late.restoreRetry.visibility == View.VISIBLE && !lateObserver.retryBusy
                            && late.restoreTimeout == null && lateObserver.retryDeadline == 0,
                            "overdue same-owner URL rebind exposes an enabled action, not a sticky request gate");
                    late.performMenuAction("刷新");
                    check(lateOwner.contents.navigation.reloads == 2 && lateObserver.retryBusy,
                            "overdue redirected owner remains explicitly reloadable after missed stale deadline");

                    for (boolean error : List.of(false, true)) {
                        Activity a = new Activity(true);
                        Shell shell = a.manager.active;
                        String deadUrl = shell.contents.url;
                        Activity.ShellHistoryObserver observer = lose(a, shell);
                        a.performMenuAction("刷新");
                        NavigationHandle redirected = new NavigationHandle(deadUrl);
                        observer.didStartNavigationInPrimaryMainFrame(redirected);
                        a.browserFrame.advance(7000);
                        redirected.url = "https://redirect.invalid/failed";
                        shell.contents.url = redirected.url;
                        a.reconcilePageRestoring();
                        check(a.browserFrame.deadline(a.restoreTimeout) == 8000,
                                "pending redirect cannot renew original foreground retry budget " + error);
                        redirected.error = error; redirected.committed = error;
                        observer.didFinishNavigationInPrimaryMainFrame(redirected);
                        a.reconcilePageRestoring();
                        observer.didFirstVisuallyNonEmptyPaint();
                        observer.didStopLoading(new GURL(shell.contents.url), true);
                        covered(a, shell, "redirected error/abort retains original dead document interruption " + error);
                        check(a.pageInterruption(shell) == observer && observer.interruptedUrl.equals(deadUrl)
                                && observer.retryNavigation == null && !observer.retryCommitted && !observer.retryBusy
                                && a.restoreRetry.visibility == View.VISIBLE,
                                "redirected failure releases handle but remains actionable and never saved-ready " + error);
                        a.performMenuAction("刷新");
                        check(shell.contents.navigation.reloads == 2 && observer.retryBusy,
                                "redirected failed recovery can explicitly retry current visible target " + error);
                    }

                    Activity blank = new Activity(true);
                    Shell webBlank = blank.manager.active;
                    webBlank.contents.url = webBlank.contents.lastCommittedUrl = "about:blank";
                    Activity.ShellHistoryObserver observer = lose(blank, webBlank);
                    covered(blank, webBlank, "web-created plain about:blank renderer loss is an actual interruption");
                    blank.performMenuAction("刷新"); blank.performMenuAction("刷新"); blank.retryPageRestoring();
                    check(webBlank.contents.navigation.reloads == 1 && observer.retryBusy
                            && blank.restoreTimeout != null && blank.restoreRetry.visibility == View.GONE,
                            "unowned web blank has working guarded explicit reload, not sticky busy without request");
                    blank.browserFrame.advance(8000);
                    check(blank.restoreRetry.visibility == View.VISIBLE && !observer.retryBusy,
                            "web blank reload remains bounded without promising document.write reconstruction");

                    Activity ntp = new Activity(true);
                    Shell owned = ntp.manager.active;
                    owned.contents.url = owned.contents.lastCommittedUrl = "about:blank#abs-new-tab-owned";
                    ntp.newTabUrls.put(owned, owned.contents.url);
                    Activity.ShellHistoryObserver nativeObserver = lose(ntp, owned);
                    ntp.reconcilePageRestoring();
                    uncovered(ntp, "browser-owned native new-tab overlay stays usable after blank renderer loss");
                    check(ntp.pageInterruption(owned) == null && nativeObserver.interruptedUrl == null
                            && !nativeObserver.retryBusy, "native NTP ownership does not retain sticky renderer interruption");
                    ntp.performMenuAction("刷新");
                    uncovered(ntp, "native NTP menu refresh does not spuriously cover its native UI");
                    check(owned.contents.navigation.reloads == 1 && !nativeObserver.retryBusy,
                            "native owned blank preserves ordinary menu reload without dead-page gate");
                }
                static void rendererDeathDuringPendingNativeNavigation() {
                    for (boolean repeated : List.of(false, true)) {
                        Activity a = new Activity(true);
                        Shell shell = a.manager.active;
                        String deadDocument = shell.contents.lastCommittedUrl;
                        String nativeEntry = "about:blank#abs-new-tab-earlier-owned-entry";
                        a.newTabUrls.put(shell, nativeEntry);
                        Activity.ShellHistoryObserver observer = a.historyObservers.get(shell);
                        if (repeated) {
                            observer = lose(a, shell);
                            a.performMenuAction("刷新");
                            check(observer.retryBusy, "first real loss has an active retry before second death");
                        }
                        NavigationHandle pendingNative = new NavigationHandle(nativeEntry);
                        observer.didStartNavigationInPrimaryMainFrame(pendingNative);
                        shell.contents.url = nativeEntry;
                        int requests = shell.contents.navigation.reloads;
                        Activity.ShellHistoryObserver delivered = lose(a, shell);
                        check(delivered == observer && shell.contents.renderer.ready
                                && a.pageInterruption(shell) == observer
                                && observer.interruptedUrl.equals(deadDocument)
                                && shell.contents.lastCommittedUrl.equals(deadDocument),
                                "actual loss during pending owned-native URL retains committed web interruption " + repeated);
                        check(!observer.retryBusy && !observer.retryCommitted && observer.retryNavigation == null
                                && shell.contents.navigation.reloads == requests,
                                "first/repeated loss invalidates retry proof without silently replaying requests " + repeated);
                        pendingNative.committed = false;
                        shell.contents.url = deadDocument;
                        observer.didFinishNavigationInPrimaryMainFrame(pendingNative);
                        a.reconcilePageRestoring();
                        observer.didFirstVisuallyNonEmptyPaint();
                        observer.didStopLoading(new GURL(deadDocument), true);
                        covered(a, shell, "aborting pending native entry cannot reveal saved-ready dead web document " + repeated);
                        check(a.restoreRetry.visibility == View.VISIBLE && !observer.retryBusy,
                                "dead web document retains enabled explicit recovery after native-entry abort " + repeated);
                        a.performMenuAction("刷新"); a.performMenuAction("刷新"); a.retryPageRestoring();
                        check(shell.contents.navigation.reloads == requests + 1 && observer.retryBusy,
                                "first/repeated pending-native loss is explicitly reloadable exactly once " + repeated);
                    }
                }
                static void rendererFreshReplacementRouterCompletion() {
                    for (boolean paint : List.of(false, true)) {
                        Activity a = new Activity(true);
                        Shell shell = a.manager.active;
                        Activity.ShellHistoryObserver observer = lose(a, shell);
                        String deadUrl = shell.contents.url;
                        a.performMenuAction("刷新");
                        NavigationHandle replacement = new NavigationHandle(deadUrl);
                        observer.didStartNavigationInPrimaryMainFrame(replacement);
                        replacement.url = "https://router.invalid/fresh-document";
                        shell.contents.url = shell.contents.lastCommittedUrl = replacement.url;
                        observer.didFinishNavigationInPrimaryMainFrame(replacement);
                        check(observer.retryCommitted && observer.interruptedUrl.equals(replacement.url),
                                "fresh cross-document replacement has proof before router, but no completion " + paint);
                        long serial = observer.navigationSerial;
                        NavigationHandle router = new NavigationHandle(replacement.url + "/route");
                        router.sameDocument = true;
                        observer.didStartNavigationInPrimaryMainFrame(router);
                        shell.contents.url = router.url;
                        a.reconcilePageRestoring();
                        observer.didStopLoading(new GURL(router.url), true);
                        covered(a, shell, "pending router URL is not yet a committed completion target " + paint);
                        NavigationHandle staleRouter = new NavigationHandle(replacement.url + "/stale");
                        staleRouter.sameDocument = true;
                        observer.didFinishNavigationInPrimaryMainFrame(staleRouter);
                        check(observer.interruptedUrl.equals(replacement.url),
                                "stale same-document finish cannot follow a different current router URL " + paint);
                        shell.contents.lastCommittedUrl = router.url;
                        observer.didFinishNavigationInPrimaryMainFrame(router);
                        check(observer.retryCommitted && observer.navigationSerial == serial
                                && observer.interruptedNavigation == serial && observer.interruptedUrl.equals(router.url),
                                "fresh committed replacement proof follows its successful same-document router URL " + paint);
                        observer.didStopLoading(new GURL(replacement.url), true);
                        covered(a, shell, "pre-router load-stop cannot complete current replacement route " + paint);
                        if (paint) observer.didFirstVisuallyNonEmptyPaint();
                        else observer.didStopLoading(new GURL(router.url), true);
                        uncovered(a, "fresh replacement plus committed router finishes from current paint/valid-stop " + paint);
                        check(a.pageInterruption(shell) == null && !observer.awaitingPaint
                                && shell.contents.navigation.reloads == 1,
                                "router completion retires exact owner without another cross-document request " + paint);
                    }
                }
                static void rendererNavigationAndOwnerPruning() {
                    Activity a = new Activity(true);
                    Shell shell = a.manager.active;
                    Activity.ShellHistoryObserver observer = lose(a, shell);
                    a.retryPageRestoring();
                    NavigationHandle oldAttempt = new NavigationHandle(shell.contents.url);
                    observer.didStartNavigationInPrimaryMainFrame(oldAttempt);
                    a.browserFrame.advance(8000); a.retryPageRestoring();
                    Runnable renewed = a.restoreTimeout;
                    observer.didFinishNavigationInPrimaryMainFrame(oldAttempt);
                    observer.didStopLoading(new GURL(shell.contents.url), true);
                    covered(a, shell, "finished old retry cannot complete renewed same-URL attempt");
                    check(!observer.retryCommitted && a.restoreTimeout == renewed,
                            "retry commit belongs to exact navigation handle, not URL alone");
                    NavigationHandle currentAttempt = new NavigationHandle(shell.contents.url);
                    observer.didStartNavigationInPrimaryMainFrame(currentAttempt);
                    observer.didFinishNavigationInPrimaryMainFrame(currentAttempt);
                    observer.didFirstVisuallyNonEmptyPaint();
                    uncovered(a, "renewed attempt completes only from its genuine navigation");

                    observer = lose(a, shell);
                    String interruptedUrl = shell.contents.url;
                    NavigationHandle sameUrlNewDocument = new NavigationHandle(interruptedUrl);
                    observer.didStartNavigationInPrimaryMainFrame(sameUrlNewDocument);
                    a.reconcilePageRestoring();
                    observer.didFirstVisuallyNonEmptyPaint();
                    observer.didStopLoading(new GURL(interruptedUrl), true);
                    covered(a, shell, "same-URL navigation start is not proof of a replacement document");
                    sameUrlNewDocument.committed = false;
                    observer.didFinishNavigationInPrimaryMainFrame(sameUrlNewDocument);
                    check(a.pageInterruption(shell) == observer && !observer.retryCommitted,
                            "aborted same-URL navigation retains dead document interruption");

                    NavigationHandle sameDocument = new NavigationHandle(interruptedUrl + "#fragment");
                    sameDocument.sameDocument = true;
                    shell.contents.url = sameDocument.url;
                    observer.didStartNavigationInPrimaryMainFrame(sameDocument);
                    observer.didFinishNavigationInPrimaryMainFrame(sameDocument);
                    a.reconcilePageRestoring();
                    observer.didFirstVisuallyNonEmptyPaint();
                    observer.didStopLoading(new GURL(shell.contents.url), true);
                    covered(a, shell, "same-document URL change plus stale paint/stop cannot retire renderer loss");
                    check(a.pageInterruption(shell) == observer && observer.interruptedUrl.equals(interruptedUrl),
                            "same-document change is not a fresh replacement commit");

                    shell.contents.url = "https://new.invalid/pending";
                    a.reconcilePageRestoring();
                    observer.didFirstVisuallyNonEmptyPaint();
                    observer.didStopLoading(new GURL(shell.contents.url), true);
                    covered(a, shell, "pending visible URL drift alone cannot discard dead document marker");
                    NavigationHandle pending = new NavigationHandle(shell.contents.url);
                    observer.didStartNavigationInPrimaryMainFrame(pending);
                    pending.committed = false;
                    observer.didFinishNavigationInPrimaryMainFrame(pending);
                    a.reconcilePageRestoring();
                    check(a.pageInterruption(shell) == observer && observer.retryNavigation == null,
                            "pending other-URL abort retains interruption and releases candidate handle");
                    covered(a, shell, "pending other-URL abort cannot uncover saved-ready dead frame");

                    String nativeEntry = "about:blank#abs-new-tab-earlier-entry";
                    a.newTabUrls.put(shell, nativeEntry);
                    NavigationHandle pendingNative = new NavigationHandle(nativeEntry);
                    observer.didStartNavigationInPrimaryMainFrame(pendingNative);
                    shell.contents.url = nativeEntry;
                    a.reconcilePageRestoring();
                    check(a.pageInterruption(shell) == observer,
                            "pending owned native-entry URL cannot prune an already interrupted web document");
                    pendingNative.committed = false;
                    shell.contents.url = interruptedUrl;
                    observer.didFinishNavigationInPrimaryMainFrame(pendingNative);
                    a.reconcilePageRestoring();
                    covered(a, shell, "aborted native-entry escape retains cover when original dead document returns");

                    int requestsBeforeEscape = shell.contents.navigation.reloads;
                    NavigationHandle escape = new NavigationHandle("https://new.invalid/real-document");
                    observer.didStartNavigationInPrimaryMainFrame(escape);
                    shell.contents.url = escape.url;
                    a.reconcilePageRestoring();
                    observer.didFinishNavigationInPrimaryMainFrame(escape);
                    observer.didStopLoading(new GURL(interruptedUrl), true);
                    covered(a, shell, "other-URL replacement still requires its own URL-correct completion");
                    observer.didStopLoading(new GURL(escape.url), true);
                    uncovered(a, "explicit successful other-URL navigation genuinely escapes dead document");
                    check(a.pageInterruption(shell) == null && shell.contents.navigation.reloads == requestsBeforeEscape,
                            "navigation escape adds no implicit reload or POST replay");

                    Activity replacement = new Activity(true);
                    Shell owned = replacement.manager.active;
                    Activity.ShellHistoryObserver old = lose(replacement, owned);
                    WebContents oldContents = owned.contents;
                    owned.contents = new WebContents(oldContents.url, true);
                    replacement.observeShell(owned); replacement.reconcilePageRestoring();
                    check(old.getWebContents() == null && old.interruptedUrl == null,
                            "contents replacement detaches old observer and clears marker");
                    Activity.ShellHistoryObserver current = lose(replacement, owned);
                    old.primaryMainFrameRenderProcessGone(1); old.didFirstVisuallyNonEmptyPaint();
                    old.didStopLoading(new GURL(oldContents.url), true); old.webContentsDestroyed();
                    covered(replacement, owned, "detached contents callbacks cannot clear replacement interruption");
                    check(replacement.pageInterruption(owned) == current, "old destroy cannot remove new observer map entry");
                    replacement.generation++; replacement.runtime.ownerGeneration++;
                    check(replacement.pageInterruption(owned) == null,
                            "generation mismatch prunes marker before replacing observer");
                    current.primaryMainFrameRenderProcessGone(1);
                    check(current.interruptedUrl == null,
                            "same map entry with stale immutable observer generation rejects late death");
                    replacement.observeShell(owned); replacement.reconcilePageRestoring();
                    current.primaryMainFrameRenderProcessGone(1);
                    uncovered(replacement, "previous runtime-generation death cannot mark current document");
                    check(current.interruptedUrl == null && current.getWebContents() == null,
                            "generation replacement retires old observer and interruption");

                    Activity close = new Activity(true);
                    Shell first = close.manager.active;
                    Shell survivor = close.manager.retain("https://b.invalid/survivor", true);
                    Activity.ShellHistoryObserver closed = lose(close, first);
                    close.manager.closeShell(first); close.main.all();
                    check(!close.historyObservers.containsKey(first) && closed.interruptedUrl == null
                            && closed.getWebContents() == null, "native close prunes and detaches observer-owned marker");
                    closed.primaryMainFrameRenderProcessGone(1); closed.didFirstVisuallyNonEmptyPaint();
                    closed.didStopLoading(new GURL(first.contents.url), true);
                    uncovered(close, "late closed-tab callbacks cannot cover ready survivor");
                    check(close.manager.active == survivor, "stale callbacks do not switch active owner");
                    Activity.ShellHistoryObserver destroyed = lose(close, survivor);
                    destroyed.webContentsDestroyed();
                    check(!close.historyObservers.containsKey(survivor) && destroyed.interruptedUrl == null,
                            "contents destruction immediately prunes durable interruption");
                    uncovered(close, "destroyed contents do not leave stale page cover");

                    for (boolean quiesce : List.of(false, true)) {
                        Activity exit = new Activity(true);
                        Shell target = exit.manager.active;
                        Activity.ShellHistoryObserver exiting = lose(exit, target);
                        if (quiesce) exit.quiescing = true; else exit.closed = true;
                        exit.cancelUiWork();
                        check(exiting.interruptedUrl == null, "runtime/Activity exit clears durable loss state " + quiesce);
                        exiting.primaryMainFrameRenderProcessGone(1);
                        uncovered(exit, "late exit callbacks cannot recreate interruption " + quiesce);
                    }
                }
                static void loadFeedbackPresentation() {
                    Activity a = new Activity(true);
                    a.progressBar.visibility = View.INVISIBLE;
                    a.progressBar.visibilityWrites = 0;
                    for (int i = 0; i < 20; i++) a.setLoadFeedbackVisible(false);
                    check(a.progressBar.visibility == View.INVISIBLE && a.progressBar.visibilityWrites == 0,
                            "unchanged load feedback retains its invisible slot without writes");
                    a.setLoadFeedbackVisible(true); a.setLoadFeedbackVisible(true);
                    check(a.progressBar.visibility == View.VISIBLE && a.progressBar.visibilityWrites == 1,
                            "changed loading presentation writes visible once");
                    a.cancelUiWork();
                    check(a.progressBar.visibility == View.INVISIBLE && a.progressBar.visibilityWrites == 2,
                            "UI cancellation stops loading feedback without removing its slot");
                    a.cancelUiWork();
                    check(a.progressBar.visibilityWrites == 2, "cancelled loading feedback stays idempotent");
                    a.setLoadFeedbackVisible(true); a.onPause(); a.onStop();
                    check(a.progressBar.visibility == View.INVISIBLE && a.progressBar.visibilityWrites == 4,
                            "pause plus stop retire loading animation with one hidden write");
                }
            """, """
                static void fullscreenPresented(Activity a, Shell shell, String label) {
                    check(a.fullscreenOwner == a.historyObservers.get(shell) && a.fullscreenOwner != null
                            && a.chromeBar.visibility == View.GONE && a.urlSuggest.visibility == View.GONE, label);
                }
                static void fullscreenCleared(Activity a, String label) {
                    check(a.fullscreenOwner == null && a.chromeBar.visibility == View.VISIBLE, label);
                }
                static void enterFullscreen(Activity a, Shell shell) {
                    shell.contents.nativeFullscreen = true;
                    shell.contents.signalFullscreen(true, true);
                    a.main.all();
                    fullscreenPresented(a, shell, "live selected native fullscreen owns ABS presentation");
                }
                static void fullscreenSignalsAndNavigation() {
                    Activity a = new Activity(true);
                    Shell shell = a.manager.active;
                    WebContents page = shell.contents;
                    int queries = page.fullscreenQueries;
                    a.urlSuggest.visibility = View.VISIBLE;
                    // Simulate Chromium settling its authoritative bit after observer notification.
                    for (int i = 0; i < 25; i++) page.signalFullscreen(false, i % 2 == 0);
                    check(a.main.queue.size() == 1 && a.fullscreenOwner == null && page.fullscreenQueries == queries,
                            "native signal burst coalesces without querying or changing window inline");
                    page.nativeFullscreen = true;
                    a.main.all();
                    fullscreenPresented(a, shell, "native bit wins over all false/resize callback arguments");
                    var observer = a.historyObservers.get(shell);
                    NavigationHandle router = new NavigationHandle(page.url + "#same-document");
                    router.sameDocument = true;
                    observer.didStartNavigationInPrimaryMainFrame(router);
                    page.url = router.url;
                    observer.didFinishNavigationInPrimaryMainFrame(router);
                    a.main.all();
                    fullscreenPresented(a, shell, "same-document router never synthesizes fullscreen exit");
                    check(page.fullscreenExits == 0, "same-document navigation does not call exit JNI");
                    // Chromium pre-commit clears native fullscreen before cross-document commit.
                    NavigationHandle replacement = new NavigationHandle("https://a.invalid/replacement");
                    observer.didStartNavigationInPrimaryMainFrame(replacement);
                    page.nativeFullscreen = false;
                    page.signalFullscreen(true, false);
                    page.url = replacement.url;
                    observer.didFinishNavigationInPrimaryMainFrame(replacement);
                    a.main.all();
                    fullscreenCleared(a, "cross-document native exit wins over true callback argument");
                    check(page.fullscreenExits == 0, "cross-document exit is owned by Chromium");
                    enterFullscreen(a, shell);
                    page.nativeFullscreen = false;
                    page.signalFullscreen(false, true);
                    observer.primaryMainFrameRenderProcessGone(1);
                    a.main.all();
                    fullscreenCleared(a, "renderer death restores chrome through native exit signal");
                    check(page.fullscreenExits == 0 && a.restoreSplashShown,
                            "renderer death remains Chromium-owned and retains existing recovery cover");
                    Activity transientSignal = new Activity(true);
                    var transientPage = transientSignal.manager.active.contents;
                    transientPage.nativeFullscreen = true;
                    transientPage.signalFullscreen(true, false);
                    transientPage.nativeFullscreen = false;
                    transientPage.signalFullscreen(false, false);
                    transientSignal.main.all();
                    fullscreenCleared(transientSignal, "enter then native exit before delivery does not flash chrome");
                    check(transientSignal.chromeBar.visibilityWrites == 0, "coalesced native enter/exit has no UI transition");
                }
                static void fullscreenIdentityAndSwitch() {
                    Activity a = new Activity(true);
                    Shell first = a.manager.active;
                    Shell second = a.manager.retain("https://b.invalid/", true);
                    enterFullscreen(a, first);
                    var oldObserver = a.historyObservers.get(first);
                    a.manager.selectShell(second);
                    check(first.contents.fullscreenExits == 0, "Shell removal never exits JNI inline");
                    second.contents.nativeFullscreen = true;
                    second.contents.signalFullscreen(true, false);
                    a.main.all();
                    fullscreenPresented(a, second, "deferred exit of previous owner does not clear new selected owner");
                    check(first.contents.fullscreenExits == 1 && second.contents.fullscreenExits == 0,
                            "tab switch exits only the detached exact WebContents once");
                    oldObserver.didToggleFullscreenModeForTab(false, false);
                    a.main.all();
                    fullscreenPresented(a, second, "retained inactive callback cannot restore bars on current owner");
                    a.manager.selectShell(first); a.main.all();
                    fullscreenCleared(a, "reselection does not silently revive old fullscreen");
                    enterFullscreen(a, first);
                    a.manager.selectShell(second); a.manager.selectShell(first); a.main.all();
                    fullscreenCleared(a, "detach/reattach before delivery still revokes fullscreen");
                    check(first.contents.fullscreenExits == 2, "rapid detach exits fullscreen on the original owner");
                    Activity replaced = new Activity(true);
                    Shell reused = replaced.manager.active;
                    WebContents old = reused.contents;
                    var retired = replaced.historyObservers.get(reused);
                    old.nativeFullscreen = true; old.signalFullscreen(true, false);
                    reused.contents = new WebContents("https://replacement.invalid/", true);
                    replaced.observeShell(reused);
                    reused.contents.nativeFullscreen = true; // No signal from this new document yet.
                    replaced.main.all();
                    fullscreenCleared(replaced, "queued retired signal cannot promote replacement contents");
                    check(old.fullscreenExits == 0 && reused.contents.fullscreenQueries == 0,
                            "retired signal must not query or exit replacement contents");
                    enterFullscreen(replaced, reused);
                    retired.didToggleFullscreenModeForTab(false, true);
                    replaced.main.all();
                    fullscreenPresented(replaced, reused, "late replaced observer cannot affect newer ownership");
                    reused.contents.destroyed = true;
                    var destroyed = replaced.historyObservers.get(reused);
                    destroyed.webContentsDestroyed();
                    destroyed.didToggleFullscreenModeForTab(true, true);
                    replaced.main.all();
                    fullscreenCleared(replaced, "destroyed contents clean presentation without any dead JNI query");
                    Activity obsolete = new Activity(true);
                    WebContents stale = obsolete.manager.active.contents;
                    stale.nativeFullscreen = true; stale.signalFullscreen(true, false);
                    obsolete.runtime.valid = false;
                    obsolete.main.all();
                    fullscreenCleared(obsolete, "superseded Activity generation ignores posted enter signal");
                    check(stale.fullscreenQueries == 0 && stale.fullscreenExits == 0,
                            "superseded Activity work does not query or exit outside quiesce");
                }
                static void fullscreenOverlaysAndFocus() {
                    for (int blocked = 0; blocked < 7; blocked++) {
                        Activity a = new Activity(true);
                        Shell shell = a.manager.active;
                        switch (blocked) {
                            case 0 -> a.historyPanel.visibility = View.VISIBLE;
                            case 1 -> a.tabSwitcher.showing = true;
                            case 2 -> a.newTab.visibility = View.VISIBLE;
                            case 3 -> a.overflowMenu = new PopupWindow();
                            case 4 -> a.beginPageRestoring(shell, true);
                            case 5 -> a.onPause();
                            default -> a.uiBuilt = false;
                        }
                        shell.contents.nativeFullscreen = true;
                        shell.contents.signalFullscreen(true, false);
                        check(shell.contents.fullscreenExits == 0, "covered request never exits JNI on observer stack " + blocked);
                        a.main.all();
                        fullscreenCleared(a, "not interactive/foreground or covered: no immersive entry " + blocked);
                        check(shell.contents.fullscreenExits == 1 && a.chromeBar.visibilityWrites == 0,
                                "rejected native fullscreen is exited once without hiding chrome " + blocked);
                    }
                    Activity a = new Activity(true);
                    Shell shell = a.manager.active;
                    shell.contents.nativeFullscreen = true; shell.contents.signalFullscreen(true, true);
                    // Overlay opens and dismisses before posted enter: rejection must stick.
                    a.tabSwitcher.showing = true; a.syncWebContentsVisibility();
                    a.tabSwitcher.showing = false; a.syncWebContentsVisibility();
                    a.main.all();
                    fullscreenCleared(a, "covered pending enter cannot resume when overview dismisses");
                    check(shell.contents.fullscreenExits == 1 && a.chromeBar.visibilityWrites == 0,
                            "overview interval rejects pending entry without hiding chrome");
                    enterFullscreen(a, shell);
                    a.historyPanel.visibility = View.VISIBLE; a.syncWebContentsVisibility();
                    a.main.all();
                    fullscreenCleared(a, "browser overlay revokes a presented owner");
                    check(shell.contents.fullscreenExits == 2, "cover exit targets the installed live owner");
                }
                static void fullscreenWaitsForWindowFocus() {
                    for (int order = 0; order < 3; order++) {
                        Activity a = new Activity(true);
                        Shell shell = a.manager.active;
                        WebContents page = shell.contents;
                        if (order != 1) a.onWindowFocusChanged(false);
                        page.nativeFullscreen = true; page.signalFullscreen(true, true);
                        if (order == 1) a.onWindowFocusChanged(false);
                        if (order == 2) a.onWindowFocusChanged(true);
                        a.main.all();
                        check(page.nativeFullscreen && page.fullscreenExits == 0,
                                "temporary focus loss never revokes granted native fullscreen " + order);
                        if (order != 2) {
                            fullscreenCleared(a, "waiting for focus keeps chrome visible " + order);
                            check(a.main.queue.isEmpty(), "pending fullscreen does not poll");
                            a.onWindowFocusChanged(true); a.main.all();
                        }
                        fullscreenPresented(a, shell, "focus return presents the exact still-granted page " + order);
                        check(a.chromeBar.visibilityWrites == 1, "fullscreen presents exactly once");
                    }
                    for (String revoke : List.of("native exit", "Back", "cover", "switch", "pause")) {
                        Activity a = new Activity(true);
                        Shell shell = a.manager.active;
                        WebContents page = shell.contents;
                        a.onWindowFocusChanged(false);
                        page.nativeFullscreen = true; page.signalFullscreen(true, true);
                        a.main.all();
                        switch (revoke) {
                            case "native exit" -> page.exitFullscreen();
                            case "Back" -> a.onBackPressed();
                            case "cover" -> {
                                a.tabSwitcher.showing = true; a.syncWebContentsVisibility();
                                a.tabSwitcher.showing = false; a.syncWebContentsVisibility();
                            }
                            case "switch" -> {
                                Shell other = a.manager.retain("https://other.invalid/", true);
                                a.manager.selectShell(other);
                                a.manager.selectShell(shell);
                            }
                            case "pause" -> { a.onPause(); a.onResume(); }
                            default -> throw new AssertionError(revoke);
                        }
                        a.onWindowFocusChanged(true); a.main.all();
                        fullscreenCleared(a, revoke + " revokes a pending owner even if focus returns");
                        check(page.fullscreenExits == 1 && !page.nativeFullscreen && a.chromeBar.visibilityWrites == 0,
                                revoke + " leaves no fullscreen to present");
                    }
                }

                static void fullscreenBackAndLifecycle() {
                    for (int route = 0; route < 3; route++) {
                        Activity a = new Activity(true);
                        Shell shell = a.manager.active;
                        WebContents page = shell.contents;
                        page.navigation.hasBack = route == 0;
                        if (route == 1) a.manager.retain("https://b.invalid/", true);
                        // Back also handles entry already native but not yet presented by ABS.
                        page.nativeFullscreen = true; page.signalFullscreen(true, false);
                        if (route != 0) a.main.all();
                        a.onBackPressed(); a.main.all();
                        fullscreenCleared(a, "Back exits immersive presentation before any browser action " + route);
                        check(page.fullscreenExits == 1 && page.navigation.backCalls == 0
                                && a.manager.active == shell && a.returns == 0, "first Back is consumed by native fullscreen " + route);
                        a.onBackPressed();
                        check(route == 0 ? page.navigation.backCalls == 1
                                : route == 1 ? a.manager.active != shell : a.returns == 1,
                                "second Back resumes ordinary navigation/tab/list handling " + route);
                    }
                    for (int route = 0; route < 4; route++) {
                        Activity a = new Activity(true);
                        Shell shell = a.manager.active;
                        enterFullscreen(a, shell);
                        // Native runtime revokes isCurrent before shutdown quiescence.
                        if (route >= 2) a.runtime.valid = false;
                        switch (route) {
                            case 0 -> a.onPause();
                            case 1 -> a.onStop();
                            case 2 -> a.quiesceForShutdown();
                            default -> a.onDestroy();
                        }
                        fullscreenCleared(a, "lifecycle departure restores normal chrome promptly " + route);
                        check(shell.contents.fullscreenExits == 1 && a.main.queue.isEmpty()
                                && a.fullscreenExits.isEmpty() && a.fullscreenSignal == null,
                                "lifecycle departure exits exactly once and cancels pending fullscreen work " + route);
                        if (route < 2) {
                            a.onResume(); a.main.all();
                            fullscreenCleared(a, "resume does not restore a revoked owner " + route);
                        } else {
                            check(shell.contents.stops == 1 && (route == 2 ? !shell.destroyed : a.cleanupComplete && shell.destroyed),
                                    "quiesce exits/stops before destruction; onDestroy closes only afterward " + route);
                        }
                    }
                }
                static void fullscreenWindowAndInsets() {
                    int stable = View.SYSTEM_UI_FLAG_LAYOUT_STABLE, unrelated = 0x4000;
                    int legacy = View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
                    for (int sdk : new int[]{29, 30, 35, 36}) {
                        android.os.Build.VERSION.SDK_INT = sdk;
                        boolean modern = sdk >= 30;
                        Activity a = new Activity(true);
                        Window window = a.activityWindow;
                        WindowInsetsController bars = window.controller;
                        window.decor.flags = stable | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                        WindowInsets original = new WindowInsets();
                        check(a.browserFrame.onApplyWindowInsets(original) == original, "normal insets unmodified " + sdk);
                        Shell shell = a.manager.active;
                        enterFullscreen(a, shell);
                        check(a.browserFrame.insetsRequests == 1 && (window.decor.flags & stable) == stable,
                                "fullscreen requests inset traversal and preserves stable flag " + sdk);
                        check(modern ? !window.fits && bars.hiddenTypes == 3 && bars.hideCalls == 1
                                        && bars.behavior == WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                                : window.controllerReads == 0 && (window.decor.flags & legacy) == legacy,
                                "API-specific fullscreen layout and transient bar behavior " + sdk);
                        WindowInsets barsOnly = new WindowInsets();
                        barsOnly.ime = Insets.NONE; barsOnly.cutout = Insets.NONE;
                        WindowInsets immersive = a.browserFrame.onApplyWindowInsets(barsOnly);
                        check(immersive.current.empty() && immersive.stable.empty() && !barsOnly.stable.empty()
                                && a.browserFrame.padding.empty(),
                                "only fullscreen clears both current and stable bar gutters " + sdk);
                        if (!modern) original.current = Insets.of(0, 24, 35, 250);
                        WindowInsets withKeyboard = a.browserFrame.onApplyWindowInsets(original);
                        check(a.browserFrame.padding.bottom == 250 && a.browserFrame.padding.right == 0
                                && a.browserFrame.padding.left == 0 && a.browserFrame.padding.top == 0,
                                "fullscreen fits the IME only; bar and cutout gutters are cleared " + sdk);
                        check(withKeyboard.current.empty() && withKeyboard.stable.empty() && withKeyboard.ime.empty()
                                && withKeyboard.cutout.left == (modern ? 0 : 17)
                                && withKeyboard.gesture.left == 29
                                && original.ime.bottom == 250 && original.cutout.left == 17,
                                "fitted geometry is not double-applied; cutout and gestures dispatch unmodified " + sdk);
                        window.decor.flags ^= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                        window.decor.flags |= unrelated | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                        a.onWindowFocusChanged(false); a.onWindowFocusChanged(true); a.main.all();
                        fullscreenPresented(a, shell, "dialog focus churn does not exit fullscreen " + sdk);
                        check(a.browserFrame.insetsRequests == 1 && bars.hideCalls == (modern ? 1 : 0),
                                "focus churn does not re-hide transient bars or request relayout " + sdk);
                        a.onBackPressed(); a.main.all();
                        check(window.fits && window.decor.flags == (stable | unrelated | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR)
                                && a.browserFrame.insetsRequests == 2 && (modern ? bars.hiddenTypes == 0
                                        && bars.showCalls == 1 && bars.behavior == 1 : window.controllerReads == 0),
                                "exit restores normal fitting/flags/behavior without undoing palette changes " + sdk);
                        check(a.browserFrame.onApplyWindowInsets(original) == original
                                && a.browserFrame.padding == original.current,
                                "normal inset forwarding and IME geometry resume unchanged " + sdk);
                    }
                    android.os.Build.VERSION.SDK_INT = 29;
                }
            """, """
                private static final String INSTALL = "安装网页应用";
                private static final String BROWSER_FULLSCREEN = "全屏浏览";
                private static final NativePwaBridge.InstallManifest MANIFEST = new NativePwaBridge.InstallManifest(
                        "https://a.invalid/app-id", "Reference app", "https://a.invalid/page/start",
                        "https://a.invalid/", "https://a.invalid");

                static PopupWindow openOverflow(Activity a, Runnable beforeDismiss) {
                    View anchor = new View();
                    PopupWindow popup = new PopupWindow();
                    a.overflowMenu = popup;
                    popup.onDismiss = () -> {
                        beforeDismiss.run();
                        a.dismissOverflowFromListener(popup, anchor, null);
                    };
                    return popup;
                }

                static void queueBrowserFullscreen(Activity a) {
                    Activity.ShellHistoryObserver owner = a.historyObservers.get(a.manager.active);
                    a.onWindowFocusChanged(false);
                    PopupWindow popup = openOverflow(a, () -> check(a.browserFullscreenRequest == owner,
                            "browser fullscreen captures its exact page before dismissing its popup"));
                    a.clickOverflowAction(popup, owner, owner.webAppPageEpoch, BROWSER_FULLSCREEN, new View());
                    check(popup.dismisses == 1 && a.overflowMenu == null && a.fullscreenOwner == null,
                            "menu click dismisses once and never mutates the window inline");
                    a.main.all();
                    fullscreenCleared(a, "closed popup still waits for Activity focus");
                    check(a.browserFullscreenRequest == owner && a.main.queue.isEmpty(),
                            "browser fullscreen waits without polling or forcing focus");
                }

                static void browserFullscreenFromOverflow() {
                    Activity a = new Activity(true);
                    Shell shell = a.manager.active;
                    WebContents page = shell.contents;
                    page.navigation.hasBack = true;
                    queueBrowserFullscreen(a);
                    a.onWindowFocusChanged(true);
                    fullscreenCleared(a, "Activity focus does not present fullscreen on its own stack");
                    a.main.all();
                    fullscreenPresented(a, shell, "Activity focus presents the queued menu action");
                    check(a.browserFullscreen && !page.nativeFullscreen && page.fullscreenExits == 0,
                            "browser fullscreen changes only native chrome and leaves DOM fullscreen unset");
                    a.onWindowFocusChanged(false); a.main.all();
                    fullscreenPresented(a, shell, "temporary blur preserves browser-owned fullscreen");
                    a.onWindowFocusChanged(true); a.main.all();
                    a.onBackPressed(); a.main.all();
                    fullscreenCleared(a, "Back restores native chrome from browser fullscreen");
                    check(page.navigation.backCalls == 0 && page.fullscreenExits == 0 && a.manager.active == shell,
                            "browser fullscreen consumes one Back without history or a DOM exit");
                    a.onBackPressed(); a.main.all();
                    check(page.navigation.backCalls == 1, "a later Back uses history normally");

                    queueBrowserFullscreen(a);
                    a.onWindowFocusChanged(true); a.main.all();
                    int chromeWrites = a.chromeBar.visibilityWrites;
                    page.nativeFullscreen = true; page.signalFullscreen(true, false); a.main.all();
                    fullscreenPresented(a, shell, "native video or DOM fullscreen takes over without a window flash");
                    check(!a.browserFullscreen && a.chromeBar.visibilityWrites == chromeWrites,
                            "takeover does not show and hide chrome again");
                    a.onBackPressed(); a.main.all();
                    fullscreenCleared(a, "Back routes a taken-over window through the actual native fullscreen exit");
                    check(page.fullscreenExits == 1 && page.navigation.backCalls == 1,
                            "native takeover consumes one Back without a second history traversal");
                }

                static void browserFullscreenCannotReplayStaleMenuOrRequest() {
                    for (String action : List.of(BROWSER_FULLSCREEN, INSTALL)) {
                        Activity a = new Activity(true);
                        Shell shell = a.manager.active;
                        Activity.ShellHistoryObserver owner = a.historyObservers.get(shell);
                        long oldEpoch = owner.webAppPageEpoch;
                        a.onWindowFocusChanged(false);
                        PopupWindow popup = openOverflow(a, () -> { });
                        owner.didStartNavigationInPrimaryMainFrame(new NavigationHandle(shell.contents.url));
                        a.clickOverflowAction(popup, owner, oldEpoch, action, new View());
                        a.onWindowFocusChanged(true); a.main.all();
                        check(popup.dismisses == 1 && a.browserFullscreenRequest == null && a.fullscreenOwner == null
                                && a.webAppInstall == null && shell.contents.manifests.isEmpty(),
                                "stale popup cannot bind even a same-URL replacement: " + action);
                    }
                    for (String revoke : List.of("Back", "navigation", "security", "visibility", "cover", "switch", "pause")) {
                        Activity a = new Activity(true);
                        Shell shell = a.manager.active;
                        Activity.ShellHistoryObserver owner = a.historyObservers.get(shell);
                        shell.contents.navigation.hasBack = true;
                        queueBrowserFullscreen(a);
                        switch (revoke) {
                            case "Back" -> a.onBackPressed();
                            case "navigation" -> owner.didStartNavigationInPrimaryMainFrame(new NavigationHandle(shell.contents.url));
                            case "security" -> owner.didChangeVisibleSecurityState();
                            case "visibility" -> {
                                shell.contents.updateWebContentsVisibility(Visibility.HIDDEN);
                                shell.contents.updateWebContentsVisibility(Visibility.VISIBLE);
                            }
                            case "cover" -> {
                                a.tabSwitcher.showing = true; a.syncWebContentsVisibility();
                                a.tabSwitcher.showing = false; a.syncWebContentsVisibility();
                            }
                            case "switch" -> {
                                Shell other = a.manager.retain("https://other.invalid/", true);
                                a.manager.selectShell(other);
                                a.manager.selectShell(shell);
                            }
                            case "pause" -> { a.onPause(); a.onResume(); }
                            default -> throw new AssertionError(revoke);
                        }
                        a.onWindowFocusChanged(true); a.main.all();
                        fullscreenCleared(a, revoke + " permanently retires the posted menu fullscreen action");
                        check(a.browserFullscreenRequest == null && shell.contents.fullscreenExits == 0
                                && shell.contents.navigation.backCalls == 0,
                                revoke + " cannot replay fullscreen or traverse history");
                    }
                }

                static WebContents beginInstallFromPopup(Activity a) {
                    // The popup, not the Activity, owns focus when the real click listener runs.
                    Shell selected = a.manager.active;
                    WebContents page = selected.contents;
                    a.onWindowFocusChanged(false);
                    PopupWindow popup = openOverflow(a, () -> check(a.webAppInstall != null
                                    && a.webAppInstall.owner == a.historyObservers.get(selected),
                            "install click captures the exact selected page before dismissing its popup"));
                    Activity.ShellHistoryObserver owner = a.historyObservers.get(selected);
                    long epoch = owner.webAppPageEpoch;
                    View item = new View();
                    item.windowFocus = false;
                    a.clickOverflowAction(popup, owner, epoch, INSTALL, item);
                    check(popup.dismisses == 0 && a.webAppInstall == null, "unfocused menu item cannot start install");
                    item.windowFocus = true;
                    a.clickOverflowAction(popup, owner, epoch, INSTALL, item);
                    check(popup.dismisses == 1 && a.overflowMenu == null && page.manifests.isEmpty(),
                            "focused menu click dismisses once and does not call Chromium inline");
                    a.main.all();
                    check(page.manifests.isEmpty() && a.main.queue.isEmpty(), "install waits for Activity focus without polling");
                    a.onWindowFocusChanged(true);
                    check(page.manifests.isEmpty(), "focus return defers manifest access to the posted pass");
                    a.main.all();
                    check(page.manifests.size() == 1, "focus return starts exactly one manifest request");
                    return page;
                }

                static void deliverManifest(Activity a, WebContents page, int request, NativePwaBridge.InstallManifest result) {
                    // Model the asynchronous Chromium callback on the Activity's UI thread.
                    a.main.post(() -> page.manifests.get(request).onResult(result));
                    a.main.all();
                }

                static Ui.Sheet requestInstallConfirmation(Activity a, WebContents page) {
                    deliverManifest(a, page, 0, MANIFEST);
                    Ui.Sheet sheet = a.consent;
                    check(sheet != null && sheet.dialog.isShowing() && a.pinRequests.isEmpty()
                            && a.registered.isEmpty(), "first manifest offers consent without registration or a pin request");
                    check(sheet.lines.contains(MANIFEST.name) && MANIFEST.origin.equals(sheet.origin.getText()),
                            "consent shows the label with a separate origin");
                    a.onWindowFocusChanged(false);
                    check(sheet.dialog.isShowing(), "Activity focus loss to the consent window does not cancel it");
                    Runnable confirm = sheet.confirm;
                    View decor = sheet.dialog.getWindow().getDecorView();
                    decor.dispatchWindowFocus(false);
                    confirm.run(); a.main.all();
                    check(page.manifests.size() == 1, "unfocused consent cannot request confirmation");
                    decor.dispatchWindowFocus(true);
                    confirm.run(); confirm.run();
                    check(page.manifests.size() == 1 && sheet.confirm == null,
                            "confirmation schedules rather than touches Chromium from the click");
                    a.main.all();
                    check(page.manifests.size() == 2 && sheet.confirm == null,
                            "consent's own focus authorizes exactly one confirmation while the Activity lacks focus");
                    return sheet;
                }

                static void installConsentRequiresFreshManifest() {
                    Activity a = new Activity(true);
                    WebContents page = beginInstallFromPopup(a);
                    a.onWindowFocusChanged(true); a.main.all();
                    check(page.manifests.size() == 1 && a.main.queue.isEmpty(), "another posted refresh cannot repeat manifest access");
                    Ui.Sheet sheet = requestInstallConfirmation(a, page);
                    // Distinct JNI results can agree by value.
                    deliverManifest(a, page, 1, new NativePwaBridge.InstallManifest(
                            MANIFEST.id, MANIFEST.name, MANIFEST.startUrl, MANIFEST.scope, MANIFEST.origin));
                    check(a.registered.size() == 1 && a.pinRequests.equals(a.registered),
                            "confirmed identical manifest registers and requests exactly one pin");
                    WebApp saved = a.registered.get(0);
                    check(saved.profileId.equals(PROFILE_ID) && saved.manifestId.equals(MANIFEST.id)
                            && saved.name.equals(MANIFEST.name) && saved.startUrl.equals(MANIFEST.startUrl)
                            && saved.scope.equals(MANIFEST.scope) && saved.origin.equals(MANIFEST.origin),
                            "only confirmed metadata goes to the currently attached profile");
                    check(a.webAppInstall == null && !sheet.dialog.isShowing(), "successful consent retires");

                    for (NativePwaBridge.InstallManifest changed : List.of(
                            new NativePwaBridge.InstallManifest("https://a.invalid/new-id", MANIFEST.name,
                                    MANIFEST.startUrl, MANIFEST.scope, MANIFEST.origin),
                            new NativePwaBridge.InstallManifest(MANIFEST.id, "Reference  app",
                                    MANIFEST.startUrl, MANIFEST.scope, MANIFEST.origin),
                            new NativePwaBridge.InstallManifest(MANIFEST.id, MANIFEST.name,
                                    "https://a.invalid/other-entry", MANIFEST.scope, MANIFEST.origin),
                            new NativePwaBridge.InstallManifest(MANIFEST.id, MANIFEST.name,
                                    MANIFEST.startUrl, "https://a.invalid/page", MANIFEST.origin),
                            new NativePwaBridge.InstallManifest(MANIFEST.id, MANIFEST.name,
                                    MANIFEST.startUrl, MANIFEST.scope, "https://other.invalid"))) {
                        Activity host = new Activity(true);
                        WebContents current = beginInstallFromPopup(host);
                        Ui.Sheet consent = requestInstallConfirmation(host, current);
                        deliverManifest(host, current, 1, changed);
                        check(host.webAppInstall == null && !consent.dialog.isShowing()
                                && host.registered.isEmpty() && host.pinRequests.isEmpty(),
                                "changed manifest cannot register or request a pin after consent");
                    }
                }

                static void installWaitsForWindowFocus() {
                    Activity a = new Activity(true);
                    WebContents page = beginInstallFromPopup(a);
                    a.onWindowFocusChanged(false);
                    deliverManifest(a, page, 0, MANIFEST);
                    check(a.webAppInstall != null && a.consent == null && a.main.queue.isEmpty(),
                            "a valid manifest never disappears or opens a sheet behind another focused window");
                    a.onWindowFocusChanged(true); a.main.all();
                    check(page.manifests.size() == 2 && a.consent == null,
                            "focus return rechecks the exact selected document, not cached manifest data");
                    deliverManifest(a, page, 1, MANIFEST);
                    check(a.consent != null && a.consent.dialog.isShowing(), "fresh result shows consent");
                    a.onWindowFocusChanged(false);
                    a.consent.confirm.run(); a.main.all();
                    check(page.manifests.size() == 3, "confirmation checks the manifest once");
                    View decor = a.consent.dialog.getWindow().getDecorView();
                    decor.dispatchWindowFocus(false);
                    deliverManifest(a, page, 2, MANIFEST);
                    check(a.webAppInstall != null && a.consent.dialog.isShowing() && a.pinRequests.isEmpty(),
                            "an unfocused consent never pins or silently closes");
                    decor.dispatchWindowFocus(true);
                    check(page.manifests.size() == 3, "consent focus gain posts the recheck");
                    a.main.all();
                    check(page.manifests.size() == 4 && a.pinRequests.isEmpty(),
                            "consent focus gain requests a fresh result without a second click");
                    decor.dispatchWindowFocus(false); decor.dispatchWindowFocus(true);
                    deliverManifest(a, page, 3, MANIFEST);
                    check(page.manifests.size() == 5 && a.pinRequests.isEmpty(),
                            "even a completed consent blur/refocus interval retires the old reply");
                    deliverManifest(a, page, 4, MANIFEST);
                    check(a.registered.size() == 1 && a.pinRequests.equals(a.registered)
                            && !a.consent.dialog.isShowing() && decor.tree.focusListeners.isEmpty()
                            && a.main.delayed.isEmpty(), "only a continuously focused reply pins and clears the listener/deadline");
                }

                static void installWaitsForFullscreenExit() {
                    Activity a = new Activity(true);
                    Shell shell = a.manager.active;
                    Activity.ShellHistoryObserver owner = a.historyObservers.get(shell);
                    WebContents page = shell.contents;
                    PopupWindow popup = openOverflow(a, () -> { });
                    a.requestChromeRefresh(); // Earlier chrome pass must still defer to the native exit.
                    page.nativeFullscreen = true; page.signalFullscreen(true, true);
                    a.clickOverflowAction(popup, owner, owner.webAppPageEpoch, INSTALL, new View());
                    check(page.manifests.isEmpty() && page.fullscreenExits == 0, "click enqueues both native exit and installation");
                    a.main.all();
                    check(page.fullscreenExits == 1 && page.manifests.size() == 1,
                            "install checks the same visible page exactly once after fullscreen exits");
                }

                static void installHasBoundedPhasesAndCancellation() {
                    Activity waiting = new Activity(true);
                    Activity.ShellHistoryObserver waitingOwner = waiting.historyObservers.get(waiting.manager.active);
                    waiting.onWindowFocusChanged(false);
                    PopupWindow waitPopup = openOverflow(waiting, () -> { });
                    waiting.clickOverflowAction(waitPopup, waitingOwner, waitingOwner.webAppPageEpoch, INSTALL, new View());
                    waiting.main.all();
                    waiting.main.advance(Activity.WEB_APP_CHECK_TIMEOUT_MS);
                    waiting.onWindowFocusChanged(true); waiting.main.all();
                    check(waiting.webAppInstall == null && waitingOwner.contents.manifests.isEmpty(),
                            "focus restored after the phase deadline cannot replay the install click");

                    Activity a = new Activity(true);
                    WebContents page = beginInstallFromPopup(a);
                    a.main.advance(Activity.WEB_APP_CHECK_TIMEOUT_MS - 1);
                    check(a.webAppInstall != null && a.consent == null, "manifest lookup remains valid before deadline");
                    deliverManifest(a, page, 0, MANIFEST);
                    Ui.Sheet sheet = a.consent;
                    View decor = sheet.dialog.getWindow().getDecorView();
                    a.onWindowFocusChanged(false);
                    a.main.advance(2 * Activity.WEB_APP_CHECK_TIMEOUT_MS);
                    check(a.webAppInstall != null && sheet.dialog.isShowing() && a.main.delayed.isEmpty(),
                            "time spent reading explicit consent does not consume either lookup budget");
                    sheet.confirm.run(); a.main.all();
                    check(page.manifests.size() == 2 && a.main.delayed.size() == 1,
                            "confirmation starts a new bounded phase");
                    a.main.advance(Activity.WEB_APP_CHECK_TIMEOUT_MS);
                    check(a.webAppInstall == null && !sheet.dialog.isShowing() && a.main.delayed.isEmpty()
                            && decor.tree.focusListeners.isEmpty() && a.toasts.contains("网页应用检查超时，请重试。"),
                            "timeout exits a focused confirmation with feedback, no listener or orphan timer");
                    deliverManifest(a, page, 1, MANIFEST);
                    check(a.pinRequests.isEmpty() && a.registered.isEmpty(), "late confirmation after timeout cannot pin");

                    for (String cancel : List.of("Back", "dismiss", "Cancel")) {
                        Activity host = new Activity(true);
                        WebContents current = beginInstallFromPopup(host);
                        Ui.Sheet consent = requestInstallConfirmation(host, current);
                        switch (cancel) {
                            case "Back" -> host.onBackPressed();
                            case "dismiss" -> consent.dialog.dismiss();
                            case "Cancel" -> consent.cancel.run();
                            default -> throw new AssertionError(cancel);
                        }
                        deliverManifest(host, current, 1, MANIFEST);
                        check(host.webAppInstall == null && !consent.dialog.isShowing() && host.main.delayed.isEmpty()
                                && consent.dialog.window.decor.tree.focusListeners.isEmpty()
                                && host.pinRequests.isEmpty() && host.registered.isEmpty()
                                && current.navigation.backCalls == 0 && host.returns == 0,
                                cancel + " retires a confirming consent without loading, traversing or pinning anything");
                    }
                }

                static void passiveOfferRevalidatesExactPageAndVisibility() {
                    Activity a = new Activity(true);
                    a.webAppOfferBar = new View(); a.webAppOfferBar.visibility = View.GONE;
                    Shell shell = a.manager.active;
                    Activity.ShellHistoryObserver owner = a.historyObservers.get(shell);
                    WebContents page = shell.contents;
                    page.securePage = false;
                    a.requestChromeRefresh(); a.main.all();
                    check(page.manifests.isEmpty(), "passive discovery ignores pages without secure HTTPS");
                    page.securePage = true; page.loading = true;
                    owner.didChangeVisibleSecurityState(); a.main.all();
                    check(page.manifests.isEmpty(), "passive discovery waits until loading settles");
                    page.loading = false;
                    owner.didStopLoading(page.getVisibleUrl(), true); a.main.all();
                    check(page.manifests.size() == 1 && a.webAppOfferBar.visibility == View.GONE,
                            "eligible foreground document starts one passive lookup without changing its viewport");
                    Activity.WebAppOffer pending = a.webAppOffer;
                    page.updateWebContentsVisibility(Visibility.HIDDEN);
                    check(a.webAppOffer == null, "hide drops only the pending passive lookup");
                    page.updateWebContentsVisibility(Visibility.VISIBLE);
                    a.main.all();
                    check(a.webAppOffer != pending && page.manifests.size() == 2,
                            "hide then visible re-arms once for the same owner and URL");
                    deliverManifest(a, page, 0, null);
                    check(a.webAppOffer != null && !a.webAppOffer.completed && a.webAppOfferBar.visibility == View.GONE,
                            "stale null reply from before hide cannot poison a fresh same-document probe");
                    deliverManifest(a, page, 1, MANIFEST);
                    Activity.WebAppOffer eligible = a.webAppOffer;
                    check(eligible.completed && a.webAppOfferBar.visibility == View.VISIBLE && a.consent == null
                            && a.webAppInstall == null && a.registered.isEmpty() && a.pinRequests.isEmpty(),
                            "eligible passive result shows only the nonmodal native action");
                    a.onWindowFocusChanged(false); a.main.all();
                    check(a.webAppOfferBar.visibility == View.GONE, "foreign window focus hides the passive offer");
                    a.onWindowFocusChanged(true); a.main.all();
                    check(a.webAppOfferBar.visibility == View.VISIBLE && page.manifests.size() == 2,
                            "focus restores the same completed offer without fetching again");
                    a.useWebAppOffer(true); a.main.all();
                    check(eligible.dismissed && a.webAppOfferBar.visibility == View.GONE && a.consent == null,
                            "dismissal is local to this page and does not open consent");
                    page.updateWebContentsVisibility(Visibility.HIDDEN);
                    page.updateWebContentsVisibility(Visibility.VISIBLE); a.main.all();
                    check(a.webAppOffer == eligible && a.webAppOfferBar.visibility == View.GONE && page.manifests.size() == 2,
                            "completed dismissal survives hide/visible, with no repeated offer");
                    owner.didStartNavigationInPrimaryMainFrame(new NavigationHandle(page.url));
                    a.main.all();
                    check(page.manifests.size() == 3 && a.webAppOffer != eligible,
                            "same URL navigation invalidates the completed prior offer");
                    deliverManifest(a, page, 2, new NativePwaBridge.InstallManifest(MANIFEST.id, MANIFEST.name,
                            MANIFEST.startUrl, "https://a.invalid/page/", MANIFEST.origin));
                    check(a.webAppOfferBar.visibility == View.GONE && a.webAppInstall == null,
                            "manifest scope must include both the visible page and start URL");
                    owner.didChangeVisibleSecurityState(); a.main.all();
                    deliverManifest(a, page, 3, MANIFEST);
                    a.useWebAppOffer(false);
                    check(a.webAppOfferBar.visibility == View.GONE && a.consent == null && page.manifests.size() == 4,
                            "offer tap withdraws the chip and schedules a fresh check, not consent on cached data");
                    a.main.all();
                    check(page.manifests.size() == 5 && a.consent == null, "eligible offer starts explicit installation only on a posted pass");
                    deliverManifest(a, page, 4, MANIFEST);
                    check(a.consent != null && a.consent.dialog.isShowing() && a.pinRequests.isEmpty(),
                            "only an explicit offer tap and another fresh eligible response open consent");
                }

                static void installedOriginSuppressesOffer() {
                    Activity a = new Activity(true);
                    a.webAppOfferBar = new View(); a.webAppOfferBar.visibility = View.GONE;
                    Shell shell = a.manager.active;
                    Activity.ShellHistoryObserver owner = a.historyObservers.get(shell);
                    WebContents page = shell.contents;
                    page.securePage = true;
                    owner.didStopLoading(page.getVisibleUrl(), true); a.main.all();
                    check(page.manifests.size() == 1 && a.webAppOfferBar.visibility == View.GONE,
                            "uninstalled origin still arms exactly one passive lookup");
                    deliverManifest(a, page, 0, MANIFEST);
                    check(a.webAppOfferBar.visibility == View.VISIBLE,
                            "before any install the eligible offer shows");
                    a.registered.add(new WebApp(APP_ID, PROFILE_ID, MANIFEST.id, MANIFEST.name,
                            MANIFEST.startUrl, MANIFEST.scope, MANIFEST.origin));
                    a.onWindowFocusChanged(false); a.main.all();
                    a.onWindowFocusChanged(true); a.main.all();
                    check(a.webAppOfferBar.visibility == View.GONE,
                            "an origin already installed in this profile hides the stale offer without new work");
                    owner.didStartNavigationInPrimaryMainFrame(new NavigationHandle(page.url));
                    a.main.all();
                    check(page.manifests.size() == 1 && a.webAppOffer == null
                            && a.webAppOfferBar.visibility == View.GONE,
                            "a fresh document on an installed origin never probes or offers again");
                    a.registered.clear();
                    owner.didChangeVisibleSecurityState(); a.main.all();
                    check(page.manifests.size() == 2 && a.webAppOffer != null,
                            "uninstalling restores the passive offer on the next refresh");
                    deliverManifest(a, page, 1, MANIFEST);
                    check(a.webAppOfferBar.visibility == View.VISIBLE,
                            "offer returns once the origin is no longer installed");
                }

                static void staleInstallResultsCannotPin() {
                    for (String change : List.of("pause", "renderer loss", "navigation",
                            "redirect", "security", "retired Shell", "history overlay", "visibility")) {
                        Activity a = new Activity(true);
                        Shell owner = a.manager.active;
                        WebContents page = beginInstallFromPopup(a);
                        Ui.Sheet sheet = change.equals("pause") ? null : requestInstallConfirmation(a, page);
                        Activity.ShellHistoryObserver observer = a.historyObservers.get(owner);
                        switch (change) {
                            case "pause" -> { a.onPause(); a.onResume(); }
                            case "renderer loss" -> observer.primaryMainFrameRenderProcessGone(1);
                            case "navigation" -> observer.didStartNavigationInPrimaryMainFrame(new NavigationHandle(MANIFEST.startUrl));
                            case "redirect" -> observer.didRedirectNavigation(new NavigationHandle(MANIFEST.startUrl));
                            case "security" -> observer.didChangeVisibleSecurityState();
                            case "retired Shell" -> a.manager.closeShell(owner);
                            case "history overlay" -> a.showHistoryPanel();
                            case "visibility" -> {
                                page.updateWebContentsVisibility(Visibility.HIDDEN);
                                page.updateWebContentsVisibility(Visibility.VISIBLE);
                            }
                            default -> throw new AssertionError(change);
                        }
                        deliverManifest(a, page, sheet == null ? 0 : 1, MANIFEST);
                        check(a.webAppInstall == null && (sheet == null ? a.consent == null : !sheet.dialog.isShowing()),
                                change + " leaves no stale consent when the manifest arrives");
                        check(a.registered.isEmpty() && a.pinRequests.isEmpty(), change + " prevents the late callback from installing");
                    }
                }

                static void frameworkBackPreservesDispatchOrder() {
                    int sdk = android.os.Build.VERSION.SDK_INT;
                    try {
                        android.os.Build.VERSION.SDK_INT = 32;
                        Activity legacy = new Activity(true);
                        legacy.registerBrowserBack();
                        check(legacy.browserBack == null && legacy.backDispatcher.callback == null,
                                "pre-33 Activity has no framework callback");
                        legacy.manager.active.contents.navigation.hasBack = true;
                        legacy.onBackPressed();
                        check(legacy.manager.active.contents.navigation.backCalls == 1, "legacy Back still uses browser policy");

                        android.os.Build.VERSION.SDK_INT = 33;
                        Activity a = new Activity(true);
                        Shell first = a.manager.active;
                        Shell previous = a.manager.retain("https://ordinary.invalid/previous", true);
                        Shell installed = a.manager.retain(MANIFEST.startUrl, true);
                        a.manager.selectShell(installed); a.main.all();
                        WebApp app = new WebApp(APP_ID, PROFILE_ID, MANIFEST.id, MANIFEST.name,
                                MANIFEST.startUrl, MANIFEST.scope, MANIFEST.origin);
                        installed.contents.standaloneScope = app.scope;
                        a.webAppShells.put(installed, new Activity.WebAppShell(app, installed.contents, previous));
                        installed.contents.navigation.hasBack = true;
                        a.registerBrowserBack();
                        var callback = a.backDispatcher.callback;
                        check(callback != null && callback == a.browserBack
                                && a.backDispatcher.priority == android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                                "API 33 registers the browser callback at the default priority");
                        enterFullscreen(a, installed);
                        callback.onBackInvoked(); a.main.all();
                        check(a.fullscreenOwner == null && a.webAppBar.visibility == View.VISIBLE
                                && a.chromeBar.visibility == View.GONE && MANIFEST.name.equals(a.webAppTitle.getText()),
                                "framework Back exits fullscreen to standalone chrome, not the browser toolbar");
                        check(a.manager.active == installed && !installed.destroyed && installed.contents.fullscreenExits == 1
                                && installed.contents.navigation.backCalls == 0, "fullscreen consumes the first framework Back");
                        callback.onBackInvoked(); a.main.all();
                        check(installed.destroyed && a.manager.active == previous && !first.destroyed
                                && installed.contents.navigation.backCalls == 0,
                                "standalone framework Back closes the app and restores its exact previous tab without traversing app history");
                        previous.contents.navigation.hasBack = true;
                        callback.onBackInvoked();
                        check(previous.contents.navigation.backCalls == 1 && a.returns == 0, "ordinary Back works after leaving standalone mode");
                        a.onDestroy();
                        check(a.backDispatcher.callback == null && a.browserBack == null, "destroy unregisters the installed framework callback");
                    } finally {
                        android.os.Build.VERSION.SDK_INT = sdk;
                    }
                }

                public static int run() {
                    loadFeedbackPresentation();
                    previewRequestCoalescing();
                    previewPostedCancellationAndRearm();
                    previewBlockedFrameDoesNotSpin();
                    previewSwitcherDismissAndReopen();
                    restorationDeadline();
                    restorationTransitions();
                    restorationOwnership();
                    restorationRetryAndCancellation();
                    rendererLossIsImmediate();
                    rendererLossRetainedOffscreen();
                    rendererRetryAndFreshCompletion();
                    rendererRetryForegroundBudget();
                    rendererBackgroundCompletionAndFailedRetry();
                    rendererRedirectFailureAndBlankOwnership();
                    rendererDeathDuringPendingNativeNavigation();
                    rendererFreshReplacementRouterCompletion();
                    rendererNavigationAndOwnerPruning();
                    previewNoDataAndBounds();
                    previewStaleResults();
                    previewSourceAndOverlays();
                    fullscreenOverlaysAndFocus();
                    fullscreenWaitsForWindowFocus();
                    fullscreenBackAndLifecycle();
                    fullscreenWindowAndInsets();
                    fullscreenSignalsAndNavigation();
                    fullscreenIdentityAndSwitch();
                    browserFullscreenFromOverflow();
                    browserFullscreenCannotReplayStaleMenuOrRequest();
                    installConsentRequiresFreshManifest();
                    installWaitsForWindowFocus();
                    installWaitsForFullscreenExit();
                    installHasBoundedPhasesAndCancellation();
                    passiveOfferRevalidatesExactPageAndVisibility();
                    installedOriginSuppressesOffer();
                    staleInstallResultsCannotPin();
                    frameworkBackPreservesDispatchOrder();
                    return checks;
                }
            }
            """);
}
