import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.ExpressionStatementTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.StatementTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.TryTree;
import com.sun.source.tree.VariableTree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.TreeScanner;
import java.io.IOException;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;

/**
 * Pure-JDK deterministic callback/order tests of source-extracted production lifecycle methods.
 * Android, history/native flush completions, Shell teardown, navigation, the ticket registry and the
 * main-loop scheduler are fake hosts. Intent admission/scheduling/consumption and the two-completion
 * drain barrier are extracted; neither the registry's SQLite transaction nor history I/O is exercised.
 * This is not a full Android compile, an ActivityManager/device test or any persistence proof.
 */
public final class NativeBrowserLifecycleHostTest {
    private static final Map<String, String> fields = new HashMap<>();
    private static final Map<String, MethodTree> methods = new HashMap<>();

    private NativeBrowserLifecycleHostTest() { }

    public static void main(String[] args) throws Exception {
        Path root = Path.of(args[0]).toAbsolutePath();
        Path output = Path.of(args[1]).toAbsolutePath().resolve("lifecycle-host");
        Files.createDirectories(output);
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        Path source = root.resolve("mobile/android/native-kernel/src/main/java/com/ahoo/abs/android/nativekernel");
        Path app = root.resolve("mobile/android/app/src/main/java/com/ahoo/abs/android");
        parse(compiler, List.of(source.resolve("NativeBrowserRuntime.java"), source.resolve("NativeBrowserActivity.java"),
                app.resolve("browser/ControlProtocol.java"), app.resolve("webapp/WebApp.java")));
        String runtime = fieldMembers("NativeBrowserRuntime", List.of("TAG", "application", "launch", "view", "historyStore", "generation",
                "draining", "drainReturned", "drainTimeout", "main", "DRAIN_TIMEOUT_MS", "status"))
                + methodMembers("NativeBrowserRuntime", List.of("attach", "isCurrent", "historyStore", "detach", "beginDrain", "finishDrain", "requireMain"));
        String activity = fieldMembers("NativeBrowserActivity", List.of("TAG", "application", "runtime", "generation",
                "closed", "quiescing", "cleanupComplete", "uiBuilt", "manager", "pageContainer", "main",
                "resumed", "chromeRefreshPosted", "chromeRefresh", "lastBackExitHint", "pendingWebAppTicket"))
                + methodMembers("NativeBrowserActivity", List.of("validateIntent", "isWebAppDelivery", "replacePendingWebAppTicket",
                        "canQueueWebAppTicket", "current", "startupFailed", "returnToList", "onNewIntent", "onDestroy", "onStatus", "onResume",
                        "requestChromeRefresh", "initializeBrowserUi", "interactive", "openPendingWebApp", "onWindowFocusChanged"))
                + createAdmissionMembers();
        activity += "\nvoid failAsyncStartup() " + methods.get("#onFailure").getBody();
        activity += "\nvoid succeedAsyncStartup() " + methods.get("#onSuccess").getBody();
        Path host = output.resolve("LifecycleHost.java");
        Files.writeString(host, HOST.replace("@RUNTIME@", runtime).replace("@ACTIVITY@", activity)
                .replace("@PROTOCOL@", fieldMembers("ControlProtocol", List.of("SESSION", "NONCE", "WEB_APP_TICKET")))
                .replace("@OPAQUE_ID@", methodMembers("WebApp", List.of("isOpaqueId"))), StandardCharsets.UTF_8);
        try (StandardJavaFileManager files = compiler.getStandardFileManager(null, null, StandardCharsets.UTF_8)) {
            boolean compiled = compiler.getTask(null, files, null,
                    List.of("--release", "17", "-Xlint:all", "-Werror", "-d", output.toString()), null,
                    files.getJavaFileObjects(host)).call();
            if (!compiled) throw new AssertionError("Source-extracted lifecycle host did not compile");
        }
        try (URLClassLoader loader = new URLClassLoader(new URL[] {output.toUri().toURL()},
                NativeBrowserLifecycleHostTest.class.getClassLoader())) {
            Object checks = loader.loadClass("LifecycleHost").getMethod("run").invoke(null);
            System.out.println(checks + " source-extracted lifecycle fake-host checks, 0 failures");
        }
    }

    private static void parse(JavaCompiler compiler, List<Path> paths) throws IOException {
        try (StandardJavaFileManager files = compiler.getStandardFileManager(null, null, StandardCharsets.UTF_8)) {
            JavacTask task = (JavacTask) compiler.getTask(null, files, null,
                    List.of("-proc:none", "--release", "17"), null, files.getJavaFileObjectsFromPaths(paths));
            for (CompilationUnitTree unit : task.parse()) {
                new TreeScanner<Void, Void>() {
                    private final ArrayDeque<String> owners = new ArrayDeque<>();
                    @Override public Void visitClass(ClassTree node, Void unused) {
                        owners.addLast(node.getSimpleName().toString());
                        for (Tree member : node.getMembers()) {
                            if (member instanceof VariableTree field) fields.put(owners.peekLast() + "#" + field.getName(), field.toString() + ";\n");
                        }
                        super.visitClass(node, unused);
                        owners.removeLast();
                        return null;
                    }
                    @Override public Void visitMethod(MethodTree node, Void unused) {
                        methods.put(owners.peekLast() + "#" + node.getName(), node);
                        return super.visitMethod(node, unused);
                    }
                }.scan(unit, null);
            }
        }
    }

    /** Exercise the actual cold admission without bringing up the Android/Chromium views. */
    private static String createAdmissionMembers() {
        VariableTree attached = null;
        TryTree admission = null;
        for (StatementTree statement : methods.get("NativeBrowserActivity#onCreate").getBody().getStatements()) {
            if (statement instanceof VariableTree local && local.getName().contentEquals("runtimeAttached")) {
                attached = local;
            }
            if (statement instanceof TryTree attempt && !attempt.getCatches().isEmpty()) {
                if (admission != null) throw new AssertionError("Ambiguous outer create rejection");
                admission = attempt;
            }
        }
        if (attached == null || admission == null || admission.getCatches().size() != 1) {
            throw new AssertionError("Missing cold admission ownership declaration or rejection");
        }
        var rejection = admission.getCatches().get(0);
        StringBuilder prefix = new StringBuilder("\nvoid createThroughAttach(Bundle savedState) {\n")
                .append(attached).append(";\ntry {\n");
        for (StatementTree statement : admission.getBlock().getStatements()) {
            if (statement instanceof ExpressionStatementTree expression
                    && expression.getExpression() instanceof MethodInvocationTree call
                    && call.getMethodSelect().toString().equals("DeviceUtils.updateDeviceSpecificUserAgentSwitch")) {
                return prefix.append("}\n").append(rejection).append("\n}\n")
                        .append("void rejectCreate(boolean runtimeAttached) ").append(rejection.getBlock()).toString();
            }
            prefix.append(statement);
            if (statement instanceof VariableTree) prefix.append(';');
            prefix.append('\n');
        }
        throw new AssertionError("Missing native bootstrap boundary after cold admission");
    }

    private static String fieldMembers(String owner, List<String> names) {
        StringBuilder result = new StringBuilder();
        for (String name : names) {
            String value = fields.get(owner + "#" + name);
            if (value == null) throw new AssertionError("Missing field " + owner + "#" + name);
            result.append(value);
        }
        return result.toString();
    }

    private static String methodMembers(String owner, List<String> names) {
        StringBuilder result = new StringBuilder();
        for (String name : names) {
            MethodTree value = methods.get(owner + "#" + name);
            if (value == null) throw new AssertionError("Missing method " + owner + "#" + name);
            result.append(value).append('\n');
        }
        return result.toString();
    }

