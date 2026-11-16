import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.VariableTree;
import com.sun.source.util.JavacTask;
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
 * Executes source-extracted Activity recovery/preview control flow on deterministic JDK17 hosts.
 * Android Views, Chromium, the frame clock and PixelCopy delivery are fakes, not production hooks.
 * This proves callback/state behavior, not Android compilation, real renderer recovery, actual
 * pixel content, device lifecycle timing, layout/accessibility, or visual acceptance.
 */
public final class NativeBrowserRecoveryHostTest {
    private static final List<String> FIELD_NAMES = List.of(
            "MAX_PREVIEW_RETRIES", "restoreSplashShown", "restoreInterrupted", "restoreEpoch", "restoreShell",
            "restoreContents", "restoreUrl", "restoreGeneration", "restoreTimeout", "chromeShell",
            "chromeContents", "previewInFlight", "previewRequested", "previewRetries", "previewEpoch",
            "previewCapture", "tabPreviews", "previewUrls", "newTabUrls", "historyObservers", "lastBackExitHint");
    private static final List<String> METHOD_NAMES = List.of(
            "showPageRestoring", "beginPageRestoring", "pageInterruption", "reloadPage",
            "ownsPageRestoring", "hidePageRestoring", "retryPageRestoring",
            "reconcilePageRestoring", "completePageRestoring", "requestActivePreview",
            "schedulePreviewCapture", "captureActivePreview", "current", "interactive", "validTab",
            "visibleUrl", "isBlankPage", "tabTitle", "isPageReady", "hideSplash", "cancelUiWork",
            "onPause", "onStop", "onResume", "syncWebContentsVisibility", "installShellObserverHooks",
            "installPreviewSurfaceHooks", "observeShell", "trackHistory", "contents",
            "performMenuAction", "ShellHistoryObserver");

    private NativeBrowserRecoveryHostTest() { }

