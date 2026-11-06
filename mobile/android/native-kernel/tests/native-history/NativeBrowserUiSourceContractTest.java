import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.Tree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.TreeScanner;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;

/**
 * Pure-JDK syntax/source-contract regressions for the embedding, not a device/RAF benchmark.
 * Parsing intentionally does not resolve Android/Chromium dependencies; a release build and
 * foreground device checks still need to verify native symbols, real surfaces and lifecycle.
 */
public final class NativeBrowserUiSourceContractTest {
    private static final String SOURCE_DIR =
            "mobile/android/native-kernel/src/main/java/com/ahoo/abs/android/nativekernel";
    private static final List<String> FILES = List.of(
            "NativeBrowserActivity.java", "TabSwitcherView.java", "NewTabPage.java",
            "BrowserHistoryStore.java", "HistoryPanel.java", "NativeBrowserRuntime.java");
    private static final Map<String, String> sources = new HashMap<>();
    private static final Map<String, String> methods = new HashMap<>();
    private static int checks;
    private static int failures;

    private NativeBrowserUiSourceContractTest() { }

    public static void main(String[] args) throws IOException {
        boolean assertions = false;
        assert assertions = true;
        check(assertions, "assertions enabled");
        check(Runtime.version().feature() == 17, "run on the release JDK 17 baseline");
        Path root = args.length == 0 ? Path.of("") : Path.of(args[0]);
        parseSources(root.toAbsolutePath());
        retainedActivityAndFrozenReuse();
        nonDestructiveQuiescence();
        drainAndRejectedActivityRecords();
        privateLifecycleStages();
        eventDrivenForegroundVisibility();
        realPreviewOwnership();
        popupAndHistorySemantics();
        overlaySafetyAndWarnings();
        System.out.println(checks + " UI source-contract checks, " + failures + " failures");
        if (failures != 0) throw new AssertionError("Native browser UI source regressions: " + failures);
    }