    private static final String HOST = String.join("", """
            import java.util.*;
            public final class LifecycleHost {
                static int checks;
                static final List<String> events = new ArrayList<>();
                static final List<String> logs = new ArrayList<>();
                static final List<String> allLogs = new ArrayList<>();
                static void check(boolean ok, String label) { checks++; if (!ok) throw new AssertionError(label + ": " + events); }
                static void equal(Object actual, Object expected, String label) { check(Objects.equals(actual, expected), label + " actual=" + actual + " expected=" + expected); }
                static void fail(Throwable failure) {
                    if (failure instanceof RuntimeException runtime) throw runtime;
                    if (failure instanceof LinkageError linkage) throw linkage;
                }
                static void reset() {
                    events.clear(); logs.clear(); Handler.posted.clear(); Handler.delayed.clear(); Handler.lastDelay = 0;
                    ShellManager.pending = null; ShellManager.failure = null;
                    ShellManager.synchronous = false; ShellManager.confirmed = true;
                    BrowserHistoryStore.creations = 0; Looper.current = Looper.main;
                    LibraryLoader.instance.initialized = true; BrowserStartupController.instance.started = true;
                    WebAppRegistry.available.clear(); WebAppRegistry.expired.clear(); WebAppRegistry.probed.clear();
                    WebAppRegistry.taken.clear(); WebAppRegistry.revoked.clear();
                    WebAppRegistry.probeFailure = false; WebAppRegistry.takeFailure = false;
                    WebAppShortcuts.state = WebAppShortcuts.PinState.CONFIRMED;
                }
                static final class Log {
                    static void i(String tag, String message) { logs.add(message); allLogs.add(message); }
                    static void w(String tag, String message) { logs.add(message); allLogs.add(message); }
                }
                static final class Looper {
                    static final Looper main = new Looper();
                    static Looper current = main;
                    static Looper myLooper() { return current; }
                    static Looper getMainLooper() { return main; }
                }
                static final class Handler {
                    static final List<Runnable> posted = new ArrayList<>();
                    static final List<Runnable> delayed = new ArrayList<>();
                    static long lastDelay;
                    Handler(Looper ignored) { }
                    boolean post(Runnable action) { posted.add(action); return true; }
                    boolean postDelayed(Runnable action, long millis) { delayed.add(action); lastDelay = millis; return true; }
                    void removeCallbacks(Runnable action) { posted.remove(action); delayed.remove(action); }
                    static void runPosted() { while (!posted.isEmpty()) posted.remove(0).run(); }
                }
                interface BrowserProcessRuntime {
                    interface DrainCallback { void onDrained(String outcome); }
                    void beginDrain(DrainCallback callback);
                }
                static final class LibraryLoader {
                    static final LibraryLoader instance = new LibraryLoader();
                    boolean initialized;
                    static LibraryLoader getInstance() { return instance; }
                    boolean isInitialized() { return initialized; }
                }
                static final class BrowserStartupController {
                    static final BrowserStartupController instance = new BrowserStartupController();
                    boolean started;
                    static BrowserStartupController getInstance() { return instance; }
                    boolean isFullBrowserStarted() { return started; }
                }
                static final class ShellManager {
                    static java.util.function.Consumer<Boolean> pending;
                    static Throwable failure;
                    static boolean synchronous;
                    static Boolean confirmed;
                    Object getActiveShell() { return this; }
                    static void flushPersistentStorageForShutdown(java.util.function.Consumer<Boolean> callback) {
                        events.add("FLUSH"); fail(failure); pending = callback;
                        if (synchronous) callback.accept(confirmed);
                    }
                }
                /** Controls only when a flush callback is delivered; no disk/store algorithm here. */
                static final class BrowserHistoryStore {
                    interface FlushCallback { void onFlushed(boolean success); }
                    static int creations;
                    final NativeBrowserApplication context;
                    final String profileId;
                    FlushCallback pending;
                    Throwable failure;
                    boolean synchronous, confirmed = true, initializing, writeInFlight;
                    int flushCalls;
                    BrowserHistoryStore(NativeBrowserApplication context, String profileId) {
                        this.context = context; this.profileId = profileId; creations++;
                    }
                    void flush(FlushCallback callback) {
                        events.add("HISTORY_FLUSH"); flushCalls++; fail(failure); pending = callback;
                        if (synchronous) reply(confirmed);
                    }
                    void reply(boolean success) {
                        check(pending != null, "history callback was actually requested");
                        pending.onFlushed(success);
                    }
                    void completeInitialization() { initializing = false; replyIfIdle(); }
                    void completeWrite() { writeInFlight = false; replyIfIdle(); }
                    private void replyIfIdle() { if (!initializing && !writeInFlight) reply(confirmed); }
                }
                static final class FrameLayout {
                    static final class LayoutParams {
                        final int width, height;
                        LayoutParams(int width, int height) { this.width = width; this.height = height; }
                    }
                    int attachments;
                    void addView(ShellManager view, int index, LayoutParams params) {
                        check(view != null && index == 0 && params.width == -1 && params.height == -1,
                                "startup attaches shared renderer below overlays at full size");
                        check(attachments == 0, "startup attaches shared renderer at most once");
                        attachments++;
                    }
                }
                static final class ProfileSpec { final String id = "profile-private-canary"; }
                static final class LaunchSpec {
                    final String sessionId = "session-private-canary";
                    final String nonce = "nonce-private-canary";
                    final ProfileSpec profile = new ProfileSpec();
                }
                static final class NativeBrowserApplication {
                    final LaunchSpec launch = new LaunchSpec();
                    NativeBrowserRuntime browserRuntime;
                    boolean draining;
                    boolean activated = true, frozen = true;
                    int frozenChecks, runtimeRequests;
                    void requireBrowserActivation() { if (!activated || draining) throw new IllegalStateException("https://private.invalid/exception-canary"); }
                    LaunchSpec requireLaunch() { return launch; }
                    boolean isDraining() { return draining; }
                    void verifyFrozenCommandLine() {
                        frozenChecks++;
                        if (!frozen) throw new IllegalStateException("frozen-private-canary");
                    }
                    NativeBrowserRuntime browserRuntime() { runtimeRequests++; return browserRuntime; }
                    String incarnation() { return "incarnation-private-canary"; }
                }
                static final class Bundle {
                    final Map<String, Object> values = new HashMap<>();
                    int size() { return values.size(); }
                    String getString(String name) { return values.get(name) instanceof String value ? value : null; }
                    boolean containsKey(String name) { return values.containsKey(name); }
                }
                @interface Nullable { }
                static final class ControlProtocol { @PROTOCOL@ }
                static final class WebApp {
                    @OPAQUE_ID@
                    final String shortcutId = "test-shortcut";
                }
                static final class WebAppShortcuts {
                    enum PinState { CONFIRMED, NOT_PINNED, UNAVAILABLE }
                    static PinState state;
                    static PinState pinState(Activity activity, String shortcutId) { return state; }
                }
                static final class android {
                    static final class os {
                        static final class Process {
                            static int myPid() { return 452; }
                        }
                    }
                }
                static final class MainActivity { }
                static final class Intent {
                    static final int FLAG_ACTIVITY_REORDER_TO_FRONT = 1;
                    static final int FLAG_ACTIVITY_SINGLE_TOP = 2;
                    Bundle extras;
                    Object data, selector, clip;
                    String type;
                    int flags;
                    boolean unreadableExtras;
                    Intent() { }
                    Intent(Object context, Class<?> target) { }
                    Intent(Intent source) {
                        data = source.data; selector = source.selector; clip = source.clip; type = source.type; flags = source.flags;
                        if (source.extras != null) { extras = new Bundle(); extras.values.putAll(source.extras.values); }
                    }
                    Bundle getExtras() {
                        if (unreadableExtras) throw new IllegalArgumentException("extras-private-canary");
                        return extras;
                    }
                    boolean hasExtra(String name) { return getExtras() != null && extras.containsKey(name); }
                    void removeExtra(String name) { extras.values.remove(name); }
                    Object getData() { return data; }
                    String getType() { return type; }
                    Object getSelector() { return selector; }
                    Object getClipData() { return clip; }
                    Intent addFlags(int value) { flags |= value; return this; }
                }
                /** Registry port only: records exact calls; probing is read-only and a take burns the token. */
                static final class WebAppRegistry implements AutoCloseable {
                    static final List<String> probed = new ArrayList<>(), taken = new ArrayList<>(), revoked = new ArrayList<>();
                    static final Set<String> available = new HashSet<>(), expired = new HashSet<>();
                    static boolean probeFailure, takeFailure;
                    final Activity activity;
                    WebAppRegistry(Activity activity) { this.activity = activity; }
                    void assertBinding(LaunchSpec launch, String incarnation, int pid, String operation) {
                        NativeBrowserApplication app = (NativeBrowserApplication) activity.getApplication();
                        check(launch == app.launch && incarnation.equals(app.incarnation()) && pid == android.os.Process.myPid(),
                                operation + " uses the attached launch, incarnation and process");
                    }
                    boolean canQueue(String ticket, LaunchSpec launch, String incarnation, int pid) {
                        probed.add(ticket); assertBinding(launch, incarnation, pid, "non-consuming admission probe");
                        if (probeFailure) throw new IllegalStateException("registry-private-canary");
                        return available.contains(ticket) && !expired.contains(ticket);
                    }
                    WebApp take(String ticket, LaunchSpec launch, String incarnation, int pid) {
                        events.add("TAKE_TICKET"); taken.add(ticket);
                        assertBinding(launch, incarnation, pid, "consuming ticket claim");
                        if (takeFailure) throw new IllegalStateException("registry-private-canary");
                        return available.remove(ticket) && !expired.contains(ticket) ? new WebApp() : null;
                    }
                    void revokeTicket(String ticket) {
                        events.add("REVOKE_TICKET"); revoked.add(ticket); available.remove(ticket);
                    }
                    @Override public void close() { }
                }
                static final class Toast {
                    static final int LENGTH_LONG = 1;
                    static Toast makeText(Object context, String text, int duration) { return new Toast(); }
                    void show() { events.add("TOAST"); }
                }
                static class Activity {
                    boolean finishing, destroyed, failNavigation, failFinish, windowFocus = true;
                    int finishes;
                    int flags;
                    boolean isFinishing() { return finishing; }
                    boolean isDestroyed() { return destroyed; }
                    void finish() { events.add("FINISH"); finishes++; if (failFinish) throw new IllegalStateException("exception-private-canary"); finishing = true; }
                    void startActivity(Intent intent) { events.add("RETURN_MANAGER"); if (failNavigation) throw new IllegalStateException("exception-private-canary"); flags = intent.flags; }
                    Object systemApplication;
                    Intent retainedIntent;
                    Object getApplication() { return systemApplication; }
                    Intent getIntent() { return retainedIntent; }
                    void setIntent(Intent intent) { events.add("SET_INTENT"); retainedIntent = intent; }
                    boolean hasWindowFocus() { return windowFocus; }
                    public void onWindowFocusChanged(boolean focus) { windowFocus = focus; }
                    protected void onNewIntent(Intent intent) { }
                    protected void onResume() { }
                    protected void onDestroy() { destroyed = true; }
                }
                // Lifecycle fake-host stub: the real bridge needs Android runtime
                // permissions, which this host deliberately does not exercise.
                static final class MediaPermissionBridge {
                    static void setHost(Activity activity) { }
                    static void clearHost(Activity activity) { }
                    static void onHostResult(String[] permissions, int[] results) { }
                }
                static final class NativeBrowserActivity extends Activity {
                    @ACTIVITY@
                    Throwable closeFailure, quietFailure;
                    int closeCalls;
                    Throwable viewFailure;
                    Runnable duringPrepare;
                    void prepareInitialTab() { events.add("PREPARE_TABS"); if (duringPrepare != null) duringPrepare.run(); fail(viewFailure); }
                    void refreshChrome() { events.add("REFRESH_CHROME"); }
                    void requestActivePreview(Object shell) { events.add("PREVIEW_REQUEST"); }
                    void hideSplash() { }
                    void reparentSplashToPageArea() { }
                    void cancelNavigationFocus() { }
                    void completeNavigationFocus() { }
                    void syncWebContentsVisibility() { }
                    // Rendering/mode effects are observed at the port, not simulated as Android views.
                    void showOrdinaryBrowser() { events.add("SHOW_ORDINARY"); }
                    void openWebApp(WebApp app) { events.add("OPEN_WEB_APP"); }
                    // Observe the offer dispatch; manifest, consent and fullscreen are other hosts' concerns.
                    int offerRefreshes;
                    void beginWebAppInstall() { }
                    void refreshWebAppOffer() { offerRefreshes++; }
                    void onWebAppInstallWindowFocusChanged(boolean hasFocus) { }
                    void wakePendingFullscreen() { }
                    void unregisterBrowserBack() { }
                    void quiesceForShutdown() { if (quiescing || cleanupComplete) return; quiescing = true; events.add("QUIESCE"); fail(quietFailure); }
                    void closeNativeView() {
                        if (cleanupComplete) return;
                        quiesceForShutdown(); closed = true; events.add("CLOSE"); closeCalls++;
                        fail(closeFailure); cleanupComplete = true;
                    }
                }
                static final class NativeBrowserRuntime implements BrowserProcessRuntime {
                    @RUNTIME@
                    NativeBrowserRuntime(NativeBrowserApplication app) { application = app; launch = app.requireLaunch(); }
                }
                static final class Fixture {
                    final NativeBrowserApplication app = new NativeBrowserApplication();
                    final NativeBrowserRuntime runtime = new NativeBrowserRuntime(app);
                    final NativeBrowserActivity activity = new NativeBrowserActivity();
                    final List<String> receipts = new ArrayList<>();
                    Fixture() { this(true); }
                    Fixture(boolean alreadyAttached) {
                        app.browserRuntime = runtime;
                        activity.systemApplication = app;
                        activity.retainedIntent = valid(app);
                        activity.manager = new ShellManager();
                        activity.pageContainer = new FrameLayout();
                        if (alreadyAttached) {
                            activity.application = app; activity.runtime = runtime; activity.generation = runtime.attach(activity);
                        }
                    }
                    void create(Intent delivery, Bundle savedState) {
                        activity.retainedIntent = delivery;
                        activity.createThroughAttach(savedState);
                    }
                    void drain() { runtime.beginDrain(outcome -> { events.add("CALLBACK"); receipts.add(outcome); }); }
                }
                static Intent valid(NativeBrowserApplication app) {
                    Intent intent = new Intent(); intent.extras = new Bundle();
                    intent.extras.values.put(ControlProtocol.SESSION, app.launch.sessionId);
                    intent.extras.values.put(ControlProtocol.NONCE, app.launch.nonce);
                    return intent;
                }
                static final String FIRST_TICKET = "67bdb5cd-57da-40bb-a563-56fff1e5b16e";
                static final String SECOND_TICKET = "8108b394-d4c8-4e97-87c2-7e6f35e5735e";
                static Intent webAppDelivery(NativeBrowserApplication app, Object ticket) {
                    Intent intent = valid(app);
                    intent.extras.values.put(ControlProtocol.WEB_APP_TICKET, ticket);
                    return intent;
                }
                static Bundle savedState(String session) {
                    Bundle state = new Bundle(); state.values.put(ControlProtocol.SESSION, session); return state;
                }
                record UnsafeDelivery(String label, java.util.function.Consumer<Intent> spoil) { }
                static List<UnsafeDelivery> unsafeEnvelope() {
                    return List.of(
                            new UnsafeDelivery("data URI", i -> i.data = "https://private.invalid/url-canary"),
                            new UnsafeDelivery("MIME type", i -> i.type = "text/plain"),
                            new UnsafeDelivery("selector", i -> i.selector = new Object()),
                            new UnsafeDelivery("clip data", i -> i.clip = new Object()),
                            new UnsafeDelivery("extra URL key", i -> i.extras.values.put("url", "https://private.invalid/url-canary")),
                            new UnsafeDelivery("command-line key at expected count", i -> {
                                i.extras.values.remove(ControlProtocol.NONCE);
                                i.extras.values.put("commandLineArgs", "switch-private-canary");
                            }),
                            new UnsafeDelivery("missing session", i -> i.extras.values.remove(ControlProtocol.SESSION)),
                            new UnsafeDelivery("wrong session", i -> i.extras.values.put(ControlProtocol.SESSION, "stale-session-private-canary")),
                            new UnsafeDelivery("wrong nonce", i -> i.extras.values.put(ControlProtocol.NONCE, "stale-nonce-private-canary")),
                            new UnsafeDelivery("non-string nonce", i -> i.extras.values.put(ControlProtocol.NONCE, 123)));
                }
                static void callbackOutcomes() {
                    for (Boolean confirmed : Arrays.asList(true, false, null)) {
                        reset(); Fixture f = new Fixture(); f.drain();
                        equal(BrowserHistoryStore.creations, 0, "native-only drain does not open an unused history store");
                        equal(events, List.of("QUIESCE", "FLUSH"), "no close/finish before native reply");
                        check(!f.activity.current(), "runtime revoked while quiescing");
                        equal(Handler.lastDelay, 5000L, "real five-second configured timeout extracted");
                        Runnable timeout = Handler.delayed.get(0);
                        ShellManager.pending.accept(confirmed);
                        equal(events, List.of("QUIESCE", "FLUSH", "CLOSE", "FINISH"), "close returns before finish; receipt remains deferred");
                        check(f.receipts.isEmpty(), "receipt is posted, not delivered inline");
                        check(Handler.delayed.isEmpty(), "timeout cancelled on native callback");
                        ShellManager.pending.accept(true); timeout.run();
                        equal(f.activity.closeCalls, 1, "duplicate/late completion cannot close twice");
                        equal(f.activity.finishes, 1, "duplicate/late completion cannot finish twice");
                        Handler.runPosted();
                        equal(f.receipts, List.of(Boolean.TRUE.equals(confirmed) ? "LOCAL_STORAGE_CONFIRMED_COOKIE_ACK" : "FAILED"), "native acknowledgment semantics unchanged");
                        f.activity.onDestroy();
                        equal(f.activity.closeCalls, 1, "later Android destruction is idempotent");
                    }
                }
                static void timeoutAndSynchronous() {
                    reset(); Fixture f = new Fixture(); f.drain();
                    Runnable timeout = Handler.delayed.get(0); timeout.run();
                    equal(events, List.of("QUIESCE", "FLUSH", "CLOSE", "FINISH"), "timeout closes before finish");
                    ShellManager.pending.accept(true); timeout.run(); Handler.runPosted();
                    equal(f.receipts, List.of("TIMED_OUT"), "late success never upgrades timeout");
                    equal(f.activity.finishes, 1, "timeout removes Activity once");
                    reset(); f = new Fixture(); ShellManager.synchronous = true; f.drain();
                    equal(f.activity.finishes, 1, "synchronous native completion finishes once");
                    Handler.runPosted(); equal(f.receipts, List.of("LOCAL_STORAGE_CONFIRMED_COOKIE_ACK"), "synchronous callback retains receipt");
                }
                static void exceptionalOutcomes() {
                    for (int mode = 0; mode < 8; mode++) {
                        reset(); Fixture f = new Fixture();
                        if (mode == 0) LibraryLoader.instance.initialized = false;
                        if (mode == 1) BrowserStartupController.instance.started = false;
                        if (mode == 2) ShellManager.failure = new IllegalStateException("exception-private-canary");
                        if (mode == 3) ShellManager.failure = new UnsatisfiedLinkError("exception-private-canary");
                        if (mode == 4) f.activity.quietFailure = new IllegalStateException("exception-private-canary");
                        if (mode == 5) f.activity.closeFailure = new IllegalStateException("exception-private-canary");
                        if (mode == 6) f.activity.closeFailure = new UnsatisfiedLinkError("exception-private-canary");
                        if (mode == 7) f.activity.failFinish = true;
                        f.drain();
                        if (mode >= 4) ShellManager.pending.accept(true);
                        check(f.receipts.isEmpty(), "exception/not-attempted receipt still posted");
                        Handler.runPosted();
                        equal(f.receipts, List.of(mode < 2 ? "NOT_ATTEMPTED" : "FAILED"), "all failure outcomes remain fail-closed");
                        equal(f.activity.finishes, mode == 5 || mode == 6 ? 0 : 1, "failed close never finishes unconfirmed teardown");
                        equal(f.activity.closeCalls, 1, "failure tears down once");
                        if (ShellManager.pending != null) ShellManager.pending.accept(false);
                        Handler.runPosted(); equal(f.receipts.size(), 1, "late callback cannot repeat failure receipt");
                    }
                    reset(); Fixture f = new Fixture(); f.drain();
                    try { f.drain(); throw new AssertionError("second drain accepted"); }
                    catch (IllegalStateException expected) { equal(expected.getMessage(), "DRAIN_ALREADY_STARTED", "repeated drain rejected"); }
                    NativeBrowserActivity second = new NativeBrowserActivity();
                    try { f.runtime.attach(second); throw new AssertionError("attach during drain accepted"); }
                    catch (IllegalStateException expected) { equal(expected.getMessage(), "RUNTIME_DRAINING", "no attach during shutdown"); }
                    ShellManager.pending.accept(true); Handler.runPosted();
                    reset(); f = new Fixture(); f.drain(); f.runtime.generation++;
                    ShellManager.pending.accept(true); Handler.delayed.get(0).run(); Handler.runPosted();
                    equal(f.activity.finishes, 0, "stale generation cannot finish a view");
                    check(f.receipts.isEmpty(), "stale generation cannot emit a receipt");
                    reset(); NativeBrowserRuntime noView = new NativeBrowserRuntime(new NativeBrowserApplication());
                    List<String> receipts = new ArrayList<>(); noView.beginDrain(receipts::add);
                    ShellManager.pending.accept(true); Handler.runPosted();
                    equal(receipts, List.of("LOCAL_STORAGE_CONFIRMED_COOKIE_ACK"), "viewless runtime still reports native outcome");
                    equal(events, List.of("FLUSH"), "viewless drain invents no Activity teardown");
                }
                static void waitingForStorage(Fixture f, String label) {
                    equal(f.activity.closeCalls, 0, label + " keeps Shells alive");
                    equal(f.activity.finishes, 0, label + " cannot finish Activity");
                    check(f.receipts.isEmpty(), label + " cannot report a drain result");
                    check(f.runtime.drainTimeout != null && Handler.delayed.contains(f.runtime.drainTimeout),
                            label + " retains the bounded timeout");
                    boolean[] responsive = {false};
                    f.runtime.main.post(() -> responsive[0] = true);
                    Handler.runPosted();
                    check(responsive[0], label + " returns to the main-loop host without waiting synchronously");
                    check(f.receipts.isEmpty(), label + " stays pending across another main-loop turn");
                }
                static void completedStorage(Fixture f, String outcome, String label) {
                    equal(f.activity.closeCalls, 1, label + " closes exactly once");
                    equal(f.activity.finishes, 1, label + " finishes exactly once");
                    check(f.receipts.isEmpty(), label + " posts rather than delivering the result inline");
                    check(Handler.delayed.isEmpty(), label + " cancels the timeout");
                    Handler.runPosted();
                    equal(f.receipts, List.of(outcome), label + " reports the expected outcome once");
                }
                static void dualStorageOutcomes() {
                    for (boolean nativeFirst : new boolean[] {false, true}) {
                        for (Boolean nativeConfirmed : Arrays.asList(true, false, null)) {
                            for (boolean historyConfirmed : new boolean[] {false, true}) {
                                reset(); Fixture f = new Fixture(); BrowserHistoryStore history = f.runtime.historyStore();
                                f.drain();
                                equal(events, List.of("QUIESCE", "HISTORY_FLUSH", "FLUSH"), "both storage attempts start before close");
                                equal(history.flushCalls, 1, "history durability callback requested once");
                                check(!f.activity.current(), "two-storage drain immediately revokes Activity generation");
                                equal(Handler.lastDelay, 5000L, "two-storage fence retains the real five-second timeout");
                                Runnable timeout = Handler.delayed.get(0);
                                waitingForStorage(f, "neither storage callback");
                                if (nativeFirst) {
                                    ShellManager.pending.accept(nativeConfirmed); ShellManager.pending.accept(nativeConfirmed);
                                } else {
                                    history.reply(historyConfirmed); history.reply(historyConfirmed);
                                }
                                waitingForStorage(f, nativeFirst ? "native-only completion" : "history-only completion");
                                if (nativeFirst) history.reply(historyConfirmed);
                                else ShellManager.pending.accept(nativeConfirmed);
                                equal(events, List.of("QUIESCE", "HISTORY_FLUSH", "FLUSH", "CLOSE", "FINISH"),
                                        "only the second storage completion permits ordered teardown");
                                // Conflicting duplicates after completion must not change the first delivered result.
                                ShellManager.pending.accept(!Boolean.TRUE.equals(nativeConfirmed));
                                history.reply(!historyConfirmed); timeout.run();
                                String expected = historyConfirmed && Boolean.TRUE.equals(nativeConfirmed)
                                        ? "LOCAL_STORAGE_CONFIRMED_COOKIE_ACK" : "FAILED";
                                completedStorage(f, expected, "two-completion barrier");
                                ShellManager.pending.accept(true); history.reply(true); timeout.run(); Handler.runPosted();
                                equal(f.receipts.size(), 1, "late duplicate callbacks cannot redeliver");
                                f.activity.onDestroy();
                                equal(f.activity.closeCalls, 1, "Android destruction after dual completion remains idempotent");
                            }
                        }
                    }
                }
                static void synchronousStorageCombinations() {
                    for (boolean historySync : new boolean[] {false, true}) {
                        for (boolean nativeSync : new boolean[] {false, true}) {
                            reset(); Fixture f = new Fixture(); BrowserHistoryStore history = f.runtime.historyStore();
                            history.synchronous = historySync; ShellManager.synchronous = nativeSync;
                            f.drain();
                            if (!historySync || !nativeSync) waitingForStorage(f, "one or both synchronous callbacks absent");
                            if (!nativeSync) {
                                ShellManager.pending.accept(true);
                                if (!historySync) waitingForStorage(f, "synchronous matrix still waiting for history");
                            }
                            if (!historySync) history.reply(true);
                            completedStorage(f, "LOCAL_STORAGE_CONFIRMED_COOKIE_ACK", "synchronous callback ordering");
                            equal(history.flushCalls, 1, "synchronous history fence is requested once");
                        }
                    }
                }
                static void historyInitializationAndInflightWaits() {
                    for (int phase = 0; phase < 3; phase++) {
                        reset(); Fixture f = new Fixture(); BrowserHistoryStore history = f.runtime.historyStore();
                        history.initializing = phase != 1; history.writeInFlight = phase != 0;
                        f.drain(); ShellManager.pending.accept(true);
                        waitingForStorage(f, "host-controlled history initialization/write pending");
                        if (history.initializing) {
                            history.completeInitialization();
                            if (history.writeInFlight) waitingForStorage(f, "initialization done but earlier history write still pending");
                        }
                        if (history.writeInFlight) history.completeWrite();
                        completedStorage(f, "LOCAL_STORAGE_CONFIRMED_COOKIE_ACK", "history callback after pending work");
                    }
                }
                static void storageFailuresAndMissingNative() {
                    for (int mode = 0; mode < 6; mode++) {
                        for (boolean historyConfirmed : new boolean[] {false, true}) {
                            reset(); Fixture f = new Fixture(); BrowserHistoryStore history = f.runtime.historyStore();
                            if (mode == 0) LibraryLoader.instance.initialized = false;
                            if (mode == 1) BrowserStartupController.instance.started = false;
                            if (mode == 2) ShellManager.failure = new IllegalStateException("exception-private-canary");
                            if (mode == 3) ShellManager.failure = new UnsatisfiedLinkError("exception-private-canary");
                            if (mode == 4) f.activity.quietFailure = new IllegalStateException("exception-private-canary");
                            if (mode == 5) f.activity.quietFailure = new UnsatisfiedLinkError("exception-private-canary");
                            f.drain();
                            equal(history.flushCalls, 1, "history fence attempted despite missing/failed native or quiescence");
                            if (mode < 2) {
                                check(ShellManager.pending == null && !events.contains("FLUSH"), "uninitialized native runner is not entered");
                            } else {
                                check(events.contains("FLUSH"), "native flush attempted even after quiesce failure");
                            }
                            if (mode >= 4) ShellManager.pending.accept(true);
                            waitingForStorage(f, "native terminal state cannot bypass pending history");
                            history.reply(historyConfirmed);
                            completedStorage(f, mode < 2 && historyConfirmed ? "NOT_ATTEMPTED" : "FAILED",
                                    "history plus native/quiescence failure");
                        }
                    }
                    for (Throwable failure : new Throwable[] {new IllegalStateException("exception-private-canary"),
                            new UnsatisfiedLinkError("exception-private-canary")}) {
                        reset(); Fixture f = new Fixture(); BrowserHistoryStore history = f.runtime.historyStore();
                        history.failure = failure; f.drain();
                        equal(history.flushCalls, 1, "throwing history flush was attempted");
                        check(ShellManager.pending != null, "history throw cannot skip best-effort native flush");
                        waitingForStorage(f, "history failure still awaits native");
                        ShellManager.pending.accept(true);
                        completedStorage(f, "FAILED", "throwing history fence cannot report success");
                    }
                }
                static void dualStorageTimeouts() {
                    for (int replied = 0; replied < 3; replied++) {
                        reset(); Fixture f = new Fixture(); BrowserHistoryStore history = f.runtime.historyStore();
                        f.drain(); Runnable timeout = Handler.delayed.get(0);
                        if (replied == 1) ShellManager.pending.accept(true);
                        if (replied == 2) history.reply(true);
                        waitingForStorage(f, "timeout with zero or one storage replies");
                        timeout.run();
                        ShellManager.pending.accept(false); history.reply(false); timeout.run();
                        completedStorage(f, "TIMED_OUT", "common two-storage deadline");
                        ShellManager.pending.accept(true); history.reply(true); timeout.run(); Handler.runPosted();
                        equal(f.activity.closeCalls, 1, "late storage callback cannot reclose timed-out Shells");
                        equal(f.activity.finishes, 1, "late storage callback cannot refinish timed-out Activity");
                        equal(f.receipts, List.of("TIMED_OUT"), "late success never upgrades the two-storage timeout");
                    }
                    reset(); Fixture stale = new Fixture(); BrowserHistoryStore history = stale.runtime.historyStore();
                    stale.drain(); Runnable timeout = Handler.delayed.get(0);
                    ShellManager.pending.accept(true); stale.runtime.generation++; history.reply(true); timeout.run(); Handler.runPosted();
                    equal(stale.activity.closeCalls, 0, "stale two-storage generation cannot close a view");
                    equal(stale.activity.finishes, 0, "stale history completion cannot finish a view");
                    check(stale.receipts.isEmpty(), "stale history completion/timeout cannot deliver a receipt");
                }
                static void runtimeHistoryOwnership() {
                    reset(); Fixture f = new Fixture();
                    check(f.runtime.historyStore == null, "runtime does not eagerly initialize history");
                    equal(BrowserHistoryStore.creations, 0, "construct/attach alone opens no history");
                    BrowserHistoryStore history = f.runtime.historyStore();
                    check(history == f.runtime.historyStore(), "repeated accessor returns the same runtime store");
                    check(history.context == f.app, "history lifetime uses the Application rather than Activity");
                    equal(history.profileId, f.app.launch.profile.id, "runtime store uses the immutable launch profile ID");
                    f.activity.onDestroy();
                    NativeBrowserActivity replacement = new NativeBrowserActivity();
                    replacement.application = f.app; replacement.runtime = f.runtime;
                    replacement.manager = new ShellManager(); replacement.pageContainer = new FrameLayout();
                    replacement.generation = f.runtime.attach(replacement);
                    check(f.runtime.historyStore() == history, "Activity recreation reuses the same history pipeline");
                    equal(BrowserHistoryStore.creations, 1, "recreation cannot open a second history writer");
                    f.drain();
                    try { f.runtime.historyStore(); throw new AssertionError("draining runtime allowed history access"); }
                    catch (IllegalStateException expected) {
                        equal(expected.getMessage(), "HISTORY_RUNTIME_DRAINING", "drain rejects late history accessor");
                    }
                    equal(BrowserHistoryStore.creations, 1, "rejected drain accessor cannot create another store");
                    ShellManager.pending.accept(true);
                    equal(replacement.closeCalls, 0, "replacement Activity also waits for history fence");
                    history.reply(true); Handler.runPosted();
                    equal(replacement.closeCalls, 1, "drain closes only the replacement owner");
                    equal(replacement.finishes, 1, "drain finishes only the replacement owner");
                    equal(f.activity.closeCalls, 1, "drain never recloses the destroyed Activity");
                    equal(f.activity.finishes, 0, "drain never finishes the old Activity record");
                    equal(f.receipts, List.of("LOCAL_STORAGE_CONFIRMED_COOKIE_ACK"), "recreated runtime reports both storage completions");
                    reset(); NativeBrowserRuntime viewless = new NativeBrowserRuntime(new NativeBrowserApplication());
                    history = viewless.historyStore(); List<String> receipts = new ArrayList<>();
                    viewless.beginDrain(receipts::add); ShellManager.pending.accept(true); Handler.runPosted();
                    check(receipts.isEmpty(), "viewless runtime still waits for its opened history store");
                    history.reply(true); Handler.runPosted();
                    equal(receipts, List.of("LOCAL_STORAGE_CONFIRMED_COOKIE_ACK"), "viewless runtime waits for both stores");
                    equal(events, List.of("HISTORY_FLUSH", "FLUSH"), "viewless history drain invents no Activity teardown");
                    reset(); Fixture wrongThread = new Fixture(); Looper.current = new Looper();
                    try {
                        try { wrongThread.runtime.historyStore(); throw new AssertionError("off-main history access accepted"); }
                        catch (IllegalStateException expected) { equal(expected.getMessage(), "NATIVE_RUNTIME_WRONG_THREAD", "history getter retains main-thread guard"); }
                        try { wrongThread.drain(); throw new AssertionError("off-main drain accepted"); }
                        catch (IllegalStateException expected) { equal(expected.getMessage(), "NATIVE_RUNTIME_WRONG_THREAD", "drain retains main-thread guard"); }
                    } finally { Looper.current = Looper.main; }
                    check(!wrongThread.runtime.draining && wrongThread.runtime.historyStore == null,
                            "off-main rejection precedes history creation or drain state mutation");
                    equal(BrowserHistoryStore.creations, 0, "off-main access cannot create a history store");
                }
                static void rejectedCreateRecords() {
                    reset(); NativeBrowserActivity rejected = new NativeBrowserActivity();
                    rejected.rejectCreate(false);
                    equal(events, List.of("TOAST", "RETURN_MANAGER", "FINISH"), "unattached create rejection returns before finish");
                    equal(rejected.closeCalls, 0, "no early native close for rejected record");
                    equal(rejected.flags, 3, "manager return flags unchanged");
                    for (boolean attached : new boolean[] {false, true}) {
                        for (boolean closed : new boolean[] {false, true}) {
                            reset(); Fixture owner = new Fixture();
                            NativeBrowserActivity activity = attached ? owner.activity : new NativeBrowserActivity();
                            activity.application = owner.app; activity.runtime = owner.runtime;
                            activity.closed = closed; activity.quiescing = !closed;
                            activity.rejectCreate(attached);
                            equal(events, List.of(), "closed/quiescing create catch cannot navigate or finish, regardless of attach flag");
                            equal(owner.activity.closeCalls, 0, "create rejection cannot destroy prior runtime owner");
                        }
                    }
                    reset(); Fixture draining = new Fixture(); draining.drain();
                    NativeBrowserActivity duringDrain = new NativeBrowserActivity();
                    duringDrain.application = draining.app; duringDrain.runtime = draining.runtime;
                    try { draining.runtime.attach(duringDrain); throw new AssertionError("draining runtime accepted create"); }
                    catch (IllegalStateException expected) { equal(expected.getMessage(), "RUNTIME_DRAINING", "draining create is rejected before attach"); duringDrain.rejectCreate(false); }
                    equal(duringDrain.finishes, 1, "only newly unattached rejected record is finished");
                    equal(draining.activity.finishes, 0, "draining owner waits for native callback");
                    equal(draining.activity.closeCalls, 0, "draining owner Shells stay alive before callback");
                    duringDrain.onDestroy();
                    equal(draining.activity.closeCalls, 0, "rejected record destruction cannot close captured drain owner");
                    ShellManager.pending.accept(true); Handler.runPosted();
                    equal(draining.activity.finishes, 1, "captured owner finishes only after native close");
                    equal(draining.receipts, List.of("LOCAL_STORAGE_CONFIRMED_COOKIE_ACK"), "rejected record detach does not invalidate pending drain");
                    reset(); Fixture f = new Fixture(); f.activity.rejectCreate(true);
                    equal(events, List.of("TOAST", "RETURN_MANAGER"), "post-attach rejection retains Activity and Shell owner");
                    check(f.activity.current(), "post-attach rejection does not revoke runtime");
                    reset(); f = new Fixture(); NativeBrowserActivity second = new NativeBrowserActivity();
                    second.application = f.app; second.runtime = f.runtime;
                    try { f.runtime.attach(second); throw new AssertionError("busy runtime accepted new view"); }
                    catch (IllegalStateException expected) { equal(expected.getMessage(), "RUNTIME_VIEW_BUSY", "busy owner stays attached"); second.rejectCreate(false); }
                    second.onDestroy();
                    check(f.activity.current(), "destroying rejected new record cannot detach existing owner");
                    equal(f.activity.closeCalls, 0, "existing owner native Shells are untouched");
                    equal(f.activity.finishes, 0, "existing owner is never finished");
                    reset(); rejected = new NativeBrowserActivity(); rejected.failNavigation = true;
                    try { rejected.rejectCreate(false); throw new AssertionError("manager failure swallowed"); }
                    catch (IllegalStateException expected) { equal(rejected.finishes, 0, "finish requires successful manager return"); }
                }
            """, """
                static void coldIntentAdmission() {
                    reset(); Fixture ordinary = new Fixture(false); Intent base = valid(ordinary.app);
                    ordinary.create(base, null);
                    check(ordinary.activity.current(), "ordinary cold launch attaches its runtime");
                    check(ordinary.activity.getIntent() == base, "ordinary cold launch keeps its original base Intent");
                    equal(ordinary.activity.pendingWebAppTicket, null, "ordinary cold launch cannot queue a ticket");
                    equal(events, List.of(), "ordinary cold admission does not set a new Intent or navigate");

                    for (boolean restored : new boolean[] {false, true}) {
                        reset(); Fixture f = new Fixture(false);
                        Intent delivery = webAppDelivery(f.app, FIRST_TICKET).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
                        WebAppRegistry.available.add(FIRST_TICKET);
                        f.create(delivery, restored ? savedState(f.app.launch.sessionId) : null);
                        check(f.activity.current(), "safe cold app envelope attaches the same native runtime");
                        Intent retained = f.activity.getIntent();
                        check(retained != delivery, "cold app delivery is stripped from a copy");
                        equal(retained.getExtras().values, valid(f.app).getExtras().values,
                                "cold retained Intent has exactly the ordinary session/nonce extras");
                        equal(retained.flags, delivery.flags, "cold copy preserves the ordinary Intent flags");
                        equal(delivery.getExtras().getString(ControlProtocol.WEB_APP_TICKET), FIRST_TICKET,
                                "cold stripping does not mutate the delivered Intent");
                        equal(f.activity.pendingWebAppTicket, restored ? null : FIRST_TICKET,
                                "only fresh cold creation queues the optional ticket");
                        equal(events, List.of("SET_INTENT"), "cold admission does not open an app or navigate");
                        equal(WebAppRegistry.probed, restored ? List.of() : List.of(FIRST_TICKET),
                                "only fresh cold creation probes ticket eligibility");
                        check(WebAppRegistry.available.contains(FIRST_TICKET) && WebAppRegistry.taken.isEmpty()
                                && WebAppRegistry.revoked.isEmpty(), "cold admission never consumes or revokes the ticket");
                        equal(logs, List.of("LIFECYCLE_ON_CREATE_INTENT_VALIDATE", "LIFECYCLE_ON_CREATE_SAVED_STATE_SESSION_CHECK",
                                "LIFECYCLE_ON_CREATE_RUNTIME_ATTACH", "LIFECYCLE_ON_CREATE_RUNTIME_ATTACHED"), "cold admission markers stay ordered");
                    }

                    for (String reason : List.of("unknown", "expired", "registry unavailable")) {
                        reset(); Fixture f = new Fixture(false);
                        if (reason.equals("expired")) {
                            WebAppRegistry.available.add(FIRST_TICKET);
                            WebAppRegistry.expired.add(FIRST_TICKET);
                        }
                        WebAppRegistry.probeFailure = reason.equals("registry unavailable");
                        f.create(webAppDelivery(f.app, FIRST_TICKET), null);
                        equal(WebAppRegistry.probed, List.of(FIRST_TICKET), reason + " cold handoff is checked once");
                        check(f.activity.current() && !f.activity.getIntent().hasExtra(ControlProtocol.WEB_APP_TICKET)
                                && f.activity.pendingWebAppTicket == null, reason + " cold handoff starts ordinary browser without queueing");
                        f.activity.onResume(); f.activity.succeedAsyncStartup(); Handler.runPosted();
                        check(!events.contains("OPEN_WEB_APP") && WebAppRegistry.taken.isEmpty()
                                && WebAppRegistry.revoked.isEmpty(), reason + " cold ticket never reaches the consuming path");
                    }
                    for (UnsafeDelivery unsafe : unsafeEnvelope()) {
                        reset(); Fixture f = new Fixture(false); Intent delivery = webAppDelivery(f.app, FIRST_TICKET);
                        unsafe.spoil().accept(delivery);
                        assertColdRejection(f, delivery, null, unsafe.label());
                    }
                    reset(); Fixture f = new Fixture(false);
                    assertColdRejection(f, webAppDelivery(f.app, "not-a-ticket"), null, "malformed ticket");
                    reset(); f = new Fixture(false);
                    assertColdRejection(f, webAppDelivery(f.app, FIRST_TICKET), savedState("stale-session"), "stale saved session");
                }
                static void assertColdRejection(Fixture f, Intent delivery, Bundle state, String label) {
                    f.create(delivery, state);
                    equal(f.app.runtimeRequests, 0, label + " is rejected before runtime lookup or attach");
                    check(f.runtime.view == null && f.runtime.generation == 0, label + " acquires no native runtime owner");
                    check(f.activity.getIntent() == delivery && f.activity.pendingWebAppTicket == null,
                            label + " cannot rewrite the base or queue a ticket");
                    equal(events, List.of("TOAST", "RETURN_MANAGER", "FINISH"), label + " retains cold rejection behavior");
                    check(logs.contains("LIFECYCLE_ON_CREATE_REJECTED"), label + " has a fixed rejection phase");
                }
                static void ordinaryContinue() {
                    reset(); Fixture f = new Fixture(); long generation = f.activity.generation;
                    f.activity.uiBuilt = true; f.activity.resumed = true;
                    WebAppRegistry.available.add(FIRST_TICKET);
                    f.activity.onNewIntent(webAppDelivery(f.app, FIRST_TICKET));
                    equal(f.activity.pendingWebAppTicket, FIRST_TICKET, "pending PWA exists before ordinary Continue");
                    Intent ordinary = valid(f.app);
                    f.activity.onNewIntent(ordinary);
                    equal(events, List.of("REVOKE_TICKET", "SHOW_ORDINARY", "SET_INTENT"),
                            "ordinary Continue revokes the pending PWA and selects browser before retaining Intent or refreshing");
                    check(f.activity.getIntent() == ordinary, "ordinary Continue retains the validated Intent");
                    equal(f.activity.pendingWebAppTicket, null, "ordinary Continue clears pending PWA before the posted pass");
                    equal(WebAppRegistry.revoked, List.of(FIRST_TICKET), "ordinary Continue revokes exactly the pending ticket once");
                    equal(f.activity.generation, generation, "Continue does not attach again");
                    check(f.activity.current(), "Continue preserves current runtime");
                    equal(Handler.posted.size(), 1, "Continue coalesces with the already-scheduled PWA refresh");
                    Handler.runPosted();
                    equal(events, List.of("REVOKE_TICKET", "SHOW_ORDINARY", "SET_INTENT", "REFRESH_CHROME"),
                            "only the ordinary browser refresh runs after superseding PWA");
                    check(WebAppRegistry.taken.isEmpty(), "superseded ticket is never consumed");
                    f.activity.onNewIntent(valid(f.app)); Handler.runPosted();
                    equal(WebAppRegistry.revoked, List.of(FIRST_TICKET), "subsequent ordinary Continue cannot revoke the same ticket again");

                    for (UnsafeDelivery unsafe : unsafeEnvelope()) {
                        reset(); f = new Fixture(); Intent bad = valid(f.app); unsafe.spoil().accept(bad);
                        assertOrdinaryRejection(f, bad, unsafe.label());
                    }
                    reset(); f = new Fixture(); assertOrdinaryRejection(f, null, "null Intent");
                    reset(); f = new Fixture(); assertOrdinaryRejection(f, new Intent(), "missing extras");
                    reset(); f = new Fixture(); f.app.activated = false;
                    assertOrdinaryRejection(f, valid(f.app), "unactivated process");
                    reset(); f = new Fixture(); f.app.frozen = false;
                    assertOrdinaryRejection(f, valid(f.app), "frozen command line mismatch");
                    reset(); f = new Fixture(); f.runtime.generation++;
                    assertOrdinaryRejection(f, valid(f.app), "stale Activity generation");
                }
                static void assertOrdinaryRejection(Fixture f, Intent invalid, String label) {
                    Intent retained = f.activity.getIntent();
                    f.activity.onNewIntent(invalid);
                    equal(events, List.of("TOAST", "RETURN_MANAGER"), label + " uses legacy ordinary startup failure");
                    equal(f.activity.finishes, 0, label + " never finishes the active record");
                    check(f.activity.getIntent() == retained && Handler.posted.isEmpty(), label + " cannot replace the Intent or post a refresh");
                    equal(logs, List.of("LIFECYCLE_ON_NEW_INTENT_REJECTED"), label + " has the fixed reuse rejection log");
                }
                static void optionalDeliveryRejectedSoft() {
                    for (UnsafeDelivery unsafe : unsafeEnvelope()) {
                        reset(); Fixture f = new Fixture(); Intent delivery = webAppDelivery(f.app, SECOND_TICKET);
                        unsafe.spoil().accept(delivery);
                        assertSoftRejection(f, delivery, unsafe.label());
                    }
                    for (Object value : Arrays.asList(null, 42, "", "https://private.invalid/url-canary",
                            "67bdb5cd-57da-10bb-a563-56fff1e5b16e", "67bdb5cd-57da-40bb-7563-56fff1e5b16e",
                            "67BDB5CD-57DA-40BB-A563-56FFF1E5B16E")) {
                        reset(); Fixture f = new Fixture();
                        assertSoftRejection(f, webAppDelivery(f.app, value), "present but invalid ticket value " + value);
                    }
                    reset(); Fixture f = new Fixture(); Intent unreadable = webAppDelivery(f.app, SECOND_TICKET);
                    unreadable.unreadableExtras = true;
                    assertSoftRejection(f, unreadable, "unreadable extras");
                    reset(); f = new Fixture(); f.app.activated = false;
                    assertSoftRejection(f, webAppDelivery(f.app, SECOND_TICKET), "unactivated optional delivery");
                    reset(); f = new Fixture(); f.app.frozen = false;
                    assertSoftRejection(f, webAppDelivery(f.app, SECOND_TICKET), "optional delivery against a changed command line");
                    reset(); f = new Fixture(); f.runtime.generation++;
                    assertSoftRejection(f, webAppDelivery(f.app, SECOND_TICKET), "optional delivery to a stale Activity generation");
                }
                static void assertSoftRejection(Fixture f, Intent invalid, String label) {
                    Intent retained = f.activity.getIntent();
                    f.activity.uiBuilt = true; f.activity.resumed = true;
                    f.activity.pendingWebAppTicket = FIRST_TICKET;
                    f.activity.onNewIntent(invalid);
                    check(Handler.posted.isEmpty(), label + " does not request a chrome pass");
                    equal(events, List.of(), label + " cannot navigate, manipulate overlays, replace Intent or drain");
                    check(f.activity.getIntent() == retained && !f.runtime.draining, label + " preserves the retained browser");
                    equal(f.activity.pendingWebAppTicket, FIRST_TICKET, label + " leaves existing pending authority alone");
                    check(WebAppRegistry.revoked.isEmpty() && WebAppRegistry.taken.isEmpty(), label + " cannot touch the registry");
                }
                static void warmTicketConsumption() {
                    reset(); Fixture f = new Fixture(); f.activity.uiBuilt = true;
                    Intent retained = f.activity.getIntent();
                    Intent delivery = webAppDelivery(f.app, FIRST_TICKET);
                    WebAppRegistry.available.add(FIRST_TICKET);
                    f.activity.onNewIntent(delivery);
                    f.activity.onNewIntent(delivery);
                    equal(f.app.frozenChecks, 2, "duplicate optional envelopes still verify frozen setup");
                    equal(f.activity.pendingWebAppTicket, FIRST_TICKET, "valid optional delivery queues without revoking the same pending token");
                    equal(events, List.of(), "warm optional admission neither opens nor writes the base Intent inline");
                    equal(Handler.posted.size(), 1, "duplicate optional envelopes coalesce the posted chrome pass");
                    equal(WebAppRegistry.probed, List.of(FIRST_TICKET, FIRST_TICKET), "admission checks both deliveries without burning the token");
                    Handler.runPosted();
                    equal(f.activity.pendingWebAppTicket, FIRST_TICKET, "posted chrome pass keeps a ticket while backgrounded");
                    check(WebAppRegistry.taken.isEmpty(), "background even with ready UI cannot take the ticket");
                    equal(f.activity.offerRefreshes, 0, "background chrome pass cannot dispatch offer discovery");
                    f.activity.onResume();
                    check(WebAppRegistry.taken.isEmpty(), "onResume does not consume directly on its callback stack");
                    equal(f.activity.offerRefreshes, 0, "onResume does not dispatch offer discovery inline");
                    events.clear(); Handler.runPosted();
                    equal(f.activity.offerRefreshes, 1, "the posted foreground pass dispatches offer reconciliation once");
                    equal(WebAppRegistry.taken, List.of(FIRST_TICKET), "posted foreground pass consumes the queued token once");
                    equal(events, List.of("TAKE_TICKET", "OPEN_WEB_APP", "REFRESH_CHROME"), "the ready foreground pass alone opens the app");
                    equal(f.activity.pendingWebAppTicket, null, "pending capability is removed after the first attempt");
                    check(f.activity.getIntent() == retained && f.activity.current(), "opening an app leaves the same base Intent and runtime");

                    events.clear(); f.activity.requestChromeRefresh(); Handler.runPosted();
                    equal(events, List.of("REFRESH_CHROME"), "subsequent chrome refresh cannot take the consumed slot again");
                    // Replays and unknown tokens never reach the posted consumer.
                    for (Intent stale : List.of(delivery, webAppDelivery(f.app, SECOND_TICKET))) {
                        events.clear(); f.activity.onNewIntent(stale);
                        equal(events, List.of(), "replayed or unavailable token cannot navigate on admission");
                        equal(Handler.posted.size(), 0, "replay or miss does not schedule or poll chrome");
                        Handler.runPosted();
                        equal(events, List.of(), "replay or miss cannot take, navigate, change mode, drain or replace base Intent");
                        equal(WebAppRegistry.taken, List.of(FIRST_TICKET), "only the original valid delivery reached the consuming path");
                        equal(f.activity.pendingWebAppTicket, null, "registry miss never queues a retry");
                        check(f.activity.getIntent() == retained && f.activity.current(), "registry miss preserves the live browser owner");
                    }

                    reset(); f = new Fixture(); f.activity.uiBuilt = true; f.activity.resumed = true; f.activity.windowFocus = false;
                    WebAppRegistry.available.add(FIRST_TICKET);
                    f.activity.onNewIntent(webAppDelivery(f.app, FIRST_TICKET));
                    Handler.runPosted();
                    equal(f.activity.pendingWebAppTicket, FIRST_TICKET, "the window-focus gate preserves the queued handoff");
                    check(WebAppRegistry.taken.isEmpty(), "live implementation also defers while the window lacks focus");
                    f.activity.onWindowFocusChanged(true);
                    check(WebAppRegistry.taken.isEmpty(), "focus gain does not consume inline");
                    Handler.runPosted();
                    equal(WebAppRegistry.taken, List.of(FIRST_TICKET), "focus gain schedules the deferred ticket pass");

                    for (boolean registryUnavailable : new boolean[] {false, true}) {
                        reset(); f = new Fixture(); f.activity.uiBuilt = true; f.activity.resumed = true;
                        retained = f.activity.getIntent(); WebAppRegistry.available.add(FIRST_TICKET);
                        WebAppRegistry.takeFailure = registryUnavailable;
                        if (!registryUnavailable) WebAppShortcuts.state = WebAppShortcuts.PinState.NOT_PINNED;
                        f.activity.onNewIntent(webAppDelivery(f.app, FIRST_TICKET)); Handler.runPosted();
                        equal(events, List.of("TAKE_TICKET", "REFRESH_CHROME"), "registry error or unpinned shortcut cannot open or mutate the base Intent");
                        check(f.activity.current() && f.activity.getIntent() == retained && f.activity.pendingWebAppTicket == null,
                                "registry error or unpinned shortcut leaves the live browser with no pending retry");
                    }

                    reset(); f = new Fixture(); f.activity.uiBuilt = true; f.activity.resumed = true;
                    WebAppRegistry.available.add(FIRST_TICKET);
                    f.activity.onNewIntent(webAppDelivery(f.app, FIRST_TICKET));
                    // The registry's single slot may be replaced before the next Android delivery.
                    WebAppRegistry.available.remove(FIRST_TICKET);
                    WebAppRegistry.available.add(SECOND_TICKET);
                    f.activity.onNewIntent(webAppDelivery(f.app, SECOND_TICKET));
                    f.activity.onNewIntent(webAppDelivery(f.app, FIRST_TICKET));
                    equal(f.activity.pendingWebAppTicket, SECOND_TICKET, "superseded delivery cannot replace the newest pending token");
                    equal(WebAppRegistry.revoked, List.of(FIRST_TICKET), "new optional delivery revokes exactly its predecessor, not the new token");
                    Handler.runPosted();
                    equal(WebAppRegistry.taken, List.of(SECOND_TICKET), "only the newest pending ticket reaches the consumer");
                    equal(events, List.of("REVOKE_TICKET", "TAKE_TICKET", "OPEN_WEB_APP", "REFRESH_CHROME"),
                            "only the newest handoff opens after the posted pass");

                    reset(); f = new Fixture(); f.activity.uiBuilt = true; f.activity.resumed = true;
                    WebAppRegistry.available.add(FIRST_TICKET);
                    f.activity.onNewIntent(webAppDelivery(f.app, FIRST_TICKET));
                    f.runtime.generation++;
                    Handler.runPosted();
                    check(WebAppRegistry.taken.isEmpty(), "queued work cannot take a ticket after its runtime ownership expires");
                    equal(events, List.of(), "stale posted work cannot open, refresh or navigate");
                }
                static void ineligibleTicketCannotDisplacePending() {
                    for (String reason : List.of("unknown", "expired", "probe failed")) {
                        reset(); Fixture f = new Fixture(); f.activity.uiBuilt = true; f.activity.resumed = true;
                        f.activity.windowFocus = false;
                        Intent retained = f.activity.getIntent();
                        WebAppRegistry.available.add(FIRST_TICKET);
                        f.activity.onNewIntent(webAppDelivery(f.app, FIRST_TICKET));
                        Handler.runPosted(); events.clear();
                        if (reason.equals("expired")) {
                            WebAppRegistry.available.add(SECOND_TICKET);
                            WebAppRegistry.expired.add(SECOND_TICKET);
                        }
                        WebAppRegistry.probeFailure = reason.equals("probe failed");
                        f.activity.onNewIntent(webAppDelivery(f.app, SECOND_TICKET));
                        equal(WebAppRegistry.probed, List.of(FIRST_TICKET, SECOND_TICKET), reason + " delivery is checked exactly once");
                        equal(f.activity.pendingWebAppTicket, FIRST_TICKET, reason + " delivery cannot displace the waiting ticket");
                        equal(Handler.posted.size(), 0, reason + " delivery adds no posted work");
                        check(WebAppRegistry.taken.isEmpty() && WebAppRegistry.revoked.isEmpty() && events.isEmpty()
                                && f.activity.getIntent() == retained, reason + " delivery cannot consume, revoke or change the ordinary Intent");
                        f.activity.onWindowFocusChanged(true); Handler.runPosted();
                        equal(WebAppRegistry.taken, List.of(FIRST_TICKET), "focus gain takes only the original waiting token");
                        equal(events, List.of("TAKE_TICKET", "OPEN_WEB_APP", "REFRESH_CHROME"), "the original handoff still opens exactly once");
                    }

                    reset(); Fixture f = new Fixture(); f.activity.uiBuilt = true; f.activity.resumed = true;
                    WebAppRegistry.available.add(FIRST_TICKET);
                    f.activity.onNewIntent(webAppDelivery(f.app, FIRST_TICKET));
                    WebAppRegistry.expired.add(FIRST_TICKET);
                    Handler.runPosted();
                    equal(WebAppRegistry.taken, List.of(FIRST_TICKET), "eligibility at delivery never substitutes for the later exact take");
                    equal(events, List.of("TAKE_TICKET", "REFRESH_CHROME"), "expiry after admission cannot open an app or poll");
                    check(f.activity.pendingWebAppTicket == null && Handler.posted.isEmpty(), "expired claim is cleared without retry");
                }
                static void coldTicketConsumptionWhenReady() {
                    for (boolean restored : new boolean[] {false, true}) {
                        reset(); Fixture f = new Fixture(false);
                        WebAppRegistry.available.add(FIRST_TICKET);
                        f.create(webAppDelivery(f.app, FIRST_TICKET), restored ? savedState(f.app.launch.sessionId) : null);
                        f.activity.onResume(); Handler.runPosted();
                        check(WebAppRegistry.taken.isEmpty(), "resumed Activity cannot take a ticket before native UI is ready");
                        events.clear(); f.activity.succeedAsyncStartup();
                        equal(WebAppRegistry.taken, restored ? List.of() : List.of(FIRST_TICKET),
                                "native initialization takes only a freshly queued cold ticket once ready");
                        check(events.contains("OPEN_WEB_APP") != restored, "restored Activity never opens its original app handoff again");
                        check(!f.activity.getIntent().hasExtra(ControlProtocol.WEB_APP_TICKET), "cold readiness never restores the ticket to the base Intent");
                        equal(f.activity.pendingWebAppTicket, null, "nothing stays queued after cold initialization");
                    }

                    reset(); Fixture f = new Fixture(false);
                    WebAppRegistry.available.add(FIRST_TICKET);
                    f.create(webAppDelivery(f.app, FIRST_TICKET), null);
                    f.activity.succeedAsyncStartup();
                    check(WebAppRegistry.taken.isEmpty(), "background initialization cannot consume the cold ticket");
                    equal(f.activity.pendingWebAppTicket, FIRST_TICKET, "ready without foreground retains the cold ticket");
                    f.activity.onResume();
                    check(WebAppRegistry.taken.isEmpty(), "foreground transition defers a ready ticket to the posted turn");
                    Handler.runPosted();
                    equal(WebAppRegistry.taken, List.of(FIRST_TICKET), "posted pass consumes the cold ticket once ready and foreground");
                }
                static void lateStartupCallbacks() {
                    reset(); Fixture live = new Fixture();
                    equal(live.activity.pageContainer.attachments, 0, "renderer stays off-window before startup success");
                    live.activity.succeedAsyncStartup();
                    equal(live.activity.pageContainer.attachments, 1, "startup success attaches renderer");
                    equal(events, List.of("PREPARE_TABS", "REFRESH_CHROME", "PREVIEW_REQUEST"),
                            "startup success then initializes browser UI");
                    live.activity.succeedAsyncStartup();
                    equal(live.activity.pageContainer.attachments, 1, "repeated success cannot attach renderer twice");
                    reset(); Fixture f = new Fixture(); f.activity.failAsyncStartup();
                    equal(f.activity.pageContainer.attachments, 0, "failed startup leaves renderer off-window");
                    equal(events, List.of("TOAST", "RETURN_MANAGER"), "active async startup failure preserves Activity");
                    equal(f.activity.finishes, 0, "active async failure cannot finish attached runtime");
                    check(logs.contains("LIFECYCLE_ASYNC_STARTUP_FAILURE"), "async failure has fixed phase");
                    reset(); f = new Fixture(); f.drain();
                    List<String> before = List.copyOf(events); int logCount = logs.size();
                    f.activity.failAsyncStartup(); f.activity.succeedAsyncStartup();
                    equal(events, before, "late success/failure during quiescence has no UI/teardown side effects");
                    equal(f.activity.pageContainer.attachments, 0, "revoked startup cannot attach renderer");
                    equal(logs.size(), logCount, "late callback is ignored before logging");
                    f.activity.onNewIntent(null);
                    equal(events, before, "quiescing reuse failure cannot navigate or finish early");
                    ShellManager.pending.accept(true); before = List.copyOf(events);
                    f.activity.failAsyncStartup(); f.activity.succeedAsyncStartup(); f.activity.onNewIntent(valid(f.app));
                    equal(events, before, "callbacks/reuse after close/finish cannot restart manager");
                    Handler.runPosted(); equal(f.receipts.size(), 1, "late callback leaves exactly one drain result");
                    reset(); f = new Fixture(); f.activity.viewFailure = new IllegalStateException("https://private.invalid/exception-canary");
                    f.activity.succeedAsyncStartup();
                    equal(events, List.of("PREPARE_TABS", "TOAST", "RETURN_MANAGER"), "active async view failure returns without destroying attached runtime");
                    equal(f.activity.finishes, 0, "async view failure never finishes attached owner");
                    check(logs.contains("LIFECYCLE_ASYNC_VIEW_INITIALIZATION_FAILURE"), "async view initialization failure has distinct fixed phase");
                    reset(); Fixture reentrant = new Fixture();
                    reentrant.activity.duringPrepare = reentrant::drain;
                    reentrant.activity.viewFailure = new IllegalStateException("https://private.invalid/exception-canary");
                    reentrant.activity.succeedAsyncStartup();
                    equal(events, List.of("PREPARE_TABS", "QUIESCE", "FLUSH"), "startup catch after reentrant drain cannot toast/navigate/finish");
                    check(!logs.contains("LIFECYCLE_ASYNC_VIEW_INITIALIZATION_FAILURE"), "stale view catch ignores failure before logging");
                    ShellManager.pending.accept(true); Handler.runPosted();
                    equal(reentrant.activity.finishes, 1, "only native drain may finish reentrantly revoked startup");
                    for (int mode = 0; mode < 4; mode++) {
                        reset(); f = new Fixture();
                        if (mode == 0) f.activity.closed = true;
                        if (mode == 1) f.activity.quiescing = true;
                        if (mode == 2) f.activity.finishing = true;
                        if (mode == 3) f.activity.destroyed = true;
                        f.activity.startupFailed("NATIVE_STARTUP_REJECTED");
                        equal(events, List.of(), "late failure cannot toast/navigate/finish a stopped Activity");
                    }
                }
                public static int run() {
                    callbackOutcomes(); timeoutAndSynchronous(); exceptionalOutcomes();
                    dualStorageOutcomes(); synchronousStorageCombinations(); historyInitializationAndInflightWaits();
                    storageFailuresAndMissingNative(); dualStorageTimeouts(); runtimeHistoryOwnership();
                    rejectedCreateRecords(); coldIntentAdmission(); ordinaryContinue(); optionalDeliveryRejectedSoft();
                    warmTicketConsumption(); ineligibleTicketCannotDisplacePending();
                    coldTicketConsumptionWhenReady(); lateStartupCallbacks();
                    for (String message : allLogs) {
                        check(message.matches("[A-Z_]+"), "lifecycle log is fixed phase only");
                        check(!message.contains("private") && !message.contains("http") && !message.contains("canary"), "no session/nonce/URL/exception leakage");
                    }
                    return checks;
                }
            }
            """);
}