    public static void main(String[] args) throws Exception {
        if (args.length != 2) throw new IllegalArgumentException("Usage: NativeBrowserRecoveryHostTest ROOT OUTPUT");
        Path root = Path.of(args[0]).toAbsolutePath();
        Path output = Path.of(args[1]).toAbsolutePath().resolve("recovery-host");
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) throw new AssertionError("A full JDK17 is required");
        Path activity = root.resolve("mobile/android/native-kernel/src/main/java/com/ahoo/abs/android/nativekernel/NativeBrowserActivity.java");
        Map<String, String> methods = new HashMap<>();
        Map<String, String> fields = new HashMap<>();
        try (StandardJavaFileManager files = compiler.getStandardFileManager(null, null, StandardCharsets.UTF_8)) {
            JavacTask task = (JavacTask) compiler.getTask(null, files, null,
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
                        }
                        if (member instanceof VariableTree field) fields.put(field.getName().toString(), field + ";\n");
                        if (member instanceof ClassTree nested && nested.getSimpleName().contentEquals("ShellHistoryObserver")) {
                            methods.put("ShellHistoryObserver", nested.toString());
                        }
                    }
                }
            }
        }
        int checks = execute(compiler, output.resolve("positive"), members(fields, methods));
        int rejected = 0;
        rejected += rejects(compiler, output, fields, methods, "old-inverted-retry-gate",
                "retryPageRestoring", "restoreRetry.getVisibility() != View.VISIBLE",
                "restoreRetry.getVisibility() == View.VISIBLE", "retry reloads exactly once");
        rejected += rejects(compiler, output, fields, methods, "missing-restore-shell-identity",
                "ownsPageRestoring", "restoreShell == shell &&", "", "restore Shell identity rejects aliased contents");
        rejected += rejects(compiler, output, fields, methods, "missing-timeout-epoch",
                "beginPageRestoring", "restoreEpoch != epoch ||", "", "old deadline cannot expire renewed retry");
        rejected += rejects(compiler, output, fields, methods, "missing-preview-reschedule",
                "captureActivePreview", "schedulePreviewCapture();", "", "NO_DATA schedules next frame without a native event");
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
        System.out.println(checks + " source-extracted recovery/preview fake-host checks, "
                + rejected + " behavioral mutation controls rejected, 0 failures");
        System.out.println("Host-only evidence: no Android build, device, real pixels, timing, or visual acceptance asserted.");
    }

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

    private static int rejects(JavaCompiler compiler, Path output, Map<String, String> fields,
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

    private static int execute(JavaCompiler compiler, Path output, String actual) throws Exception {
        Files.createDirectories(output);
        Path host = output.resolve("RecoveryHost.java");
        Files.writeString(host, HOST.replace("@ACTUAL@", actual), StandardCharsets.UTF_8);
        Path ids = output.resolve("org/chromium/content_shell/R.java");
        Files.createDirectories(ids.getParent());
        Files.writeString(ids, "package org.chromium.content_shell; public final class R { public static final class id { public static final int contentview_holder = 1; } }", StandardCharsets.UTF_8);
        try (StandardJavaFileManager files = compiler.getStandardFileManager(null, null, StandardCharsets.UTF_8)) {
            boolean compiled = compiler.getTask(null, files, null,
                    List.of("--release", "17", "-Xlint:all", "-Werror", "-d", output.toString()),
                    null, files.getJavaFileObjects(host, ids)).call();
            if (!compiled) throw new AssertionError("Source-extracted recovery host did not compile: " + output);
        }
        try (URLClassLoader loader = new URLClassLoader(new URL[] {output.toUri().toURL()}, NativeBrowserRecoveryHostTest.class.getClassLoader())) {
            return (Integer) loader.loadClass("RecoveryHost").getMethod("run").invoke(null);
        }
    }

    private static final String HOST = String.join("", """
            import java.util.*;
            public final class RecoveryHost {
                static int checks;
                static void check(boolean pass, String message) {
                    checks++;
                    if (!pass) throw new AssertionError(message);
                }
                static final class Handler {
                    final ArrayDeque<Runnable> queue = new ArrayDeque<>();
                    void post(Runnable task) { queue.add(task); }
                    void removeCallbacks(Runnable task) { queue.removeIf(item -> item == task); }
                    void all() {
                        int delivered = 0;
                        while (!queue.isEmpty()) {
                            if (++delivered > 100) throw new AssertionError("unbounded handler loop");
                            queue.remove().run();
                        }
                    }
                }
                static class View {
                    static final int VISIBLE = 0, GONE = 8;
                    int visibility = VISIBLE, width = 1080, height = 1920, draws;
                    boolean attached = true, shown = true;
                    int getVisibility() { return visibility; }
                    void setVisibility(int value) { visibility = value; }
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
                    OnHierarchyChangeListener hierarchy;
                    void setOnHierarchyChangeListener(OnHierarchyChangeListener value) { hierarchy = value; }
                }
                static final class Frame extends ViewGroup {
                    static final class Task {
                        final Runnable runnable;
                        final long due;
                        Task(Runnable runnable, long due) { this.runnable = runnable; this.due = due; }
                    }
                    final List<Task> tasks = new ArrayList<>();
                    long now;
                    void postOnAnimation(Runnable task) { tasks.add(new Task(task, now + 16)); }
                    void postOnAnimationDelayed(Runnable task, long delay) { tasks.add(new Task(task, now + delay)); }
                    void removeCallbacks(Runnable task) { tasks.removeIf(item -> item.runnable == task); }
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
                    void setText(String value) { text = value; }
                }
                static final class NewTabPage extends View { void dismissDialogs() { } }
                static final class HistoryPanel extends View { void dismiss() { visibility = GONE; } }
                static final class TabSwitcher { boolean showing; }
                static final class Popup { int dismisses; void dismiss() { dismisses++; } }
                static final class Store {
                    int flushes, visits, titles;
                    void flush() { flushes++; }
                    void recordVisit(String url, String title) { visits++; }
                    void updateTitle(String url, String title) { titles++; }
                }
                static final class BrowserHistory {
                    static boolean isTrackable(String url) { return url.startsWith("https://") || url.startsWith("http://"); }
                }
                // Monotonic Android clock and Chromium are host API fakes; the observer below is extracted.
                static final class android {
                    static final class os {
                        static final class SystemClock {
                            static long now;
                            static long elapsedRealtime() { return now; }
                        }
                    }
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
                    public void primaryMainFrameRenderProcessGone(int status) { }
                    public void didStartNavigationInPrimaryMainFrame(NavigationHandle navigation) { }
                    public void didFinishNavigationInPrimaryMainFrame(NavigationHandle navigation) { }
                    public void didFirstVisuallyNonEmptyPaint() { }
                    public void didStopLoading(GURL url, boolean valid) { }
                    public void navigationEntriesChanged() { }
                    public void onVisibilityChanged(int visibility) { }
                    public void webContentsDestroyed() { }
                    public void titleWasSet(String title) { }
                }
                static final class Toast {
                    static final int LENGTH_SHORT = 0;
                    static Toast makeText(Object context, String text, int length) { return new Toast(); }
                    void show() { }
                }
                static final class GURL {
                    final String value;
                    GURL(String value) { this.value = value; }
                    String getSpec() { return value; }
                }
                static final class NavigationController {
                    int reloads;
                    boolean lastCheckForRepost;
                    boolean canGoForward() { return false; }
                    void goForward() { }
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
                    boolean destroyed;
                    int visibility = Visibility.VISIBLE;
                    final NavigationController navigation = new NavigationController();
                    final List<WebContentsObserver> observers = new ArrayList<>();
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
                    void updateWebContentsVisibility(int value) { visibility = value; }
                }
                static final class Shell extends View {
                    WebContents contents;
                    boolean destroyed;
                    final ViewGroup holder = new ViewGroup();
                    Shell(String url, boolean ready) { contents = new WebContents(url, ready); }
                    boolean isDestroyed() { return destroyed; }
                    WebContents getWebContents() { return contents; }
                    @Override View findViewById(int id) { return holder; }
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
                        Shell old = active; active = shell;
                        if (hierarchy != null && old != null) hierarchy.onChildViewRemoved(this, old);
                        if (hierarchy != null && shell != null) hierarchy.onChildViewAdded(this, shell);
                    }
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
                    boolean recycled;
                    View drawnFrom;
                    Bitmap(int width, int height) { this.width = width; this.height = height; }
                    static Bitmap createBitmap(int width, int height, Config config) { return new Bitmap(width, height); }
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
                static final class Window { }
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
                    static void reset() { submitted.clear(); pending.clear(); windowRequests = 0; }
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
                // Runtime permission routing is outside this recovery host's scope.
                static final class MediaPermissionBridge { static void setHost(Object host) { } }
                static class BaseActivity {
                    boolean finishing, destroyed;
                    int pauses, stops;
                    boolean isFinishing() { return finishing; }
                    boolean isDestroyed() { return destroyed; }
                    protected void onPause() { pauses++; }
                    protected void onStop() { stops++; }
                    protected void onResume() { }
                }
                static final class Activity extends BaseActivity {
                    static final String TAG = "Host";
                    static final int MAX_TABS = 10;
                    final Handler main = new Handler(), previewResults = new Handler();
                    final Frame browserFrame = new Frame();
                    final View splash = new View(), splashSpinner = new View(), progressBar = new View();
                    final TextView splashTitle = new TextView(), splashStatus = new TextView(), restoreRetry = new TextView();
                    final NewTabPage newTab = new NewTabPage();
                    final HistoryPanel historyPanel = new HistoryPanel();
                    final TabSwitcher tabSwitcher = new TabSwitcher();
                    final Store historyStore = new Store();
                    final Runtime runtime = new Runtime();
                    final ContentViewRenderView renderView = new ContentViewRenderView();
                    SurfaceHolder.Callback previewSurfaceObserver;
                    final Runnable chromeRefresh = () -> { chromeRefreshPosted = false; refreshChrome(); };
                    ShellManager manager = new ShellManager();
                    Popup overflowMenu;
                    long generation = 7;
                    boolean resumed = true, uiBuilt = true, closed, quiescing, chromeRefreshPosted, ntpRenderDirty;
                    Shell loadingShell;
                    int switcherRefreshes, focusCancellations;
                    Activity(boolean ready) {
                        android.os.SystemClock.now = 0;
                        splash.visibility = View.GONE; restoreRetry.visibility = View.GONE;
                        newTab.visibility = View.GONE; historyPanel.visibility = View.GONE;
                        manager.retain("https://a.invalid/page", ready);
                        installShellObserverHooks(); installPreviewSurfaceHooks();
                        observeShell(manager.active);
                        // Start from settled bootstrap, with the real production observer installed.
                        previewRequested = false; browserFrame.removeCallbacks(previewCapture);
                        main.queue.clear(); chromeRefreshPosted = false;
                    }
                    void cancelNavigationFocus() { focusCancellations++; }
                    void hideUrlSuggestions() { }
                    void dismissTabSwitcher() { tabSwitcher.showing = false; }
                    void refreshTabSwitcher(boolean force) { if (force) switcherRefreshes++; }
                    void requestChromeRefresh() {
                        if (!chromeRefreshPosted) { chromeRefreshPosted = true; main.post(chromeRefresh); }
                    }
                    // These non-recovery destinations have dedicated suites; only their menu seams are fake.
                    void createBlankTab() { manager.retain("about:blank", true); }
                    void showTabSwitcher() { tabSwitcher.showing = true; }
                    void showHistoryPanel() { historyPanel.visibility = View.VISIBLE; }
                    void closeTab(Shell shell) { manager.closeShell(shell); }
                    void returnToList() { }
                    void requestEnvironmentExit() { quiescing = true; cancelUiWork(); }
                    void refreshChrome() { trackHistory(); reconcilePageRestoring(); }
                    Window getWindow() { return new Window(); }
                    @ACTUAL@
                }
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
                    a.requestActivePreview(next);
                    check(PixelCopy.submitted.size() == 1, "new active request waits for old in-flight destination");
                    finish(a, PixelCopy.SUCCESS);
                    check(a.tabPreviews.isEmpty() && a.browserFrame.has(a.previewCapture),
                            "stale completion still schedules an already requested new owner");
                    a.browserFrame.frame(); finish(a, PixelCopy.SUCCESS);
                    check(a.tabPreviews.get(next) == PixelCopy.submitted.get(1).bitmap && !a.tabPreviews.containsKey(old),
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
                public static int run() {
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
                    return checks;
                }
            }
            """);
}