    private static void parseSources(Path root) throws IOException {
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) throw new IllegalStateException("A full JDK is required");
        List<Path> paths = new ArrayList<>();
        for (String name : FILES) {
            Path path = root.resolve(SOURCE_DIR).resolve(name);
            sources.put(name, Files.readString(path, StandardCharsets.UTF_8));
            paths.add(path);
        }
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
        try (StandardJavaFileManager files = compiler.getStandardFileManager(
                diagnostics, null, StandardCharsets.UTF_8)) {
            JavacTask task = (JavacTask) compiler.getTask(null, files, diagnostics,
                    List.of("-proc:none", "--release", "17"), null,
                    files.getJavaFileObjectsFromPaths(paths));
            int parsed = 0;
            for (CompilationUnitTree unit : task.parse()) {
                parsed++;
                new TreeScanner<Void, Void>() {
                    private final ArrayDeque<String> classes = new ArrayDeque<>();
                    @Override public Void visitMethodInvocation(MethodInvocationTree node, Void unused) {
                        String file = unit.getSourceFile().getName();
                        if ((file.endsWith("/NativeBrowserActivity.java") || file.endsWith("/NativeBrowserRuntime.java"))
                                && node.getMethodSelect().toString().matches("Log\\.[diwe]")) {
                            check(node.getArguments().size() == 2, "log has no dynamic fields or Throwable: " + node);
                            check(node.getArguments().size() >= 2
                                            && node.getArguments().get(1).getKind() == Tree.Kind.STRING_LITERAL,
                                    "log message is a compile-time literal: " + node);
                        }
                        return super.visitMethodInvocation(node, unused);
                    }

                    @Override public Void visitClass(ClassTree node, Void unused) {
                        classes.addLast(node.getSimpleName().toString());
                        try { return super.visitClass(node, unused); }
                        finally { classes.removeLast(); }
                    }
                    @Override public Void visitMethod(MethodTree node, Void unused) {
                        if (!classes.isEmpty() && node.getBody() != null) {
                            methods.put(classes.getLast() + "#" + node.getName(), node.getBody().toString());
                        }
                        return super.visitMethod(node, unused);
                    }
                }.scan(unit, null);
            }
            check(parsed == FILES.size(), "all five Android UI sources parsed with JDK 17");
        }
        for (Diagnostic<? extends JavaFileObject> diagnostic : diagnostics.getDiagnostics()) {
            check(diagnostic.getKind() != Diagnostic.Kind.ERROR,
                    "syntax parse: " + diagnostic);
        }
    }

    private static void retainedActivityAndFrozenReuse() {
        String back = method("NativeBrowserActivity", "returnToList");
        has(back, "FLAG_ACTIVITY_REORDER_TO_FRONT", "manager return preserves activity stack");
        has(back, "FLAG_ACTIVITY_SINGLE_TOP", "manager return avoids duplicate manager instance");
        lacks(back, "finish()", "manager return is not explicit profile exit");
        lacks(back, "FLAG_ACTIVITY_CLEAR_TOP", "manager return cannot clear retained browser");
        String reuse = method("NativeBrowserActivity", "onNewIntent");
        has(reuse, "super.onNewIntent(intent)", "reuse honors Android intent lifecycle");
        has(reuse, "validateIntent(intent)", "reuse revalidates immutable session and nonce");
        has(reuse, "application.verifyFrozenCommandLine()", "reuse validates frozen process switches");
        has(reuse, "!current()", "closed, draining or stale runtime cannot be continued");
        before(reuse, "validateIntent(intent)", "setIntent(intent)", "validate before publishing new intent");
        lacks(reuse, "runtime.attach", "Continue cannot attach a second native runtime");
        lacks(reuse, "prepareInitialTab", "Continue cannot recreate the initial blank tab");
        lacks(reuse, "new ShellManager", "Continue cannot recreate retained shells");
    }

    private static void nonDestructiveQuiescence() {
        String quiet = method("NativeBrowserActivity", "quiesceForShutdown");
        has(source("NativeBrowserActivity.java"), "    void quiesceForShutdown()",
                "shutdown barrier is package-private for runtime coordination");
        has(quiet, "Looper.myLooper() != Looper.getMainLooper()", "shutdown is UI-thread-only");
        has(quiet, "quiescing || cleanupComplete", "shutdown barrier is idempotent");
        before(quiet, "quiescing = true", "contents.stop()", "disable actions before stopping navigation");
        has(quiet, "resumed = false", "quiesced browser is not foreground");
        has(quiet, "cancelUiWork()", "quiescence cancels refresh/capture scheduling");
        has(quiet, "historyPanel.quiesce()", "history actions are stopped");
        has(quiet, "newTab.quiesce()", "native new-tab actions are stopped");
        has(quiet, "overflowMenu.dismiss()", "pending native menu is dismissed");
        has(quiet, "for (Shell shell : manager.getShells())", "stop every retained native tab");
        has(quiet, "contents.stop()", "stop pending native navigations");
        has(quiet, "updateWebContentsVisibility(Visibility.HIDDEN)", "hide native pages before storage flush");
        has(quiet, "NATIVE_VIEW_QUIESCE_UNCONFIRMED", "native barrier failure cannot become success");
        for (String destruction : List.of("shell.close()", "manager.destroy()", "window.destroy()",
                "contents.destroy()", "closeNativeView()")) {
            lacks(quiet, destruction, "quiescence retains native objects: " + destruction);
        }
        String cancel = method("NativeBrowserActivity", "cancelUiWork");
        has(cancel, "main.removeCallbacks(chromeRefresh)", "cancel owned refresh work");
        has(cancel, "browserFrame.removeCallbacks(previewCapture)", "cancel owned capture scheduling");
        lacks(cancel, "previewResults.remove", "PixelCopy result cleanup cannot be cancelled");
        lacks(source("NativeBrowserActivity.java"), "removeCallbacksAndMessages",
                "no blanket cancellation that can strand async capture destinations");
        has(method("NativeBrowserActivity", "dispatchTouchEvent"), "quiescing || closed",
                "touch input is consumed after quiescence");
        has(method("NativeBrowserActivity", "dispatchKeyEvent"), "quiescing || closed",
                "key input is consumed after quiescence");
        has(method("NativeBrowserActivity", "current"), "!quiescing", "all observer callbacks honor shutdown");
        before(method("NativeBrowserActivity", "closeNativeView"), "quiesceForShutdown()", "shell.close()",
                "destruction can occur only after the local barrier");
    }

    private static void drainAndRejectedActivityRecords() {
        String begin = method("NativeBrowserRuntime", "beginDrain");
        before(begin, "draining = true", "current.quiesceForShutdown()", "revoke runtime before quiescence");
        before(begin, "current.quiesceForShutdown()", "ShellManager.flushPersistentStorageForShutdown", "retain shells until native flush replies");
        lacks(begin, "closeNativeView()", "no early shell destruction in beginDrain");
        lacks(begin, ".finish()", "no early Activity finish in beginDrain");
        has(source("NativeBrowserRuntime.java"), "DRAIN_TIMEOUT_MS = 5000", "bounded five-second drain retained");
        String done = method("NativeBrowserRuntime", "finishDrain");
        has(done, "!draining || drainReturned || generation != expectedGeneration", "ignore late or stale completion");
        before(done, "drainReturned = true", "current.closeNativeView()", "claim completion before reentrant teardown");
        before(done, "current.closeNativeView()", "current.finish()", "remove record only after native view closes");
        before(done, "current.finish()", "main.post", "request Activity removal before delivering drain receipt");
        has(done, "result = \"FAILED\"", "close/finish exceptions preserve FAILED receipt");
        has(done, "RuntimeException | LinkageError", "teardown runtime/linkage failures remain failures");
        String create = method("NativeBrowserActivity", "onCreate");
        has(create, "boolean runtimeAttached = false", "new Activity starts without runtime ownership");
        before(create, "generation = runtime.attach(this)", "runtimeAttached = true", "attach must return before ownership is committed");
        has(create, "generation = runtime.attach(this); runtimeAttached = true;", "no throwing work between attach and ownership flag");
        has(method("NativeBrowserRuntime", "attach"), "view = activity; activity.onStatus(status); return ++generation;", "attach publishes only through a non-throwing tail");
        check(compact(method("NativeBrowserActivity", "onStatus")).equals("{}"), "status hook cannot throw after runtime ownership is published");
        before(create, "runtimeAttached = true", "DeviceUtils.updateDeviceSpecificUserAgentSwitch", "later initialization rejection is post-attach");
        before(create, "startupFailed(\"NATIVE_STARTUP_REJECTED\")", "if (!runtimeAttached && !closed && !quiescing) finish()", "only unattached create rejection finishes after manager return");
        lacks(method("NativeBrowserActivity", "startupFailed"), "finish()", "shared startup rejection never finishes a live Activity");
        lacks(method("NativeBrowserActivity", "onNewIntent"), "finish()", "onNewIntent rejection preserves live tabs");
        String failure = method("NativeBrowserActivity", "startupFailed");
        has(failure, "!closed && !quiescing && !isFinishing() && !isDestroyed()", "late failure cannot navigate a draining/finished Activity");
        String asynchronous = method("", "onFailure");
        before(asynchronous, "if (!current()) return", "startupFailed", "late startup callback is ignored");
        lacks(asynchronous, "finish()", "async failure cannot destroy an attached runtime");
        has(create, "savedState != null && !launch.sessionId.equals(savedState.getString(ControlProtocol.SESSION))", "saved-session validation retained");
        String validate = method("NativeBrowserActivity", "validateIntent");
        for (String guard : List.of("application.requireBrowserActivation()", "intent == null", "intent.getData() != null",
                "intent.getSelector() != null", "intent.getClipData() != null", "extras == null", "extras.size() != 2",
                "extras.containsKey(\"commandLineArgs\")", "!launch.sessionId.equals(extras.getString(ControlProtocol.SESSION))",
                "!launch.nonce.equals(extras.getString(ControlProtocol.NONCE))")) {
            has(validate, guard, "strict intent gate retained: " + guard);
        }
    }

    private static void privateLifecycleStages() {
        String create = method("NativeBrowserActivity", "onCreate");
        before(create, "Log.i(TAG, \"LIFECYCLE_ON_CREATE_INTENT_VALIDATE\")", "validateIntent(getIntent())", "intent stage is fixed and precedes validation");
        before(create, "Log.i(TAG, \"LIFECYCLE_ON_CREATE_SAVED_STATE_SESSION_CHECK\")", "savedState != null", "saved-state stage precedes session check");
        before(create, "Log.i(TAG, \"LIFECYCLE_ON_CREATE_RUNTIME_ATTACH\")", "runtime.attach(this)", "attach stage precedes runtime ownership");
        has(create, "Log.w(TAG, \"LIFECYCLE_ON_CREATE_REJECTED\")", "create failure has a fixed stage");
        has(method("", "onFailure"), "Log.w(TAG, \"LIFECYCLE_ASYNC_STARTUP_FAILURE\")", "async failure has a distinct fixed stage");
        has(method("NativeBrowserActivity", "onNewIntent"), "Log.w(TAG, \"LIFECYCLE_ON_NEW_INTENT_REJECTED\")", "new intent failure has a distinct fixed stage");
        has(create, "Log.w(TAG, \"LIFECYCLE_ASYNC_VIEW_INITIALIZATION_FAILURE\")", "async view failure has a distinct fixed stage");
    }

    private static void eventDrivenForegroundVisibility() {
        String activity = source("NativeBrowserActivity.java");
        lacks(activity, "uiTick", "no perpetual UI polling runnable");
        lacks(activity, "postDelayed", "no periodic view/history/preview polling");
        has(method("NativeBrowserActivity", "requestChromeRefresh"), "chromeRefreshPosted",
                "native view events coalesce into one main-loop refresh");
        String visibility = method("NativeBrowserActivity", "syncWebContentsVisibility");
        has(visibility, "resumed && current()", "visibility requires actual resumed current activity");
        has(visibility, "pageForeground && shell == active ? Visibility.VISIBLE : Visibility.HIDDEN",
                "only selected foreground WebContents may be visible");
        has(visibility, "contents.getVisibility() != visibility", "visibility updates are idempotent");
        for (String overlay : List.of("tabSwitcher", "historyPanel", "newTab")) {
            has(visibility, overlay, "native overlay hides underlying web page: " + overlay);
        }
        String pause = method("NativeBrowserActivity", "onPause");
        before(pause, "resumed = false", "syncWebContentsVisibility()", "background flag set before hiding tabs");
        has(pause, "cancelUiWork()", "pause cancels pending capture/refresh");
        has(pause, "previewEpoch++", "pause invalidates pending pixels");
        has(method("NativeBrowserActivity", "onResume"), "resumed = true", "resume restores foreground state");
        has(method("NativeBrowserActivity", "onResume"), "requestActivePreview", "resume requests real fresh pixels");
        has(method("NativeBrowserActivity", "onStop"), "syncWebContentsVisibility()", "stop reconciles all tab visibility");
        has(method("ShellHistoryObserver", "onVisibilityChanged"), "requestChromeRefresh()",
                "background popup visibility is reconciled from native events");
    }

    private static void realPreviewOwnership() {
        String capture = method("NativeBrowserActivity", "captureActivePreview");
        has(capture, "renderView.getSurfaceView()", "use manager's actual shared renderer SurfaceView");
        has(capture, "surface.getHolder().getSurface().isValid()", "check real surface validity");
        has(capture, "renderer.isReady()", "check native compositor readiness");
        has(capture, "source.isAttachedToWindow()", "source must be attached");
        has(capture, "source.isShown()", "do not capture hidden or detached surfaces");
        has(capture, "observer.awaitingPaint", "cross-document loads wait for paint/load events");
        has(capture, "PixelCopy.request(surface, bitmap", "web previews contain actual compositor pixels");
        has(capture, "source.draw(canvas)", "native new-tab previews contain actual view pixels");
        has(capture, "}, previewResults)", "async result handler is separate from UI work cancellation");
        has(capture, "resumed && validTab(shell) && previewEpoch == epoch", "pending pixels have foreground and epoch ownership");
        has(capture, "manager.getActiveShell() == shell", "shared surface still belongs to captured tab");
        has(capture, "shell.getWebContents() == contents", "WebContents identity must still match");
        has(capture, "url.equals(visibleUrl(shell))", "preview URL must still match");
        has(capture, "result == PixelCopy.SUCCESS && samePage", "only matching successful pixels are published");
        has(capture, "PixelCopy.ERROR_SOURCE_NO_DATA", "first-buffer copies can retry honestly");
        has(capture, "previewRetries < MAX_PREVIEW_RETRIES", "source-no-data retries are bounded");
        has(method("NativeBrowserActivity", "schedulePreviewCapture"), "postOnAnimation(previewCapture)",
                "retry on a real animation traversal, not timer/JS spoofing");
        has(method("ShellHistoryObserver", "didFirstVisuallyNonEmptyPaint"), "requestActivePreview(shell)",
                "previews captured while tabs are visited, not only at overview open");
        has(method("ShellHistoryObserver", "didStopLoading"), "requestActivePreview(shell)",
                "load completion requests settled pixels");
        has(method("NativeBrowserActivity", "installPreviewSurfaceHooks"), "surfaceChanged",
                "resized/recreated surfaces trigger new captures");
        String compact = compact(capture);
        int success = compact.indexOf("if(result==PixelCopy.SUCCESS&&samePage)");
        int reject = compact.indexOf("}else{", success);
        check(success >= 0 && reject > success
                        && !compact.substring(success, reject).contains("bitmap.recycle()"),
                "published web bitmaps never explicitly recycled");
        int home = compact.indexOf("if(nativeHome)");
        int async = compact.indexOf("previewInFlight=true", home);
        String homeBlock = compact.substring(home, async);
        before(homeBlock, "bitmap.recycle()", "tabPreviews.put", "native draw error is handled before publication");
        lacks(method("NativeBrowserActivity", "closeNativeView"), ".recycle()",
                "cleanup releases published preview references without recycling display lists");
        for (String fake : List.of("evaluateJavaScript", "requestAnimationFrame", "setFrameRate(",
                "setPreferredRefreshRate", "captureContentAsBitmapForTesting", "Bitmap.compress")) {
            lacks(source("NativeBrowserActivity.java"), fake, "no fake score, frame cadence or disk snapshots: " + fake);
        }
    }

    private static void popupAndHistorySemantics() {
        String hooks = method("NativeBrowserActivity", "installShellObserverHooks");
        has(hooks, "contentview_holder", "popup ContentView initialization hook is retained");
        has(hooks, "observeShell(shell)", "popup observer installed synchronously at initialization");
        lacks(hooks, "postDelayed", "popup first navigation does not race a polling timer");
        String commits = method("ShellHistoryObserver", "didFinishNavigationInPrimaryMainFrame");
        has(commits, "navigation.hasCommitted()", "only committed navigation creates history");
        has(commits, "navigation.isSameDocument()", "same-document navigations do not create repeated visits");
        has(commits, "historyStore.recordVisit", "real top-level visits still recorded");
        has(method("NativeBrowserActivity", "updateNtpVisibility"), "url.equals(newTabUrls.get(active))",
                "native new-tab overlay belongs only to its browser-created blank entry");
        has(method("NativeBrowserActivity", "refreshChrome"), "!address.hasFocus()", "omnibox typing is not overwritten");
        has(method("NativeBrowserActivity", "onBackPressed"), "!interactive()", "back cannot navigate after shutdown");
        has(method("NativeBrowserActivity", "loadResolvedUrl"), "!interactive()", "native search/history cannot navigate after shutdown");
    }

    private static void overlaySafetyAndWarnings() {
        String switcher = source("TabSwitcherView.java");
        has(switcher, "new ScrollView(context)", "tab overview scrolls through all retained tabs");
        has(switcher, "widthDp < 300f ? 1 : 2", "overview retains adaptive two-column cards");
        has(method("TabSwitcherView", "makeCard"), "image.setImageBitmap(item.preview)", "overview displays real cached bitmaps");
        has(method("TabSwitcherView", "dismiss"), "cancelScrollWork()", "shutdown/dismiss cancels deferred scrolling");
        has(method("TabSwitcherView", "dismiss"), "grid.removeAllViews()", "dismiss drops stale ImageView references");
        lacks(switcher, ".recycle()", "overview never recycles displayed bitmaps");
        for (String overlay : List.of("NewTabPage", "HistoryPanel")) {
            has(method(overlay, "quiesce"), "quiescing = true", "permanent action barrier: " + overlay);
        }
        has(method("NewTabPage", "confirmRemove"), "if (quiescing) return", "pending remove confirmation cannot mutate stopped profile");
        has(method("HistoryPanel", "confirmClear"), "if (quiescing) return", "pending clear confirmation cannot mutate stopped profile");
        has(method("HistoryPanel", "dismiss"), "onHistoryDismissed()", "dismiss restores correct underlying web visibility");
        has(source("BrowserHistoryStore.java"), "import org.chromium.base.Log;", "history uses Chromium logging facade");
        for (String name : FILES) {
            lacks(source(name), "import android.util.Log;", "NoAndroidLog compatibility: " + name);
            lacks(source(name), "ScrollView.LayoutParams", "canonical FrameLayout parameter type: " + name);
        }
    }

    private static String source(String name) {
        String source = sources.get(name);
        if (source == null) throw new IllegalArgumentException("Source not parsed: " + name);
        return source;
    }

    private static String method(String owner, String name) {
        String body = methods.get(owner + "#" + name);
        if (body == null) throw new IllegalArgumentException("Method not parsed: " + owner + "#" + name);
        return body;
    }

    private static String compact(String text) {
        return text.replaceAll("\\s+", "");
    }

    private static void has(String body, String token, String label) {
        check(compact(body).contains(compact(token)), label);
    }

    private static void lacks(String body, String token, String label) {
        check(!compact(body).contains(compact(token)), label);
    }

    private static void before(String body, String first, String second, String label) {
        String text = compact(body);
        int a = text.indexOf(compact(first));
        int b = text.indexOf(compact(second));
        check(a >= 0 && b > a, label);
    }

    private static void check(boolean passed, String label) {
        checks++;
        if (!passed) {
            failures++;
            System.err.println("FAIL " + label);
        }
    }
}
