import com.sun.source.tree.AssignmentTree;
import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.ExpressionStatementTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.StatementTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.VariableTree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.TreeScanner;
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
 * Executes actual patched ShellManager and Shell method bodies on JDK17 fake Views/JNI.
 * Parentage, visibility, reference handoff and call ordering are modeled, not Android rendering.
 * This is not an Android build, real Surface lifecycle/performance test, or visual acceptance.
 */
public final class NativePersistentTabHostTest {
    private NativePersistentTabHostTest() { }

    public static void main(String[] args) throws Exception {
        if (args.length != 2) throw new IllegalArgumentException("Usage: NativePersistentTabHostTest PATCHED_ROOT OUTPUT");
        Path source = Path.of(args[0]).resolve("content/shell/android/java/src/org/chromium/content_shell");
        Path output = Path.of(args[1]);
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) throw new AssertionError("A full JDK17 is required");
        String manager = extract(compiler, source.resolve("ShellManager.java"),
                List.of("mWindow", "mActiveShell", "mShells", "mContentViewRenderView", "mUsePersistentTabContentViewHost"),
                List.of("usePersistentTabContentViewHost", "setWindow", "getContentViewRenderView", "getActiveShell",
                        "createShell", "showShell", "detachShell", "getShells", "selectShell", "closeShell", "removeShell", "destroy"));
        verifyNativeInitBinding(compiler, source.resolve("Shell.java"));
        String shell = extract(compiler, source.resolve("Shell.java"),
                List.of("mNativeShell", "mWindow", "mWebContents", "mContentViewRenderView", "mIsFullscreen",
                        "mUsePersistentContentViewHost", "mOverlayMode", "mContentViewRenderViewReady",
                        "mOverlayModeChangedCallbackForTesting"),
                List.of("usePersistentContentViewHost", "setContentViewRenderView", "bindCurrentWebContentsToRenderView",
                        "isDestroyed", "onNativeDestroyed", "toggleFullscreenModeForTab",
                        "isFullscreenForTabOrPending", "setOverlayMode", "getWebContents"));
        Files.createDirectories(output);
        Path host = output.resolve("PersistentTabHost.java");
        Files.writeString(host, HOST.replace("@MANAGER@", manager).replace("@SHELL@", shell), StandardCharsets.UTF_8);
        try (StandardJavaFileManager files = compiler.getStandardFileManager(null, null, StandardCharsets.UTF_8)) {
            boolean compiled = compiler.getTask(null, files, null,
                    List.of("--release", "17", "-Xlint:all", "-Werror", "-d", output.toString()),
                    null, files.getJavaFileObjects(host)).call();
            if (!compiled) throw new AssertionError("Source-extracted persistent host did not compile");
        }
        try (URLClassLoader loader = new URLClassLoader(new URL[] {output.toUri().toURL()},
                NativePersistentTabHostTest.class.getClassLoader())) {
            int checks = (Integer) loader.loadClass("PersistentTabHost").getMethod("run").invoke(null);
            System.out.println(checks + " source-extracted persistent-tab fake-host checks, 0 failures");
        }
        System.out.println("Host-only: no Android build, physical Surface timing/performance, or visual acceptance.");
    }

    private static String extract(JavaCompiler compiler, Path source, List<String> fields,
            List<String> methods) throws Exception {
        Map<String, String> members = new HashMap<>();
        try (StandardJavaFileManager files = compiler.getStandardFileManager(null, null, StandardCharsets.UTF_8)) {
            JavacTask task = (JavacTask) compiler.getTask(null, files, null,
                    List.of("-proc:none", "--release", "17"), null, files.getJavaFileObjects(source));
            for (CompilationUnitTree unit : task.parse()) {
                for (Tree top : unit.getTypeDecls()) {
                    if (!(top instanceof ClassTree type)) continue;
                    for (Tree member : type.getMembers()) {
                        String name = member instanceof VariableTree field ? field.getName().toString()
                                : member instanceof MethodTree method ? method.getName().toString() : "";
                        if (!fields.contains(name) && !methods.contains(name)) continue;
                        String text = member.toString() + (member instanceof VariableTree ? ";" : "");
                        // Only annotation spelling is erased; method bodies are not rewritten.
                        text = text.replaceAll("@(?:Nullable|CalledByNative|Initializer|RequiresNonNull\\([^)]*\\))\\s*", "");
                        if (members.put(name, text) != null) throw new AssertionError("Ambiguous production member: " + name);
                    }
                }
            }
        }
        StringBuilder result = new StringBuilder();
        for (String name : fields) result.append(required(members, name)).append('\n');
        for (String name : methods) result.append(required(members, name)).append('\n');
        return result.toString();
    }

    private static void verifyNativeInitBinding(JavaCompiler compiler, Path source) throws Exception {
        int verified = 0;
        try (StandardJavaFileManager files = compiler.getStandardFileManager(null, null, StandardCharsets.UTF_8)) {
            JavacTask task = (JavacTask) compiler.getTask(null, files, null,
                    List.of("-proc:none", "--release", "17"), null, files.getJavaFileObjects(source));
            for (CompilationUnitTree unit : task.parse()) {
                for (Tree top : unit.getTypeDecls()) {
                    if (!(top instanceof ClassTree type)) continue;
                    for (Tree member : type.getMembers()) {
                        if (!(member instanceof MethodTree method)
                                || !method.getName().contentEquals("initFromNativeTabContents")) continue;
                        List<? extends StatementTree> statements = method.getBody().getStatements();
                        int assignment = -1, binding = -1;
                        for (int index = 0; index < statements.size(); index++) {
                            if (!(statements.get(index) instanceof ExpressionStatementTree statement)) continue;
                            if (statement.getExpression() instanceof AssignmentTree value
                                    && value.getVariable().toString().equals("mWebContents")
                                    && value.getExpression().toString().equals("webContents")) assignment = index;
                            if (statement.getExpression() instanceof MethodInvocationTree call
                                    && call.getMethodSelect().toString().equals("bindCurrentWebContentsToRenderView")
                                    && call.getArguments().isEmpty()) binding = index;
                        }
                        int[] calls = new int[2];
                        new TreeScanner<Void, Void>() {
                            @Override public Void visitMethodInvocation(MethodInvocationTree call, Void unused) {
                                String select = call.getMethodSelect().toString();
                                if (select.equals("bindCurrentWebContentsToRenderView")) calls[0]++;
                                if (select.endsWith(".setCurrentWebContents")) calls[1]++;
                                return super.visitMethodInvocation(call, unused);
                            }
                        }.scan(method.getBody(), null);
                        if (assignment < 0 || binding <= assignment || binding != statements.size() - 1
                                || calls[0] != 1 || calls[1] != 0) {
                            throw new AssertionError("Production native init must assign WebContents then call the binder once, last");
                        }
                        verified++;
                    }
                }
            }
        }
        if (verified != 1) throw new AssertionError("Expected exactly one production native initialization method");
        System.out.println("1 production AST native-init-to-binder relation, 0 failures");
    }

    private static String required(Map<String, String> members, String name) {
        String result = members.get(name);
        if (result == null) throw new AssertionError("Missing production member: " + name);
        return result;
    }

    private static final String HOST = """
            import java.util.*;
            public final class PersistentTabHost {
                static int checks;
                static final List<String> events = new ArrayList<>();
                static void check(boolean pass, String message) {
                    checks++;
                    if (!pass) throw new AssertionError(message);
                }
                interface Callback<T> { void onResult(T result); }
                static <T> T assumeNonNull(T value) { return Objects.requireNonNull(value); }
                static final class ThreadUtils { static void assertOnUiThread() { } }
                static final class WindowAndroid { }
                static final class Context {
                    static final String LAYOUT_INFLATER_SERVICE = "inflater";
                    Object getSystemService(String name) { return new LayoutInflater(this); }
                }
                static final class LayoutInflater {
                    final Context context;
                    LayoutInflater(Context value) { context = value; }
                    Object inflate(int resource, Object parent) { return new Shell(context); }
                }
                static final class R {
                    static final class id { static final int toolbar = 1, contentview_holder = 2; }
                    static final class layout { static final int shell_view = 3; }
                }
                static class View {
                    static final int VISIBLE = 0, GONE = 8;
                    ViewGroup parent;
                    int visibility = VISIBLE, adds, removes;
                    ViewGroup getParent() { return parent; }
                    void setVisibility(int value) { visibility = value; }
                    int getVisibility() { return visibility; }
                    View findViewById(int id) { return null; }
                }
                static class ViewGroup extends View {
                    static class LayoutParams {
                        static final int MATCH_PARENT = -1;
                        LayoutParams(int width, int height) { }
                    }
                    final List<View> children = new ArrayList<>();
                    void addView(View child) { addView(child, new LayoutParams(-1, -1)); }
                    void addView(View child, int index, LayoutParams params) {
                        if (child.parent != null) throw new AssertionError("View already parented");
                        if (this instanceof ShellManager manager && manager.mUsePersistentTabContentViewHost
                                && child instanceof Shell shell) {
                            check(shell.mUsePersistentContentViewHost && shell.toolbar.getVisibility() == GONE,
                                    "product policy hides toolbar before Shell attach");
                        }
                        children.add(index, child); child.parent = this; child.adds++;
                        if (child instanceof ContentViewRenderView) events.add("renderer:add");
                    }
                    void addView(View child, LayoutParams params) { addView(child, children.size(), params); }
                    void removeView(View child) {
                        if (!children.remove(child)) return;
                        child.parent = null; child.removes++;
                        if (child instanceof ContentViewRenderView) events.add("renderer:detach");
                    }
                    int getChildCount() { return children.size(); }
                    View getChildAt(int index) { return children.get(index); }
                    Context getContext() { return new Context(); }
                }
                static class FrameLayout extends ViewGroup { }
                static class LinearLayout extends FrameLayout { }
                static final class Visibility { static final int VISIBLE = 0, HIDDEN = 1; }
                static final class WebContents {
                    int visibility = Visibility.HIDDEN;
                    boolean destroyed;
                    boolean isDestroyed() { return destroyed; }
                    void updateWebContentsVisibility(int value) {
                        check(!destroyed, "native removal never updates destroyed WebContents");
                        visibility = value;
                    }
                }
                static final class ContentViewRenderView extends View {
                    WebContents current;
                    boolean overlay, compositorInitialized, nativeDestroyed;
                    int bindAttempts, binds, modeWrites, destroys;
                    Runnable onBind;
                    final List<String> calls = new ArrayList<>();
                    ContentViewRenderView(Context context) { }
                    void onNativeLibraryLoaded(WindowAndroid window) { }
                    void setCurrentWebContents(WebContents value) {
                        check(!nativeDestroyed, "cannot bind a natively destroyed renderer");
                        check(value != null && !value.isDestroyed(), "bind requires live WebContents");
                        bindAttempts++;
                        if (onBind != null) onBind.run();
                        current = value; compositorInitialized = true; binds++;
                        calls.add("current");
                    }
                    void setOverlayVideoMode(boolean value) {
                        check(compositorInitialized && !nativeDestroyed,
                                "overlay requires an initialized, live native compositor");
                        overlay = value; modeWrites++; calls.add("overlay:" + value);
                    }
                    void destroy() {
                        check(getParent() == null, "renderer detached before native destroy");
                        check(!nativeDestroyed, "native renderer destruction occurs once");
                        nativeDestroyed = true; compositorInitialized = false;
                        events.add("renderer:destroy"); destroys++;
                    }
                }
                static final class ShellManager extends FrameLayout {
                    @MANAGER@
                }
                static final class Shell extends LinearLayout {
                    final FrameLayout holder = new FrameLayout();
                    final LinearLayout toolbar = new LinearLayout();
                    int closes;
                    Shell(Context context) { mWebContents = new WebContents(); }
                    void initialize(long pointer, WindowAndroid window) { mNativeShell = pointer; mWindow = window; }
                    void close() { closes++; mNativeShell = 0; }
                    @Override View findViewById(int id) { return id == R.id.toolbar ? toolbar : holder; }
                    @SHELL@
                }
                static ShellManager manager(boolean persistent) {
                    ShellManager manager = new ShellManager();
                    manager.setWindow(new WindowAndroid());
                    if (persistent) manager.usePersistentTabContentViewHost();
                    return manager;
                }
                static Shell create(ShellManager manager, long pointer) { return (Shell) manager.createShell(pointer); }
                static void state(ShellManager manager, Shell active, ContentViewRenderView renderer,
                        ViewGroup parent, int adds, int removes) {
                    check(renderer.getParent() == parent && renderer.adds == adds && renderer.removes == removes,
                            "tab transitions never reparent fixed renderer");
                    check(parent == manager && manager.getChildAt(0) == renderer, "fixed renderer stays at manager layer zero");
                    check(manager.getActiveShell() == active, "manager active Shell identity");
                    if (active != null) {
                        check(renderer.current == active.getWebContents(), "renderer current WebContents owner");
                        check(active.mContentViewRenderViewReady, "selected Shell completed its compositor binding");
                    }
                    for (Shell shell : manager.getShells()) {
                        boolean selected = shell == active;
                        check(shell.getWebContents().visibility == (selected ? Visibility.VISIBLE : Visibility.HIDDEN),
                                "only active retained WebContents is visible");
                        check(shell.mContentViewRenderView == (selected ? renderer : null), "only active Shell owns renderer reference");
                        check(shell.mContentViewRenderViewReady == selected, "inactive retained Shell is never renderer-ready");
                        check(shell.toolbar.getVisibility() == View.GONE, "product toolbar is hidden before showing Shell");
                    }
                }
                static void rejects(Runnable action, String message) {
                    try { action.run(); }
                    catch (IllegalStateException failure) {
                        check(message.equals(failure.getMessage()), "opt-in guard reports precise state");
                        return;
                    }
                    throw new AssertionError("Expected opt-in guard: " + message);
                }
                static Shell productShell() {
                    Shell shell = new Shell(new Context());
                    shell.initialize(100, new WindowAndroid());
                    shell.usePersistentContentViewHost();
                    return shell;
                }
                static void initialBinding() {
                    Shell shell = productShell();
                    shell.mWebContents = null;
                    ContentViewRenderView renderer = new ContentViewRenderView(new Context());
                    List<Boolean> observed = new ArrayList<>();
                    shell.mOverlayModeChangedCallbackForTesting = observed::add;
                    shell.setContentViewRenderView(renderer);
                    shell.bindCurrentWebContentsToRenderView();
                    shell.setOverlayMode(true); shell.setOverlayMode(false); shell.setOverlayMode(true);
                    check(shell.mContentViewRenderView == renderer && !shell.mContentViewRenderViewReady
                            && !renderer.compositorInitialized && renderer.bindAttempts == 0 && renderer.modeWrites == 0,
                            "first renderer reference with null WebContents only caches overlay callbacks");
                    check(observed.equals(List.of(true, false, true)), "only actual initial callbacks notify observers");
                    shell.mWebContents = new WebContents();
                    shell.bindCurrentWebContentsToRenderView();
                    check(shell.mContentViewRenderViewReady && renderer.current == shell.mWebContents
                            && renderer.calls.equals(List.of("current", "overlay:true")),
                            "first bind initializes compositor before replaying only the latest cached mode");
                    check(observed.equals(List.of(true, false, true)), "initial replay never synthesizes observer callbacks");

                    shell.setContentViewRenderView(null);
                    check(!shell.mContentViewRenderViewReady, "detaching clears renderer readiness");
                    shell.setOverlayMode(false);
                    Shell selected = productShell();
                    selected.setContentViewRenderView(renderer);
                    selected.bindCurrentWebContentsToRenderView();
                    int writes = renderer.modeWrites;
                    shell.setOverlayMode(true);
                    check(renderer.modeWrites == writes && !renderer.overlay && renderer.current == selected.mWebContents,
                            "stale detached callback cannot change the selected Shell's renderer");
                    selected.setContentViewRenderView(null);
                    shell.setContentViewRenderView(renderer);
                    check(!shell.mContentViewRenderViewReady && renderer.modeWrites == writes,
                            "reattaching an initialized renderer still waits for this Shell's binding");
                    shell.bindCurrentWebContentsToRenderView();
                    check(shell.mContentViewRenderViewReady && renderer.modeWrites == writes + 1 && renderer.overlay
                            && renderer.current == shell.mWebContents, "reattach binds owner before restoring latest mode");
                    check(observed.equals(List.of(true, false, true, false, true)),
                            "detach and reattach replay add no synthetic observer callbacks");

                    writes = renderer.modeWrites;
                    shell.setContentViewRenderView(renderer);
                    shell.setOverlayMode(true);
                    check(!shell.mContentViewRenderViewReady && renderer.modeWrites == writes,
                            "even same-reference setter invalidates prior binding readiness");
                    renderer.onBind = () -> shell.setOverlayMode(false);
                    shell.bindCurrentWebContentsToRenderView();
                    check(renderer.modeWrites == writes + 1 && !renderer.overlay,
                            "overlay callback reentered during bind stays cached and latest mode wins");
                    check(observed.equals(List.of(true, false, true, false, true, true, false)),
                            "reentrant callback is observed once but replay is not observed");
                }
                static void failedAndReentrantBinding() {
                    Shell failed = productShell();
                    ContentViewRenderView renderer = new ContentViewRenderView(new Context());
                    failed.setContentViewRenderView(renderer);
                    failed.setOverlayMode(true);
                    IllegalStateException injected = new IllegalStateException("injected onBind failure");
                    for (int attempt = 0; attempt < 2; attempt++) {
                        int binds = renderer.binds, writes = renderer.modeWrites;
                        renderer.onBind = () -> { throw injected; };
                        try {
                            failed.bindCurrentWebContentsToRenderView();
                            throw new AssertionError("Expected exact artificial onBind failure");
                        } catch (IllegalStateException actual) {
                            if (actual != injected) throw actual;
                        }
                        check(!failed.mContentViewRenderViewReady && renderer.binds == binds && renderer.modeWrites == writes,
                                "failed bind propagates without readiness or overlay replay");
                        failed.setOverlayMode(false);
                        check(renderer.modeWrites == writes, "callback after failed bind remains cached");
                        renderer.onBind = null;
                        failed.bindCurrentWebContentsToRenderView();
                        check(failed.mContentViewRenderViewReady && renderer.binds == binds + 1
                                && renderer.modeWrites == writes + 1, "successful retry alone marks binding ready");
                    }
                    for (int scenario = 0; scenario < 5; scenario++) {
                        Shell shell = productShell();
                        ContentViewRenderView original = new ContentViewRenderView(new Context());
                        ContentViewRenderView replacement = new ContentViewRenderView(new Context());
                        shell.setContentViewRenderView(original);
                        shell.setOverlayMode(true);
                        int change = scenario;
                        original.onBind = () -> {
                            check(!shell.mContentViewRenderViewReady, "reentrant bind is not prematurely ready");
                            switch (change) {
                                case 0 -> shell.setContentViewRenderView(null);
                                case 1 -> shell.setContentViewRenderView(replacement);
                                case 2 -> shell.mWebContents = new WebContents();
                                case 3 -> shell.mWebContents.destroyed = true;
                                case 4 -> shell.onNativeDestroyed();
                                default -> throw new AssertionError("Unknown reentrant scenario");
                            }
                        };
                        shell.bindCurrentWebContentsToRenderView();
                        check(original.binds == 1 && !shell.mContentViewRenderViewReady
                                && original.modeWrites == 0 && replacement.modeWrites == 0,
                                "reentrant renderer/content identity or liveness change prevents readiness and replay: " + scenario);
                        shell.setOverlayMode(false);
                        check(original.modeWrites == 0 && replacement.modeWrites == 0,
                                "callback after invalidated reentrant binding stays cached: " + scenario);
                    }
                }
                static void destroyedBinding() {
                    Shell shell = productShell();
                    ContentViewRenderView renderer = new ContentViewRenderView(new Context());
                    shell.setContentViewRenderView(renderer);
                    shell.bindCurrentWebContentsToRenderView();
                    shell.mNativeShell = 0;
                    int writes = renderer.modeWrites, attempts = renderer.bindAttempts;
                    shell.setOverlayMode(true);
                    check(shell.isDestroyed() && shell.mContentViewRenderView == renderer
                            && renderer.modeWrites == writes, "destroyed Shell cannot forward overlay despite non-null ready reference");
                    shell.bindCurrentWebContentsToRenderView();
                    check(!shell.mContentViewRenderViewReady && renderer.bindAttempts == attempts,
                            "destroyed Shell cannot start another native binding");

                    Shell nativeGone = productShell();
                    ContentViewRenderView nativeRenderer = new ContentViewRenderView(new Context());
                    nativeGone.setContentViewRenderView(nativeRenderer);
                    nativeGone.bindCurrentWebContentsToRenderView();
                    nativeGone.onNativeDestroyed();
                    check(nativeGone.isDestroyed() && nativeGone.mWindow == null && nativeGone.mWebContents == null
                            && !nativeGone.mContentViewRenderViewReady && nativeGone.mContentViewRenderView == nativeRenderer,
                            "actual nativeDestroyed clears readiness and native state even with retained renderer reference");
                    nativeGone.setOverlayMode(true);
                    nativeRenderer.destroy();
                    nativeGone.setOverlayMode(false);
                    nativeGone.bindCurrentWebContentsToRenderView();
                    check(nativeRenderer.modeWrites == 1 && nativeRenderer.bindAttempts == 1
                            && nativeRenderer.nativeDestroyed, "late callbacks never overlay or rebind after native renderer destruction");

                    Shell deadContents = productShell();
                    ContentViewRenderView unused = new ContentViewRenderView(new Context());
                    deadContents.mWebContents.destroyed = true;
                    deadContents.setContentViewRenderView(unused);
                    deadContents.bindCurrentWebContentsToRenderView();
                    deadContents.setOverlayMode(true);
                    check(!deadContents.mContentViewRenderViewReady && unused.bindAttempts == 0 && unused.modeWrites == 0,
                            "already-destroyed WebContents cannot initialize or replay overlay");
                    Shell detached = productShell();
                    detached.bindCurrentWebContentsToRenderView();
                    check(!detached.mContentViewRenderViewReady, "binding without a renderer is a safe product no-op");
                }
                public static int run() {
                    initialBinding();
                    failedAndReentrantBinding();
                    destroyedBinding();
                    ShellManager uninitialized = new ShellManager();
                    rejects(uninitialized::usePersistentTabContentViewHost, "SHELL_MANAGER_NOT_INITIALIZED");
                    check(!uninitialized.mUsePersistentTabContentViewHost && uninitialized.getChildCount() == 0,
                            "uninitialized opt-in leaves state untouched");
                    ShellManager late = manager(false);
                    Shell existing = create(late, 10);
                    ContentViewRenderView existingRenderer = late.getContentViewRenderView();
                    rejects(late::usePersistentTabContentViewHost, "PERSISTENT_TAB_HOST_REQUIRES_NO_SHELLS");
                    check(!late.mUsePersistentTabContentViewHost && existingRenderer.getParent() == existing.holder
                            && existingRenderer.adds == 1 && existingRenderer.removes == 0,
                            "late opt-in preserves existing default parent and policy");
                    late.destroy();
                    ShellManager manager = manager(true);
                    ContentViewRenderView renderer = manager.getContentViewRenderView();
                    ViewGroup parent = renderer.getParent();
                    check(parent != null, "product renderer initially has fixed host");
                    int adds = renderer.adds, removes = renderer.removes;
                    manager.usePersistentTabContentViewHost();
                    check(renderer.adds == adds && renderer.removes == removes, "repeated opt-in is idempotent");
                    Shell a = create(manager, 1), b = create(manager, 2);
                    int shellAdds = b.adds, shellRemoves = b.removes;
                    manager.usePersistentTabContentViewHost();
                    manager.selectShell(b);
                    check(b.adds == shellAdds && b.removes == shellRemoves, "same-Tab selection does not reattach Shell");
                    state(manager, b, renderer, parent, adds, removes);
                    for (int repeat = 0; repeat < 4; repeat++) {
                        manager.selectShell(a); state(manager, a, renderer, parent, adds, removes);
                        manager.selectShell(b); state(manager, b, renderer, parent, adds, removes);
                    }
                    int writes = renderer.modeWrites;
                    a.setOverlayMode(true);
                    check(renderer.modeWrites == writes && !renderer.overlay, "inactive overlay only caches and never touches active video mode");
                    manager.selectShell(a);
                    check(renderer.overlay, "activating Shell restores cached overlay mode");
                    b.setOverlayMode(false);
                    check(renderer.overlay, "inactive non-overlay tab cannot reset active video mode");
                    manager.selectShell(b);
                    check(!renderer.overlay, "switching to normal tab restores its own overlay mode");
                    a.toggleFullscreenModeForTab(true);
                    check(a.isFullscreenForTabOrPending(), "product fullscreen state still tracked");
                    a.toggleFullscreenModeForTab(false);
                    check(!a.isFullscreenForTabOrPending() && a.toolbar.getVisibility() == View.GONE,
                            "product fullscreen exit cannot resurrect stock toolbar");
                    Shell c = create(manager, 3);
                    state(manager, c, renderer, parent, adds, removes);
                    manager.closeShell(a);
                    check(a.closes == 1 && !manager.getShells().contains(a) && a.mContentViewRenderView == null,
                            "closing inactive tab retires only that tab");
                    state(manager, c, renderer, parent, adds, removes);
                    manager.closeShell(c);
                    check(c.closes == 1, "closing active tab closes it once");
                    state(manager, b, renderer, parent, adds, removes);
                    manager.closeShell(b);
                    state(manager, null, renderer, parent, adds, removes);
                    Shell nativeClosed = create(manager, 8);
                    nativeClosed.getWebContents().destroyed = true;
                    manager.removeShell(nativeClosed);
                    check(!manager.getShells().contains(nativeClosed) && nativeClosed.mContentViewRenderView == null,
                            "native removal of already-destroyed WebContents clears Shell ownership safely");
                    state(manager, null, renderer, parent, adds, removes);
                    Shell d = create(manager, 4), e = create(manager, 5);
                    state(manager, e, renderer, parent, adds, removes);
                    events.clear();
                    manager.destroy();
                    check(renderer.destroys == 1 && renderer.getParent() == null, "destroy detaches and destroys fixed renderer once");
                    check(events.indexOf("renderer:detach") >= 0
                            && events.indexOf("renderer:detach") < events.indexOf("renderer:destroy"), "detach precedes native renderer destroy");
                    check(d.mContentViewRenderView == null && e.mContentViewRenderView == null,
                            "destroy clears active and inactive Shell renderer references");
                    check(manager.getContentViewRenderView() == null && manager.getActiveShell() == null,
                            "destroy clears manager renderer and active owners");
                    manager.destroy();
                    check(renderer.destroys == 1, "double destroy is idempotent");
                    d.setOverlayMode(true);
                    check(renderer.destroys == 1, "retired inactive overlay callback does not dereference renderer");

                    ShellManager legacy = manager(false);
                    ContentViewRenderView ordinary = legacy.getContentViewRenderView();
                    check(ordinary.getParent() == null, "default manager keeps original deferred attachment");
                    Shell first = create(legacy, 6), second = create(legacy, 7);
                    check(ordinary.getParent() == second.holder && ordinary.adds == 2 && ordinary.removes == 1,
                            "default Shell retains per-Shell renderer reparenting");
                    legacy.selectShell(first);
                    check(ordinary.getParent() == first.holder, "default tab selection reparents to selected Shell");
                    check(ordinary.binds == 3 && ordinary.modeWrites == 0,
                            "stock binder only sets current WebContents without product overlay replay");
                    first.toggleFullscreenModeForTab(true);
                    check(first.toolbar.getVisibility() == View.GONE, "default fullscreen entry hides stock toolbar");
                    first.toggleFullscreenModeForTab(false);
                    check(first.toolbar.getVisibility() == View.VISIBLE, "default fullscreen exit retains stock toolbar");
                    first.setOverlayMode(true);
                    check(ordinary.overlay, "default active overlay still forwards to renderer");
                    legacy.destroy(); legacy.destroy();
                    check(ordinary.destroys == 1, "default destroy remains idempotent");
                    return checks;
                }
            }
            """;
}
