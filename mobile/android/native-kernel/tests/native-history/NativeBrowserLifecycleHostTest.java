import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
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
 * Android, native flushing, Shell teardown, navigation and the main-loop scheduler are fake hosts.
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
        parse(compiler, List.of(source.resolve("NativeBrowserRuntime.java"), source.resolve("NativeBrowserActivity.java")));
        String runtime = fieldMembers("NativeBrowserRuntime", List.of("TAG", "application", "view", "generation",
                "draining", "drainReturned", "drainTimeout", "main", "DRAIN_TIMEOUT_MS", "status"))
                + methodMembers("NativeBrowserRuntime", List.of("attach", "isCurrent", "detach", "beginDrain", "finishDrain", "requireMain"));
        String activity = fieldMembers("NativeBrowserActivity", List.of("TAG", "application", "runtime", "generation",
                "closed", "quiescing", "cleanupComplete", "uiBuilt", "manager"))
                + methodMembers("NativeBrowserActivity", List.of("validateIntent", "current", "startupFailed", "returnToList", "onNewIntent", "onDestroy", "onStatus"));
        String rejected = null;
        for (StatementTree statement : methods.get("NativeBrowserActivity#onCreate").getBody().getStatements()) {
            if (statement instanceof TryTree attempt && !attempt.getCatches().isEmpty()) {
                if (rejected != null) throw new AssertionError("Ambiguous outer create rejection");
                rejected = attempt.getCatches().get(0).getBlock().toString();
            }
        }
        if (rejected == null) throw new AssertionError("Missing outer create rejection");
        activity += "\nvoid rejectCreate(boolean runtimeAttached) " + rejected;
        activity += "\nvoid failAsyncStartup() " + methods.get("#onFailure").getBody();
        activity += "\nvoid succeedAsyncStartup() " + methods.get("#onSuccess").getBody();
        Path host = output.resolve("LifecycleHost.java");
        Files.writeString(host, HOST.replace("@RUNTIME@", runtime).replace("@ACTIVITY@", activity), StandardCharsets.UTF_8);
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

    private static final String HOST = """
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
                    LibraryLoader.instance.initialized = true; BrowserStartupController.instance.started = true;
                }
                static final class Log {
                    static void i(String tag, String message) { logs.add(message); allLogs.add(message); }
                    static void w(String tag, String message) { logs.add(message); allLogs.add(message); }
                }
                static final class Looper {
                    static final Looper main = new Looper();
                    static Looper myLooper() { return main; }
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
                static final class LaunchSpec {
                    final String sessionId = "session-private-canary";
                    final String nonce = "nonce-private-canary";
                }
                static final class NativeBrowserApplication {
                    final LaunchSpec launch = new LaunchSpec();
                    boolean draining;
                    boolean activated = true;
                    void requireBrowserActivation() { if (!activated || draining) throw new IllegalStateException("https://private.invalid/exception-canary"); }
                    LaunchSpec requireLaunch() { return launch; }
                    boolean isDraining() { return draining; }
                    void verifyFrozenCommandLine() { }
                }
                static final class Bundle {
                    final Map<String, String> values = new HashMap<>();
                    int size() { return values.size(); }
                    String getString(String name) { return values.get(name); }
                    boolean containsKey(String name) { return values.containsKey(name); }
                }
                static final class ControlProtocol { static final String SESSION = "session"; static final String NONCE = "nonce"; }
                static final class MainActivity { }
                static final class Intent {
                    static final int FLAG_ACTIVITY_REORDER_TO_FRONT = 1;
                    static final int FLAG_ACTIVITY_SINGLE_TOP = 2;
                    Bundle extras;
                    Object data, selector, clip;
                    int flags;
                    Intent() { }
                    Intent(Object context, Class<?> target) { }
                    Bundle getExtras() { return extras; }
                    Object getData() { return data; }
                    Object getSelector() { return selector; }
                    Object getClipData() { return clip; }
                    Intent addFlags(int value) { flags |= value; return this; }
                }
                static final class Toast {
                    static final int LENGTH_LONG = 1;
                    static Toast makeText(Object context, String text, int duration) { return new Toast(); }
                    void show() { events.add("TOAST"); }
                }
                static class Activity {
                    boolean finishing, destroyed, failNavigation, failFinish;
                    int finishes;
                    int flags;
                    boolean isFinishing() { return finishing; }
                    boolean isDestroyed() { return destroyed; }
                    void finish() { events.add("FINISH"); finishes++; if (failFinish) throw new IllegalStateException("exception-private-canary"); finishing = true; }
                    void startActivity(Intent intent) { events.add("RETURN_MANAGER"); if (failNavigation) throw new IllegalStateException("exception-private-canary"); flags = intent.flags; }
                    void setIntent(Intent intent) { events.add("SET_INTENT"); }
                    protected void onNewIntent(Intent intent) { }
                    protected void onDestroy() { destroyed = true; }
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
                    // Mirrors the real post-success sequence minus the splash hide (no splash in this fake).
                    void initializeBrowserUi() {
                        prepareInitialTab(); uiBuilt = true; refreshChrome(); requestActivePreview(manager.getActiveShell());
                    }
                    void requestChromeRefresh() { events.add("REFRESH"); }
                    void quiesceForShutdown() { if (quiescing || cleanupComplete) return; quiescing = true; events.add("QUIESCE"); fail(quietFailure); }
                    void closeNativeView() {
                        if (cleanupComplete) return;
                        quiesceForShutdown(); closed = true; events.add("CLOSE"); closeCalls++;
                        fail(closeFailure); cleanupComplete = true;
                    }
                }
                static final class NativeBrowserRuntime implements BrowserProcessRuntime {
                    @RUNTIME@
                    NativeBrowserRuntime(NativeBrowserApplication app) { application = app; }
                }
                static final class Fixture {
                    final NativeBrowserApplication app = new NativeBrowserApplication();
                    final NativeBrowserRuntime runtime = new NativeBrowserRuntime(app);
                    final NativeBrowserActivity activity = new NativeBrowserActivity();
                    final List<String> receipts = new ArrayList<>();
                    Fixture() { activity.application = app; activity.runtime = runtime; activity.manager = new ShellManager(); activity.generation = runtime.attach(activity); }
                    void drain() { runtime.beginDrain(outcome -> { events.add("CALLBACK"); receipts.add(outcome); }); }
                }
                static Intent valid(NativeBrowserApplication app) {
                    Intent intent = new Intent(); intent.extras = new Bundle();
                    intent.extras.values.put(ControlProtocol.SESSION, app.launch.sessionId);
                    intent.extras.values.put(ControlProtocol.NONCE, app.launch.nonce);
                    return intent;
                }
                static void callbackOutcomes() {
                    for (Boolean confirmed : Arrays.asList(true, false, null)) {
                        reset(); Fixture f = new Fixture(); f.drain();
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
                        if (mode >= 5) ShellManager.pending.accept(true);
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
                static void createAndReuse() {
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
                    reset(); f = new Fixture(); long generation = f.activity.generation;
                    f.activity.onNewIntent(valid(f.app));
                    equal(events, List.of("SET_INTENT", "REFRESH"), "valid Continue only publishes validated intent and refreshes");
                    equal(f.activity.generation, generation, "Continue does not attach again");
                    check(f.activity.current(), "Continue preserves current runtime");
                    for (int mode = 0; mode < 9; mode++) {
                        reset(); f = new Fixture(); Intent intent = valid(f.app);
                        if (mode == 0) intent = null;
                        if (mode == 1) intent.data = "https://private.invalid/url-canary";
                        if (mode == 2) intent.selector = new Object();
                        if (mode == 3) intent.clip = new Object();
                        if (mode == 4) intent.extras = null;
                        if (mode == 5) intent.extras.values.put("commandLineArgs", "private-canary");
                        if (mode == 6) intent.extras.values.put(ControlProtocol.SESSION, "stale-session-private-canary");
                        if (mode == 7) intent.extras.values.put(ControlProtocol.NONCE, "stale-nonce-private-canary");
                        if (mode == 8) f.app.activated = false;
                        f.activity.onNewIntent(intent);
                        equal(events, List.of("TOAST", "RETURN_MANAGER"), "invalid Continue does not finish or replace live tabs");
                        equal(f.activity.finishes, 0, "invalid Continue never finishes active record");
                        check(logs.contains("LIFECYCLE_ON_NEW_INTENT_REJECTED"), "new-intent failure has fixed phase");
                    }
                    reset(); rejected = new NativeBrowserActivity(); rejected.failNavigation = true;
                    try { rejected.rejectCreate(false); throw new AssertionError("manager failure swallowed"); }
                    catch (IllegalStateException expected) { equal(rejected.finishes, 0, "finish requires successful manager return"); }
                }
                static void lateStartupCallbacks() {
                    reset(); Fixture f = new Fixture(); f.activity.failAsyncStartup();
                    equal(events, List.of("TOAST", "RETURN_MANAGER"), "active async startup failure preserves Activity");
                    equal(f.activity.finishes, 0, "active async failure cannot finish attached runtime");
                    check(logs.contains("LIFECYCLE_ASYNC_STARTUP_FAILURE"), "async failure has fixed phase");
                    reset(); f = new Fixture(); f.drain();
                    List<String> before = List.copyOf(events); int logCount = logs.size();
                    f.activity.failAsyncStartup(); f.activity.succeedAsyncStartup();
                    equal(events, before, "late success/failure during quiescence has no UI/teardown side effects");
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
                    callbackOutcomes(); timeoutAndSynchronous(); exceptionalOutcomes(); createAndReuse(); lateStartupCallbacks();
                    for (String message : allLogs) {
                        check(message.matches("[A-Z_]+"), "lifecycle log is fixed phase only");
                        check(!message.contains("private") && !message.contains("http") && !message.contains("canary"), "no session/nonce/URL/exception leakage");
                    }
                    return checks;
                }
            }
            """;
}
