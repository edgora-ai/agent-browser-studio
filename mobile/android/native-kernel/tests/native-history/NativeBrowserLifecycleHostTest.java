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
 * Android, history/native flush completions, Shell teardown, navigation and the main-loop scheduler
 * are fake hosts. The runtime getter and two-completion drain barrier are extracted, not reimplemented.
 * History initialization/write waits below are controlled callback scenarios, not real history I/O.
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
        String runtime = fieldMembers("NativeBrowserRuntime", List.of("TAG", "application", "launch", "view", "historyStore", "generation",
                "draining", "drainReturned", "drainTimeout", "main", "DRAIN_TIMEOUT_MS", "status"))
                + methodMembers("NativeBrowserRuntime", List.of("attach", "isCurrent", "historyStore", "detach", "beginDrain", "finishDrain", "requireMain"));
        String activity = fieldMembers("NativeBrowserActivity", List.of("TAG", "application", "runtime", "generation",
                "closed", "quiescing", "cleanupComplete", "uiBuilt", "manager", "pageContainer"))
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
                    BrowserHistoryStore.creations = 0; Looper.current = Looper.main;
                    LibraryLoader.instance.initialized = true; BrowserStartupController.instance.started = true;
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
                    NativeBrowserRuntime(NativeBrowserApplication app) { application = app; launch = app.requireLaunch(); }
                }
                static final class Fixture {
                    final NativeBrowserApplication app = new NativeBrowserApplication();
                    final NativeBrowserRuntime runtime = new NativeBrowserRuntime(app);
                    final NativeBrowserActivity activity = new NativeBrowserActivity();
                    final List<String> receipts = new ArrayList<>();
                    Fixture() { activity.application = app; activity.runtime = runtime; activity.manager = new ShellManager(); activity.pageContainer = new FrameLayout(); activity.generation = runtime.attach(activity); }
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
                    createAndReuse(); lateStartupCallbacks();
                    for (String message : allLogs) {
                        check(message.matches("[A-Z_]+"), "lifecycle log is fixed phase only");
                        check(!message.contains("private") && !message.contains("http") && !message.contains("canary"), "no session/nonce/URL/exception leakage");
                    }
                    return checks;
                }
            }
            """;
}
